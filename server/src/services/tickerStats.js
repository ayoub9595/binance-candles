// 24-hour rolling stats for the whole spot market, behind a short cache — the
// source for the "top movers" bar.
//
// /api/v3/ticker/24hr with no symbol returns every ticker (~3700 rows) for a
// flat weight of 80, which is far cheaper than asking per symbol. It is fetched
// lazily and cached, so a client polling the movers bar costs one upstream
// request per TTL no matter how many browsers are watching, and nothing at all
// while nobody is.
//
// Movers are filtered through the spot catalog, so every row the bar shows is a
// pair the chart can actually open — clicking a mover must never land on a
// symbol that cannot load.

import { ensureCatalog, getSymbolInfo } from './spotCatalog.js';

const TICKER_URL = 'https://api.binance.com/api/v3/ticker/24hr';

// 30s: the bar reports a rolling 24h window, so second-level freshness is
// meaningless, and this keeps the endpoint at ~160 weight/min worst case.
const TTL_MS = 30_000;

// Raw top-gainer lists are dominated by illiquid microcaps — a pair doing $300k
// a day can print +65% on noise and would crowd out every real move. The floor
// is expressed in the QUOTE asset (so $1M for USDT pairs) and is a query
// parameter, not a constant, because "liquid enough" depends on the quote.
export const DEFAULT_MIN_QUOTE_VOLUME = 1_000_000;

let cache = null; // { rows, fetchedAt }
let inFlight = null;

async function fetchTickers() {
  const res = await fetch(TICKER_URL);
  if (!res.ok) {
    throw new Error(`ticker/24hr request failed: ${res.status} ${await res.text()}`);
  }
  const raw = await res.json();
  if (!Array.isArray(raw)) throw new Error('ticker/24hr returned an unexpected shape');

  // Keep only rows the catalog recognises as tradable spot pairs, pre-parsed to
  // numbers — the endpoint returns every field as a string, and re-parsing per
  // request would make each call scan 3700 rows twice.
  const rows = [];
  for (const t of raw) {
    const info = getSymbolInfo(t.symbol);
    if (!info) continue;
    const changePercent = Number(t.priceChangePercent);
    const lastPrice = Number(t.lastPrice);
    const quoteVolume = Number(t.quoteVolume);
    if (!Number.isFinite(changePercent) || !Number.isFinite(quoteVolume)) continue;
    rows.push({
      symbol: info.symbol,
      baseAsset: info.baseAsset,
      quoteAsset: info.quoteAsset,
      changePercent,
      lastPrice,
      quoteVolume,
    });
  }
  return rows;
}

// Concurrent callers share one upstream request. A stale cache is preferred to
// an error when the refresh fails: the bar showing 40-second-old numbers beats
// the bar going blank.
async function getRows() {
  await ensureCatalog();
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const rows = await fetchTickers();
      cache = { rows, fetchedAt: Date.now() };
      return cache;
    } catch (err) {
      if (cache) {
        console.warn('[ticker] refresh failed, serving cached rows:', err.message);
        return cache;
      }
      throw err;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

// Top gainers and losers for one quote asset.
// Returns { gainers, losers, fetchedAt, pool } — `pool` is how many pairs
// cleared the volume floor, which is what tells a caller "the list is short
// because the market is quiet" apart from "the floor is too high".
export async function getMovers({ quote = 'USDT', limit = 10, minQuoteVolume = DEFAULT_MIN_QUOTE_VOLUME } = {}) {
  const { rows, fetchedAt } = await getRows();
  const q = String(quote).toUpperCase();

  const pool = rows.filter((r) => r.quoteAsset === q && r.quoteVolume >= minQuoteVolume);
  // One sort, read from both ends — the losers list is the gainers list
  // reversed, so sorting twice would be pure waste.
  const byChange = [...pool].sort((a, b) => b.changePercent - a.changePercent);

  // A pool smaller than 2*limit would have the two ends overlap and show the
  // same coin as both a top gainer and a top loser, which reads as a bug. Split
  // the pool instead so the lists are always disjoint.
  const gainCount = Math.min(limit, Math.ceil(byChange.length / 2));
  const loseCount = Math.min(limit, byChange.length - gainCount);

  return {
    quote: q,
    minQuoteVolume,
    pool: pool.length,
    fetchedAt,
    gainers: byChange.slice(0, gainCount),
    losers: byChange.slice(byChange.length - loseCount).reverse(),
  };
}
