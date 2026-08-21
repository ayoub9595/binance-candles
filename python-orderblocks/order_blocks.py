"""FVG-based order blocks — Python port of client/src/utils/orderBlocks.js.

When a 3-candle fair value gap prints, the candle BEFORE the displacement
(middle) candle is the order block — the origin the imbalance launched from.
A bullish FVG marks a demand OB, a bearish FVG a supply OB. The zone is that
origin candle's full range.

Origin-candle filters (both against the candle right before it; candidates
with no previous candle are skipped):
  1. Wick: the origin candle must show rejection stronger than its
     predecessor — for a demand OB its LOWER wick must be strictly larger
     than the previous candle's lower wick; for a supply OB the UPPER
     wicks are compared.
  2. Position: the origin candle must sit entirely lower than its
     predecessor for a demand OB (lower high AND lower low — it dug down
     before the displacement up), entirely higher for a supply OB.

Lifecycle: the zone extends right while price stays away ("fresh"). The
first wick back into it mitigates it — the box freezes at that bar. All
zones are returned, fresh and mitigated — display filtering/capping is the
caller's job, which keeps this function purely prefix-stable.

No lookahead: an OB is known the moment the gap's third candle closes, and
mitigation is evaluated per bar in order — feeding a growing prefix of
candles (bar replay) yields exactly what was knowable at that moment.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Sequence


@dataclass(frozen=True)
class Candle:
    """One OHLC bar. `time` is the bar's open time in epoch seconds."""

    time: int
    open: float
    high: float
    low: float
    close: float


@dataclass
class OrderBlock:
    id: str
    direction: str  # 'bullish' (demand) or 'bearish' (supply)
    top: float
    bottom: float
    from_time: int  # origin candle
    detected_time: int  # gap's third candle — when the zone became KNOWN
    to_time: Optional[int] = None  # mitigation bar, or last bar if fresh
    mitigated: bool = False

    def to_box(self) -> dict:
        """Same shape and keys as the JS computeFvgOrderBlocks() boxes, so
        output can be diffed directly against the frontend."""
        return {
            "id": self.id,
            "dir": self.direction,
            "top": self.top,
            "bottom": self.bottom,
            "fromTime": self.from_time,
            "detectedTime": self.detected_time,
            "toTime": self.to_time,
            "mitigated": self.mitigated,
        }


def lower_wick(bar: Candle) -> float:
    return min(bar.open, bar.close) - bar.low


def upper_wick(bar: Candle) -> float:
    return bar.high - max(bar.open, bar.close)


def compute_fvg_order_blocks(candles: Sequence[Candle]) -> list[OrderBlock]:
    """candles: ascending OHLC bars.

    Returns every zone, fresh and mitigated — from_time is the origin candle;
    detected_time is the gap's third candle, i.e. the bar on which the zone
    first became known (two bars after its origin); to_time is the mitigation
    bar for tapped zones, the last bar for fresh ones.
    """
    done: list[OrderBlock] = []
    active: list[OrderBlock] = []

    for j in range(2, len(candles)):
        bar = candles[j]

        # Mitigation first: the current bar can tap existing zones. A zone's
        # own pattern can't tap it — the third candle sits beyond the gap,
        # which is beyond the origin candle's range by construction.
        for k in range(len(active) - 1, -1, -1):
            ob = active[k]
            touched = (
                bar.low <= ob.top if ob.direction == "bullish" else bar.high >= ob.bottom
            )
            if touched:
                ob.to_time = bar.time
                ob.mitigated = True
                done.append(ob)
                del active[k]

        first = candles[j - 2]
        before_first = candles[j - 3] if j >= 3 else None  # filter baseline
        if bar.low > first.high:
            if (
                before_first is not None
                and lower_wick(first) > lower_wick(before_first)
                and first.high < before_first.high
                and first.low < before_first.low
            ):
                active.append(
                    OrderBlock(
                        id=f"ob:bullish:{first.time}",
                        direction="bullish",
                        top=first.high,
                        bottom=first.low,
                        from_time=first.time,
                        detected_time=bar.time,
                    )
                )
        elif bar.high < first.low:
            if (
                before_first is not None
                and upper_wick(first) > upper_wick(before_first)
                and first.high > before_first.high
                and first.low > before_first.low
            ):
                active.append(
                    OrderBlock(
                        id=f"ob:bearish:{first.time}",
                        direction="bearish",
                        top=first.high,
                        bottom=first.low,
                        from_time=first.time,
                        detected_time=bar.time,
                    )
                )

    last_time = candles[-1].time if candles else 0
    for ob in active:
        ob.to_time = last_time
        ob.mitigated = False
    return done + active
