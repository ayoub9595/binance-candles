// The forex/metals instruments served from a forex provider (Deriv or the
// cTrader Open API, per FOREX_PROVIDER) rather than Binance. Kept in a
// dependency-free module so the spot catalog (search, labels) and the feeds
// (ingestion) can share it without an import cycle. Each entry carries its
// name at every provider: derivSymbol for Deriv, ctraderSymbol as listed by
// the cTrader broker (Fusion Markets lists spot gold as plain XAUUSD).

export const FOREX_INSTRUMENTS = [
  { symbol: 'XAUUSD', baseAsset: 'XAU', quoteAsset: 'USD', derivSymbol: 'frxXAUUSD', ctraderSymbol: 'XAUUSD' },
];

const BY_SYMBOL = new Map(FOREX_INSTRUMENTS.map((i) => [i.symbol, i]));

export function isForexSymbol(symbol) {
  return BY_SYMBOL.has(String(symbol ?? '').toUpperCase());
}

export function getForexInstrument(symbol) {
  return BY_SYMBOL.get(String(symbol ?? '').toUpperCase()) ?? null;
}
