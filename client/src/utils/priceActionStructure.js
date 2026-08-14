// Exact port of the market-structure engine from the "PriceAction" Pine
// Script library v4 by mickes (TradingView, Mozilla Public License 2.0),
// fetched from TradingView's published open-source script registry — see
// reference/PriceAction-v4.pine for the original. This is the engine the
// "Liquidity & inducements" indicator drives its trend/BOS/CHoCH from.
//
// Semantics preserved from the library:
//   - Pivot(): confirmed left/right fractal pivots (ta.pivothigh/low
//     semantics: strictly higher/lower than every bar in the window) are
//     unshifted into a per-trend array capped at 6 entries, newest first.
//   - ChangeOfCharacter() runs BEFORE BreakOfStructure() each bar. A CHoCH
//     fires on the first counter-trend pivot whose price the close CROSSES
//     (close beyond it while the previous close was not), including from the
//     unknown initial trend — so the first structure event is always CHoCH.
//     "CHoCH+" is reported instead when the pullback pivots leading into the
//     flip were already stepping that way (higher low before a bullish flip,
//     lower high before a bearish one). On a CHoCH the trend flips, pivots
//     at or before the broken pivot are pruned, survivors are barred from
//     BOS, and their CHoCH flags re-arm.
//   - BreakOfStructure() fires when the close moves beyond a with-trend
//     pivot not yet broken, deduplicated against previously broken pivots:
//     a newer, higher (bullish) / lower (bearish) already-broken pivot
//     suppresses the older break; otherwise the older record is discarded.
//   - Each pivot fires each event type at most once.
//
// The engine is a per-bar stepper so detectors can fold it into their own
// single pass. Feeding a growing prefix of candles replays identically —
// everything is causal (pivots confirm `rightLength` bars late).

function isPivotHigh(candles, i, left, right) {
  const h = candles[i].high;
  for (let k = i - left; k <= i + right; k++) {
    if (k !== i && candles[k].high >= h) return false;
  }
  return true;
}

function isPivotLow(candles, i, left, right) {
  const l = candles[i].low;
  for (let k = i - left; k <= i + right; k++) {
    if (k !== i && candles[k].low <= l) return false;
  }
  return true;
}

// Returns a tracker with step(candles, j) → { events, trend, breakOccurred }.
// events: [{ type: 'BOS'|'CHoCH'|'CHoCH+', dir: 'bullish'|'bearish', price,
//            fromTime, time }] — at most one CHoCH-type and one BOS per bar.
// trend: -1 | 0 | 1 after this bar. Call step() once per bar, in order.
export function createStructureTracker({ leftLength = 5, rightLength = 5 } = {}) {
  let pivots = []; // newest first: { price, barIndex, type, time, bosBroken, chochBroken }
  let bosHistory = []; // { barIndex, price, deleted } — broken pivots this trend
  let trend = 0;

  // The library compares the latest two opposite-side pivots to decide CHoCH
  // vs CHoCH+ (higher low before a bullish flip / lower high before a
  // bearish one). Ported mechanically, including Pine's for-loop quirk of
  // auto-reversing when `from > to` — it matters for two-element arrays.
  function isChochPlus(pivotType) {
    if (pivots.length < 2 || trend === 0) return false;
    const wantType = -pivotType; // opposite-side pivots decide the "+"
    const last = pivots.length - 2;
    for (let a = 0; a <= last; a++) {
      if (pivots[a].type !== wantType) continue;
      const step = a + 1 <= last ? 1 : -1;
      for (let b = a + 1; step === 1 ? b <= last : b >= last; b += step) {
        if (pivots[b].type !== wantType) continue;
        if (wantType === -1) return pivots[a].price > pivots[b].price; // higher low
        return pivots[a].price < pivots[b].price; // lower high
      }
      return false;
    }
    return false;
  }

  function onChoch(chochPivot) {
    bosHistory = [];
    const kept = [];
    for (const p of pivots) {
      if (p.barIndex <= chochPivot.barIndex) continue; // pruned (incl. the CHoCH pivot)
      p.bosBroken = true;
      kept.push(p);
    }
    for (const p of kept) {
      if (p.barIndex !== chochPivot.barIndex) p.chochBroken = false;
    }
    pivots = kept;
  }

  function step(candles, j) {
    const events = [];
    const bar = candles[j];

    // 1. Pivot(): confirm the candidate rightLength bars back.
    const i = j - rightLength;
    if (i >= leftLength) {
      if (isPivotHigh(candles, i, leftLength, rightLength)) {
        if (pivots.length > 5) pivots.pop();
        pivots.unshift({ price: candles[i].high, barIndex: i, type: 1, time: candles[i].time, bosBroken: false, chochBroken: false });
      }
      if (isPivotLow(candles, i, leftLength, rightLength)) {
        if (pivots.length > 5) pivots.pop();
        pivots.unshift({ price: candles[i].low, barIndex: i, type: -1, time: candles[i].time, bosBroken: false, chochBroken: false });
      }
    }

    const prevClose = j > 0 ? candles[j - 1].close : NaN;

    // 2. ChangeOfCharacter() — crossing close on a counter-trend pivot.
    let chochFired = false;
    for (const pivot of pivots) {
      if (trend <= 0 && pivot.type === 1 && bar.close > pivot.price && prevClose < pivot.price && !pivot.chochBroken) {
        pivot.chochBroken = true;
        const type = isChochPlus(pivot.type) ? 'CHoCH+' : 'CHoCH';
        trend = 1;
        onChoch(pivot);
        events.push({ type, dir: 'bullish', price: pivot.price, fromTime: pivot.time, time: bar.time });
        chochFired = true;
        break;
      } else if (trend >= 0 && pivot.type === -1 && bar.close < pivot.price && prevClose > pivot.price && !pivot.chochBroken) {
        pivot.chochBroken = true;
        const type = isChochPlus(pivot.type) ? 'CHoCH+' : 'CHoCH';
        trend = -1;
        onChoch(pivot);
        events.push({ type, dir: 'bearish', price: pivot.price, fromTime: pivot.time, time: bar.time });
        chochFired = true;
        break;
      }
    }

    // 3. BreakOfStructure() — close beyond a with-trend pivot, deduped
    //    against already-broken ones. (After a CHoCH this bar, survivors are
    //    all bosBroken, so nothing double-fires.)
    let bosFired = false;
    for (const pivot of pivots) {
      const bullish = trend === 1 && pivot.type === 1 && bar.close > pivot.price && !pivot.bosBroken;
      const bearish = trend === -1 && pivot.type === -1 && bar.close < pivot.price && !pivot.bosBroken;
      if (!bullish && !bearish) continue;
      let create = true;
      for (const b of bosHistory) {
        if (b.deleted) continue;
        if (b.barIndex > pivot.barIndex) {
          const supersedes = bullish ? b.price < pivot.price : b.price > pivot.price;
          if (supersedes) {
            b.deleted = true; // the library deletes the older drawing
          } else {
            create = false; // a newer, stronger break already covers this one
            break;
          }
        }
      }
      if (!create) continue;
      bosHistory.unshift({ barIndex: pivot.barIndex, price: pivot.price, deleted: false });
      pivot.bosBroken = true;
      events.push({ type: 'BOS', dir: bullish ? 'bullish' : 'bearish', price: pivot.price, fromTime: pivot.time, time: bar.time });
      bosFired = true;
      break;
    }

    return { events, trend, breakOccurred: chochFired || bosFired };
  }

  return {
    step,
    get trend() {
      return trend;
    },
  };
}
