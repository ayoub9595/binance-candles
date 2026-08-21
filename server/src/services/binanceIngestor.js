import WebSocket from 'ws';
import { config } from '../config.js';
import { runBackfill } from './binanceBackfill.js';
import { ensureCatalog, isCatalogReady, isTradableSymbol } from './spotCatalog.js';
import { fromWsKline, toWireShape } from '../utils/normalizeCandle.js';
import { upsertCandle, getLatestOpenTime } from '../models/candleRepository.js';
import { broadcastCandleUpdate } from '../sockets/socketServer.js';

// The ingestor owns ONE Binance combined-stream connection whose subscriptions
// are a live registry rather than a fixed list:
//   - pinned combos (config.binanceSymbols x intervals) are subscribed at boot
//     and never released — they are what the app backfills and serves cold;
//   - any other tradable spot pair is subscribed ON DEMAND when a browser
//     subscribes to it and dropped when the last viewer leaves, which is what
//     lets the UI chart the whole exchange without streaming all of it.
// Reconnects rebuild the subscription list from the registry, so on-demand
// pairs survive a drop exactly like pinned ones do.

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const WATCHDOG_INTERVAL_MS = 30000;
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

// Binance caps a connection at 1024 streams and 5 inbound messages/second.
// Subscribe/unsubscribe requests are therefore coalesced over a short window
// (a user clicking through symbols emits a burst of both) and the registry is
// capped well under the stream limit.
const FLUSH_MS = 250;
const MAX_STREAMS = 800;

// key -> { symbol, interval, refs, pinned }. Pinned entries carry refs = 0 and
// are simply never eligible for release.
const registry = new Map();
const pendingSub = new Set();
const pendingUnsub = new Set();

let ws = null;
let wsOpen = false;
let flushTimer = null;
let nextRequestId = 1;

function comboKey({ symbol, interval }) {
  return `${symbol}:${interval}`;
}

function streamName({ symbol, interval }) {
  return `${symbol.toLowerCase()}@kline_${interval}`;
}

function normalizeCombo(symbol, interval) {
  const sym = typeof symbol === 'string' ? symbol.toUpperCase() : '';
  if (!sym || !config.binanceIntervals.includes(interval)) return null;
  return { symbol: sym, interval };
}

// --- Subscription plumbing -------------------------------------------------

function flush() {
  flushTimer = null;
  if (!wsOpen || !ws) return;

  // Unsubscribe first: within one flush a combo can appear in both sets (a
  // symbol switched away from and back to), and the sets are disjoint by
  // construction below, so ordering only matters for the stream-count ceiling.
  for (const [method, set] of [
    ['UNSUBSCRIBE', pendingUnsub],
    ['SUBSCRIBE', pendingSub],
  ]) {
    if (!set.size) continue;
    ws.send(JSON.stringify({ method, params: [...set], id: nextRequestId++ }));
    console.log(`[ingestor] ${method} ${set.size} stream(s)`);
    set.clear();
  }
}

function scheduleFlush() {
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}

// A combo queued for subscribe and then released before the flush lands should
// simply never be sent, rather than being subscribed and immediately dropped.
function queueSubscribe(entry) {
  const stream = streamName(entry);
  pendingUnsub.delete(stream);
  pendingSub.add(stream);
  scheduleFlush();
}

function queueUnsubscribe(entry) {
  const stream = streamName(entry);
  pendingSub.delete(stream);
  pendingUnsub.add(stream);
  scheduleFlush();
}

// --- Public API: on-demand streams ----------------------------------------

// Claim a live stream for `{symbol, interval}`. Ref-counted, so N browsers on
// the same pair share one Binance stream. Returns false when the combo is not
// chartable (unknown symbol, un-ingested interval) or the connection is at its
// stream ceiling — the caller can still serve stored candles either way.
export function acquireCombo(combo) {
  const norm = normalizeCombo(combo?.symbol, combo?.interval);
  if (!norm) return false;
  if (isCatalogReady()) {
    if (!isTradableSymbol(norm.symbol)) return false;
  } else {
    // Boot race (a browser subscribes before exchangeInfo lands) or a failed
    // fetch: refusing here would break a legitimate pair, so accept and let
    // the catalog catch up. A bogus symbol costs one idle stream slot until
    // its viewer leaves, which the ref-counting below reclaims.
    ensureCatalog().catch(() => {});
  }

  const key = comboKey(norm);
  const existing = registry.get(key);
  if (existing) {
    if (!existing.pinned) existing.refs += 1;
    return true;
  }

  if (registry.size >= MAX_STREAMS) {
    console.warn(`[ingestor] stream ceiling (${MAX_STREAMS}) reached, refusing ${key}`);
    return false;
  }

  // History for a never-charted pair is not this function's job: the read
  // paths seed cold combos themselves (historyEnsurer.ensureSeeded), so
  // duplicating a backfill here would only spend Binance weight twice. This
  // subscription supplies the LIVE candle from here on.
  const entry = { ...norm, refs: 1, pinned: false };
  registry.set(key, entry);
  queueSubscribe(entry);
  return true;
}

// Live subscription state. On-demand streams are ref-counted against browser
// subscriptions, and a leak there is invisible from the outside — so the
// counts are reported rather than left to be inferred from the logs.
export function getStreamStats() {
  const values = [...registry.values()];
  const onDemand = values.filter((e) => !e.pinned);
  return {
    connected: wsOpen,
    total: values.length,
    pinned: values.length - onDemand.length,
    onDemand: onDemand
      .map((e) => ({ symbol: e.symbol, interval: e.interval, viewers: e.refs }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.interval.localeCompare(b.interval)),
    max: MAX_STREAMS,
  };
}

// Give up one claim. The stream is dropped once no viewer holds it; pinned
// combos ignore this entirely.
export function releaseCombo(combo) {
  const norm = normalizeCombo(combo?.symbol, combo?.interval);
  if (!norm) return;
  const key = comboKey(norm);
  const entry = registry.get(key);
  if (!entry || entry.pinned) return;

  entry.refs -= 1;
  if (entry.refs > 0) return;
  registry.delete(key);
  queueUnsubscribe(entry);
}

// --- Backfill --------------------------------------------------------------

async function backfillCombos(combos, { startTimes, limit } = {}) {
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
  for (const combo of combos) {
    const norm = normalizeCombo(combo.symbol, combo.interval);
    if (norm) registry.set(comboKey(norm), { ...norm, refs: 0, pinned: true });
  }

  console.log(`[ingestor] running initial backfill for ${registry.size} combos...`);
  await backfillCombos([...registry.values()], { limit: backfillLimit });
  console.log('[ingestor] initial backfill pass complete');

  let backoffMs = MIN_BACKOFF_MS;
  let lastMessageAt = Date.now();
  let watchdogTimer;

  function scheduleReconnect() {
    clearInterval(watchdogTimer);
    console.log(`[ingestor] reconnecting in ${backoffMs}ms...`);
    setTimeout(connect, backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }

  async function connect() {
    wsOpen = false;
    // Gap recovery: catch up every registered combo on anything missed while
    // disconnected before resubscribing (also covers Binance's forced 24h
    // disconnect). Snapshotted because on-demand combos can come and go while
    // the paced backfill runs.
    const active = [...registry.values()];
    try {
      const startTimes = new Map();
      for (const { symbol, interval } of active) {
        const latestOpenTime = await getLatestOpenTime({ symbol, interval });
        if (latestOpenTime) startTimes.set(`${symbol}:${interval}`, latestOpenTime);
      }
      await backfillCombos(active, { startTimes });
    } catch (err) {
      console.error('[ingestor] gap-fill backfill pass failed', err);
    }

    // Build the URL from the registry as it stands NOW — anything acquired
    // during the backfill above is included here instead of waiting on a
    // flush, and its queued SUBSCRIBE becomes a harmless no-op.
    const streams = [...registry.values()].map(streamName).join('/');
    const streamUrl = `wss://stream.binance.com:9443/stream?streams=${streams}`;
    ws = new WebSocket(streamUrl);

    ws.on('open', () => {
      console.log(`[ingestor] Binance combined WS connected (${registry.size} streams)`);
      backoffMs = MIN_BACKOFF_MS;
      lastMessageAt = Date.now();
      wsOpen = true;
      // Drain whatever queued while the socket was down.
      if (pendingSub.size || pendingUnsub.size) flush();
    });

    ws.on('ping', () => ws.pong());

    ws.on('message', async (data) => {
      lastMessageAt = Date.now();
      try {
        const payload = JSON.parse(data);
        // SUBSCRIBE/UNSUBSCRIBE acks come back on the same socket as
        // {result: null, id}; errors as {error: {code, msg}, id}. Neither is a
        // malformed kline, so neither should be warned about as one.
        if (payload?.error) {
          console.error('[ingestor] stream request rejected', payload.error);
          return;
        }
        if ('result' in payload) return;

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
      wsOpen = false;
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
