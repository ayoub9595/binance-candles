// Buy-side reversal candle patterns forming IN CONTACT WITH a demand order block
// while price retests it — the classic "wait for the zone, then wait for the
// candle" entry trigger, made explicit on the chart.
//
// Three patterns, deliberately DISJOINT so each marker means one thing:
//   'engulf'  Bullish Engulfing — red then green, where the green BODY swallows
//             the red candle's ENTIRE RANGE, wicks included:
//             green.open <= red.low AND green.close >= red.high. Note this is
//             a full-range engulf, not the textbook body-engulfs-body: the
//             green candle has to open at or under everything the red one
//             traded and close at or above all of it.
//             The bounds are inclusive on purpose. Strict < and > would demand
//             a genuine gap-down open, and continuous exchange data barely ever
//             produces one — over 6 symbols x 1500 bars of 15m, only 17
//             red-to-green pairs opened BELOW the red low while 185 opened
//             exactly AT it, so a strict reading threw away essentially every
//             real occurrence (1 hit versus 33).
//   'eat70'   The partial reversal (Rising Sun / piercing), which must satisfy
//             BOTH conditions:
//               a. its close eats back 70%..100% of the red body, and
//               b. its own LOWER wick is bigger than 70% of its own body —
//                  the rejection tail that makes it a reversal rather than
//                  just a green candle.
//             The lower wick specifically, never the upper one: a candle whose
//             long wick points UP is a shooting-star shape, and letting that
//             fire a buy trigger would be backwards.
//             The eat is capped BELOW 100% so 'engulf' and 'eat70' can never
//             both fire on one bar. That is now true by construction rather
//             than by convention: engulf forces green.close >= red.high >=
//             red.open, which puts the eat ratio at 1.0 or more, and 'eat70'
//             excludes exactly that.
//   'morning' Morning Doji Star — red, doji, green, where the green ALSO closes
//             above the midpoint of the red body. A doji is a candle whose body
//             is at most dojiFrac of its own high–low range.
//             The midpoint is inclusive: closing exactly on it counts.
//             The midpoint close is the textbook confirmation, and it is what
//             stops this from being the loosest of the three by a wide margin:
//             without it, red / small-body / green has no magnitude requirement
//             at all, so any hesitation bar between two ordinary candles counts.
//             The doji's colour is deliberately NOT constrained — a red-tinted
//             doji is still a doji, which is standard for the pattern; only its
//             body size matters.
//
// Contact: EVERY candle of the pattern must be IN TOUCH with the zone. Two
// modes, selectable per call:
//   'touch'  (default) each candle reaches into the zone — its low is at or
//            below the zone top, and its high at or above the zone bottom. The
//            candle may close or wick out above the top, and may dip below the
//            bottom; what matters is that no candle of the pattern is off the
//            zone. This is the rule to use for real retest entries: the
//            reversal candle that actually rejects a demand zone routinely
//            closes back above its top, and strict containment throws exactly
//            those away.
//   'inside' each candle sits entirely within the zone (high <= top and
//            low >= bottom). Much stricter; kept because it is a useful
//            "the whole reversal happened in the zone" filter.
// `low <= top` uses the same touching-counts convention as the detector's own
// mitigation test, so a candle grazing the top edge counts as contact.
// The `high >= bottom` half only rules out candles sitting entirely BELOW the
// zone, which nothing would call touching it.
//
// Expressed over the whole pattern, both modes are two comparisons:
//   'touch'  max(low) <= top  and  min(high) >= bottom
//   'inside' max(high) <= top and  min(low)  >= bottom
//
// Only DEMAND (bullish) zones are considered: these are long triggers. The
// supply mirror would be the same three shapes inverted (green then red,
// evening doji star) against bearish zones.
//
// Eligibility: the pattern's first candle must close strictly AFTER the zone's
// detectedTime, so a zone can only be triggered by bars that came after it was
// knowable. Mitigation state is deliberately ignored — a "retest" is any return
// into the zone, and most zones are re-entered many times after the first tap,
// so gating on mitigated would throw away nearly every trigger.
//
// A pattern can be in contact with several overlapping zones at once, and the
// looser 'touch' mode makes that common. Only ONE hit is emitted per
// (pattern, bar), attributed to the zone with the LATEST origin — the freshest
// one it touches. That keeps one marker per signal instead of one per zone, and
// the choice is deterministic, so it is prefix-stable.
//
// No lookahead: a pattern is known the moment its last candle closes, the zone
// it needs was known before its first candle, and the contact test reads only
// those bars — feeding a growing prefix of candles (bar replay) yields exactly
// what was knowable at that moment. Nothing here is ever revised by later
// bars.

// Noise guards, not part of the pattern definitions. Both default ON because an
// unguarded scan buries the chart: pass 0 to disable either.
//   minBodyFrac — the reversal (green) candle's body must be at least this
//                 fraction of the zone's height. Without it, a two-tick wiggle
//                 deep inside a wide zone counts the same as a real rejection.
//   minZonePct  — the zone itself must be at least this % of price tall. A
//                 zone one tick high makes every body "100% of the zone", which
//                 floods stablecoin-like series with meaningless hits.
const DEFAULT_CONTAINMENT = 'touch';
const DEFAULT_DOJI_FRAC = 0.1;
const DEFAULT_EAT_MIN = 0.7;
// The reversal candle's lower wick must exceed this multiple of its own body.
const DEFAULT_WICK_MIN = 0.7;
// Morning star confirmation: the green must close this far up the red body.
// 0.5 is the classic midpoint; 0 disables the check.
const DEFAULT_MORNING_CLOSE_FRAC = 0.5;
const DEFAULT_MIN_BODY_FRAC = 0.15;
const DEFAULT_MIN_ZONE_PCT = 0.2;

function isRed(c) {
  return c.close < c.open;
}

function isGreen(c) {
  return c.close > c.open;
}

function isDoji(c, dojiFrac) {
  const range = c.high - c.low;
  return range > 0 && Math.abs(c.close - c.open) <= dojiFrac * range;
}

// The tail below the body. For a green candle that is open - low.
function lowerWick(c) {
  return Math.min(c.open, c.close) - c.low;
}

// How much of the red body the green close ate back, as a ratio. null when the
// red candle has no body to measure against.
function eatenRatio(r, g) {
  const body = r.open - r.close;
  return body > 0 ? (g.close - r.close) / body : null;
}

function matchEngulf(candles, k) {
  const r = candles[k];
  const g = candles[k + 1];
  if (!isRed(r) || !isGreen(g)) return false;
  return g.open <= r.low && g.close >= r.high;
}

// candles: ascending toChartBar array ({time: sec, open, high, low, close}).
// boxes:   computeFvgOrderBlocks() output for the SAME candles.
// Returns { hits: [{ id, pattern, time, startTime, span, zoneId, zoneTop,
//                    zoneBottom, bodyFrac, depthPct, eatenPct, visit }] } in
// ascending time order — `time` is the pattern's LAST candle (the bar the
// signal completes on, which is where a marker belongs), startTime its first.
// bodyFrac and depthPct are percentages of the zone height; depthPct is how far
// below the zone's top the pattern's lowest low reached, so 0 is right at the
// top edge and 100 is all the way down to the bottom. In 'touch' mode depthPct
// can exceed 100: the pattern is allowed to trade below the zone as long as
// every candle still makes contact with it. visit counts which entry
// into the zone this is, 1 being the first touch after detection.
// All hits are returned — display capping is the caller's job, which keeps this
// function purely prefix-stable.
export function computeObRetestPatterns(candles, boxes, options = {}) {
  const {
    containment = DEFAULT_CONTAINMENT,
    dojiFrac = DEFAULT_DOJI_FRAC,
    eatMin = DEFAULT_EAT_MIN,
    wickMin = DEFAULT_WICK_MIN,
    morningCloseFrac = DEFAULT_MORNING_CLOSE_FRAC,
    minBodyFrac = DEFAULT_MIN_BODY_FRAC,
    minZonePct = DEFAULT_MIN_ZONE_PCT,
  } = options;
  const strict = containment === 'inside';

  const hits = [];
  if (!candles || candles.length < 2 || !boxes || !boxes.length) return { hits };

  // Demand zones only, tall enough to be worth measuring against. Left in the
  // order the detector emitted them: origins relocate, so origin order and
  // detection order genuinely disagree, and the pick below compares explicitly
  // rather than relying on either.
  const zones = boxes.filter(
    (b) =>
      b.dir === 'bullish' &&
      b.top > b.bottom &&
      (minZonePct <= 0 || ((b.top - b.bottom) / b.bottom) * 100 >= minZonePct)
  );
  if (!zones.length) return { hits };

  const indexByTime = new Map();
  for (let i = 0; i < candles.length; i++) indexByTime.set(candles[i].time, i);

  // Which entry into the zone bar `at` belongs to. Counted from the bar after
  // detection, incrementing on every transition from outside to inside, where
  // "inside" is the zone's full range touching the bar's range — the same test
  // the detector's mitigation uses, so visit 1 is always the mitigation bar.
  const visitNumber = (zone, at) => {
    const from = indexByTime.get(zone.detectedTime);
    if (from === undefined) return 0;
    let n = 0;
    let wasIn = false;
    for (let i = from + 1; i <= at; i++) {
      const c = candles[i];
      const nowIn = c.low <= zone.top && c.high >= zone.bottom;
      if (nowIn && !wasIn) n += 1;
      wasIn = nowIn;
    }
    return n;
  };

  // pattern spec: [name, span, matcher]. Evaluated per bar so the outer loop
  // stays over candles — pattern tests are cheap, zone containment is not.
  const specs = [
    ['engulf', 2, (cs, k) => matchEngulf(cs, k)],
    [
      'eat70',
      2,
      (cs, k) => {
        const r = cs[k];
        const g = cs[k + 1];
        if (!isRed(r) || !isGreen(g)) return false;
        const e = eatenRatio(r, g);
        if (e === null || e < eatMin || e >= 1) return false;
        // g is green, so its body is strictly positive and this cannot divide
        // by zero or admit a doji.
        if (lowerWick(g) <= wickMin * (g.close - g.open)) return false;
        // Redundant given e < 1 (see the header proof), kept as belt and braces
        // so loosening 'engulf' later cannot silently make the two overlap.
        return !matchEngulf(cs, k);
      },
    ],
    [
      'morning',
      3,
      (cs, k) => {
        const r = cs[k];
        if (!isRed(r) || !isDoji(cs[k + 1], dojiFrac)) return false;
        const g = cs[k + 2];
        if (!isGreen(g)) return false;
        if (morningCloseFrac <= 0) return true;
        // Measured up from the red CLOSE toward its OPEN, so the fraction reads
        // the same way the eat ratio does: 0.5 is the middle of the red body.
        // Inclusive, like every other threshold here — a close landing exactly
        // ON the midpoint counts. Real data lands on it more often than one
        // would guess, because the midpoint of a body an even number of ticks
        // tall is itself a tick.
        return g.close >= r.close + morningCloseFrac * (r.open - r.close);
      },
    ],
  ];

  for (const [pattern, span, matches] of specs) {
    for (let k = 0; k + span <= candles.length; k++) {
      if (!matches(candles, k)) continue;
      const first = candles[k];
      const last = candles[k + span - 1];
      const body = last.close - last.open;

      // Four extremes, because the two contact modes need different pairs:
      // 'inside' compares the pattern's outer bounds (maxHigh/minLow) against
      // the zone, 'touch' compares its inner ones (maxLow/minHigh) — "every
      // candle's low is under the top" is exactly "the highest low is under the
      // top". minLow is kept either way, since depthPct is measured from it.
      let maxHigh = -Infinity;
      let minLow = Infinity;
      let maxLow = -Infinity;
      let minHigh = Infinity;
      for (let n = 0; n < span; n++) {
        const c = candles[k + n];
        if (c.high > maxHigh) maxHigh = c.high;
        if (c.low < minLow) minLow = c.low;
        if (c.low > maxLow) maxLow = c.low;
        if (c.high < minHigh) minHigh = c.high;
      }
      const contacts = strict
        ? (z) => maxHigh <= z.top && minLow >= z.bottom
        : (z) => maxLow <= z.top && minHigh >= z.bottom;

      // Freshest zone this pattern QUALIFIES against: among zones that were
      // already known, are in contact, and pass the body guard, the latest
      // origin wins. Deterministic, because the detector emits at most one
      // demand zone per origin candle.
      //
      // The body guard is applied HERE, as part of eligibility, rather than to
      // the winner afterwards. Attributing first and guarding second lets a
      // fresher but TALLER zone shadow the signal: the body can be a decisive
      // rejection of the tight zone it touches and still fall under 15% of a
      // wider one overlapping it, and the hit would be dropped even though a
      // zone it genuinely qualifies against was right there. Folding the guard
      // into the test also keeps 'inside' results a strict subset of 'touch'
      // ones, since contact only ever widens the candidate set and each zone is
      // judged on its own height.
      let zone = null;
      let height = 0;
      for (const z of zones) {
        if (z.detectedTime >= first.time) continue; // not knowable yet
        if (!contacts(z)) continue; // pattern is not in touch with this zone
        const zh = z.top - z.bottom;
        if (minBodyFrac > 0 && body < minBodyFrac * zh) continue; // not decisive here
        if (!zone || z.fromTime > zone.fromTime) {
          zone = z;
          height = zh;
        }
      }
      if (!zone) continue;

      const eaten = eatenRatio(first, last);
      hits.push({
        id: `obx:${pattern}:${last.time}`,
        pattern,
        time: last.time,
        startTime: first.time,
        span,
        zoneId: zone.id,
        zoneTop: zone.top,
        zoneBottom: zone.bottom,
        bodyFrac: (body / height) * 100,
        depthPct: ((zone.top - minLow) / height) * 100,
        eatenPct: eaten === null ? null : eaten * 100,
        visit: visitNumber(zone, k),
      });
    }
  }

  // One pass per pattern means hits come out grouped by pattern; the chart
  // needs strict ascending time across all of them.
  hits.sort((a, b) => a.time - b.time || (a.pattern < b.pattern ? -1 : 1));
  return { hits };
}
