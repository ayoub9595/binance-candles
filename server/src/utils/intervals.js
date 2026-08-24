// Uniform bar width per interval, for the arithmetic that turns a run of stored
// openTimes into "which bars are missing".
//
// 3d/1w/1M are deliberately absent: their bars are not a fixed number of ms
// apart (week bars align to Monday, month bars vary in length), so stepping a
// range by a constant would invent openTimes that never existed. Callers treat
// an unknown interval as "not gap-checkable" and skip it rather than guess.
const INTERVAL_MS = {
  '1s': 1000,
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
};

export function intervalMs(interval) {
  return INTERVAL_MS[interval] ?? null;
}
