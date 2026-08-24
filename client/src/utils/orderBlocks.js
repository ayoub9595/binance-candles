// FVG-based order blocks.
//
// A fair value gap points at an order block: the candle its imbalance launched
// from. WHICH candle that is gets resolved by walking back from the gap. When a
// 3-candle gap prints (see fvg.js), the search starts at the candle BEFORE the
// displacement (middle) candle and steps further back for as long as the candle
// behind swallowed it whole without eating the imbalance — and gives up
// entirely when no candle back there qualifies, so a gap can also resolve to no
// zone at all. A bullish FVG marks a demand OB, a bearish FVG a supply OB. The
// zone is the resolved origin candle's full high–low range.
//
// Origin resolution — cand is the candidate (C1 to begin with), prev the candle
// right behind it, and C3 the gap's third candle, whose extreme is the gap's FAR
// edge (C3.low for demand, C3.high for supply). At each step:
//   1. Reach — cand extends past prev on its own side (cand.low <= prev.low for
//      demand, cand.high >= prev.high for supply): cand IS the order block, the
//      walk stops. Ties count, so matching prev's extreme is enough. Nothing is
//      asked of the other side — unlike the position filter this replaces, a
//      demand origin may print a HIGHER high than prev and still be the zone.
//   2. Eaten — prev engulfs cand outright (prev.high > cand.high AND
//      prev.low < cand.low). Then prev, not cand, is where the move really came
//      from, so the zone MOVES BACK ONTO prev — but only while prev still keeps
//      a gap against C3 (prev.high < C3.low for demand, prev.low > C3.high for
//      supply). The walk then repeats from prev, so a run of nested engulfing
//      candles resolves to the earliest one that still leaves an imbalance.
//      If prev has traded through the whole gap instead, the walk stops and
//      keeps cand — the last candle that does keep the gap.
//   3. Neither — cand sits entirely on top of prev (prev.low < cand.low with
//      prev.high <= cand.high). A demand origin that never dug below its
//      predecessor is no origin at all: no zone.
// Rules 1 and 2 are mutually exclusive — engulfing needs prev.low < cand.low,
// which is exactly what rule 1 rules out — so the order they are tested in
// cannot matter. The walk strictly steps back, so it always terminates.
//
// Running out of history yields NO zone, at any point in the walk and not just
// at the start: every candidate needs a candle behind it to be judged against,
// and a walk that reaches the left edge of the loaded window has not finished.
// This is deliberately fail-closed. Keeping the edge candle instead would mean
// a zone that MOVES — or disappears under rule 3 — the moment older bars load
// in and the walk can continue, and a box that jumps when history arrives is
// worse than a box that shows up late. Only gaps within a few bars of the
// window's left edge are affected.
//
// Because origins relocate, two different gaps can resolve to the SAME candle.
// The first (earliest-detected) one wins and later re-detections of that
// (direction, origin) are ignored — one zone per origin candle per side, which
// keeps ids unique for callers that key on them, and keeps the result
// prefix-stable since "first" is decided causally.
//
// Lifecycle: the zone extends right while price stays away ("fresh"). The
// first wick back into it mitigates it — the box freezes at that bar. All
// zones are returned, fresh and mitigated — display filtering/capping is the
// caller's job, which keeps this function purely prefix-stable.
//
// Mitigation is only ever evaluated on bars AFTER the one a zone was detected
// on, which is what keeps a relocated origin from mitigating itself: the
// candles between the resolved origin and the gap's first leg are nested
// INSIDE the zone by construction (each step back happens because the earlier
// candle engulfed the later one), so they are part of the zone's formation, not
// taps on it. Every zone's top also stays below the gap's far edge — the walk
// only ever steps onto a candle that still keeps the gap — so the third candle
// sits clear of it either way.
//
// No lookahead: an OB is known the moment the gap's third candle closes, and
// mitigation is evaluated per bar in order — feeding a growing prefix of
// candles (bar replay) yields exactly what was knowable at that moment. The
// walk reads only bars at or before the gap's third candle, all of them closed
// by then.

// Walks back from `start` and returns the index of the order block candle, or
// -1 if the gap leaves none. gapFar is C3's extreme on the gap's far side.
function resolveOrigin(candles, start, gapFar, bullish) {
  let i = start;
  for (;;) {
    if (i === 0) return -1; // ran out of history behind the candidate
    const cand = candles[i];
    const prev = candles[i - 1];
    // 1. Reach.
    if (bullish ? cand.low <= prev.low : cand.high >= prev.high) return i;
    // 2. Eaten — engulfing is direction-agnostic: prev covers cand both sides.
    if (prev.high > cand.high && prev.low < cand.low) {
      const prevKeepsGap = bullish ? prev.high < gapFar : prev.low > gapFar;
      if (!prevKeepsGap) return i; // prev exhausted the gap: cand is the one that keeps it
      i -= 1;
      continue;
    }
    // 3. Neither.
    return -1;
  }
}

// candles: ascending toChartBar array ({time: sec, open, high, low, close}).
// Returns { boxes: [{ id, dir: 'bullish'|'bearish', top, bottom, fromTime,
//                     detectedTime, toTime, mitigated }] } — fromTime is the
// resolved origin candle, which may sit further back than the gap's first leg;
// detectedTime is the gap's third candle, i.e. the bar on which the zone first
// became KNOWN, which is what a replay has to key off to answer "has this zone
// printed yet?"; toTime is the mitigation bar for tapped zones, the last bar
// for fresh ones.
export function computeFvgOrderBlocks(candles) {
  const done = [];
  const active = [];
  const seen = new Set(); // ids already emitted — origins can be reached twice

  for (let j = 2; j < candles.length; j++) {
    const bar = candles[j];

    // Mitigation first: the current bar can tap existing zones. A zone's own
    // pattern can't tap it — see the header.
    for (let k = active.length - 1; k >= 0; k--) {
      const ob = active[k];
      const touched = ob.dir === 'bullish' ? bar.low <= ob.top : bar.high >= ob.bottom;
      if (touched) {
        done.push({ ...ob, toTime: bar.time, mitigated: true });
        active.splice(k, 1);
      }
    }

    const bullish = bar.low > candles[j - 2].high;
    const bearish = !bullish && bar.high < candles[j - 2].low;
    if (!bullish && !bearish) continue;

    const oi = resolveOrigin(candles, j - 2, bullish ? bar.low : bar.high, bullish);
    if (oi < 0) continue;

    const origin = candles[oi];
    const id = `ob:${bullish ? 'bullish' : 'bearish'}:${origin.time}`;
    if (seen.has(id)) continue; // this origin already carries a zone on this side
    seen.add(id);
    active.push({
      id,
      dir: bullish ? 'bullish' : 'bearish',
      top: origin.high,
      bottom: origin.low,
      fromTime: origin.time,
      detectedTime: bar.time,
    });
  }

  const lastTime = candles.length ? candles[candles.length - 1].time : 0;
  return {
    boxes: [
      ...done,
      ...active.map((ob) => ({ ...ob, toTime: lastTime, mitigated: false })),
    ],
  };
}
