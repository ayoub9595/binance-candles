// Fair Value Gaps (FVG) — the classic ICT/SMC 3-candle imbalance.
//
// A bullish FVG forms when candle 3's low sits strictly above candle 1's
// high: the displacement candle in the middle moved so fast it left a price
// void [candle1.high … candle3.low] with no overlap. Bearish is the mirror
// (candle 3's high below candle 1's low). The zone is anchored at the middle
// candle and stays "open" until price comes back and wicks through its FAR
// side (full fill / mitigation) — a bullish gap fills when a later low
// reaches its bottom, a bearish one when a later high reaches its top.
//
// All gaps are returned, filled or not — display filtering/capping is the
// caller's job, which keeps this function purely prefix-stable.
//
// No lookahead: a gap is known the moment its third candle closes, and fills
// are evaluated per bar in order — feeding a growing prefix of candles (bar
// replay) yields exactly what was knowable at that moment.

// candles: ascending toChartBar array ({time: sec, open, high, low, close}).
// Returns { boxes: [{ id, dir: 'bullish'|'bearish', top, bottom, fromTime,
//                     toTime, filled }] } — fromTime is the middle candle;
// toTime is the fill bar for filled gaps, the last bar for open ones.
export function computeFvgs(candles) {
  const done = [];
  const active = [];

  for (let j = 2; j < candles.length; j++) {
    const bar = candles[j];

    // Fill check first: an existing gap can be consumed by this bar. The
    // newly-formed gap below can't be filled by its own third candle (its
    // extreme defines the near side of the void).
    for (let k = active.length - 1; k >= 0; k--) {
      const gap = active[k];
      const filled = gap.dir === 'bullish' ? bar.low <= gap.bottom : bar.high >= gap.top;
      if (filled) {
        done.push({ ...gap, toTime: bar.time, filled: true });
        active.splice(k, 1);
      }
    }

    const first = candles[j - 2];
    if (bar.low > first.high) {
      active.push({
        id: `fvg:bullish:${candles[j - 1].time}`,
        dir: 'bullish',
        top: bar.low,
        bottom: first.high,
        fromTime: candles[j - 1].time,
      });
    } else if (bar.high < first.low) {
      active.push({
        id: `fvg:bearish:${candles[j - 1].time}`,
        dir: 'bearish',
        top: first.low,
        bottom: bar.high,
        fromTime: candles[j - 1].time,
      });
    }
  }

  const lastTime = candles.length ? candles[candles.length - 1].time : 0;
  return {
    boxes: [
      ...done,
      ...active.map((gap) => ({ ...gap, toTime: lastTime, filled: false })),
    ],
  };
}
