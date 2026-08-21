// The forex/metals instruments served from Deriv rather than Binance. Kept in
// a dependency-free module so both the spot catalog (search, labels) and the
// Deriv feed (ingestion) can share it without an import cycle.

export const FOREX_INSTRUMENTS = [
  { symbol: 'XAUUSD', baseAsset: 'XAU', quoteAsset: 'USD', derivSymbol: 'frxXAUUSD' },
];

const BY_SYMBOL = new Map(FOREX_INSTRUMENTS.map((i) => [i.symbol, i]));

export function isForexSymbol(symbol) {
  return BY_SYMBOL.has(String(symbol ?? '').toUpperCase());
}

export function getForexInstrument(symbol) {
  return BY_SYMBOL.get(String(symbol ?? '').toUpperCase()) ?? null;
}
