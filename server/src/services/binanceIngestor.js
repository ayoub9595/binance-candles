import WebSocket from 'ws';
import { runBackfill } from './binanceBackfill.js';
import { fromWsKline, toWireShape } from '../utils/normalizeCandle.js';
import { upsertCandle, getLatestOpenTime } from '../models/candleRepository.js';
import { broadcastCandleUpdate } from '../sockets/socketServer.js';

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const WATCHDOG_INTERVAL_MS = 30000;
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

function streamName({ symbol, interval }) {
  return `${symbol.toLowerCase()}@kline_${interval}`;
}

async function backfillAllCombos(combos, { startTimes, limit } = {}) {
  for (const combo of combos) {
    const { symbol, interval } = combo;
    try {
      const startTime = startTimes?.get(`${symbol}:${interval}`);
      const count = await runBackfill({ symbol, interval, startTime, limit });
      console.log(`[ingestor] backfill for ${symbol} ${interval}: upserted ${count} candles`);
    } catch (err) {
      // One bad/rate-limited combo must not block backfill for the rest.
      console.error(`[ingestor] backfill FAILED for ${symbol} ${interval}`, err.message);
    }
  }
}

export async function startIngestor({ combos, backfillLimit }) {
  console.log(`[ingestor] running initial backfill for ${combos.length} combos...`);
  await backfillAllCombos(combos, { limit: backfillLimit });
  console.log('[ingestor] initial backfill pass complete');

  let backoffMs = MIN_BACKOFF_MS;
  let ws;
  let lastMessageAt = Date.now();
  let watchdogTimer;

  function scheduleReconnect() {
    clearInterval(watchdogTimer);
    console.log(`[ingestor] reconnecting in ${backoffMs}ms...`);
    setTimeout(connect, backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }

  async function connect() {
    // Gap recovery: catch up every combo on anything missed while disconnected
    // before resubscribing (also covers Binance's forced 24h disconnect).
    try {
      const startTimes = new Map();
      for (const { symbol, interval } of combos) {
        const latestOpenTime = await getLatestOpenTime({ symbol, interval });
        if (latestOpenTime) startTimes.set(`${symbol}:${interval}`, latestOpenTime);
      }
      await backfillAllCombos(combos, { startTimes });
    } catch (err) {
      console.error('[ingestor] gap-fill backfill pass failed', err);
    }

    const streams = combos.map(streamName).join('/');
    const streamUrl = `wss://stream.binance.com:9443/stream?streams=${streams}`;
    ws = new WebSocket(streamUrl);

    ws.on('open', () => {
      console.log(`[ingestor] Binance combined WS connected (${combos.length} streams)`);
      backoffMs = MIN_BACKOFF_MS;
      lastMessageAt = Date.now();
    });

    ws.on('ping', () => ws.pong());

    ws.on('message', async (data) => {
      lastMessageAt = Date.now();
      try {
        const payload = JSON.parse(data);
        const k = payload?.data?.k;
        if (!k || payload.data.e !== 'kline') {
          console.warn('[ingestor] ignoring non-kline/malformed combined-stream message', payload?.stream);
          return;
        }
        const candle = fromWsKline(k);
        await upsertCandle(candle);
        broadcastCandleUpdate(candle.symbol, candle.interval, toWireShape(candle));
      } catch (err) {
        console.error('[ingestor] failed to process WS message', err);
      }
    });

    ws.on('close', () => {
      console.log('[ingestor] Binance WS closed');
      scheduleReconnect();
    });

    ws.on('error', (err) => {
      console.error('[ingestor] Binance WS error', err.message);
      ws.close();
    });

    watchdogTimer = setInterval(() => {
      if (Date.now() - lastMessageAt > STALE_THRESHOLD_MS) {
        console.warn('[ingestor] connection stale, forcing reconnect');
        ws.terminate();
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  await connect();
}
