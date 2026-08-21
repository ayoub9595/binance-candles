"""Unit tests for the FVG-based order block detector (mirrors orderBlocks.js)."""

import unittest

from order_blocks import Candle, compute_fvg_order_blocks


def c(t, o, h, l, cl):
    return Candle(time=t, open=o, high=h, low=l, close=cl)


# Bullish base pattern: before_first(0), origin(1), displacement(2), gap third(3).
# origin lower wick 10 > before_first's 5; origin high 106<110, low 94<100.
# Gap: third.low 107 > origin.high 106. Zone = [94, 106].
BULL_BASE = [
    c(0, 105, 110, 100, 106),
    c(1, 104, 106, 94, 104.5),
    c(2, 104, 115, 103, 114),
    c(3, 114, 120, 107, 118),
]


class BullishDetection(unittest.TestCase):
    def test_detects_fresh_demand_zone(self):
        candles = BULL_BASE + [c(4, 118, 121, 108, 120)]  # low 108 stays above 106
        blocks = compute_fvg_order_blocks(candles)
        self.assertEqual(len(blocks), 1)
        ob = blocks[0]
        self.assertEqual(ob.direction, "bullish")
        self.assertEqual(ob.id, "ob:bullish:1")
        self.assertEqual((ob.top, ob.bottom), (106, 94))
        self.assertEqual((ob.from_time, ob.detected_time), (1, 3))
        self.assertFalse(ob.mitigated)
        self.assertEqual(ob.to_time, 4)  # fresh zones extend to the last bar

    def test_mitigated_when_price_taps_zone_top(self):
        candles = BULL_BASE + [
            c(4, 118, 121, 108, 120),
            c(5, 120, 122, 105, 121),  # low 105 <= top 106 -> tap
        ]
        blocks = compute_fvg_order_blocks(candles)
        self.assertEqual(len(blocks), 1)
        self.assertTrue(blocks[0].mitigated)
        self.assertEqual(blocks[0].to_time, 5)  # box freezes at the tap bar

    def test_rejected_when_wick_not_stronger(self):
        # before_first lower wick == origin's (10 vs 10): strict > fails.
        candles = [c(0, 105, 110, 95, 106)] + BULL_BASE[1:]
        self.assertEqual(compute_fvg_order_blocks(candles), [])

    def test_rejected_when_origin_not_entirely_lower(self):
        # Wick passes (3 < 10) but origin.high 106 > before_first.high 105.
        candles = [c(0, 103, 105, 100, 104)] + BULL_BASE[1:]
        self.assertEqual(compute_fvg_order_blocks(candles), [])

    def test_skipped_without_a_baseline_candle(self):
        # Pattern starts at index 0: no candle before the origin to filter on.
        self.assertEqual(compute_fvg_order_blocks(BULL_BASE[1:]), [])

    def test_prefix_stability(self):
        # A growing prefix never rewrites what was already known (bar replay).
        candles = BULL_BASE + [c(4, 118, 121, 108, 120), c(5, 120, 122, 105, 121)]
        early = compute_fvg_order_blocks(candles[:5])[0]
        late = compute_fvg_order_blocks(candles)[0]
        self.assertEqual(
            (early.id, early.from_time, early.detected_time, early.top, early.bottom),
            (late.id, late.from_time, late.detected_time, late.top, late.bottom),
        )


# Bearish mirror: origin upper wick 10 > before_first's 5; origin high 116>110,
# low 104>100. Gap: third.high 103 < origin.low 104. Zone = [104, 116].
BEAR_BASE = [
    c(0, 105, 110, 100, 104),
    c(1, 106, 116, 104, 105.5),
    c(2, 106, 107, 95, 96),
    c(3, 102, 103, 98, 99),
]


class BearishDetection(unittest.TestCase):
    def test_detects_fresh_supply_zone(self):
        candles = BEAR_BASE + [c(4, 99, 103.5, 97, 98)]  # high 103.5 stays below 104
        blocks = compute_fvg_order_blocks(candles)
        self.assertEqual(len(blocks), 1)
        ob = blocks[0]
        self.assertEqual(ob.direction, "bearish")
        self.assertEqual(ob.id, "ob:bearish:1")
        self.assertEqual((ob.top, ob.bottom), (116, 104))
        self.assertEqual((ob.from_time, ob.detected_time), (1, 3))
        self.assertFalse(ob.mitigated)

    def test_mitigated_when_price_taps_zone_bottom(self):
        candles = BEAR_BASE + [
            c(4, 99, 103.5, 97, 98),
            c(5, 98, 104.5, 96, 100),  # high 104.5 >= bottom 104 -> tap
        ]
        blocks = compute_fvg_order_blocks(candles)
        self.assertEqual(len(blocks), 1)
        self.assertTrue(blocks[0].mitigated)
        self.assertEqual(blocks[0].to_time, 5)


if __name__ == "__main__":
    unittest.main()
