# FVG-based Order Block Detector (Python)

A standalone Python port of the frontend logic in
`client/src/utils/orderBlocks.js`, wired to Binance spot **15m** klines.
It detects only order blocks (demand = bullish, supply = bearish), derived
from fair value gaps. Stdlib only — no dependencies, Python 3.9+.

## How detection works (identical to the JS)

1. **FVG trigger** — the classic 3-candle imbalance:
   - Bullish: candle 3's low strictly above candle 1's high.
   - Bearish: candle 3's high strictly below candle 1's low.
2. **The order block** is candle 1 (the candle *before* the displacement
   candle) — the origin the imbalance launched from. The zone is that
   candle's full high–low range.
3. **Origin filters** (both compared against the candle right before the
   origin; a pattern with no such baseline candle is skipped):
   - *Wick*: the origin must show stronger rejection — strictly larger lower
     wick for a demand OB, strictly larger upper wick for a supply OB.
   - *Position*: the origin must sit entirely lower than its predecessor for
     a demand OB (lower high AND lower low), entirely higher for supply.
4. **Lifecycle**: the zone stays *fresh* while price keeps away. The first
   wick back into it (bullish: `low <= top`; bearish: `high >= bottom`)
   *mitigates* it and freezes the box at that bar.
5. **No lookahead**: an OB is known the moment the gap's third candle closes;
   mitigation is evaluated bar by bar in order, so results are prefix-stable
   (bar-replay safe). Only closed candles are analysed — the still-forming
   bar is dropped by the fetcher.

## Usage

```
cd python-orderblocks

python main.py BTCUSDT                          # 15m, last 1000 closed candles
python main.py ETHUSDT --direction bullish      # demand zones only
python main.py BTCUSDT --direction bearish --fresh-only
python main.py BTCUSDT --limit 3000             # paginates past the 1000 API cap
python main.py BTCUSDT --json > blocks.json     # machine-readable output
```

`--interval` defaults to `15m` (any Binance interval works: 1m, 5m, 1h, 4h, …).

On Windows you can also double-click `run.bat` (defaults to BTCUSDT), or pass
the same arguments through it: `run.bat ETHUSDT --direction bullish --fresh-only`.

## 24/7 realtime scanner (top 100)

`scanner.py` watches the **top 100 USDT spot pairs by 24h quote volume**
(same tradable-pair filter as the app's spot catalog; stablecoin bases like
USDC/FDUSD excluded) and runs forever:

```
python scanner.py                          # top 100, 15m — or double-click scan.bat
python scanner.py --direction bullish      # demand-zone alerts only
python scanner.py --symbols BTCUSDT,ETHUSDT --interval 5m
python scanner.py --once                   # one pass: print fresh zones, exit
```

How it runs:

- **Warmup** — scans every symbol silently (nothing pre-existing is alerted)
  and prints a snapshot of all currently fresh zones.
- **`TAP` alerts (realtime)** — every `--price-poll` seconds (default 10) one
  cheap all-symbols price request checks whether price just entered a fresh
  zone. Alerted at most once per zone.
- **`NEW` / `MITIGATED` alerts (on candle close)** — a few seconds after every
  15m close, all symbols are rescanned in a thread pool and diffed against the
  previous state. Detection is prefix-stable, so even after downtime the diff
  yields exactly the missed events (a tap the poll missed is still confirmed
  here from the bar's wick).
- **Self-maintaining** — the top-100 list re-ranks every `--refresh-top`
  minutes (joiners warm up silently, leavers drop); per-symbol errors skip
  that cycle only; 429/418 responses honour Binance's Retry-After;
  `scan.bat` auto-restarts the process if it ever crashes.

Alerts print to the console and append to `alerts.jsonl` (one JSON object per
line: `ts, type, symbol, dir, top, bottom, id, price`). Zone memory spans the
`--limit` window — 1000 × 15m ≈ 10.4 days; raise it to track older fresh
zones. For true 24/7 on Windows, disable sleep (Settings → Power) or run it
on an always-on machine.

### Web dashboard — ongoing untouched zones

While the scanner runs it serves a local dashboard at
**http://127.0.0.1:8765** listing every ongoing order block that price has
NOT touched since detection (zones tapped intra-candle disappear immediately).
Live KPI tiles (untouched / bullish / bearish counts, next-close countdown),
a direction filter, symbol search, and sorting by newest or **closest to
price** — each row shows the zone bounds, last price, distance to the zone's
near edge (with a "near" chip at ≤ 0.5%), and age. Refreshes every 5 seconds;
a banner appears if the scanner stops feeding it.

Options: `--web-port 8765`, `--web-host 0.0.0.0` (view from your phone on the
same network), `--no-web` to disable. The API behind it is
`GET /api/zones` (JSON), if you want to consume it from other tools.

## Output fields

| Table column   | JSON key       | Meaning                                            |
|----------------|----------------|----------------------------------------------------|
| DIR            | `dir`          | `bullish` (demand) or `bearish` (supply)           |
| TOP / BOTTOM   | `top`/`bottom` | zone bounds = origin candle's high/low             |
| ORIGIN         | `fromTime`     | origin candle open time (epoch sec in JSON)        |
| DETECTED       | `detectedTime` | gap's third candle — when the zone became known    |
| UNTIL          | `toTime`       | mitigation bar for tapped zones, last bar if fresh |
| STATUS         | `mitigated`    | `FRESH` / `mitigated`                              |

JSON output uses the exact same keys as the JS `computeFvgOrderBlocks()`
boxes, so it can be diffed against the frontend directly.

## Files

- `order_blocks.py` — pure detection logic (`compute_fvg_order_blocks`)
- `binance_client.py` — public REST client (klines with backwards pagination,
  all-symbol prices, top-N ranking via exchangeInfo + 24h tickers)
- `main.py` — one-shot CLI for a single symbol
- `scanner.py` — 24/7 realtime scanner for the top-100 (NEW / TAP / MITIGATED)
- `dashboard.py` — local web dashboard: ongoing untouched zones (port 8765)
- `run.bat` — Windows launcher for the one-shot CLI
- `scan.bat` — Windows launcher for the scanner (auto-restarts on crash)
- `test_order_blocks.py` — unit tests: `python -m unittest -v`
