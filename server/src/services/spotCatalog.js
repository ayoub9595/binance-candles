// Catalog of every tradable Binance SPOT symbol, so the UI can search the whole
// exchange instead of only the handful of pairs the ingestor streams by default
// (config.binanceSymbols, which remain the pinned/default list).
//
// exchangeInfo is one ~20-weight request returning thousands of symbols, so it
// is fetched once at boot and refreshed on a long timer — never per keystroke.
// Searches run entirely against the in-memory index.
//
// A failed fetch is non-fatal: the catalog simply stays empty and everything
// falls back to the configured symbols, so the app degrades to exactly its
// previous behaviour rather than breaking.

import { config } from '../config.js';
import { FOREX_INSTRUMENTS } from './forexInstruments.js';

const EXCHANGE_INFO_URL = 'https://api.binance.com/api/v3/exchangeInfo';
const REFRESH_MS = 6 * 60 * 60 * 1000;

// Ranking bias for the quotes people actually chart, so a search for "BTC"
// surfaces BTCUSDT well before BTCNGN. Anything unlisted sorts after all of
// these but is still returned — the bias orders results, it never filters.
const QUOTE_PRIORITY = ['USDT', 'FDUSD', 'USDC', 'BTC', 'ETH', 'BNB', 'TRY', 'EUR', 'BRL', 'JPY'];
const QUOTE_RANK = new Map(QUOTE_PRIORITY.map((q, i) => [q, i]));
const quoteRank = (q) => QUOTE_RANK.get(q) ?? QUOTE_PRIORITY.length;

// Instruments served from Deriv instead of Binance (real XAUUSD — Binance has
// no forex pairs). Always present in the index and search results, catalog
// loaded or not, since their tradability does not depend on exchangeInfo.
const FOREX_ENTRIES = FOREX_INSTRUMENTS.map(({ symbol, baseAsset, quoteAsset }) => ({
  symbol,
  baseAsset,
  quoteAsset,
}));

// Rewrite the queries people actually type for gold so they land on XAUUSD
// instead of an empty result. Exact matches only: a partially typed alias
// falls through to the normal search bands.
const QUERY_ALIASES = new Map([
  ['GOLD', 'XAU'],
  ['XAUUSDT', 'XAUUSD'],
]);

// symbol -> { symbol, baseAsset, quoteAsset }
let binanceEntries = [];
let entries = [...FOREX_ENTRIES];
let index = new Map(entries.map((e) => [e.symbol, e]));
let loadedAt = 0;
let inFlight = null;

// Users type "BTC/USDT", "btc-usdt" or "btc usdt" and mean one pair; the
// separator carries no information here, so it is dropped on both sides of the
// comparison rather than special-cased.
function normalize(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function fetchSpotSymbols() {
  // permissions=SPOT narrows a ~2MB document to the pairs we can chart. Some
  // gateways reject the parameter, so fall back to the unfiltered document and
  // apply the same filter locally — the isSpotTradingAllowed check below makes
  // both paths equivalent.
  let raw;
  try {
    raw = await getJson(`${EXCHANGE_INFO_URL}?permissions=SPOT`);
  } catch (err) {
    console.warn('[catalog] permissions=SPOT request failed, retrying unfiltered:', err.message);
    raw = await getJson(EXCHANGE_INFO_URL);
  }

  const symbols = Array.isArray(raw?.symbols) ? raw.symbols : [];
  return symbols
    .filter((s) => s.status === 'TRADING' && s.isSpotTradingAllowed !== false)
    .map((s) => ({ symbol: s.symbol, baseAsset: s.baseAsset, quoteAsset: s.quoteAsset }));
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`exchangeInfo request failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function load() {
  const list = await fetchSpotSymbols();
  // Pre-sorted by quote preference so search only ever has to sort its own
  // (much smaller) match set, and ties inside a score band stay stable.
  list.sort((a, b) => quoteRank(a.quoteAsset) - quoteRank(b.quoteAsset) || a.symbol.localeCompare(b.symbol));
  binanceEntries = list;
  entries = [...FOREX_ENTRIES, ...list];
  index = new Map(entries.map((e) => [e.symbol, e]));
  loadedAt = Date.now();
  console.log(`[catalog] loaded ${list.length} tradable spot symbols`);
}

// Concurrent callers share one request; a rejected load clears itself so the
// next caller retries rather than being stuck with the failure forever.
export function ensureCatalog() {
  if (inFlight) return inFlight;
  if (binanceEntries.length && Date.now() - loadedAt < REFRESH_MS) return Promise.resolve();
  inFlight = load().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

// Kick a refresh at boot and keep it warm. unref() so a pending timer never
// holds the process open on shutdown.
export function startCatalogRefresh() {
  ensureCatalog().catch((err) => console.error('[catalog] initial load failed', err.message));
  const timer = setInterval(() => {
    ensureCatalog().catch((err) => console.error('[catalog] refresh failed', err.message));
  }, REFRESH_MS);
  timer.unref?.();
  return timer;
}

// The configured symbols are always tradable regardless of catalog state —
// they are what the ingestor streams, and a failed exchangeInfo fetch must not
// take the default pairs offline.
export function isTradableSymbol(symbol) {
  const sym = normalize(symbol);
  return config.binanceSymbols.includes(sym) || index.has(sym);
}

export function getSymbolInfo(symbol) {
  return index.get(normalize(symbol)) ?? null;
}

export function catalogSize() {
  return entries.length;
}

// Whether isTradableSymbol() can actually answer "no" for a Binance pair.
// Before the first successful load it can only answer "yes, that's a
// configured pair or a forex instrument", which callers that gate on it need
// to tell apart from a real rejection.
export function isCatalogReady() {
  return binanceEntries.length > 0;
}

// Ranked search over the catalog. Bands, best first:
//   0 exact symbol            "BTCUSDT"  -> BTCUSDT
//   1 exact base asset        "BTC"      -> BTCUSDT, BTCFDUSD, ...
//   2 symbol prefix           "BTCU"     -> BTCUSDT, BTCUSDC
//   3 base-asset prefix       "PEP"      -> PEPEUSDT
//   4 symbol substring        "USDT"     -> everything quoted in USDT
// Within a band, the pre-sorted quote preference decides, then the shorter
// symbol, then alphabetical — so the canonical pair leads every band.
export function searchSymbols(query, limit = 25) {
  const typed = normalize(query);
  if (!typed) return [];
  const q = QUERY_ALIASES.get(typed) ?? typed;

  const matches = [];
  for (const e of entries) {
    let score;
    if (e.symbol === q) score = 0;
    else if (e.baseAsset === q) score = 1;
    else if (e.symbol.startsWith(q)) score = 2;
    else if (e.baseAsset.startsWith(q)) score = 3;
    else if (e.symbol.includes(q)) score = 4;
    else continue;
    matches.push({ score, e });
  }

  matches.sort(
    (a, b) =>
      a.score - b.score ||
      quoteRank(a.e.quoteAsset) - quoteRank(b.e.quoteAsset) ||
      a.e.symbol.length - b.e.symbol.length ||
      a.e.symbol.localeCompare(b.e.symbol)
  );

  return matches.slice(0, limit).map((m) => m.e);
}
