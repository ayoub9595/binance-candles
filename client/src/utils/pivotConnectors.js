// Pivot connector chains — the sloped dotted lines that link consecutive
// swing highs to each other and consecutive swing lows to each other.
//
// What they are for: a BOS/CHoCH label tells you a level broke, but not the
// shape of the approach. Joining the swing points of a leg draws that shape
// directly — a fan of rising lows under a rising high chain reads as an
// intact bullish leg at a glance, and the moment the two chains stop agreeing
// is visible before the structure engine has anything to say about it. The
// reference "Liquidity & inducements" screenshot draws exactly this.
//
// Why it reuses createStructureTracker instead of scanning for fractals
// itself: the LEG BOUNDARIES have to be the same ones the app draws BOS/CHoCH
// labels on. Re-deriving breaks independently would drift from those labels,
// and a chain that stops one bar off the label it is supposed to stop at is
// worse than no chain. The pivot geometry, by contrast, is deliberately NOT
// subject to the engine's bookkeeping: `pivots` is reported at confirmation
// time, before onChoch() prunes and outside the 6-entry cap, so the point set
// is exactly the raw 5/5 fractal set. That is intended — a swing that happened
// is still a swing after a later CHoCH invalidated it for break purposes, and
// the chain is drawing the shape of the move, not the engine's live state.
//
// Legs: a leg is the span between consecutive structure breaks. legIndex
// starts at 0 and increments on every breakOccurred, so ids stay stable
// across recomputes — leg n is leg n no matter how many bars have since
// arrived. Chains from closed legs stay in the output; capping how many are
// actually drawn is the caller's job, same as with inducement segments.
//
// Same-bar tie-break: a pivot can confirm on the very bar a break fires
// (pivots confirm `lookback` bars late, so the two are unrelated events that
// happen to land together). Such a pivot is assigned to the leg that was
// CURRENT when it confirmed — i.e. the OLD leg, closed by this bar's break.
// That mirrors the structure engine's own ordering, where Pivot() runs before
// ChangeOfCharacter()/BreakOfStructure(), and it is what the chain geometry
// wants: the pivot is a swing of the move that just ended, and the break is
// the thing that ended it, so the chain should reach that point and stop
// rather than open the next leg with a stale point behind the break.
//
// Causal / prefix-stable like everything else here: one forward pass, chains
// are only ever appended to, and the in-progress leg is emitted too so its
// chain grows point by point as pivots confirm during replay.

import { createStructureTracker } from './priceActionStructure.js';

const LOOKBACK = 5; // matches the app's market-structure pivots

// candles: ascending toChartBar array ({time: sec, open, high, low, close}).
// Returns { chains: [{ id, side: 'high'|'low', legIndex, points }] } where
// points is [{ time, value }, ...] ascending by time. A chain is emitted only
// once it has at least 2 points — a lone pivot is a dot, not a connector.
export function computePivotConnectors(candles, { lookback = LOOKBACK } = {}) {
  const chains = [];
  const structure = createStructureTracker({ leftLength: lookback, rightLength: lookback });

  let legIndex = 0;
  let highPoints = [];
  let lowPoints = [];

  // Closes the current leg into the output. Called on every break and once
  // more at the end for the still-open leg, which is why the in-progress
  // chain is visible during replay rather than appearing only once its leg
  // has been broken.
  function emitLeg() {
    if (highPoints.length >= 2) {
      chains.push({ id: `high:${legIndex}`, side: 'high', legIndex, points: highPoints });
    }
    if (lowPoints.length >= 2) {
      chains.push({ id: `low:${legIndex}`, side: 'low', legIndex, points: lowPoints });
    }
  }

  for (let j = 0; j < candles.length; j++) {
    const { breakOccurred, pivots } = structure.step(candles, j);

    // Pivots arrive in bar order and each bar index confirms at most once, so
    // pushing as they come already yields points ascending by time — no sort
    // needed, and none wanted (a sort would hide an ordering bug upstream).
    for (const p of pivots) {
      if (p.type === 1) highPoints.push({ time: p.time, value: p.price });
      else lowPoints.push({ time: p.time, value: p.price });
    }

    // Break closes the leg AFTER this bar's pivots were absorbed — the
    // same-bar rule documented in the header.
    if (breakOccurred) {
      emitLeg();
      highPoints = [];
      lowPoints = [];
      legIndex += 1;
    }
  }

  emitLeg(); // the leg still open at the right edge

  return { chains };
}
