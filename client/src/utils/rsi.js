// Wilder's RSI over chart bar closes — the classic 14-period smoothing, the
// same arithmetic TradingView's built-in uses, so the readout matches what
// the strategy's Pine sees. Computed over the full bar array each call: the
// last value therefore INCLUDES the forming candle, ticking live exactly like
// an on-chart RSI pane, and a replay stepping bar-by-bar reproduces the same
// sequence (pure function of the bars, no lookahead, no state).

export const RSI_PERIOD = 14;

// bars: ascending chart bars ({ close }). Returns the current RSI (0..100),
// or null while there are not yet period+1 bars to seed the averages.
export function computeRsi(bars, period = RSI_PERIOD) {
  if (!bars || bars.length <= period) return null;

  // Seed: simple average of the first `period` changes...
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = bars[i].close - bars[i - 1].close;
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;

  // ...then Wilder smoothing over the rest.
  for (let i = period + 1; i < bars.length; i++) {
    const d = bars[i].close - bars[i - 1].close;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }

  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}
