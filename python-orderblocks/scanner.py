"""24/7 realtime FVG order-block scanner for the top Binance USDT pairs.

Loop design:
  1. Warmup: fetch a candle window per symbol, compute all zones, seed state
     SILENTLY (nothing that existed before the scanner started is alerted),
     then print a snapshot of the currently fresh zones.
  2. Between candle closes: poll every last price in ONE cheap request every
     --price-poll seconds and alert TAP the moment price enters a fresh zone.
  3. A few seconds after every interval close: rescan each symbol (thread
     pool), diff against the previous state and alert NEW zones and
     MITIGATED zones (skipping ones already TAP-alerted intra-candle).
     Detection is prefix-stable, so a rescan can never rewrite the past —
     even after downtime the diff yields exactly the missed events.
  4. Every --refresh-top minutes the top-N list is re-ranked by 24h quote
     volume; joiners get a silent warmup, leavers are dropped.

Alerts go to stdout and are appended as JSON lines to --alerts-file.
Errors never kill the loop: failed symbols are skipped for that cycle and
rate-limit responses (429/418) honour Binance's Retry-After.

Usage:
  python scanner.py                    # top 100 USDT pairs, 15m
  python scanner.py --direction bullish --price-poll 5
  python scanner.py --symbols BTCUSDT,ETHUSDT --interval 5m
  python scanner.py --once             # single scan: print fresh zones, exit
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import dashboard
from binance_client import (
    BinanceError,
    fetch_candles,
    fetch_prices,
    fetch_top_usdt_symbols,
)
from order_blocks import OrderBlock, compute_fvg_order_blocks

INTERVAL_SECONDS = {
    "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
    "1h": 3600, "2h": 7200, "4h": 14400, "6h": 21600,
    "8h": 28800, "12h": 43200, "1d": 86400,
}
CLOSE_BUFFER = 5  # seconds after a close before klines are re-fetched
FETCH_WORKERS = 8


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def fmt_time(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")


def fmt_price(value: float) -> str:
    s = f"{value:.10f}".rstrip("0").rstrip(".")
    return s or "0"


def id_time(ob_id: str) -> int:
    return int(ob_id.rsplit(":", 1)[1])


class SymbolState:
    __slots__ = ("fresh", "known", "tapped")

    def __init__(self):
        self.fresh: dict[str, OrderBlock] = {}  # id -> still-untapped zone
        self.known: set[str] = set()            # every id seen in the window
        self.tapped: set[str] = set()           # TAP-alerted intra-candle


class AlertSink:
    """Prints alert lines and appends them as JSON lines to a log file."""

    def __init__(self, path: str, direction: str):
        self.path = path
        self.direction = direction

    def emit(self, kind: str, symbol: str, ob: OrderBlock,
             price: float | None = None, note: str = ""):
        if self.direction != "both" and ob.direction != self.direction:
            return
        zone = f"{fmt_price(ob.bottom)}..{fmt_price(ob.top)}"
        tail = f"  price {fmt_price(price)}" if price is not None else ""
        if note:
            tail += f"  {note}"
        print(f"[{utc_now()}] {kind:<9} {symbol:<12} {ob.direction:<7} OB {zone}{tail}",
              flush=True)
        record = {
            "ts": int(time.time()),
            "type": kind.lower(),
            "symbol": symbol,
            "dir": ob.direction,
            "top": ob.top,
            "bottom": ob.bottom,
            "id": ob.id,
            "price": price,
        }
        try:
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(json.dumps(record) + "\n")
        except OSError as err:
            print(f"[{utc_now()}] warn: could not write {self.path}: {err}", flush=True)


def scan_symbol(symbol: str, interval: str, limit: int):
    candles = fetch_candles(symbol, interval, limit)
    blocks = compute_fvg_order_blocks(candles)
    window_start = candles[0].time if candles else 0
    return blocks, window_start


def apply_scan(symbol: str, blocks: list[OrderBlock], window_start: int,
               state: SymbolState, sink: AlertSink, silent: bool):
    """Diff a fresh recompute against the previous state; returns (new, mitigated)."""
    new_count = 0
    mit_count = 0
    fresh_now: dict[str, OrderBlock] = {}
    for ob in blocks:
        if ob.id not in state.known:
            state.known.add(ob.id)
            new_count += 1
            if not silent:
                note = "(already mitigated)" if ob.mitigated else "(on close)"
                sink.emit("NEW", symbol, ob, note=note)
        if ob.mitigated:
            if ob.id in state.fresh:  # fresh -> tapped this cycle
                mit_count += 1
                if not silent and ob.id not in state.tapped:
                    sink.emit("MITIGATED", symbol, ob, note="(confirmed on close)")
            state.tapped.discard(ob.id)
        else:
            fresh_now[ob.id] = ob
    state.fresh = fresh_now
    # Zones whose origin scrolled out of the window can never reappear —
    # prune their ids so memory stays flat over weeks of runtime.
    state.known = {i for i in state.known if id_time(i) >= window_start}
    state.tapped = {i for i in state.tapped if i in fresh_now}
    return new_count, mit_count


def scan_all(symbols: list[str], states: dict[str, SymbolState],
             sink: AlertSink, args, silent: bool):
    new_total = mit_total = errors = 0
    with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
        futures = {
            pool.submit(scan_symbol, s, args.interval, args.limit): s
            for s in symbols
        }
        for fut in as_completed(futures):
            symbol = futures[fut]
            try:
                blocks, window_start = fut.result()
            except Exception as err:
                errors += 1
                print(f"[{utc_now()}] warn: {symbol} scan failed: {err}", flush=True)
                continue
            state = states.setdefault(symbol, SymbolState())
            n, m = apply_scan(symbol, blocks, window_start, state, sink, silent)
            new_total += n
            mit_total += m
    return new_total, mit_total, errors


def poll_taps(states: dict[str, SymbolState], sink: AlertSink) -> dict[str, float]:
    """One all-symbols price fetch; TAP-alerts zones price just entered.
    Returns the price map so callers can reuse it (dashboard snapshot)."""
    prices = fetch_prices()
    for symbol, state in states.items():
        price = prices.get(symbol)
        if price is None:
            continue
        for ob in state.fresh.values():
            if ob.id in state.tapped:
                continue
            hit = price <= ob.top if ob.direction == "bullish" else price >= ob.bottom
            if hit:
                state.tapped.add(ob.id)
                sink.emit("TAP", symbol, ob, price=price)
    return prices


def build_snapshot(states: dict[str, SymbolState], prices: dict[str, float],
                   args, source_label: str, next_close: int) -> dict:
    """Read-only view for the dashboard: ongoing zones price has NOT touched
    (fresh minus intra-candle taps), with distance from last price to the
    zone's near edge."""
    zones = []
    for symbol, state in states.items():
        price = prices.get(symbol)
        for ob in state.fresh.values():
            if ob.id in state.tapped:
                continue
            if args.direction != "both" and ob.direction != args.direction:
                continue
            if price:
                edge = ob.top if ob.direction == "bullish" else ob.bottom
                dist = price - edge if ob.direction == "bullish" else edge - price
                dist_pct = round(dist / price * 100, 4)
            else:
                dist_pct = None
            zones.append({
                "symbol": symbol,
                "dir": ob.direction,
                "top": ob.top,
                "bottom": ob.bottom,
                "fromTime": ob.from_time,
                "detectedTime": ob.detected_time,
                "price": price,
                "distPct": dist_pct,
            })
    zones.sort(key=lambda z: z["detectedTime"], reverse=True)
    return {
        "meta": {
            "interval": args.interval,
            "symbols": len(states),
            "source": source_label,
            "updated": int(time.time()),
            "nextClose": next_close,
        },
        "zones": zones,
    }


def print_snapshot(states: dict[str, SymbolState], direction: str):
    rows = [
        (symbol, ob)
        for symbol, state in states.items()
        for ob in state.fresh.values()
        if direction == "both" or ob.direction == direction
    ]
    rows.sort(key=lambda r: r[1].detected_time, reverse=True)
    print(f"\n=== fresh zones right now ({len(rows)}) ===", flush=True)
    if rows:
        print(f"{'SYMBOL':<12} {'DIR':<8} {'BOTTOM':>16} {'TOP':>16}  DETECTED (UTC)")
        for symbol, ob in rows:
            print(f"{symbol:<12} {ob.direction:<8} {fmt_price(ob.bottom):>16} "
                  f"{fmt_price(ob.top):>16}  {fmt_time(ob.detected_time)}")
    print(flush=True)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="24/7 realtime FVG order-block scanner (Binance USDT spot pairs)."
    )
    parser.add_argument("--top", type=int, default=100,
                        help="scan the top N pairs by 24h quote volume (default: 100)")
    parser.add_argument("--symbols", default=None,
                        help="comma-separated fixed list (overrides --top), e.g. BTCUSDT,ETHUSDT")
    parser.add_argument("--interval", default="15m", choices=sorted(INTERVAL_SECONDS, key=INTERVAL_SECONDS.get),
                        help="kline interval (default: 15m)")
    parser.add_argument("--limit", type=int, default=1000,
                        help="candle window per symbol; zone memory span (default: 1000 = ~10.4 days on 15m)")
    parser.add_argument("--direction", choices=["bullish", "bearish", "both"], default="both",
                        help="only alert demand (bullish) or supply (bearish) zones")
    parser.add_argument("--price-poll", type=float, default=10,
                        help="seconds between realtime TAP price checks; 0 disables (default: 10)")
    parser.add_argument("--refresh-top", type=float, default=60,
                        help="minutes between top-list re-ranks (default: 60)")
    parser.add_argument("--alerts-file",
                        default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "alerts.jsonl"),
                        help="JSONL alert log (default: alerts.jsonl next to this script)")
    parser.add_argument("--once", action="store_true",
                        help="scan once, print the fresh-zone snapshot, exit")
    parser.add_argument("--web-port", type=int, default=8765,
                        help="dashboard port (default: 8765)")
    parser.add_argument("--web-host", default="127.0.0.1",
                        help="dashboard bind address; use 0.0.0.0 to view from other devices (default: 127.0.0.1)")
    parser.add_argument("--no-web", action="store_true", help="disable the web dashboard")
    args = parser.parse_args(argv)

    step = INTERVAL_SECONDS[args.interval]
    sink = AlertSink(args.alerts_file, args.direction)
    fixed_list = ([s.strip().upper() for s in args.symbols.split(",") if s.strip()]
                  if args.symbols else None)
    source_label = (f"fixed list ({len(fixed_list)} pairs)" if fixed_list
                    else f"top {args.top} USDT pairs")

    if not args.once and not args.no_web:
        try:
            dashboard.start(args.web_host, args.web_port)
            print(f"[{utc_now()}] dashboard: http://{args.web_host}:{args.web_port}",
                  flush=True)
        except OSError as err:
            print(f"[{utc_now()}] warn: dashboard failed to start on port "
                  f"{args.web_port}: {err}", flush=True)

    print(f"FVG order-block scanner | "
          f"{'fixed list: ' + ','.join(fixed_list) if fixed_list else f'top {args.top} USDT pairs by 24h volume'} | "
          f"{args.interval} | window {args.limit} candles | "
          f"tap poll {args.price_poll:g}s | alerts -> {args.alerts_file}", flush=True)

    if fixed_list:
        symbols = fixed_list
    else:
        symbols = fetch_top_usdt_symbols(args.top)
        print(f"[{utc_now()}] top list loaded: {len(symbols)} symbols "
              f"({symbols[0]} ... {symbols[-1]})", flush=True)

    states: dict[str, SymbolState] = {}
    t0 = time.monotonic()
    _, _, errors = scan_all(symbols, states, sink, args, silent=True)
    print(f"[{utc_now()}] warmup scan done: {len(states)} symbols in "
          f"{time.monotonic() - t0:.1f}s" + (f" ({errors} errors)" if errors else ""),
          flush=True)
    print_snapshot(states, args.direction)
    if args.once:
        return 0

    try:
        last_prices = fetch_prices()
    except BinanceError:
        last_prices = {}
    dashboard.publish(build_snapshot(states, last_prices, args, source_label,
                                     (int(time.time()) // step + 1) * step))

    print(f"[{utc_now()}] watching for NEW / TAP / MITIGATED events. Ctrl+C to stop.",
          flush=True)
    last_refresh = time.time()
    while True:
        next_close = (int(time.time()) // step + 1) * step + CLOSE_BUFFER
        # --- between closes: realtime tap polling ---
        while True:
            remain = next_close - time.time()
            if remain <= 0:
                break
            wait = min(args.price_poll, remain) if args.price_poll > 0 else min(30, remain)
            time.sleep(max(wait, 0.5))
            if args.price_poll > 0 and next_close - time.time() > 1:
                try:
                    last_prices = poll_taps(states, sink)
                    dashboard.publish(build_snapshot(states, last_prices, args,
                                                     source_label, next_close - CLOSE_BUFFER))
                except BinanceError as err:
                    print(f"[{utc_now()}] warn: price poll failed: {err}", flush=True)
                    if err.retry_after:
                        time.sleep(min(err.retry_after, 120))

        # --- on close: rescan everything and diff ---
        close_label = datetime.fromtimestamp(next_close - CLOSE_BUFFER, tz=timezone.utc).strftime("%H:%M")
        t0 = time.monotonic()
        new, mitigated, errors = scan_all(symbols, states, sink, args, silent=False)
        fresh = sum(len(s.fresh) for s in states.values())
        print(f"[{utc_now()}] {args.interval} close {close_label} | "
              f"{len(symbols)} symbols | fresh {fresh} | new {new} | mitigated {mitigated} | "
              f"{time.monotonic() - t0:.1f}s" + (f" | {errors} errors" if errors else ""),
              flush=True)
        dashboard.publish(build_snapshot(states, last_prices, args, source_label,
                                         (int(time.time()) // step + 1) * step))

        # --- periodic top-list refresh ---
        if not fixed_list and time.time() - last_refresh >= args.refresh_top * 60:
            try:
                fresh_list = fetch_top_usdt_symbols(args.top)
                added = [s for s in fresh_list if s not in states]
                removed = [s for s in symbols if s not in fresh_list]
                if added:
                    scan_all(added, states, sink, args, silent=True)
                for s in removed:
                    states.pop(s, None)
                symbols = fresh_list
                last_refresh = time.time()
                if added or removed:
                    print(f"[{utc_now()}] top list refreshed: +{len(added)} -{len(removed)}",
                          flush=True)
            except BinanceError as err:
                print(f"[{utc_now()}] warn: top-list refresh failed, keeping current: {err}",
                      flush=True)
                last_refresh = time.time()  # try again next period, not next close


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print(f"\n[{utc_now()}] scanner stopped.", flush=True)
        sys.exit(0)
