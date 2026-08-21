import { Router } from 'express';
import { DEFAULT_MIN_QUOTE_VOLUME, getMovers } from '../services/tickerStats.js';

export const moversRouter = Router();

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

// Top gainers/losers over the rolling 24h window for one quote asset.
//   ?quote=USDT      which quote to rank within
//   ?limit=12        rows per side
//   ?minQuoteVolume  liquidity floor, in the quote asset
moversRouter.get('/movers', async (req, res) => {
  const quote = typeof req.query.quote === 'string' && req.query.quote ? req.query.quote : 'USDT';
  const limit = clampInt(req.query.limit, 12, 1, 50);
  const minQuoteVolume = clampInt(req.query.minQuoteVolume, DEFAULT_MIN_QUOTE_VOLUME, 0, Number.MAX_SAFE_INTEGER);

  try {
    res.json(await getMovers({ quote, limit, minQuoteVolume }));
  } catch (err) {
    console.error('[movers] failed', err.message);
    res.status(502).json({ error: 'failed to load 24h ticker stats from Binance' });
  }
});
