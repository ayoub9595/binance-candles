// "Summit break" validation for order blocks.
//
// The model: the inducement is based on the ORDER BLOCK itself. A demand zone
// is created by a bearish push — the decline that dug the bottom (the cave)
// the zone sits in. Walk that decline back from the zone's origin candle to
// where it started: the TOP that created the setup. THE order block is the
// zone whose move off it prints a high superior to that top. A supply zone
// mirrors: the valley its own rally rose from, broken downward.
//
// Rules, per zone:
//   - The top: the walk back has two phases, and both exist because the top
//     has to sit STRICTLY ABOVE the origin candle to be worth breaking.
//       1. Clear the zone's own extreme. Bars immediately behind the origin
//          that do not exceed its high are part of the same dig — they are
//          not the top the decline came from. Step back over them to the
//          first bar with a genuinely higher high (lower low for supply);
//          that bar seeds the walk.
//       2. Follow backwards records from the seed: keep stepping while each
//          earlier bar sets a new high (a new low for supply), and stop at
//          the first that does not. The last record bar is the top and its
//          high is the target — by construction the maximum of the walked
//          stretch. If the decline contained a pullback whose high exceeded
//          the bars before it, the walk stops there: the nearest top that
//          created the final dig is the one the zone answers to.
//     Phase 1 is why the target beats the origin's own extreme even though
//     detection makes no promise about the origin's far side. orderBlocks.js
//     keeps a demand zone when its LOW reaches past the candle behind it and
//     says nothing about the highs, so the bar behind an origin may well sit
//     lower — the case that used to be impossible, and the case that would
//     otherwise collapse the target onto the origin itself. (A zone that
//     resolved through the engulfing branch is the opposite: the bar behind it
//     engulfs it, so phase 1 finds its seed on the first step and does nothing.)
//     Whenever the bar right behind the origin already prints a higher high,
//     phase 1 stops there immediately and phase 2 alone runs, which is exactly
//     the walk this file has always done — the two phases only ever ADD a
//     target where there was none, never move one that existed.
//     Relocated origins are safe here too: the candles between a walked-back
//     origin and its gap are nested inside the zone, so their highs are below
//     the origin's own and they can neither seed phase 1 nor take the target.
//     The break still has to come from the displacement onward.
//     A zone whose origin is the highest high (lowest low) in the loaded
//     history behind it has no top at all and gets NO entry in the returned
//     map: absent means "no verdict", which every caller already treats as
//     "does not pass the filter" (fail-closed), rather than a null target
//     that would draw a level line at nothing.
//   - The break: wick to or through — high >= target for demand, low <=
//     target for supply. No close/body requirement, and touching counts: the
//     top is inducement liquidity, so this is the same "wicks to or through"
//     rule the IDM engine (inducement.js) uses for its takes.
//   - The window: the break has to happen while the move off the zone is
//     still running — at or before the bar that first trades back into the
//     zone (its mitigation bar; a single bar can tap the zone and take the
//     top at once, and that break is still this move's doing). Once price
//     has re-entered the zone, a later break belongs to a new move, so the
//     zone stays invalid. Fresh zones stay eligible through the last bar.
//
// No lookahead, replay-friendly: the walk reads only bars at or before the
// origin, so a zone's target is fixed from the moment the zone prints and is
// identical in every prefix that contains it; the break scan is causal, so a
// verdict only ever moves forward — pending → broke (frozen at the break
// bar) or pending → failed (frozen at mitigation) — never backwards.

// candles: ascending toChartBar array ({time: sec, open, high, low, close});
// boxes: computeFvgOrderBlocks() output (same candles, same tick).
// Returns Map<box.id, { broke, targetPrice, targetTime, breakTime }> —
// targetTime is the bar the top printed on (so the caller can draw the level
// from its birth), breakTime the bar that took it, null while pending or
// after a failed window. Zones with no top behind them are simply absent.
export function computeObTopBreaks(candles, boxes) {
  const result = new Map();
  if (!candles.length) return result;

  const indexByTime = new Map();
  for (let i = 0; i < candles.length; i++) indexByTime.set(candles[i].time, i);

  for (const b of boxes) {
    const origin = indexByTime.get(b.fromTime);
    if (origin === undefined) continue; // trimmed out of the mirror
    const bullish = b.dir === 'bullish';

    // Phase 1 — step back over the zone's own dig to the first bar that
    // actually rises above the origin. Anything at or below the origin's high
    // is no target: the displacement candle already trades through it, so a
    // "break" of it would be free.
    const originExtreme = bullish ? candles[origin].high : candles[origin].low;
    let seed = -1;
    for (let i = origin - 1; i >= 0; i--) {
      const v = bullish ? candles[i].high : candles[i].low;
      if (bullish ? v > originExtreme : v < originExtreme) {
        seed = i;
        break;
      }
    }
    if (seed < 0) continue; // no top behind the zone in loaded history

    // Phase 2 — follow the creating leg back from the seed. Strict records: an
    // equal high (double top) stops the walk — the twin sits at the same
    // price, so the target is unaffected by which twin ends the walk, and
    // anything higher BEYOND the twin is deliberately excluded: a double top
    // is its own stall, so the final decline starts there (nearest-cause
    // rule).
    let target = bullish ? candles[seed].high : candles[seed].low;
    let targetIdx = seed;
    for (let i = seed - 1; i >= 0; i--) {
      const v = bullish ? candles[i].high : candles[i].low;
      if (bullish ? v > target : v < target) {
        target = v;
        targetIdx = i;
      } else break;
    }

    // Mitigated zones scan through their mitigation bar. The index lookup
    // cannot miss under current wiring (boxes and candles come from the same
    // array on the same tick) — but if it ever did, an empty window
    // (fail-closed) beats extending a tapped zone's eligibility to the last
    // bar.
    const end = b.mitigated
      ? indexByTime.get(b.toTime) ?? origin
      : candles.length - 1;
    let breakTime = null;
    for (let i = origin + 1; i <= end; i++) {
      if (bullish ? candles[i].high >= target : candles[i].low <= target) {
        breakTime = candles[i].time;
        break;
      }
    }
    result.set(b.id, {
      broke: breakTime !== null,
      targetPrice: target,
      targetTime: candles[targetIdx].time,
      breakTime,
    });
  }
  return result;
}
