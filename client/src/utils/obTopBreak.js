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
//   - The top: walking backwards from the origin candle, every bar of the
//     creating decline shows a higher high than everything nearer the zone;
//     the walk follows those backwards records and stops at the first bar
//     that fails to set one. The last record bar is the top and its high is
//     the target (by construction the maximum of the walked stretch). The
//     first step is guaranteed — a demand origin has a lower high than its
//     predecessor (the zone's own position filter) — so every zone has a
//     real top; no null targets. If the decline contained a pullback whose
//     high exceeded the bars before it, the walk stops there: the nearest
//     top that created the final dig is the one the zone answers to. Supply
//     mirrors on lows (backwards low-records; target = the valley's low).
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
// after a failed window.
export function computeObTopBreaks(candles, boxes) {
  const result = new Map();
  if (!candles.length) return result;

  const indexByTime = new Map();
  for (let i = 0; i < candles.length; i++) indexByTime.set(candles[i].time, i);

  for (const b of boxes) {
    const origin = indexByTime.get(b.fromTime);
    if (origin === undefined) continue; // trimmed out of the mirror
    const bullish = b.dir === 'bullish';

    // Walk the creating leg back from the origin. Strict records: an equal
    // high (double top) stops the walk — the twin sits at the same price, so
    // the target is unaffected by which twin ends the walk, and anything
    // higher BEYOND the twin is deliberately excluded: a double top is its
    // own stall, so the final decline starts there (nearest-cause rule).
    let target = bullish ? candles[origin].high : candles[origin].low;
    let targetIdx = origin;
    for (let i = origin - 1; i >= 0; i--) {
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
