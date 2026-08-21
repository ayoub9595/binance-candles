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
//   - Minor 1/1 pivots form the pullbacks. Every minor pivot that confirms
//     after the latest structure break becomes an IDM level, on BOTH sides at
//     once: every minor HIGH is liquidity above, every minor LOW is liquidity
//     below, tracked in parallel regardless of trend. Levels accumulate —
//     each pullback behind a new peak stays on the chart as its own level.
//   - An IDM is TAKEN as soon as price wicks to or through it
//     (high >= level / low <= level) — no close-back requirement. Levels are
//     independent, so one bar can sweep several stacked levels at once; each
//     resolves separately.
//   - A structure break invalidates untaken IDMs. They are still RETURNED,
//     flagged `invalidated: true` with toTime = the break bar, so callers can
//     reconstruct every level's full lifetime (armed → swept / invalidated /
//     still pending). The indicator's default "keep invalidated = false" look
//     is preserved by the DISPLAY skipping them — hiding is the caller's job,
//     like all other display filtering here.
//
// Importance tiers — why levels are not all equal:
//   Arming every pullback on both sides finds ~270 takes on 1500 bars, while
//   the reference indicator shows a handful. The difference is not a bug in
//   either: the indicator draws only the ONE canonical inducement per leg,
//   which is the liquidity a move is actually engineered to grab. So each
//   level is tagged rather than filtered, and the caller demotes instead of
//   discarding:
//     - 'major' — the canonical IDM. After every structure break, the FIRST
//       minor pivot to confirm on the COUNTER-TREND side of the (just
//       updated) trend is that leg's inducement: a LOW while trend is +1, a
//       HIGH while trend is -1. That is the pullback the leg has to sweep
//       before continuing, and it is what the indicator plots. One claim per
//       side per leg — the claim flags reset with the pending levels on every
//       break.
//     - 'minor' — everything else: the with-trend side (liquidity, but not
//       inducement for THIS leg) and every further counter-trend pullback
//       once the leg's major is already claimed.
//   While trend is 0 — before the first CHoCH, when there is no trend to be
//   counter to — nothing qualifies, so the opening leg is all minor. That is
//   correct: with no established direction there is no canonical inducement.
//   Only major takes emit a marker; the minor levels exist to be seen (drawn
//   dotted by the caller), not to shout.
//
// No lookahead: structure pivots confirm 5 bars late, minor pivots 1 bar
// late, and takes/invalidations are evaluated per bar in order — feeding a
// growing prefix of candles (bar replay) yields exactly what was knowable at
// that moment. Importance is decided at arming time from the trend then in
// force and never revised, so it is prefix-stable too.

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
//   markers  — lightweight-charts series markers at MAJOR IDM take bars only
//              (minor takes are the noise this tier system exists to demote,
//              so they stay silent and are visible purely as level lines)
//   segments — horizontal level lines, one per inducement:
//              { id, side: 'high'|'low', price, fromTime, toTime, swept,
//                invalidated, counterTrend, importance: 'major'|'minor' }
//              taken IDMs run pivot→take bar (swept: true); levels killed
//              un-swept by a structure break run pivot→break bar
//              (swept: false, invalidated: true); still-pending levels run
//              pivot→last bar (swept: false, invalidated: false), and there
//              may be several of them per side.
//              All events are returned — display capping/filtering is the
//              caller's job, which keeps this function purely prefix-stable.
export function computeInducements(
  candles,
  { structureLookback = STRUCTURE_LOOKBACK, pivotLookback = PIVOT_LOOKBACK } = {}
) {
  const markers = [];
  const resolved = []; // swept + invalidated levels, in resolution order

  const structure = createStructureTracker({ leftLength: structureLookback, rightLength: structureLookback });

  // A minor pivot can only become an IDM if its bar lies strictly after this
  // index — the latest structure break. Starts at -1 rather than Infinity:
  // arming no longer waits for a known trend (both sides track regardless), so
  // pivots count from the first confirmable one. (Takes do not move this: with
  // multiple levels live at once there is nothing to "re-arm".)
  let armAfterHighIndex = -1;
  let armAfterLowIndex = -1;

  // Per-leg claim flags for the canonical inducement. Only the first
  // counter-trend pullback of a leg is major; these say whether that slot is
  // already spent. Cleared alongside the pending levels on every structure
  // break, because a break starts a new leg with a new inducement to find.
  // (Two flags, one per side, even though a single leg has a constant trend
  // and therefore only ever one counter-trend side — the pair keeps the rule
  // "at most one major per side per leg" explicit and independent of that
  // invariant.)
  let majorHighClaimed = false;
  let majorLowClaimed = false;

  // Every pullback becomes its own pending IDM level, each taken independently
  // when price wicks it — highs and lows tracked in parallel so both
  // directions are live at the same time.
  let pendingHighs = []; // [{ price, fromTime, trend, importance }]
  let pendingLows = [];

  for (let j = 0; j < candles.length; j++) {
    const bar = candles[j];

    // 1. Market structure first, exactly like the indicator's main flow
    //    (Pivot → ChangeOfCharacter → BreakOfStructure).
    const { trend, breakOccurred } = structure.step(candles, j);

    // 2. Minor pivots confirm pivotLookback bars late; each one whose bar lies
    //    after the arm point becomes an IDM level. Uses the just-updated
    //    trend, and — on a break bar — the arm point from BEFORE the break,
    //    matching the indicator's order where creation runs before the break
    //    handler (the new IDM then dies in step 4 below, which is the
    //    indicator's behavior too).
    //    Both directions arm: every minor HIGH is liquidity above and every
    //    minor LOW is liquidity below, so each side tracks independently and
    //    the chart shows inducement on both at once. `trend` is not a gate —
    //    it decides which side is counter-trend, and thus which single pivot
    //    per leg earns 'major' (see the header). The decision is made HERE,
    //    at arming time, and frozen onto the pending record: a later break
    //    flipping the trend must not retroactively re-rank a level that is
    //    already on the chart, or replay would disagree with itself.
    const mi = j - pivotLookback;
    if (mi >= pivotLookback) {
      if (isSwingHigh(candles, mi, pivotLookback) && mi > armAfterHighIndex) {
        const counterTrend = trend === -1;
        const major = counterTrend && !majorHighClaimed;
        if (major) majorHighClaimed = true;
        pendingHighs.push({
          price: candles[mi].high,
          fromTime: candles[mi].time,
          trend,
          importance: major ? 'major' : 'minor',
        });
      }
      if (isSwingLow(candles, mi, pivotLookback) && mi > armAfterLowIndex) {
        const counterTrend = trend === 1;
        const major = counterTrend && !majorLowClaimed;
        if (major) majorLowClaimed = true;
        pendingLows.push({
          price: candles[mi].low,
          fromTime: candles[mi].time,
          trend,
          importance: major ? 'major' : 'minor',
        });
      }
    }

    // 3. Take check: a wick touching the level takes the inducement. The
    //    confirming bar of the IDM pivot has a strictly lower high (higher
    //    low), so an IDM can never be taken on its own creation bar.
    //    One bar can sweep several stacked levels at once, so every pending
    //    level is tested and all the hit ones resolve on this bar. The marker
    //    fires only if a MAJOR level was among them — a bar that clears three
    //    minor levels and one major still prints exactly one 'IDM' label, and
    //    a bar that clears only minors prints none.
    let tookMajorHigh = false;
    pendingHighs = pendingHighs.filter((p) => {
      if (bar.high < p.price) return true;
      resolved.push({
        id: `high:${p.fromTime}`,
        side: 'high',
        price: p.price,
        fromTime: p.fromTime,
        toTime: bar.time,
        swept: true,
        invalidated: false,
        // Trend when the level formed: a high in a bearish trend is the
        // classic counter-trend inducement, a high in a bullish one is
        // with-trend liquidity. Lets the caller style or filter the two.
        counterTrend: p.trend === -1,
        importance: p.importance,
      });
      if (p.importance === 'major') tookMajorHigh = true;
      return false;
    });
    if (tookMajorHigh) {
      // size 0 renders the text with no arrow glyph — how this repo draws its
      // BOS/CHoCH labels, so IDM labels sit in the same visual register.
      markers.push({ time: bar.time, position: 'aboveBar', color: SWEEP_HIGH_COLOR, shape: 'arrowDown', size: 0, text: 'IDM' });
    }

    let tookMajorLow = false;
    pendingLows = pendingLows.filter((p) => {
      if (bar.low > p.price) return true;
      resolved.push({
        id: `low:${p.fromTime}`,
        side: 'low',
        price: p.price,
        fromTime: p.fromTime,
        toTime: bar.time,
        swept: true,
        invalidated: false,
        counterTrend: p.trend === 1,
        importance: p.importance,
      });
      if (p.importance === 'major') tookMajorLow = true;
      return false;
    });
    if (tookMajorLow) {
      markers.push({ time: bar.time, position: 'belowBar', color: SWEEP_LOW_COLOR, shape: 'arrowUp', size: 0, text: 'IDM' });
    }

    // 4. A structure break invalidates whatever is still pending — including
    //    an IDM created earlier this same bar (indicator behavior) — and
    //    restarts the cycle from the break bar. The major-claim flags reset
    //    here too: the next leg gets its own canonical inducement, and a
    //    major armed earlier on this very bar (step 2) releases its claim
    //    along with the level itself. Invalidated levels are emitted, not
    //    dropped, so callers can reconstruct a level's full lifetime — that a
    //    level was still STANDING at some earlier bar even though it died
    //    un-swept later. Takes ran first (step 3), so a level swept on the
    //    break bar itself resolves as swept, never as invalidated.
    if (breakOccurred) {
      for (const p of pendingHighs) {
        resolved.push({
          id: `high:${p.fromTime}`,
          side: 'high',
          price: p.price,
          fromTime: p.fromTime,
          toTime: bar.time,
          swept: false,
          invalidated: true,
          counterTrend: p.trend === -1,
          importance: p.importance,
        });
      }
      for (const p of pendingLows) {
        resolved.push({
          id: `low:${p.fromTime}`,
          side: 'low',
          price: p.price,
          fromTime: p.fromTime,
          toTime: bar.time,
          swept: false,
          invalidated: true,
          counterTrend: p.trend === 1,
          importance: p.importance,
        });
      }
      pendingHighs = [];
      pendingLows = [];
      armAfterHighIndex = j;
      armAfterLowIndex = j;
      majorHighClaimed = false;
      majorLowClaimed = false;
    }
  }

  const lastTime = candles.length ? candles[candles.length - 1].time : 0;
  const segments = [...resolved];
  for (const p of pendingHighs) {
    segments.push({
      id: `high:${p.fromTime}`,
      side: 'high',
      price: p.price,
      fromTime: p.fromTime,
      toTime: lastTime,
      swept: false,
      invalidated: false,
      counterTrend: p.trend === -1,
      importance: p.importance,
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
      invalidated: false,
      counterTrend: p.trend === 1,
      importance: p.importance,
    });
  }

  return { markers, segments };
}
