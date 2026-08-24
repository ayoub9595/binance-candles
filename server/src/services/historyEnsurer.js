import { fetchCandlePage } from './candleSource.js';
import { isTradableSymbol } from './spotCatalog.js';
import { pace } from './upstreamPacer.js';
import { bulkUpsertCandles, getOldestOpenTime, getLatestOpenTime } from '../models/candleRepository.js';

// The startup backfill only keeps the most recent BACKFILL_LIMIT candles, so
// replaying an older day needs the missing history pulled from Binance on
// demand. ensureHistory() walks backward from the oldest stored candle in
// 1000-candle pages until `fromMs` is covered, upserting as it goes — fully
// idempotent, so once a range has been walked, later calls return instantly.

// Hard cap on pages per call: at 1000 candles/page this is ~6.8 years of 15m
// or ~2.3 years of 5m — a runaway-request backstop, not a practical limit.
const MAX_PAGES = 240;

// Pacing is shared with the gap healer via upstreamPacer.js — both page against
// the same Binance weight budget, so they must draw from one slot clock.

// Both providers speak the same BACKWARD paging dialect — `endTime` with no
// start returns the newest `limit` candles at or before that instant — which is
// exactly what the walk below and the cold seed need. services/candleSource.js
// owns that seam (the gap healer's forward paging shares it).

async function walkBack({ symbol, interval, fromMs }) {
  // Nothing stored at all (combo added but ingestor not caught up yet):
  // walk back from "now" instead of failing.
  let oldest = (await getOldestOpenTime({ symbol, interval })) ?? Date.now();
  let pages = 0;

  while (oldest > fromMs && pages < MAX_PAGES) {
    await pace();
    // One page further into the past.
    const candles = await fetchCandlePage({ symbol, interval, endTime: oldest - 1, limit: 1000 });
    if (candles.length === 0) break; // ran out of history (before the symbol listed)
    await bulkUpsertCandles(candles);
    const pageOldest = candles[0].openTime;
    if (pageOldest >= oldest) break; // no progress — bail rather than spin
    oldest = pageOldest;
    pages += 1;
  }

  if (pages > 0) {
    console.log(
      `[history] ${symbol} ${interval}: backfilled ${pages} page(s), oldest now ${new Date(oldest).toISOString()}`
    );
  }
  return oldest;
}

// Concurrent ensures for the same combo (e.g. the replay's main interval plus
// the same interval as a trendline) chain instead of racing: the second call
// re-checks oldest after the first finishes and usually returns immediately.
const inFlight = new Map();

export function ensureHistory({ symbol, interval, fromMs }) {
  const key = `${symbol}:${interval}`;
  const tail = inFlight.get(key) ?? Promise.resolve();
  const run = tail.catch(() => {}).then(() => walkBack({ symbol, interval, fromMs }));
  inFlight.set(key, run);
  run.finally(() => {
    if (inFlight.get(key) === run) inFlight.delete(key);
  });
  return run;
}

// --- Cold combos -----------------------------------------------------------
//
// Only the configured symbols are backfilled at boot, so a pair the user
// searched for has NOTHING stored for any interval. Several read paths ask for
// candles without a preceding /history/ensure — trendline overlays and the live
// HTF bias among them — and would otherwise render empty for on-demand pairs.
// So a read that finds a genuinely empty combo seeds it once, inline, and
// retries; every later read hits stored data and this never runs again.
//
// "Genuinely empty" is checked against the whole combo rather than the current
// query, so an ordinary query that legitimately returns nothing (a date before
// the pair listed, a forward page past the end) cannot trigger a fetch on every
// call.
const seeded = new Set();
const seeding = new Map();

const SEED_LIMIT = 1000;

async function seed({ symbol, interval }) {
  await pace();
  // No endTime: both providers return the most recent SEED_LIMIT candles.
  const candles = await fetchCandlePage({ symbol, interval, limit: SEED_LIMIT });
  if (candles.length === 0) return 0;
  await bulkUpsertCandles(candles);
  console.log(`[history] seeded cold combo ${symbol} ${interval}: ${candles.length} candles`);
  return candles.length;
}

// Returns true when candles were written, i.e. the caller should re-run its
// query. Never throws — a cold pair that Binance rejects just stays empty.
export async function ensureSeeded({ symbol, interval }) {
  const key = `${symbol}:${interval}`;
  if (seeded.has(key)) return false;
  if (!isTradableSymbol(symbol)) return false;

  const existing = seeding.get(key);
  if (existing) return existing;

  const run = (async () => {
    // Re-check under the dedupe: a concurrent request may have seeded it, and
    // the boot backfill covers the configured pairs already.
    if (await getLatestOpenTime({ symbol, interval })) {
      seeded.add(key);
      return false;
    }
    try {
      const count = await seed({ symbol, interval });
      // Mark seeded either way: an empty response means Binance has no klines
      // for this combo, and retrying that on every read is pure waste.
      seeded.add(key);
      return count > 0;
    } catch (err) {
      console.error(`[history] cold seed FAILED for ${key}`, err.message);
      return false; // not marked seeded — a transient failure may retry
    }
  })();

  seeding.set(key, run);
  run.finally(() => {
    if (seeding.get(key) === run) seeding.delete(key);
  });
  return run;
}
