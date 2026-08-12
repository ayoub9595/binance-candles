import { fetchKlines } from './binanceRest.js';
import { fromRestKline } from '../utils/normalizeCandle.js';
import { bulkUpsertCandles } from '../models/candleRepository.js';

export async function runBackfill({ symbol, interval, startTime, limit }) {
  const raw = await fetchKlines({ symbol, interval, startTime, limit });
  const candles = raw.map((k) => fromRestKline(k, symbol, interval));
  await bulkUpsertCandles(candles);
  return candles.length;
}
