"""Detect FVG-based order blocks (bullish demand / bearish supply) on Binance
15m candles.

Usage:
  python main.py BTCUSDT
  python main.py ETHUSDT --limit 2000 --direction bearish --fresh-only
  python main.py BTCUSDT --json > blocks.json
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone

from binance_client import BinanceError, fetch_candles
from order_blocks import compute_fvg_order_blocks


def fmt_time(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")


def fmt_price(value: float) -> str:
    s = f"{value:.10f}".rstrip("0").rstrip(".")
    return s or "0"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="FVG-based order block detector over Binance spot klines."
    )
    parser.add_argument("symbol", help="Binance spot symbol, e.g. BTCUSDT")
    parser.add_argument("--interval", default="15m", help="kline interval (default: 15m)")
    parser.add_argument(
        "--limit", type=int, default=1000,
        help="number of most-recent candles to analyse (default: 1000)",
    )
    parser.add_argument(
        "--direction", choices=["bullish", "bearish", "both"], default="both",
        help="only report demand (bullish) or supply (bearish) zones",
    )
    parser.add_argument("--fresh-only", action="store_true", help="hide mitigated zones")
    parser.add_argument(
        "--json", action="store_true", dest="as_json",
        help="print raw boxes as JSON (same keys as the JS frontend)",
    )
    args = parser.parse_args(argv)

    try:
        candles = fetch_candles(args.symbol, args.interval, args.limit)
    except BinanceError as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    if len(candles) < 4:
        print("error: not enough closed candles to analyse", file=sys.stderr)
        return 1

    blocks = compute_fvg_order_blocks(candles)
    if args.direction != "both":
        blocks = [ob for ob in blocks if ob.direction == args.direction]
    if args.fresh_only:
        blocks = [ob for ob in blocks if not ob.mitigated]
    blocks.sort(key=lambda ob: ob.from_time)

    if args.as_json:
        print(json.dumps([ob.to_box() for ob in blocks], indent=2))
        return 0

    fresh = sum(1 for ob in blocks if not ob.mitigated)
    print(
        f"{args.symbol.upper()} {args.interval} — {len(candles)} closed candles "
        f"({fmt_time(candles[0].time)} → {fmt_time(candles[-1].time)} UTC)"
    )
    print(f"{len(blocks)} order block(s): {fresh} fresh, {len(blocks) - fresh} mitigated")
    if not blocks:
        return 0

    print()
    header = (
        f"{'DIR':<8} {'STATUS':<10} {'TOP':>16} {'BOTTOM':>16}  "
        f"{'ORIGIN (UTC)':<17} {'DETECTED (UTC)':<17} {'UNTIL (UTC)':<17}"
    )
    print(header)
    print("-" * len(header))
    for ob in blocks:
        status = "mitigated" if ob.mitigated else "FRESH"
        print(
            f"{ob.direction:<8} {status:<10} {fmt_price(ob.top):>16} {fmt_price(ob.bottom):>16}  "
            f"{fmt_time(ob.from_time):<17} {fmt_time(ob.detected_time):<17} {fmt_time(ob.to_time):<17}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
