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

// PAXGUSDT (PAX Gold, 1 token = 1 troy oz) is Binance's gold token: Binance
// does not list XAUUSD, since spot gold is a forex/CFD product rather than a
// crypto pair — the klines endpoint rejects it with HTTP 400. Real XAUUSD is
// served from Deriv instead, via FOREX_SYMBOLS below.
const binanceSymbols = parseList(
  process.env.BINANCE_SYMBOLS,
  'BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,PAXGUSDT'
).map((s) => s.toUpperCase());
const binanceIntervals = parseList(process.env.BINANCE_INTERVALS, '1m,3m,5m,15m,30m,1h,4h');

// Forex instruments pinned at boot, ingested from the selected forex provider
// rather than Binance. Only symbols defined in services/forexInstruments.js
// are usable; unsupported entries are skipped with a warning at startup.
const forexSymbols = parseList(process.env.FOREX_SYMBOLS, 'XAUUSD').map((s) => s.toUpperCase());

// Which upstream serves those symbols (services/forexProvider.js):
//   deriv   — Deriv's public API, keyless, the default.
//   ctrader — the cTrader Open API, i.e. your broker's own feed (Fusion
//             Markets et al). Needs an app from https://openapi.ctrader.com
//             and an access token authorized against the trading account.
const forexProvider = (process.env.FOREX_PROVIDER || 'deriv').toLowerCase();
if (!['deriv', 'ctrader'].includes(forexProvider)) {
  throw new Error(`Invalid FOREX_PROVIDER "${forexProvider}" — must be "deriv" or "ctrader"`);
}

const ctrader = {
  hostType: (process.env.CTRADER_HOST_TYPE || 'demo').toLowerCase(),
  clientId: process.env.CTRADER_CLIENT_ID || '',
  clientSecret: process.env.CTRADER_CLIENT_SECRET || '',
  accessToken: process.env.CTRADER_ACCESS_TOKEN || '',
  refreshToken: process.env.CTRADER_REFRESH_TOKEN || '',
  // Optional ctidTraderAccountId; discovered from the access token when unset.
  accountId: process.env.CTRADER_ACCOUNT_ID ? Number(process.env.CTRADER_ACCOUNT_ID) : null,
};

// Fail at boot, not at first fetch: a ctrader selection without credentials
// would otherwise look like a working server whose gold chart never loads.
if (forexProvider === 'ctrader') {
  if (!['demo', 'live'].includes(ctrader.hostType)) {
    throw new Error(`Invalid CTRADER_HOST_TYPE "${ctrader.hostType}" — must be "demo" or "live"`);
  }
  const missing = [
    ['CTRADER_CLIENT_ID', ctrader.clientId],
    ['CTRADER_CLIENT_SECRET', ctrader.clientSecret],
    ['CTRADER_ACCESS_TOKEN', ctrader.accessToken],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new Error(
      `FOREX_PROVIDER=ctrader is missing ${missing.join(', ')} — register an app at ` +
        'https://openapi.ctrader.com, authorize it against your broker account, and set them in .env'
    );
  }
}

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
  forexSymbols,
  forexProvider,
  ctrader,
  // Deriv's public demo app id — enough for keyless candle history. Register
  // an app at api.deriv.com to use your own.
  derivAppId: process.env.DERIV_APP_ID || '1089',
  backfillLimit: Number(process.env.BACKFILL_LIMIT || 1000),
};
