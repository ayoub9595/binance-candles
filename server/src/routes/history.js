import { Router } from 'express';
import { config } from '../config.js';
import { healGaps } from '../services/gapHealer.js';
import { ensureHistory } from '../services/historyEnsurer.js';
import { ensureCatalog, isTradableSymbol } from '../services/spotCatalog.js';
import { getOldestOpenTime, getLatestOpenTime } from '../models/candleRepository.js';

export const historyRouter = Router();

// Shared gate: any tradable symbol (Binance spot, or a forex instrument, which
// the catalog index carries regardless of exchangeInfo) at an ingested
// interval. The catalog is what keeps a typo from becoming a paged upstream
// walk for a symbol that does not exist.
async function resolveCombo({ symbol, interval }) {
  const sym = typeof symbol === 'string' ? symbol.toUpperCase() : '';
  await ensureCatalog().catch(() => {});
  if (!isTradableSymbol(sym) || !config.binanceIntervals.includes(interval)) return null;
  return { symbol: sym, interval };
}

// Make sure candles for this combo exist at least back to `fromMs`,
// backfilling from the symbol's provider (Binance, or Deriv for forex) if the
// stored history is too shallow. Responds with the oldest stored openTime,
// which may still be newer than `fromMs` when the symbol listed later than
// the requested date — or, for forex, when the provider's history ran out.
historyRouter.post('/history/ensure', async (req, res) => {
  const { symbol, interval, fromMs } = req.body ?? {};
  const combo = await resolveCombo({ symbol, interval });
  if (!combo) {
    return res.status(400).json({ error: 'unknown symbol or interval' });
  }
  const { symbol: sym } = combo;
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

// Repair the stored candles for one combo: re-scan its history for holes and
// page them in from the provider. This is the manual counterpart to the
// automatic heal the ingestor runs on acquire and reconnect, and differs from
// it in two ways that only make sense when a user asked for it — forex combos
// are included, and windows previously recorded as unfillable are retried.
//
// Needed because a hole in the MIDDLE of a combo's history is otherwise
// permanent for forex: /history/ensure only ever extends the oldest edge, and
// the background healer skips forex, so nothing repairs a gap left by (for
// instance) a restart after enough downtime that Deriv's response window no
// longer reaches back to the newest stored bar.
historyRouter.post('/history/repair', async (req, res) => {
  const combo = await resolveCombo(req.body ?? {});
  if (!combo) {
    return res.status(400).json({ error: 'unknown symbol or interval' });
  }

  try {
    const summary = await healGaps(combo, { manual: true });
    const [oldestMs, newestMs] = await Promise.all([
      getOldestOpenTime(combo),
      getLatestOpenTime(combo),
    ]);
    res.json({ ...summary, oldestMs, newestMs });
  } catch (err) {
    console.error('[history] repair failed', err);
    res.status(502).json({ error: 'failed to repair history from the upstream provider' });
  }
});
