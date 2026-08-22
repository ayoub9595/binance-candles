"""FVG-based order blocks — Python port of client/src/utils/orderBlocks.js.

A fair value gap points at an order block: the candle its imbalance launched
from. WHICH candle that is gets resolved by walking back from the gap. When a
3-candle gap prints, the search starts at the candle BEFORE the displacement
(middle) candle and steps further back for as long as the candle behind
swallowed it whole without eating the imbalance — and gives up entirely when no
candle back there qualifies, so a gap can also resolve to no zone at all. A
bullish FVG marks a demand OB, a bearish FVG a supply OB. The zone is the
resolved origin candle's full high-low range.

Origin resolution — cand is the candidate (C1 to begin with), prev the candle
right behind it, and C3 the gap's third candle, whose extreme is the gap's FAR
edge (C3.low for demand, C3.high for supply). At each step:
  1. Reach - cand extends past prev on its own side (cand.low <= prev.low for
     demand, cand.high >= prev.high for supply): cand IS the order block, the
     walk stops. Ties count, so matching prev's extreme is enough. Nothing is
     asked of the other side - unlike the position filter this replaces, a
     demand origin may print a HIGHER high than prev and still be the zone.
  2. Eaten - prev engulfs cand outright (prev.high > cand.high AND
     prev.low < cand.low). Then prev, not cand, is where the move really came
     from, so the zone MOVES BACK ONTO prev - but only while prev still keeps a
     gap against C3 (prev.high < C3.low for demand, prev.low > C3.high for
     supply). The walk then repeats from prev, so a run of nested engulfing
     candles resolves to the earliest one that still leaves an imbalance. If
     prev has traded through the whole gap instead, the walk stops and keeps
     cand - the last candle that does keep the gap.
  3. Neither - cand sits entirely on top of prev (prev.low < cand.low with
     prev.high <= cand.high). A demand origin that never dug below its
     predecessor is no origin at all: no zone.
Rules 1 and 2 are mutually exclusive - engulfing needs prev.low < cand.low,
which is exactly what rule 1 rules out - so the order they are tested in cannot
matter. The walk strictly steps back, so it always terminates.

Running out of history yields NO zone, at any point in the walk and not just at
the start: every candidate needs a candle behind it to be judged against, and a
walk that reaches the left edge of the loaded window has not finished. This is
deliberately fail-closed - keeping the edge candle instead would mean a zone
that MOVES, or disappears under rule 3, the moment older bars load in.

Because origins relocate, two different gaps can resolve to the SAME candle.
The first (earliest-detected) one wins and later re-detections of that
(direction, origin) are ignored - one zone per origin candle per side, which
keeps ids unique for callers that key on them, and keeps the result
prefix-stable since "first" is decided causally.

Lifecycle: the zone extends right while price stays away ("fresh"). The
first wick back into it mitigates it — the box freezes at that bar. All
zones are returned, fresh and mitigated — display filtering/capping is the
caller's job, which keeps this function purely prefix-stable.

Mitigation is only ever evaluated on bars AFTER the one a zone was detected on,
which is what keeps a relocated origin from mitigating itself: the candles
between the resolved origin and the gap's first leg are nested INSIDE the zone
by construction, so they are part of the zone's formation, not taps on it.

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
    from_time: int  # resolved origin candle
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


def resolve_origin(
    candles: Sequence[Candle], start: int, gap_far: float, bullish: bool
) -> int:
    """Walks back from `start` and returns the index of the order block candle,
    or -1 if the gap leaves none. gap_far is C3's extreme on the gap's far side.
    """
    i = start
    while True:
        if i == 0:
            return -1  # ran out of history behind the candidate
        cand = candles[i]
        prev = candles[i - 1]
        # 1. Reach.
        if (cand.low <= prev.low) if bullish else (cand.high >= prev.high):
            return i
        # 2. Eaten — engulfing is direction-agnostic: prev covers cand both sides.
        if prev.high > cand.high and prev.low < cand.low:
            prev_keeps_gap = prev.high < gap_far if bullish else prev.low > gap_far
            if not prev_keeps_gap:
                return i  # prev exhausted the gap: cand is the one that keeps it
            i -= 1
            continue
        # 3. Neither.
        return -1


def compute_fvg_order_blocks(candles: Sequence[Candle]) -> list[OrderBlock]:
    """candles: ascending OHLC bars.

    Returns every zone, fresh and mitigated — from_time is the resolved origin
    candle, which may sit further back than the gap's first leg; detected_time
    is the gap's third candle, i.e. the bar on which the zone first became
    known; to_time is the mitigation bar for tapped zones, the last bar for
    fresh ones.
    """
    done: list[OrderBlock] = []
    active: list[OrderBlock] = []
    seen: set[str] = set()  # ids already emitted — origins can be reached twice

    for j in range(2, len(candles)):
        bar = candles[j]

        # Mitigation first: the current bar can tap existing zones. A zone's
        # own pattern can't tap it — see the module docstring.
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
        bullish = bar.low > first.high
        bearish = not bullish and bar.high < first.low
        if not bullish and not bearish:
            continue

        oi = resolve_origin(candles, j - 2, bar.low if bullish else bar.high, bullish)
        if oi < 0:
            continue

        origin = candles[oi]
        direction = "bullish" if bullish else "bearish"
        ob_id = f"ob:{direction}:{origin.time}"
        if ob_id in seen:
            continue  # this origin already carries a zone on this side
        seen.add(ob_id)
        active.append(
            OrderBlock(
                id=ob_id,
                direction=direction,
                top=origin.high,
                bottom=origin.low,
                from_time=origin.time,
                detected_time=bar.time,
            )
        )

    last_time = candles[-1].time if candles else 0
    for ob in active:
        ob.to_time = last_time
        ob.mitigated = False
    return done + active
