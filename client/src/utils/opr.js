// Daily opening price range (OPR) for the OPRSTRATEGY workspace: the high/low
// carved out while a fixed UTC window forms each day — 00:25 to 00:35 UTC,
// i.e. the 00:25 and 00:30 candles on the 5m chart the strategy is traded on.
// Ported from the HORIIZONFX Pine reference: a candle belongs to the window
// when its OPEN time lands in [start, end), and the range's high/low lines run
// from the window to the end of that UTC day. No lookback, no repaint: a range
// has NO value at all until the window's second candle has closed — the first
// bar at/past the window end releases it — and what it releases never moves.
//
// Prefix-stable like the SMC detectors: a range is decided entirely by the
// bars inside its own day, so a replay stepping bar-by-bar sees each range
// appear exactly when it became knowable — the box growing through the
// window, the lines landing with the first bar after it.

// Window bounds as seconds-of-day, UTC. Change these two to move the window.
export const OPR_WINDOW_START_SEC = 0 * 3600 + 25 * 60; // 00:25 UTC
export const OPR_WINDOW_END_SEC = 0 * 3600 + 35 * 60; // 00:35 UTC (exclusive)

// Size filter, mirroring the Pine "Taille minimale/maximale OPR" inputs: a
// day's OPR only counts when its height lands inside [min, max], measured in
// pips — the gold convention where 1 pip is one 0.01 tick, so 300 pips =
// $3.00 and 1900 pips = $19.00, exactly the Pine's numbers. Out-of-band days
// form no tradable range and are not drawn.
export const OPR_PIP = 0.01;
export const OPR_MIN_SIZE_PIPS = 300;
export const OPR_MAX_SIZE_PIPS = 1900;

const DAY_SEC = 86400;

// bars: ascending chart bars ({ time: epoch seconds (UTC), high, low }).
// Returns ascending ranges, one per UTC day that has bars in the window:
//   { id, day, from, windowEnd, to, high, low, complete, sizePips, valid }
// `from`/`windowEnd` bound the bars that DEFINED the range (the box),
// `to` is the last bar of the range's own day seen so far (where the lines
// end), and `complete` flips once any bar at or past the window close exists
// — i.e. after the window's second candle ends, the moment the high/low get
// their one and only value. `valid` adds the size filter on top: complete AND
// sized inside [OPR_MIN_SIZE_PIPS, OPR_MAX_SIZE_PIPS]. Renderers draw
// only valid ranges — an incomplete range has no value yet, an out-of-band
// one never will. Uncapped: rendering trims, detection never does.
export function computeOprRanges(bars) {
  const ranges = [];
  let cur = null; // the range of the day currently being scanned
  for (const b of bars) {
    const day = Math.floor(b.time / DAY_SEC);
    // A new day freezes the previous range where its last bar left it.
    if (cur && cur.day !== day) cur = null;
    const sod = b.time - day * DAY_SEC;
    if (sod >= OPR_WINDOW_START_SEC && sod < OPR_WINDOW_END_SEC) {
      if (!cur) {
        cur = {
          id: day,
          day,
          from: b.time,
          windowEnd: b.time,
          to: b.time,
          high: b.high,
          low: b.low,
          complete: false,
        };
        ranges.push(cur);
      } else {
        cur.windowEnd = b.time;
        cur.to = b.time;
        if (b.high > cur.high) cur.high = b.high;
        if (b.low < cur.low) cur.low = b.low;
      }
    } else if (cur && sod >= OPR_WINDOW_END_SEC) {
      // Same day, past the window: the lines extend under the rest of it.
      cur.to = b.time;
    }
  }
  // Complete = the window has closed in bar time. Any bar at/past the close
  // settles it, including a bar from a LATER day when a thin session gapped
  // straight over its own close.
  const lastTime = bars.length ? bars[bars.length - 1].time : 0;
  for (const r of ranges) {
    r.complete = lastTime >= r.day * DAY_SEC + OPR_WINDOW_END_SEC;
    r.sizePips = (r.high - r.low) / OPR_PIP;
    r.valid = r.complete && r.sizePips >= OPR_MIN_SIZE_PIPS && r.sizePips <= OPR_MAX_SIZE_PIPS;
  }
  return ranges;
}
