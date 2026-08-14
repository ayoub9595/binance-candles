import { fetchKlines } from './binanceRest.js';
import { fromRestKline } from '../utils/normalizeCandle.js';
import { bulkUpsertCandles, getOldestOpenTime } from '../models/candleRepository.js';

// The startup backfill only keeps the most recent BACKFILL_LIMIT candles, so
// replaying an older day needs the missing history pulled from Binance on
// demand. ensureHistory() walks backward from the oldest stored candle in
// 1000-candle pages until `fromMs` is covered, upserting as it goes — fully
// idempotent, so once a range has been walked, later calls return instantly.

// Hard cap on pages per call: at 1000 candles/page this is ~6.8 years of 15m
// or ~2.3 years of 5m — a runaway-request backstop, not a practical limit.
const MAX_PAGES = 240;

// Global pacing across all concurrent walks. Klines at limit=1000 cost 5
// weight; one page per 300ms keeps worst-case usage near 1000 weight/min,
// under Binance's 1200/min budget even with the live ingestor running.
const PAGE_GAP_MS = 300;
let nextSlotAt = 0;

function pace() {
  const now = Date.now();
  const at = Math.max(now, nextSlotAt);
  nextSlotAt = at + PAGE_GAP_MS;
  return at > now ? new Promise((resolve) => setTimeout(resolve, at - now)) : Promise.resolve();
}

async function walkBack({ symbol, interval, fromMs }) {
  // Nothing stored at all (combo added but ingestor not caught up yet):
  // walk back from "now" instead of failing.
  let oldest = (await getOldestOpenTime({ symbol, interval })) ?? Date.now();
  let pages = 0;

  while (oldest > fromMs && pages < MAX_PAGES) {
    await pace();
    // endTime with no startTime returns the newest `limit` candles at or
    // before that instant — exactly one page further into the past.
    const raw = await fetchKlines({ symbol, interval, endTime: oldest - 1, limit: 1000 });
    if (raw.length === 0) break; // ran out of history (before the symbol listed)
    const candles = raw.map((k) => fromRestKline(k, symbol, interval));
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
