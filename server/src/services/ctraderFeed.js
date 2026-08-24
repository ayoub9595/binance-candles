import WebSocket from 'ws';
import { config } from '../config.js';
import { getForexInstrument } from './forexInstruments.js';
import { toWireShape } from '../utils/normalizeCandle.js';
import { bulkUpsertCandles, getLatestOpenTime } from '../models/candleRepository.js';
import { broadcastCandleUpdate } from '../sockets/socketServer.js';
import { intervalMs } from '../utils/intervals.js';

// Broker-real forex candles over the cTrader Open API (Spotware), JSON flavour
// on port 5036 — the same instrument feed the Fusion Markets cTrader charts
// draw from, so what this app stores matches what that platform shows. Same
// contract as derivFeed.js: candles land in the same Mongo collection and
// socket rooms as Binance ones, the read paths and the client can't tell the
// difference, and the live candle is POLLED (GetTrendbars, limit 2) on the
// same fast/slow cadence rather than streamed — one mechanism for both forex
// providers, and no spot-subscription bookkeeping. Needs credentials: an app
// registered at openapi.ctrader.com plus an access token authorized against
// the broker account (see .env.example).
//
// Volume is tick volume (quote updates per bar), the only volume forex has;
// the quote/taker fields stay 0 like Deriv's.

const REQUEST_TIMEOUT_MS = 15000;
const HEARTBEAT_INTERVAL_MS = 10000; // Spotware drops sockets idle >~30s
const FAST_POLL_MS = 5000;
const SLOW_POLL_MS = 60000;
const TICK_MS = 1000;
const MAX_COUNT = 5000;
const PRICE_SCALE = 100000; // trendbar prices are ints in 1/100000 units

const HOSTS = {
  demo: 'wss://demo.ctraderapi.com:5036',
  live: 'wss://live.ctraderapi.com:5036',
};

// Open API payload type numbers (OpenApiMessages.proto).
const PT = {
  ERROR: 50,
  HEARTBEAT: 51,
  APPLICATION_AUTH_REQ: 2100,
  ACCOUNT_AUTH_REQ: 2102,
  SYMBOLS_LIST_REQ: 2114,
  GET_TRENDBARS_REQ: 2137,
  ERROR_RES: 2142,
  GET_ACCOUNTS_BY_TOKEN_REQ: 2149,
  REFRESH_TOKEN_REQ: 2173,
};

// App interval -> ProtoOATrendbarPeriod, plus the documented ceiling on
// (toTimestamp - fromTimestamp) for that period band. Anything unlisted (1s,
// 2h, 6h, 8h; 1w/1M are also out — intervalMs can't step them) is simply not
// chartable through this provider. The caps are conservative: a larger real
// allowance only means more pages, never lost bars.
const PERIODS = {
  '1m': { id: 1, maxRangeMs: 302_400_000 },
  '3m': { id: 3, maxRangeMs: 302_400_000 },
  '5m': { id: 5, maxRangeMs: 302_400_000 },
  '15m': { id: 7, maxRangeMs: 21_168_000_000 },
  '30m': { id: 8, maxRangeMs: 21_168_000_000 },
  '1h': { id: 9, maxRangeMs: 21_168_000_000 },
  '4h': { id: 10, maxRangeMs: 31_622_400_000 },
  '12h': { id: 11, maxRangeMs: 31_622_400_000 },
  '1d': { id: 12, maxRangeMs: 31_622_400_000 },
};

// --- Socket + session plumbing -------------------------------------------------
//
// One lazy connection shared by history fetches and the live poll, like the
// Deriv socket — but with a handshake: the connect promise resolves only after
// app auth, account auth and the symbol-id lookup have all succeeded, so every
// caller of ensureReady() can fire requests immediately. A dropped socket
// fails everything in flight and the next request redoes the whole handshake.

let ws = null;
let ready = false; // socket open AND handshake complete
let connectPromise = null;
let heartbeatTimer = null;
let nextMsgId = 1;
const pending = new Map(); // clientMsgId -> { resolve, reject, timer }

// Session facts learned during the handshake. The token is mutable: a refresh
// mid-session replaces it in memory (the .env still needs updating by hand).
let accessToken = null;
let accountId = null;
const symbolIds = new Map(); // 'XAUUSD' -> broker's numeric symbolId

function failAllPending(err) {
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(err);
  }
  pending.clear();
}

// Correlated send on the current socket. Used raw during the handshake (before
// `ready` flips) and by request() afterwards.
function sendRaw(socket, payloadType, payload) {
  return new Promise((resolve, reject) => {
    const clientMsgId = String(nextMsgId++);
    const timer = setTimeout(() => {
      pending.delete(clientMsgId);
      reject(new Error('cTrader request timed out'));
    }, REQUEST_TIMEOUT_MS);
    pending.set(clientMsgId, { resolve, reject, timer });
    socket.send(JSON.stringify({ clientMsgId, payloadType, payload }));
  });
}

function handleMessage(data) {
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }
  if (msg.payloadType === PT.HEARTBEAT) return; // server keepalive, no reply needed
  const entry = pending.get(msg.clientMsgId);
  if (!entry) return; // unsolicited event, or a late reply that already timed out
  pending.delete(msg.clientMsgId);
  clearTimeout(entry.timer);
  if (msg.payloadType === PT.ERROR_RES || msg.payloadType === PT.ERROR) {
    const p = msg.payload ?? {};
    entry.reject(new Error(`cTrader ${p.errorCode ?? 'ERROR'}: ${p.description ?? 'request failed'}`));
  } else {
    entry.resolve(msg.payload ?? {});
  }
}

// Account auth with one refresh-and-retry: access tokens expire (~monthly);
// with a refresh token configured the session heals itself. The new token
// lives only in memory — it is logged so CTRADER_ACCESS_TOKEN can be updated
// before the next restart.
async function authorizeAccount(socket) {
  const auth = () => sendRaw(socket, PT.ACCOUNT_AUTH_REQ, { ctidTraderAccountId: accountId, accessToken });
  try {
    await auth();
  } catch (err) {
    if (!config.ctrader.refreshToken || !/TOKEN/i.test(err.message)) throw err;
    console.warn('[ctrader] account auth rejected the access token — trying the refresh token');
    const res = await sendRaw(socket, PT.REFRESH_TOKEN_REQ, { refreshToken: config.ctrader.refreshToken });
    if (!res.accessToken) throw new Error('cTrader token refresh returned no accessToken');
    accessToken = res.accessToken;
    console.warn(`[ctrader] access token refreshed — set CTRADER_ACCESS_TOKEN=${res.accessToken} in .env to survive restarts`);
    await auth();
  }
}

async function handshake(socket) {
  await sendRaw(socket, PT.APPLICATION_AUTH_REQ, {
    clientId: config.ctrader.clientId,
    clientSecret: config.ctrader.clientSecret,
  });

  // int64 fields arrive as strings in the JSON flavour — Number() everything.
  if (!accountId) {
    if (config.ctrader.accountId) {
      accountId = config.ctrader.accountId;
    } else {
      const res = await sendRaw(socket, PT.GET_ACCOUNTS_BY_TOKEN_REQ, { accessToken });
      const accounts = res.ctidTraderAccount ?? [];
      const wantLive = config.ctrader.hostType === 'live';
      const match = accounts.find((a) => Boolean(a.isLive) === wantLive) ?? accounts[0];
      if (!match) throw new Error('access token has no cTrader trading accounts — authorize it against your Fusion Markets account');
      accountId = Number(match.ctidTraderAccountId);
      console.log(`[ctrader] using account ${accountId}${match.isLive ? ' (live)' : ' (demo)'} — pin it with CTRADER_ACCOUNT_ID to skip discovery`);
    }
  }

  await authorizeAccount(socket);

  const res = await sendRaw(socket, PT.SYMBOLS_LIST_REQ, {
    ctidTraderAccountId: accountId,
    includeArchivedSymbols: false,
  });
  symbolIds.clear();
  for (const s of res.symbol ?? []) {
    if (s.symbolName) symbolIds.set(String(s.symbolName).toUpperCase(), Number(s.symbolId));
  }
  if (!symbolIds.size) throw new Error('cTrader symbols list came back empty');
}

function ensureReady() {
  if (ready && ws?.readyState === WebSocket.OPEN) return Promise.resolve();
  if (connectPromise) return connectPromise;

  connectPromise = new Promise((resolve, reject) => {
    if (accessToken === null) accessToken = config.ctrader.accessToken;
    const socket = new WebSocket(HOSTS[config.ctrader.hostType]);
    let settled = false;
    ws = socket;
    ready = false;

    socket.on('open', () => {
      heartbeatTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ payloadType: PT.HEARTBEAT, payload: {} }));
        }
      }, HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref?.();
      handshake(socket).then(
        () => {
          settled = true;
          ready = true;
          console.log('[ctrader] WS connected and authorized');
          resolve();
        },
        (err) => {
          settled = true;
          console.error('[ctrader] handshake failed:', err.message);
          socket.close();
          reject(err);
        }
      );
    });

    socket.on('message', handleMessage);

    socket.on('error', (err) => {
      console.error('[ctrader] WS error', err.message);
      // 'close' follows and does the cleanup.
    });

    socket.on('close', () => {
      ready = false;
      clearInterval(heartbeatTimer);
      if (ws === socket) ws = null;
      failAllPending(new Error('cTrader WS closed'));
      if (!settled) reject(new Error('cTrader WS failed to connect'));
      else console.log('[ctrader] WS closed');
    });
  }).finally(() => {
    connectPromise = null;
  });

  return connectPromise;
}

function request(payloadType, payload) {
  return ensureReady().then(() => sendRaw(ws, payloadType, payload));
}

// --- History fetch -------------------------------------------------------------

function toCandles(trendbars, symbol, interval, step) {
  const now = Date.now();
  const out = [];
  for (const b of trendbars ?? []) {
    if (b.utcTimestampInMinutes == null || b.low == null) continue;
    const openTime = Number(b.utcTimestampInMinutes) * 60000;
    if (openTime % step !== 0) continue; // defensive: mirror of the Deriv alignment filter
    const low = Number(b.low);
    const closeTime = openTime + step - 1;
    out.push({
      symbol,
      interval,
      openTime,
      closeTime,
      open: (low + Number(b.deltaOpen ?? 0)) / PRICE_SCALE,
      high: (low + Number(b.deltaHigh ?? 0)) / PRICE_SCALE,
      // The forming bar can lack deltaClose; its open is the best stand-in
      // until the next poll updates it.
      close: (low + Number(b.deltaClose ?? b.deltaOpen ?? 0)) / PRICE_SCALE,
      low: low / PRICE_SCALE,
      volume: Number(b.volume ?? 0),
      quoteVolume: 0,
      numTrades: 0,
      takerBuyBaseVol: 0,
      takerBuyQuoteVol: 0,
      isClosed: closeTime < now,
    });
  }
  out.sort((a, b) => a.openTime - b.openTime);
  return out;
}

// Same contract as fetchForexKlines (Deriv): Mongo-shaped candles ascending by
// openTime; `endTime` means "the newest `limit` candles at or before that
// instant", no endTime means up to now, `startTime` walks forward from there.
// GetTrendbars is windowed (from/to both required, `count` semantics are
// underdocumented), so the backward mode asks for a window sized to `limit`
// bars and WIDENS it when a page comes back empty — a weekend or holiday can
// swallow a whole first guess, and stopping there would read as "no data" to
// the backward history walk.
export async function fetchCtraderKlines({ symbol, interval, startTime, endTime, limit = 1000 }) {
  const inst = getForexInstrument(symbol);
  const period = PERIODS[interval];
  const step = intervalMs(interval);
  if (!inst?.ctraderSymbol || !period || !step) return [];

  await ensureReady();
  const symbolId = symbolIds.get(inst.ctraderSymbol.toUpperCase());
  if (!symbolId) {
    console.warn(`[ctrader] broker lists no symbol named ${inst.ctraderSymbol}`);
    return [];
  }

  const cap = Math.min(Math.max(Math.trunc(limit), 1), MAX_COUNT);
  const page = (from, to) =>
    request(PT.GET_TRENDBARS_REQ, {
      ctidTraderAccountId: accountId,
      symbolId,
      period: period.id,
      fromTimestamp: Math.max(0, Math.floor(from)),
      toTimestamp: Math.floor(to),
      count: cap,
    }).then((res) => toCandles(res.trendbar, inst.symbol, interval, step));

  if (startTime) {
    const to = Math.min(endTime ?? Date.now(), startTime + period.maxRangeMs);
    if (to <= startTime) return [];
    return (await page(startTime, to)).slice(0, cap);
  }

  const to = endTime ?? Date.now();
  let windowMs = Math.min(cap * step, period.maxRangeMs);
  for (;;) {
    const candles = await page(to - windowMs, to);
    if (candles.length) return candles.slice(-cap);
    if (windowMs >= period.maxRangeMs) return []; // nothing within the API's reach
    windowMs = Math.min(windowMs * 5, period.maxRangeMs);
  }
}

// --- Live poll -------------------------------------------------------------------
//
// Identical registry/cadence machinery to derivFeed's: pinned combos are never
// removed, viewer refs only decide fast vs slow polling.

const registry = new Map(); // key -> { symbol, interval, viewers, pinned, nextPollAt, inFlight }

function comboKey({ symbol, interval }) {
  return `${symbol}:${interval}`;
}

function normalizeCombo(symbol, interval) {
  const sym = typeof symbol === 'string' ? symbol.toUpperCase() : '';
  if (!getForexInstrument(sym)?.ctraderSymbol) return null;
  if (!config.binanceIntervals.includes(interval) || !PERIODS[interval] || !intervalMs(interval)) return null;
  return { symbol: sym, interval };
}

export function acquireCtraderCombo(combo) {
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

export function releaseCtraderCombo(combo) {
  const norm = normalizeCombo(combo?.symbol, combo?.interval);
  if (!norm) return;
  const key = comboKey(norm);
  const entry = registry.get(key);
  if (!entry) return;
  entry.viewers = Math.max(0, entry.viewers - 1);
  if (!entry.pinned && entry.viewers === 0) registry.delete(key);
}

export function getCtraderStats() {
  return {
    provider: 'ctrader',
    connected: ready,
    combos: [...registry.values()]
      .map((e) => ({ symbol: e.symbol, interval: e.interval, viewers: e.viewers, pinned: e.pinned }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.interval.localeCompare(b.interval)),
  };
}

async function pollCombo(entry) {
  // Two candles so the just-closed bar's final state is always re-sent along
  // with the in-progress one.
  const candles = await fetchCtraderKlines({ symbol: entry.symbol, interval: entry.interval, limit: 2 });
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
      .catch((err) => console.error(`[ctrader] poll failed for ${entry.symbol} ${entry.interval}`, err.message))
      .finally(() => {
        entry.inFlight = false;
      });
  }
}

export async function startCtraderFeed({ combos, backfillLimit }) {
  for (const combo of combos) {
    const norm = normalizeCombo(combo?.symbol, combo?.interval);
    if (!norm) {
      console.warn(`[ctrader] skipping unsupported forex combo ${combo?.symbol} ${combo?.interval}`);
      continue;
    }
    registry.set(comboKey(norm), { ...norm, viewers: 0, pinned: true, nextPollAt: 0, inFlight: false });
  }

  if (registry.size) {
    console.log(`[ctrader] backfilling ${registry.size} forex combos...`);
    for (const entry of registry.values()) {
      try {
        // Resume from the newest stored candle when there is one; otherwise
        // seed the most recent page. Older interior gaps are /history/ensure's
        // job, exactly as with Deriv.
        const latest = await getLatestOpenTime({ symbol: entry.symbol, interval: entry.interval });
        const candles = latest
          ? await fetchCtraderKlines({ symbol: entry.symbol, interval: entry.interval, startTime: latest, limit: MAX_COUNT })
          : await fetchCtraderKlines({ symbol: entry.symbol, interval: entry.interval, limit: backfillLimit });
        if (candles.length) await bulkUpsertCandles(candles);
        console.log(`[ctrader] backfill for ${entry.symbol} ${entry.interval}: upserted ${candles.length} candles`);
      } catch (err) {
        console.error(`[ctrader] backfill FAILED for ${entry.symbol} ${entry.interval}`, err.message);
      }
    }
    console.log('[ctrader] initial backfill pass complete');
  }

  const timer = setInterval(pollTick, TICK_MS);
  timer.unref?.();
}
