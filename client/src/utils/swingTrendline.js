// Classic 5-bar "fractal" swing detection: a candle is confirmed as a swing
// high/low only once `lookback` candles exist on both sides of it, so the
// most recent `lookback` candles (including the currently-forming one) can
// never be confirmed yet — matches how real swing points work.
function findSwingHighs(candles, lookback) {
  const swings = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const h = candles[i].high;
    let isSwing = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= h) {
        isSwing = false;
        break;
      }
    }
    if (isSwing) swings.push(candles[i]);
  }
  return swings;
}

function findSwingLows(candles, lookback) {
  const swings = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const l = candles[i].low;
    let isSwing = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].low <= l) {
        isSwing = false;
        break;
      }
    }
    if (isSwing) swings.push(candles[i]);
  }
  return swings;
}

// Straight line through the two most recent swing points, extrapolated
// forward to `latestTime` — just the 2 endpoints, lightweight-charts draws
// the segment between them.
function buildLine(swings, key, latestTime) {
  if (swings.length < 2) return [];
  const a = swings[swings.length - 2];
  const b = swings[swings.length - 1];
  const aPoint = { time: a.time, value: a[key] };
  const bPoint = { time: b.time, value: b[key] };
  const slope = (bPoint.value - aPoint.value) / (bPoint.time - aPoint.time);
  const extrapolatedValue = aPoint.value + slope * (latestTime - aPoint.time);
  return [aPoint, { time: latestTime, value: extrapolatedValue }];
}

// candles: ascending array of {time, open, high, low, close} (toChartBar shape).
// Returns {resistance, support}: a straight line through the two most recent
// confirmed swing highs (resistance) / swing lows (support), extended to the
// latest candle's time — a classic hand-drawn-style trendline.
export function computeSwingTrendline(candles, lookback = 2) {
  if (candles.length === 0) return { resistance: [], support: [] };
  const latestTime = candles[candles.length - 1].time;
  const swingHighs = findSwingHighs(candles, lookback);
  const swingLows = findSwingLows(candles, lookback);
  return {
    resistance: buildLine(swingHighs, 'high', latestTime),
    support: buildLine(swingLows, 'low', latestTime),
  };
}
