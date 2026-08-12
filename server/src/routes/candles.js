import { Router } from 'express';
import { getCandles } from '../models/candleRepository.js';

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

  const candles = await getCandles({
    symbol: symbol.toUpperCase(),
    interval,
    limit: limit ? Number(limit) : 500,
    startTime: toEpochMs(startTime),
    endTime: toEpochMs(endTime),
  });
  res.json(candles);
});
