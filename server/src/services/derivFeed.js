import WebSocket from 'ws';
import { config } from '../config.js';
import { getForexInstrument } from './forexInstruments.js';
import { toWireShape } from '../utils/normalizeCandle.js';
import { bulkUpsertCandles, getLatestOpenTime } from '../models/candleRepository.js';
import { broadcastCandleUpdate } from '../sockets/socketServer.js';

// Real forex instruments (XAUUSD) come from Deriv's public WebSocket API —
// Binance lists no forex pairs, only proxies like PAXG. Deriv serves months of
// intraday candle history keyless (ticks_history requests over the socket),
// but rejects streaming subscriptions for metals on a public app id, so the
// LIVE candle is polled over the same socket instead: fast while a browser is
// watching the combo, slow for pinned combos nobody is viewing (just enough to
// keep the stored history gap-free).
//
// Candles land in the same Mongo collection and socket rooms as Binance ones,
// so the read paths and the client cannot tell the difference. Volume is the
// one gap: forex has no traded volume, so those fields are stored as 0.

const REQUEST_TIMEOUT_MS = 15000;
const PING_INTERVAL_MS = 30000; // Deriv drops connections idle for ~2 minutes
const FAST_POLL_MS = 5000;
const SLOW_POLL_MS = 60000;
const TICK_MS = 1000;
const MAX_COUNT = 5000; // Deriv's per-request candle ceiling

// App interval -> Deriv granularity (seconds). Anything unlisted (1s, 6h, 12h,
// 3d, 1w, 1M) has no Deriv equivalent and is simply not chartable for forex.
const GRANULARITY_SEC = {
  '1m': 60,
  '3m': 180,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '2h': 7200,
  '4h': 14400,
  '8h': 28800,
  '1d': 86400,
};

// --- Socket plumbing ---------------------------------------------------------
//
// One lazy connection shared by history fetches and the live poll. Requests
// are correlated by req_id; a dropped socket fails everything in flight and
// the next request reconnects, so the pollers double as the retry loop.

let ws = null;
let wsReady = false;
let connectPromise = null;
let pingTimer = null;
let nextReqId = 1;
const pending = new Map(); // req_id -> { resolve, reject, timer }

function failAllPending(err) {
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(err);
  }
  pending.clear();
}

function ensureSocket() {
  if (wsReady && ws?.readyState === WebSocket.OPEN) return Promise.resolve();
  if (connectPromise) return connectPromise;

  connectPromise = new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${config.derivAppId}`);
    let opened = false;
    ws = socket;
    wsReady = false;

    socket.on('open', () => {
      opened = true;
      wsReady = true;
      console.log('[deriv] WS connected');
      // Keepalive; the reply carries no req_id and is dropped by handleMessage.
      pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ ping: 1 }));
      }, PING_INTERVAL_MS);
      pingTimer.unref?.();
      resolve();
    });

    socket.on('message', handleMessage);

    socket.on('error', (err) => {
      console.error('[deriv] WS error', err.message);
      // 'close' follows and does the cleanup.
    });

    socket.on('close', () => {
      wsReady = false;
      clearInterval(pingTimer);
      if (ws === socket) ws = null;
      failAllPending(new Error('Deriv WS closed'));
      if (!opened) reject(new Error('Deriv WS failed to connect'));
      else console.log('[deriv] WS closed');
    });
  }).finally(() => {
    connectPromise = null;
  });

  return connectPromise;
}

function handleMessage(data) {
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }
  const entry = pending.get(msg.req_id);
  if (!entry) return; // pong, or a late reply whose request already timed out
  pending.delete(msg.req_id);
  clearTimeout(entry.timer);
  if (msg.error) entry.reject(new Error(`Deriv ${msg.error.code}: ${msg.error.message}`));
  else entry.resolve(msg);
}

function request(payload) {
  return ensureSocket().then(
    () =>
      new Promise((resolve, reject) => {
        const reqId = nextReqId++;
        const timer = setTimeout(() => {
          pending.delete(reqId);
          reject(new Error('Deriv request timed out'));
        }, REQUEST_TIMEOUT_MS);
        pending.set(reqId, { resolve, reject, timer });
        ws.send(JSON.stringify({ ...payload, req_id: reqId }));
      })
  );
}

// --- History fetch -----------------------------------------------------------

// Same contract as Binance's fetchKlines but returns candles already in the
// Mongo doc shape (ascending openTime): `endTime` returns the newest `limit`
// candles at or before that instant, no endTime means "up to now" — which is
// exactly what historyEnsurer's backward walk and cold seed expect.
export async function fetchForexKlines({ symbol, interval, startTime, endTime, limit = 1000 }) {
  const inst = getForexInstrument(symbol);
  const granularity = GRANULARITY_SEC[interval];
  if (!inst || !granularity) return [];

  const req = {
    ticks_history: inst.derivSymbol,
    style: 'candles',
    granularity,
    count: Math.min(Math.max(Math.trunc(limit), 1), MAX_COUNT),
    end: endTime ? Math.floor(endTime / 1000) : 'latest',
  };
  if (startTime) req.start = Math.floor(startTime / 1000);

  const msg = await request(req);
  const raw = Array.isArray(msg.candles) ? msg.candles : [];
  const intervalMs = granularity * 1000;
  const now = Date.now();
  // Deriv clips the first candle of a window to the window edge, giving it a
  // partial bucket with an unaligned epoch (e.g. 09:39:28 in 5m data). Stored,
  // that becomes a duplicate bar inside a real bucket, so unaligned candles
  // are dropped — every genuine bucket at these granularities is UTC-aligned.
  return raw.filter((c) => (c.epoch * 1000) % intervalMs === 0).map((c) => {
    const openTime = c.epoch * 1000;
    const closeTime = openTime + intervalMs - 1;
    return {
      symbol: inst.symbol,
      interval,
      openTime,
      closeTime,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: 0,
      quoteVolume: 0,
      numTrades: 0,
      takerBuyBaseVol: 0,
      takerBuyQuoteVol: 0,
      isClosed: closeTime < now,
    };
  });
}

// --- Live poll ---------------------------------------------------------------

// key -> { symbol, interval, viewers, pinned, nextPollAt, inFlight }. Pinned
// combos are never removed; viewer refs only decide the poll cadence.
const registry = new Map();

function comboKey({ symbol, interval }) {
  return `${symbol}:${interval}`;
}

function normalizeCombo(symbol, interval) {
  const sym = typeof symbol === 'string' ? symbol.toUpperCase() : '';
  if (!getForexInstrument(sym)) return null;
  if (!config.binanceIntervals.includes(interval) || !GRANULARITY_SEC[interval]) return null;
  return { symbol: sym, interval };
}

// Mirror of the Binance ingestor's acquire/release contract so the socket
// server can route subscriptions here without caring about the provider.
export function acquireForexCombo(combo) {
  const norm = normalizeCombo(combo?.symbol, combo?.interval);
  if (!norm) return false;
  const key = comboKey(norm);
  const existing = registry.get(key);
  if (existing) {
    existing.viewers += 1;
    existing.nextPollAt = 0; // a fresh viewer gets a current candle immediately
    return true;
  }
  registry.set(key, { ...norm, viewers: 1, pinned: false, nextPollAt: 0, inFlight: false });
  return true;
}

export function releaseForexCombo(combo) {
  const norm = normalizeCombo(combo?.symbol, combo?.interval);
  if (!norm) return;
  const key = comboKey(norm);
  const entry = registry.get(key);
  if (!entry) return;
  entry.viewers = Math.max(0, entry.viewers - 1);
  if (!entry.pinned && entry.viewers === 0) registry.delete(key);
}

export function getForexStats() {
  return {
    connected: wsReady,
    combos: [...registry.values()]
      .map((e) => ({ symbol: e.symbol, interval: e.interval, viewers: e.viewers, pinned: e.pinned }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.interval.localeCompare(b.interval)),
  };
}

async function pollCombo(entry) {
  // Two candles so the just-closed bar's final state is always re-sent along
  // with the in-progress one — the last poll of a closing bar can be up to a
  // poll interval before its actual close.
  const candles = await fetchForexKlines({ symbol: entry.symbol, interval: entry.interval, limit: 2 });
  if (!candles.length) return;
  await bulkUpsertCandles(candles);
  for (const candle of candles) {
    broadcastCandleUpdate(candle.symbol, candle.interval, toWireShape(candle));
  }
}

function pollTick() {
  const now = Date.now();
  for (const entry of registry.values()) {
    if (entry.inFlight || now < entry.nextPollAt) continue;
    entry.inFlight = true;
    entry.nextPollAt = now + (entry.viewers > 0 ? FAST_POLL_MS : SLOW_POLL_MS);
    pollCombo(entry)
      .catch((err) => console.error(`[deriv] poll failed for ${entry.symbol} ${entry.interval}`, err.message))
      .finally(() => {
        entry.inFlight = false;
      });
  }
}

export async function startForexFeed({ combos, backfillLimit }) {
  for (const combo of combos) {
    const norm = normalizeCombo(combo?.symbol, combo?.interval);
    if (!norm) {
      console.warn(`[deriv] skipping unsupported forex combo ${combo?.symbol} ${combo?.interval}`);
      continue;
    }
    registry.set(comboKey(norm), { ...norm, viewers: 0, pinned: true, nextPollAt: 0, inFlight: false });
  }

  if (registry.size) {
    console.log(`[deriv] backfilling ${registry.size} forex combos...`);
    for (const entry of registry.values()) {
      try {
        // Resume from the newest stored candle when there is one (gap recovery
        // after a restart, capped at Deriv's 5000/request — older interior gaps
        // are left to /history/ensure); otherwise seed the most recent page.
        const latest = await getLatestOpenTime({ symbol: entry.symbol, interval: entry.interval });
        const candles = latest
          ? await fetchForexKlines({ symbol: entry.symbol, interval: entry.interval, startTime: latest, limit: MAX_COUNT })
          : await fetchForexKlines({ symbol: entry.symbol, interval: entry.interval, limit: backfillLimit });
        if (candles.length) await bulkUpsertCandles(candles);
        console.log(`[deriv] backfill for ${entry.symbol} ${entry.interval}: upserted ${candles.length} candles`);
      } catch (err) {
        console.error(`[deriv] backfill FAILED for ${entry.symbol} ${entry.interval}`, err.message);
      }
    }
    console.log('[deriv] initial backfill pass complete');
  }

  // The ticker runs even with nothing pinned: on-demand forex combos acquired
  // by browser subscriptions still need polling.
  const timer = setInterval(pollTick, TICK_MS);
  timer.unref?.();
}
