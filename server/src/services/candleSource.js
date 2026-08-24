import { fetchKlines } from './binanceRest.js';
import { fetchForexKlines } from './forexProvider.js';
import { isForexSymbol } from './forexInstruments.js';
import { fromRestKline } from '../utils/normalizeCandle.js';
import { intervalMs } from '../utils/intervals.js';

// The one seam between "which provider serves this symbol" and every caller
// that pages candles (the backward history walk, the gap healer, the cold
// seed). Both providers return candle docs in Mongo shape, ascending by
// openTime, so callers only pick a window — never a provider.

// Both providers page BACKWARD identically: `endTime` with no start returns the
// newest `limit` candles at or before that instant.
export async function fetchCandlePage({ symbol, interval, startTime, endTime, limit = 1000 }) {
  if (isForexSymbol(symbol)) {
    return fetchForexKlines({ symbol, interval, startTime, endTime, limit });
  }
  const raw = await fetchKlines({ symbol, interval, startTime, endTime, limit });
  return raw.map((k) => fromRestKline(k, symbol, interval));
}

// Filling a KNOWN window is where the two providers diverge, so it gets its own
// seam — and each is paged in the only direction it answers reliably.
//
// Binance takes `startTime` and returns the OLDEST `limit` bars from there, so
// its window is walked left to right.
//
// Deriv has no forward mode at all: ticks_history always returns bars ENDING at
// `end`, and `count` binds before `start` does. Walking its right edge forward
// looks like it works and quietly loses data — a page that comes back short
// (which Deriv does freely, since a span containing a market close yields far
// fewer bars than `count`) still ends at the window's right edge, so the cursor
// is past `toMs` while the HEAD of the window was never covered. So Deriv's
// window is walked right to left instead, shrinking `toMs` to just before the
// oldest bar each page returned. That direction is monotonic by construction.
//
// Returns { candles, nextFrom, nextTo, done } — the window still to fill, and
// whether there is any point asking again.
export async function fetchWindowPage({ symbol, interval, fromMs, toMs, limit = 1000 }) {
  const step = intervalMs(interval);

  if (!isForexSymbol(symbol)) {
    const candles = await fetchCandlePage({ symbol, interval, startTime: fromMs, endTime: toMs, limit });
    if (candles.length === 0) return { candles, nextFrom: fromMs, nextTo: toMs, done: true };
    const nextFrom = candles[candles.length - 1].openTime + step;
    // Binance honours `limit` exactly, so a short page means the window ran out.
    return { candles, nextFrom, nextTo: toMs, done: candles.length < limit || nextFrom > toMs };
  }

  // Never ask for more bars than the window can hold: Deriv returns `count`
  // bars ending at `toMs`, so an oversized count on a small hole drags in a
  // long tail from before it — harmless (upserts are idempotent) but wasted.
  const span = step ? Math.floor((toMs - fromMs) / step) + 1 : limit;
  const count = Math.max(1, Math.min(limit, span));

  const candles = await fetchCandlePage({ symbol, interval, endTime: toMs, limit: count });
  if (candles.length === 0) return { candles, nextFrom: fromMs, nextTo: toMs, done: true };

  const oldest = candles[0].openTime;
  // A page reaching at or past the window's left edge finished it. One that
  // starts before the window never had bars inside it either — the hole is a
  // market closure, not lost data.
  const nextTo = oldest - (step ?? 0);
  return { candles, nextFrom: fromMs, nextTo, done: oldest <= fromMs || nextTo < fromMs };
}
