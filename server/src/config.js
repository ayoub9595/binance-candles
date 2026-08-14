import 'dotenv/config';

const VALID_INTERVALS = new Set([
  '1s', '1m', '3m', '5m', '15m', '30m',
  '1h', '2h', '4h', '6h', '8h', '12h',
  '1d', '3d', '1w', '1M',
]);

function parseList(raw, fallback) {
  const list = (raw || fallback).split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set(list)];
}

// PAXGUSDT (PAX Gold, 1 token = 1 troy oz) is the gold instrument: Binance
// does not list XAUUSD, since spot gold is a forex/CFD product rather than a
// crypto pair — the klines endpoint rejects it with HTTP 400.
const binanceSymbols = parseList(
  process.env.BINANCE_SYMBOLS,
  'BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,PAXGUSDT'
).map((s) => s.toUpperCase());
const binanceIntervals = parseList(process.env.BINANCE_INTERVALS, '5m,15m,1h,4h');

for (const interval of binanceIntervals) {
  if (!VALID_INTERVALS.has(interval)) {
    throw new Error(
      `Invalid BINANCE_INTERVALS entry "${interval}" — must be one of: ${[...VALID_INTERVALS].join(', ')}`
    );
  }
}

export const config = {
  port: Number(process.env.PORT || 4000),
  mongodbUri: process.env.MONGODB_URI || 'mongodb://localhost:27017',
  dbName: process.env.DB_NAME || 'binance_candles',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  binanceSymbols,
  binanceIntervals,
  backfillLimit: Number(process.env.BACKFILL_LIMIT || 1000),
};
