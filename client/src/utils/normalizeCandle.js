// Wire shape ({time: ms, open, high, low, close, volume, isClosed}) -> lightweight-charts bar ({time: seconds, open, high, low, close})
export function toChartBar(candle) {
  return {
    time: Math.floor(candle.time / 1000),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  };
}
