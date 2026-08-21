import { Router } from 'express';
import { getCandles } from '../models/candleRepository.js';
import { ensureSeeded } from '../services/historyEnsurer.js';
import { ensureCatalog } from '../services/spotCatalog.js';

export const candlesRouter = Router();

// Epoch-ms query param -> number, or undefined for anything non-numeric so a
// malformed value can never put NaN into the Mongo query.
function toEpochMs(value) {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

candlesRouter.get('/candles', async (req, res) => {
  const { symbol, interval, limit, startTime, endTime } = req.query;
  if (!symbol || !interval) {
    return res.status(400).json({ error: 'symbol and interval are required' });
  }

  const query = {
    symbol: symbol.toUpperCase(),
    interval,
    limit: limit ? Number(limit) : 500,
    startTime: toEpochMs(startTime),
    endTime: toEpochMs(endTime),
  };

  const candles = await getCandles(query);
  if (candles.length > 0) return res.json(candles);

  // Empty result: this may be a pair the user just searched for, which nothing
  // has ever backfilled. ensureSeeded pulls one page from Binance the first
  // time a combo is seen and is a no-op on every subsequent call, so the read
  // path stays a single Mongo query in the normal case.
  await ensureCatalog().catch(() => {});
  const wrote = await ensureSeeded({ symbol: query.symbol, interval: query.interval });
  res.json(wrote ? await getCandles(query) : candles);
});
