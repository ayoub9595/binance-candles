// FVG-based order blocks.
//
// When a 3-candle fair value gap prints (see fvg.js), the candle BEFORE the
// displacement (middle) candle is the order block — the origin the imbalance
// launched from. A bullish FVG marks a demand OB, a bearish FVG a supply OB.
// The zone is that origin candle's full range.
//
// Origin-candle filters (both against the candle right before it; candidates
// with no previous candle are skipped):
//   1. Wick: the origin candle must show rejection stronger than its
//      predecessor — for a demand OB its LOWER wick must be strictly larger
//      than the previous candle's lower wick; for a supply OB the UPPER
//      wicks are compared.
//   2. Position: the origin candle must sit entirely lower than its
//      predecessor for a demand OB (lower high AND lower low — it dug down
//      before the displacement up), entirely higher for a supply OB.
//
// Lifecycle: the zone extends right while price stays away ("fresh"). The
// first wick back into it mitigates it — the box freezes at that bar. All
// zones are returned, fresh and mitigated — display filtering/capping is the
// caller's job, which keeps this function purely prefix-stable.
//
// No lookahead: an OB is known the moment the gap's third candle closes, and
// mitigation is evaluated per bar in order — feeding a growing prefix of
// candles (bar replay) yields exactly what was knowable at that moment.

function lowerWick(bar) {
  return Math.min(bar.open, bar.close) - bar.low;
}

function upperWick(bar) {
  return bar.high - Math.max(bar.open, bar.close);
}

// candles: ascending toChartBar array ({time: sec, open, high, low, close}).
// Returns { boxes: [{ id, dir: 'bullish'|'bearish', top, bottom, fromTime,
//                     toTime, mitigated }] } — fromTime is the origin candle;
// toTime is the mitigation bar for tapped zones, the last bar for fresh ones.
export function computeFvgOrderBlocks(candles) {
  const done = [];
  const active = [];

  for (let j = 2; j < candles.length; j++) {
    const bar = candles[j];

    // Mitigation first: the current bar can tap existing zones. A zone's own
    // pattern can't tap it — the third candle sits beyond the gap, which is
    // beyond the origin candle's range by construction.
    for (let k = active.length - 1; k >= 0; k--) {
      const ob = active[k];
      const touched = ob.dir === 'bullish' ? bar.low <= ob.top : bar.high >= ob.bottom;
      if (touched) {
        done.push({ ...ob, toTime: bar.time, mitigated: true });
        active.splice(k, 1);
      }
    }

    const first = candles[j - 2];
    const beforeFirst = j >= 3 ? candles[j - 3] : null; // filter baseline
    if (bar.low > first.high) {
      if (
        beforeFirst &&
        lowerWick(first) > lowerWick(beforeFirst) &&
        first.high < beforeFirst.high &&
        first.low < beforeFirst.low
      ) {
        active.push({
          id: `ob:bullish:${first.time}`,
          dir: 'bullish',
          top: first.high,
          bottom: first.low,
          fromTime: first.time,
        });
      }
    } else if (bar.high < first.low) {
      if (
        beforeFirst &&
        upperWick(first) > upperWick(beforeFirst) &&
        first.high > beforeFirst.high &&
        first.low > beforeFirst.low
      ) {
        active.push({
          id: `ob:bearish:${first.time}`,
          dir: 'bearish',
          top: first.high,
          bottom: first.low,
          fromTime: first.time,
        });
      }
    }
  }

  const lastTime = candles.length ? candles[candles.length - 1].time : 0;
  return {
    boxes: [
      ...done,
      ...active.map((ob) => ({ ...ob, toTime: lastTime, mitigated: false })),
    ],
  };
}
