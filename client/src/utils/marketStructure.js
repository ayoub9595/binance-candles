// Market structure — BOS / CHoCH / CHoCH+ events and current trend, driven
// by the exact port of mickes' PriceAction library (see
// priceActionStructure.js and reference/PriceAction-v4.pine). Defaults match
// the "Liquidity & inducements" indicator's market-structure settings (5/5
// pivots).
//
// No lookahead: pivots confirm `rightLength` bars late and events are
// evaluated per bar in order — feeding a growing prefix of candles (bar
// replay) yields exactly the events known at that moment.

import { createStructureTracker } from './priceActionStructure.js';

// candles: ascending toChartBar array ({time: sec, open, high, low, close}).
// Returns:
//   events — [{ time, type: 'BOS'|'CHoCH'|'CHoCH+', dir: 'bullish'|'bearish',
//               price, fromTime }] ascending; price/fromTime identify the
//               broken pivot
//   trend  — 'bullish' | 'bearish' | null, structure state after the last bar
export function computeMarketStructure(candles, { leftLength = 5, rightLength = 5 } = {}) {
  const tracker = createStructureTracker({ leftLength, rightLength });
  const events = [];
  for (let j = 0; j < candles.length; j++) {
    events.push(...tracker.step(candles, j).events);
  }
  return {
    events,
    trend: tracker.trend === 1 ? 'bullish' : tracker.trend === -1 ? 'bearish' : null,
  };
}
