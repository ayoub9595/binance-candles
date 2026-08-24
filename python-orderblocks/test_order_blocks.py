"""Unit tests for the FVG-based order block detector (mirrors orderBlocks.js)."""

import unittest

from order_blocks import Candle, compute_fvg_order_blocks, resolve_origin


def c(t, o, h, l, cl):
    return Candle(time=t, open=o, high=h, low=l, close=cl)


# Bullish base: prev(0), origin(1), displacement(2), gap third(3).
# Gap: third.low 107 > origin.high 106, so the gap's far edge is 107.
# Origin low 94 <= prev low 100 -> rule 1 keeps the origin. Zone = [94, 106].
BULL_BASE = [
    c(0, 105, 110, 100, 106),
    c(1, 104, 106, 94, 104.5),
    c(2, 104, 115, 103, 114),
    c(3, 114, 120, 107, 118),
]


class Rule1Reach(unittest.TestCase):
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

    def test_higher_high_than_prev_is_still_a_zone(self):
        # Origin.high 106 > prev.high 105: the old position filter rejected this,
        # rule 1 asks only about the low (94 <= 100).
        candles = [c(0, 103, 105, 100, 104)] + BULL_BASE[1:]
        blocks = compute_fvg_order_blocks(candles)
        self.assertEqual([ob.id for ob in blocks], ["ob:bullish:1"])
        self.assertEqual((blocks[0].top, blocks[0].bottom), (106, 94))

    def test_equal_low_counts_as_reach(self):
        # Origin.low == prev.low: ties count, so the zone stands.
        candles = [c(0, 105, 110, 94, 106)] + BULL_BASE[1:]
        self.assertEqual([ob.id for ob in compute_fvg_order_blocks(candles)],
                         ["ob:bullish:1"])

    def test_mitigated_when_price_taps_zone_top(self):
        candles = BULL_BASE + [
            c(4, 118, 121, 108, 120),
            c(5, 120, 122, 105, 121),  # low 105 <= top 106 -> tap
        ]
        blocks = compute_fvg_order_blocks(candles)
        self.assertEqual(len(blocks), 1)
        self.assertTrue(blocks[0].mitigated)
        self.assertEqual(blocks[0].to_time, 5)  # box freezes at the tap bar

    def test_prefix_stability(self):
        candles = BULL_BASE + [c(4, 118, 121, 108, 120), c(5, 120, 122, 105, 121)]
        early = compute_fvg_order_blocks(candles[:5])[0]
        late = compute_fvg_order_blocks(candles)[0]
        self.assertEqual(
            (early.id, early.from_time, early.detected_time, early.top, early.bottom),
            (late.id, late.from_time, late.detected_time, late.top, late.bottom),
        )


class Rule3NoZone(unittest.TestCase):
    def test_origin_sitting_on_top_of_prev_is_dropped(self):
        # prev = [96, 104]; origin = [98, 106]: higher low AND higher high, so
        # prev is neither reached past nor engulfing. A demand origin that never
        # dug below its predecessor is no origin.
        candles = [c(0, 97, 104, 96, 103), c(1, 104, 106, 98, 104.5)] + BULL_BASE[2:]
        self.assertEqual(compute_fvg_order_blocks(candles), [])

    def test_no_candle_behind_the_origin_is_dropped(self):
        # Pattern starts at index 0: nothing behind the candidate to judge it on.
        self.assertEqual(compute_fvg_order_blocks(BULL_BASE[1:]), [])

    def test_walk_reaching_the_window_edge_is_dropped(self):
        # The engulfing chain resolves onto index 0, which has no candle behind
        # it — fail-closed rather than keeping an origin the walk never finished
        # judging. (Rule2Eaten below is the same shape with a filler in front.)
        no_filler = [
            c(0, 93, 108, 92, 107),
            c(1, 104, 106, 96, 104.5),
            c(2, 104, 115, 105, 114),
            c(3, 114, 120, 110, 118),
        ]
        self.assertEqual(resolve_origin(no_filler, 1, 110, True), -1)
        self.assertEqual(compute_fvg_order_blocks(no_filler), [])

    def test_no_gap_no_zone(self):
        flat = [c(t, 100, 105, 95, 101) for t in range(6)]
        self.assertEqual(compute_fvg_order_blocks(flat), [])


class Rule2Eaten(unittest.TestCase):
    # filler(0) keeps the engulfer via rule 1 (92 <= 95); engulfer(1) = [92, 108]
    # swallows origin(2) = [96, 106] and its high 108 stays under the gap's far
    # edge 110, so the zone MOVES BACK onto the engulfer.
    EATEN_KEEPS_GAP = [
        c(0, 96, 100, 95, 99),
        c(1, 93, 108, 92, 107),
        c(2, 104, 106, 96, 104.5),
        c(3, 104, 115, 105, 114),
        c(4, 114, 120, 110, 118),  # third.low 110 > origin.high 106 -> gap
    ]

    def test_zone_relocates_onto_the_engulfing_candle(self):
        blocks = compute_fvg_order_blocks(self.EATEN_KEEPS_GAP)
        self.assertEqual(len(blocks), 1)
        ob = blocks[0]
        self.assertEqual(ob.id, "ob:bullish:1")            # origin walked back
        self.assertEqual((ob.top, ob.bottom), (108, 92))   # the engulfer's range
        self.assertEqual((ob.from_time, ob.detected_time), (1, 4))

    def test_engulfer_that_ate_the_whole_gap_keeps_the_inner_candle(self):
        # Same shape, but the engulfer's high 111 >= the gap's far edge 110: it
        # traded through the imbalance, so the walk stops and keeps the candle
        # that does keep the gap.
        candles = [self.EATEN_KEEPS_GAP[0], c(1, 93, 111, 92, 107)] + self.EATEN_KEEPS_GAP[2:]
        blocks = compute_fvg_order_blocks(candles)
        self.assertEqual([ob.id for ob in blocks], ["ob:bullish:2"])
        self.assertEqual((blocks[0].top, blocks[0].bottom), (106, 96))

    def test_walk_chains_over_several_engulfing_candles(self):
        # [88,109] engulfs [92,108] engulfs [96,106]; both engulfers keep the gap
        # (< 110), so the zone resolves to the outermost one, held by the filler.
        chain = [
            c(0, 90, 93, 89, 92),       # filler: keeps index 1 via rule 1 (88 <= 89)
            c(1, 89, 109, 88, 108),
            c(2, 93, 108, 92, 107),
            c(3, 104, 106, 96, 104.5),
            c(4, 104, 115, 105, 114),
            c(5, 114, 120, 110, 118),   # gap far edge 110
        ]
        self.assertEqual(resolve_origin(chain, 3, 110, True), 1)
        blocks = compute_fvg_order_blocks(chain)
        self.assertEqual([ob.id for ob in blocks], ["ob:bullish:1"])
        self.assertEqual((blocks[0].top, blocks[0].bottom), (109, 88))
        # Push the outermost candle through the gap and the walk stops one short.
        eats_gap = [chain[0], c(1, 89, 112, 88, 108)] + chain[2:]
        self.assertEqual(resolve_origin(eats_gap, 3, 110, True), 2)

    def test_relocated_zone_is_not_mitigated_by_its_own_formation(self):
        # origin(2) is nested inside the resolved zone [92, 108] and so is the
        # displacement low 105 — neither may count as a tap.
        blocks = compute_fvg_order_blocks(self.EATEN_KEEPS_GAP)
        self.assertFalse(blocks[0].mitigated)
        self.assertEqual(blocks[0].to_time, 4)  # fresh through the last bar

    def test_relocated_zone_still_mitigates_afterwards(self):
        candles = self.EATEN_KEEPS_GAP + [c(5, 118, 121, 107, 120)]  # 107 <= 108
        blocks = compute_fvg_order_blocks(candles)
        self.assertEqual(len(blocks), 1)
        self.assertTrue(blocks[0].mitigated)
        self.assertEqual(blocks[0].to_time, 5)


# Bearish mirror. Gap: third.high 103 < origin.low 104, far edge 103.
# Origin.high 116 >= prev.high 110 -> rule 1. Zone = [104, 116].
BEAR_BASE = [
    c(0, 105, 110, 100, 104),
    c(1, 106, 116, 104, 105.5),
    c(2, 106, 107, 95, 96),
    c(3, 102, 103, 98, 99),
]


class BearishMirror(unittest.TestCase):
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

    def test_lower_low_than_prev_is_still_a_zone(self):
        # Origin.low 104 < prev.low 105 — rule 1 asks only about the high.
        candles = [c(0, 106, 112, 105, 107)] + BEAR_BASE[1:]
        self.assertEqual([ob.id for ob in compute_fvg_order_blocks(candles)],
                         ["ob:bearish:1"])

    def test_mitigated_when_price_taps_zone_bottom(self):
        candles = BEAR_BASE + [
            c(4, 99, 103.5, 97, 98),
            c(5, 98, 104.5, 96, 100),  # high 104.5 >= bottom 104 -> tap
        ]
        blocks = compute_fvg_order_blocks(candles)
        self.assertEqual(len(blocks), 1)
        self.assertTrue(blocks[0].mitigated)
        self.assertEqual(blocks[0].to_time, 5)

    def test_origin_sitting_under_prev_is_dropped(self):
        # prev = [106, 118] sits entirely ABOVE origin = [104, 116]: rule 1 fails
        # (116 >= 118 is false) and prev does not engulf (its low 106 is not
        # below 104). A supply origin that never pushed above its predecessor is
        # no origin.
        candles = [c(0, 107, 118, 106, 117)] + BEAR_BASE[1:]
        self.assertEqual(compute_fvg_order_blocks(candles), [])

    def test_supply_zone_relocates_onto_its_engulfer(self):
        # filler(0) keeps the engulfer via rule 1 (118 >= 114); engulfer(1) =
        # [103.5, 118] swallows origin(2) = [104, 116] and its low 103.5 stays
        # above the gap's far edge 103 -> relocate onto it.
        keeps = [
            c(0, 109, 114, 108, 113),
            c(1, 104, 118, 103.5, 117),
            c(2, 106, 116, 104, 105.5),
            c(3, 106, 107, 95, 96),
            c(4, 102, 103, 98, 99),
        ]
        blocks = compute_fvg_order_blocks(keeps)
        self.assertEqual([ob.id for ob in blocks], ["ob:bearish:1"])
        self.assertEqual((blocks[0].top, blocks[0].bottom), (118, 103.5))

    def test_supply_engulfer_through_the_gap_keeps_the_inner_candle(self):
        # Engulfer low 102 sits BELOW the far edge 103: it ate the whole gap.
        ate = [
            c(0, 109, 114, 108, 113),
            c(1, 103, 118, 102, 117),
            c(2, 106, 116, 104, 105.5),
            c(3, 106, 107, 95, 96),
            c(4, 102, 103, 98, 99),
        ]
        blocks = compute_fvg_order_blocks(ate)
        self.assertEqual([ob.id for ob in blocks], ["ob:bearish:2"])
        self.assertEqual((blocks[0].top, blocks[0].bottom), (116, 104))


class OriginsAreUnique(unittest.TestCase):
    # Two independent demand setups, so there is more than one zone to compare.
    MULTI = [
        c(0, 105, 110, 100, 106),
        c(1, 104, 106, 94, 104.5),    # origin A (94 <= 100)
        c(2, 104, 115, 103, 114),
        c(3, 114, 120, 107, 118),     # third: 107 > 106 -> zone A
        c(4, 118, 122, 112, 120),
        c(5, 119, 121, 108, 120),     # origin B (108 <= 112)
        c(6, 120, 132, 119, 131),
        c(7, 131, 136, 123, 135),     # third: 123 > 121 -> zone B
    ]

    def test_more_than_one_zone_is_actually_produced(self):
        # Guards the two tests below from passing vacuously on an empty list.
        self.assertGreaterEqual(len(compute_fvg_order_blocks(self.MULTI)), 2)

    def test_one_zone_per_origin_per_side(self):
        blocks = compute_fvg_order_blocks(self.MULTI)
        ids = [ob.id for ob in blocks]
        self.assertEqual(len(set(ids)), len(ids))
        self.assertEqual(len({(ob.direction, ob.from_time) for ob in blocks}), len(ids))

    def test_detection_never_precedes_the_origin(self):
        for ob in compute_fvg_order_blocks(self.MULTI):
            self.assertGreater(ob.detected_time, ob.from_time)


if __name__ == "__main__":
    unittest.main()
