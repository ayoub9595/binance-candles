import { Router } from 'express';
import { config } from '../config.js';
import { ensureHistory } from '../services/historyEnsurer.js';
import { ensureCatalog, isTradableSymbol } from '../services/spotCatalog.js';

export const historyRouter = Router();

// Make sure candles for this combo exist at least back to `fromMs`,
// backfilling from the symbol's provider (Binance, or Deriv for forex) if the
// stored history is too shallow. Responds with the oldest stored openTime,
// which may still be newer than `fromMs` when the symbol listed later than
// the requested date — or, for forex, when the provider's history ran out.
historyRouter.post('/history/ensure', async (req, res) => {
  const { symbol, interval, fromMs } = req.body ?? {};
  const sym = typeof symbol === 'string' ? symbol.toUpperCase() : '';
  // Any tradable spot pair may be backfilled, not just the streamed defaults —
  // the catalog is the gate that keeps a typo from turning into a paged walk
  // against Binance for a symbol that does not exist.
  await ensureCatalog().catch(() => {});
  if (!isTradableSymbol(sym) || !config.binanceIntervals.includes(interval)) {
    return res.status(400).json({ error: 'unknown symbol or interval' });
  }
  const from = Number(fromMs);
  if (!Number.isFinite(from) || from <= 0) {
    return res.status(400).json({ error: 'fromMs must be a positive epoch-ms number' });
  }

  try {
    const oldestMs = await ensureHistory({ symbol: sym, interval, fromMs: from });
    res.json({ oldestMs });
  } catch (err) {
    console.error('[history] ensure failed', err);
    res.status(502).json({ error: 'failed to backfill history from the upstream provider' });
  }
});
