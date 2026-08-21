import { Router } from 'express';
import { config } from '../config.js';
import { catalogSize, ensureCatalog, getSymbolInfo, searchSymbols } from '../services/spotCatalog.js';

export const instrumentsRouter = Router();

// The configured symbols are the DEFAULTS the client pins, not the limit of
// what it may chart — /instruments/search reaches the whole spot exchange.
// `catalogSize` lets the client tell "search found nothing" apart from
// "the catalog hasn't loaded", which are very different things to show.
instrumentsRouter.get('/instruments', (req, res) => {
  res.json({
    // Forex instruments (XAUUSD from Deriv) pin alongside the Binance pairs —
    // the client treats every entry the same, the server routes by symbol.
    symbols: [...config.forexSymbols, ...config.binanceSymbols],
    intervals: config.binanceIntervals,
    catalogSize: catalogSize(),
  });
});

instrumentsRouter.get('/instruments/search', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 50) : 25;

  // First search after a cold start pays the exchangeInfo fetch; every later
  // one is served from memory. A failure here is not fatal — an empty catalog
  // returns no results rather than an error, and the pinned defaults still work.
  try {
    await ensureCatalog();
  } catch (err) {
    console.error('[instruments] catalog unavailable', err.message);
  }

  res.json({ results: searchSymbols(q, limit), catalogSize: catalogSize() });
});

// Resolve one symbol's base/quote — used to label a pair restored from
// localStorage without spending a search round-trip on it.
instrumentsRouter.get('/instruments/:symbol', async (req, res) => {
  try {
    await ensureCatalog();
  } catch {
    // fall through: a configured symbol still resolves below
  }
  const info = getSymbolInfo(req.params.symbol);
  if (!info) return res.status(404).json({ error: 'unknown symbol' });
  res.json(info);
});
