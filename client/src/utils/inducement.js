// Retracement inducement (IDM) detection.
//
// Logic ported from the "Liquidity & inducements" TradingView indicator
// (© mickes, Mozilla Public License 2.0) — its "Retracement inducement"
// feature with default settings. Market structure (trend, BOS/CHoCH) comes
// from the exact port of the author's PriceAction library
// (priceActionStructure.js), the same engine the indicator imports.
//
// Mechanics:
//   - Market structure runs on 5/5 pivots and decides the trend; any
//     structure break (BOS/CHoCH/CHoCH+) restarts the inducement cycle.
//   - Minor 1/1 pivots form the pullbacks. EVERY minor pivot that confirms
//     after the latest structure break becomes an IDM level, on BOTH sides at
//     once: every minor HIGH is liquidity above, every minor LOW is liquidity
//     below, tracked in parallel regardless of trend. Levels accumulate —
//     each pullback behind a new peak stays on the chart as its own level.
//     Segments carry `counterTrend` (a high in a bearish trend / a low in a
//     bullish one) so the caller can style or filter the classic direction.
//   - An IDM is TAKEN as soon as price wicks to or through it
//     (high >= level / low <= level) — no close-back requirement. Levels are
//     independent, so one bar can sweep several stacked levels at once; each
//     resolves separately, under a single marker per side for that bar.
//   - A structure break invalidates untaken IDMs (they are dropped,
//     matching the indicator's default "keep invalidated = false").
//
// Divergences from the indicator (deliberate):
//   - The indicator keeps at most one pending IDM per side and stops after
//     the first pullback of each break; here every pullback arms its own
//     level. On 1500 BTCUSDT 15m bars the one-per-side rule blocked 214
//     pivots and yielded 84 takes; keeping every level yields ~269.
//   - The indicator arms only the counter-trend side; here both sides arm at
//     once, so inducement above and below is visible simultaneously.
// The trade-off is churn — a sizeable share of takes land within a couple of
// bars of the pivot forming. Display capping in the caller (ChartPage) is
// what keeps the chart readable.
//
// No lookahead: structure pivots confirm 5 bars late, minor pivots 1 bar
// late, and takes/invalidations are evaluated per bar in order — feeding a
// growing prefix of candles (bar replay) yields exactly what was knowable at
// that moment.

import { createStructureTracker } from './priceActionStructure.js';

const SWEEP_HIGH_COLOR = '#ef5350';
const SWEEP_LOW_COLOR = '#26a69a';

// Indicator defaults: "Market structure" pivot 5/5, "Retracement
// inducements" pivot 1/1.
const STRUCTURE_LOOKBACK = 5;
const PIVOT_LOOKBACK = 1;

function isSwingHigh(candles, i, lookback) {
  const h = candles[i].high;
  for (let j = i - lookback; j <= i + lookback; j++) {
    if (j !== i && candles[j].high >= h) return false;
  }
  return true;
}

function isSwingLow(candles, i, lookback) {
  const l = candles[i].low;
  for (let j = i - lookback; j <= i + lookback; j++) {
    if (j !== i && candles[j].low <= l) return false;
  }
  return true;
}

// candles: ascending toChartBar array ({time: sec, open, high, low, close}).
// Returns:
//   markers  — lightweight-charts series markers at IDM take bars
//   segments — horizontal level lines, one per inducement:
//              { id, side: 'high'|'low', price, fromTime, toTime, swept }
//              taken IDMs run pivot→take bar (swept: true); still-pending
//              levels run pivot→last bar (swept: false), and there may be
//              several of them per side.
//              All events are returned — display capping/filtering is the
//              caller's job, which keeps this function purely prefix-stable.
export function computeInducements(
  candles,
  { structureLookback = STRUCTURE_LOOKBACK, pivotLookback = PIVOT_LOOKBACK } = {}
) {
  const markers = [];
  const taken = [];

  const structure = createStructureTracker({ leftLength: structureLookback, rightLength: structureLookback });

  // A minor pivot can only become an IDM if its bar lies strictly after this
  // index — the latest structure break. Starts at -1 rather than Infinity:
  // arming no longer waits for a known trend (both sides track regardless), so
  // pivots count from the first confirmable one. (Takes do not move this: with
  // multiple levels live at once there is nothing to "re-arm".)
  let armAfterHighIndex = -1;
  let armAfterLowIndex = -1;

  // Every pullback becomes its own pending IDM level, each taken independently
  // when price wicks it — highs and lows tracked in parallel so both
  // directions are live at the same time.
  let pendingHighs = []; // [{ price, fromTime, trend }]
  let pendingLows = [];

  for (let j = 0; j < candles.length; j++) {
    const bar = candles[j];

    // 1. Market structure first, exactly like the indicator's main flow
    //    (Pivot → ChangeOfCharacter → BreakOfStructure).
    const { trend, breakOccurred } = structure.step(candles, j);

    // 2. Minor pivots confirm pivotLookback bars late; the first one whose
    //    bar lies after the arm point becomes the IDM on the counter-trend
    //    side. Uses the just-updated trend, and — on a break bar — the arm
    //    point from BEFORE the break, matching the indicator's order where
    //    creation runs before the break handler (the new IDM then dies in
    //    step 4 below, which is the indicator's behavior too).
    //    Both directions arm regardless of trend: every minor HIGH is
    //    liquidity above and every minor LOW is liquidity below, so each side
    //    tracks independently and the chart shows inducement on both at once.
    //    `trend` is therefore no longer a gate — it only labels which side is
    //    with- or counter-trend for the consumer.
    const mi = j - pivotLookback;
    if (mi >= pivotLookback) {
      if (isSwingHigh(candles, mi, pivotLookback) && mi > armAfterHighIndex) {
        pendingHighs.push({ price: candles[mi].high, fromTime: candles[mi].time, trend });
      }
      if (isSwingLow(candles, mi, pivotLookback) && mi > armAfterLowIndex) {
        pendingLows.push({ price: candles[mi].low, fromTime: candles[mi].time, trend });
      }
    }

    // 3. Take check: a wick touching the level takes the inducement. The
    //    confirming bar of the IDM pivot has a strictly lower high (higher
    //    low), so an IDM can never be taken on its own creation bar.
    //    One bar can sweep several stacked levels at once, so every pending
    //    level is tested and all the hit ones resolve on this bar. A single
    //    marker per side keeps the chart readable when that happens.
    let tookHigh = false;
    pendingHighs = pendingHighs.filter((p) => {
      if (bar.high < p.price) return true;
      taken.push({
        id: `high:${p.fromTime}`,
        side: 'high',
        price: p.price,
        fromTime: p.fromTime,
        toTime: bar.time,
        swept: true,
        // Trend when the level formed: a high in a bearish trend is the
        // classic counter-trend inducement, a high in a bullish one is
        // with-trend liquidity. Lets the caller style or filter the two.
        counterTrend: p.trend === -1,
      });
      tookHigh = true;
      return false;
    });
    if (tookHigh) {
      markers.push({ time: bar.time, position: 'aboveBar', color: SWEEP_HIGH_COLOR, shape: 'arrowDown', text: 'IDM' });
    }

    let tookLow = false;
    pendingLows = pendingLows.filter((p) => {
      if (bar.low > p.price) return true;
      taken.push({
        id: `low:${p.fromTime}`,
        side: 'low',
        price: p.price,
        fromTime: p.fromTime,
        toTime: bar.time,
        swept: true,
        counterTrend: p.trend === 1,
      });
      tookLow = true;
      return false;
    });
    if (tookLow) {
      markers.push({ time: bar.time, position: 'belowBar', color: SWEEP_LOW_COLOR, shape: 'arrowUp', text: 'IDM' });
    }

    // 4. A structure break invalidates whatever is still pending — including
    //    an IDM created earlier this same bar (indicator behavior) — and
    //    restarts the cycle from the break bar.
    if (breakOccurred) {
      pendingHighs = [];
      pendingLows = [];
      armAfterHighIndex = j;
      armAfterLowIndex = j;
    }
  }

  const lastTime = candles.length ? candles[candles.length - 1].time : 0;
  const segments = [...taken];
  for (const p of pendingHighs) {
    segments.push({
      id: `high:${p.fromTime}`,
      side: 'high',
      price: p.price,
      fromTime: p.fromTime,
      toTime: lastTime,
      swept: false,
      counterTrend: p.trend === -1,
    });
  }
  for (const p of pendingLows) {
    segments.push({
      id: `low:${p.fromTime}`,
      side: 'low',
      price: p.price,
      fromTime: p.fromTime,
      toTime: lastTime,
      swept: false,
      counterTrend: p.trend === 1,
    });
  }

  return { markers, segments };
}
