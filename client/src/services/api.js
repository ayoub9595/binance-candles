import axios from 'axios';
import { API_BASE_URL } from '../config.js';

const client = axios.create({ baseURL: API_BASE_URL });

export async function getCandles(symbol, interval, limit = 500, { startTime, endTime } = {}) {
  const { data } = await client.get('/api/candles', {
    params: { symbol, interval, limit, startTime, endTime },
  });
  return data;
}

export async function getInstruments() {
  const { data } = await client.get('/api/instruments');
  return data;
}

// Search every tradable Binance spot pair, not just the configured defaults.
// The server holds the exchange catalog in memory, so this is cheap enough to
// call per keystroke (debounced by the caller).
// Returns { results: [{ symbol, baseAsset, quoteAsset }], catalogSize }.
export async function searchSymbols(q, limit = 25, { signal } = {}) {
  const { data } = await client.get('/api/instruments/search', { params: { q, limit }, signal });
  return data;
}

// Base/quote for one pair, used to label a symbol restored from localStorage.
// 404s for anything not on the exchange.
export async function getSymbolInfo(symbol) {
  const { data } = await client.get(`/api/instruments/${encodeURIComponent(symbol)}`);
  return data;
}

// Top gainers/losers over the rolling 24h window. The server caches the
// upstream ticker for 30s, so polling faster than that only costs a round trip.
// Returns { quote, minQuoteVolume, pool, fetchedAt, gainers, losers } where each
// row is { symbol, baseAsset, quoteAsset, changePercent, lastPrice, quoteVolume }.
export async function getMovers({ quote = 'USDT', limit = 12, signal } = {}) {
  const { data } = await client.get('/api/movers', { params: { quote, limit }, signal });
  return data;
}

// Ask the server to backfill this combo from Binance back to `fromMs` if its
// stored history is too shallow. Can take a while for dates far in the past
// (the server pages through Binance klines); instant once a range is covered.
export async function ensureHistory(symbol, interval, fromMs) {
  const { data } = await client.post('/api/history/ensure', { symbol, interval, fromMs });
  return data;
}
