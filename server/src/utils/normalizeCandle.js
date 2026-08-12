// Binance REST kline: [openTime, open, high, low, close, volume, closeTime, quoteVolume, numTrades, takerBuyBaseVol, takerBuyQuoteVol, ignore]
export function fromRestKline(raw, symbol, interval) {
  const [openTime, open, high, low, close, volume, closeTime, quoteVolume, numTrades, takerBuyBaseVol, takerBuyQuoteVol] = raw;
  return {
    symbol,
    interval,
    openTime,
    closeTime,
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    volume: Number(volume),
    quoteVolume: Number(quoteVolume),
    numTrades,
    takerBuyBaseVol: Number(takerBuyBaseVol),
    takerBuyQuoteVol: Number(takerBuyQuoteVol),
    isClosed: closeTime < Date.now(),
  };
}

// Binance WS kline payload's `k` object
export function fromWsKline(k) {
  return {
    symbol: k.s,
    interval: k.i,
    openTime: k.t,
    closeTime: k.T,
    open: Number(k.o),
    high: Number(k.h),
    low: Number(k.l),
    close: Number(k.c),
    volume: Number(k.v),
    quoteVolume: Number(k.q),
    numTrades: k.n,
    takerBuyBaseVol: Number(k.V),
    takerBuyQuoteVol: Number(k.Q),
    isClosed: k.x,
  };
}

// Mongo doc -> wire shape sent over REST/socket to the client
export function toWireShape(doc) {
  return {
    symbol: doc.symbol,
    interval: doc.interval,
    time: doc.openTime,
    open: doc.open,
    high: doc.high,
    low: doc.low,
    close: doc.close,
    volume: doc.volume,
    isClosed: doc.isClosed,
  };
}
