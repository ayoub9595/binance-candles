"""Minimal Binance spot REST client — public endpoints, stdlib only (no deps)."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request

from order_blocks import Candle

BASE = "https://api.binance.com"
KLINES_URL = f"{BASE}/api/v3/klines"
TICKER_24H_URL = f"{BASE}/api/v3/ticker/24hr"
PRICE_URL = f"{BASE}/api/v3/ticker/price"
EXCHANGE_INFO_URL = f"{BASE}/api/v3/exchangeInfo"

MAX_PER_REQUEST = 1000  # API cap per klines request

# Stable/fiat-pegged bases: pairs like USDCUSDT trade huge volume but have no
# meaningful price structure, so they would waste top-N scanner slots.
STABLE_BASES = {
    "USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "PYUSD", "USDE", "USD1",
    "XUSD", "GUSD", "USDS", "AEUR", "EUR", "EURI",
}


class BinanceError(RuntimeError):
    """`retry_after` is set (seconds) when Binance asked us to back off (429/418)."""

    def __init__(self, message: str, retry_after: int | None = None):
        super().__init__(message)
        self.retry_after = retry_after


def _get_json(url: str, params: dict | None = None, timeout: int = 15):
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "orderblocks-py/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as err:
        retry_after = None
        if err.code in (418, 429):
            try:
                retry_after = int(err.headers.get("Retry-After") or 60)
            except ValueError:
                retry_after = 60
        try:
            msg = json.load(err).get("msg", "")
        except Exception:
            msg = ""
        raise BinanceError(f"Binance rejected the request: {msg or err}", retry_after) from err
    except urllib.error.URLError as err:
        raise BinanceError(f"Could not reach Binance: {err.reason}") from err


def fetch_candles(
    symbol: str,
    interval: str = "15m",
    limit: int = 1000,
    include_open: bool = False,
) -> list[Candle]:
    """Fetch the most recent `limit` klines for `symbol`, oldest -> newest.

    Paginates backwards in chunks of 1000 when `limit` exceeds the per-request
    cap. The still-forming bar is dropped by default so every high/low is
    final (no-lookahead detection needs closed bars); pass include_open=True
    to keep it.
    """
    symbol = symbol.upper()
    chunks: list[list] = []
    remaining = limit
    end_time = None
    while remaining > 0:
        params = {
            "symbol": symbol,
            "interval": interval,
            "limit": min(remaining, MAX_PER_REQUEST),
        }
        if end_time is not None:
            params["endTime"] = end_time
        rows = _get_json(KLINES_URL, params)
        if not rows:
            break
        chunks.append(rows)
        remaining -= len(rows)
        if len(rows) < params["limit"]:
            break  # reached the start of the symbol's history
        end_time = rows[0][0] - 1  # continue just before the oldest row we have

    rows = [row for chunk in reversed(chunks) for row in chunk]
    if not include_open and rows:
        now_ms = int(time.time() * 1000)
        if rows[-1][6] > now_ms:  # close time still in the future -> forming
            rows = rows[:-1]
    return [
        Candle(
            time=row[0] // 1000,  # open time ms -> sec, matches the JS charts
            open=float(row[1]),
            high=float(row[2]),
            low=float(row[3]),
            close=float(row[4]),
        )
        for row in rows
    ]


def fetch_prices() -> dict[str, float]:
    """Last price for every symbol in ONE request (flat weight, ~2k rows)."""
    rows = _get_json(PRICE_URL, timeout=15)
    out = {}
    for r in rows:
        try:
            out[r["symbol"]] = float(r["price"])
        except (KeyError, ValueError):
            continue
    return out


def _tradable_usdt_symbols() -> set[str]:
    """TRADING spot USDT pairs from exchangeInfo (same filter as the JS
    spotCatalog: status TRADING + isSpotTradingAllowed), minus stable bases."""
    try:
        raw = _get_json(
            EXCHANGE_INFO_URL,
            {"permissions": "SPOT", "showPermissionSets": "false"},
            timeout=30,
        )
    except BinanceError:
        raw = _get_json(EXCHANGE_INFO_URL, timeout=30)  # some gateways reject params

    out = set()
    for s in raw.get("symbols", []):
        if s.get("status") != "TRADING":
            continue
        if s.get("isSpotTradingAllowed") is False:
            continue
        if s.get("quoteAsset") != "USDT":
            continue
        if s.get("baseAsset") in STABLE_BASES:
            continue
        out.add(s["symbol"])
    return out


def fetch_top_usdt_symbols(n: int = 100) -> list[str]:
    """Top-n tradable spot USDT pairs ranked by 24h quote volume."""
    tradable = _tradable_usdt_symbols()
    tickers = _get_json(TICKER_24H_URL, timeout=30)
    ranked = []
    for t in tickers:
        sym = t.get("symbol")
        if sym not in tradable:
            continue
        try:
            ranked.append((float(t.get("quoteVolume", "0")), sym))
        except ValueError:
            continue
    ranked.sort(reverse=True)
    return [sym for _, sym in ranked[:n]]
