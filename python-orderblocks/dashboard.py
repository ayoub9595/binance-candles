"""Local web dashboard for scanner.py — stdlib http.server, no deps.

Serves a single dark-themed page listing every ongoing order block that has
NOT been touched yet (fresh zones minus intra-candle taps), auto-refreshing
from /api/zones every 5 seconds. The scanner pushes read-only snapshots via
publish(); the HTTP thread never reaches into live scanner state.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_lock = threading.Lock()
_snapshot: dict = {"meta": {}, "zones": []}


def publish(snapshot: dict) -> None:
    global _snapshot
    with _lock:
        _snapshot = snapshot


def _current() -> dict:
    with _lock:
        return _snapshot


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 (http.server API)
        if self.path.split("?")[0] == "/api/zones":
            body = json.dumps(_current()).encode("utf-8")
            ctype = "application/json"
        elif self.path.split("?")[0] == "/":
            body = PAGE.encode("utf-8")
            ctype = "text/html; charset=utf-8"
        else:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # keep the alert console clean
        pass


def start(host: str, port: int) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Order Block Watch</title>
<style>
  :root {
    --bg: #0b1220; --panel: #121b30; --line: #22304d;
    --ink: #e6edf7; --ink2: #93a4bf; --mut: #64748b;
    --bull: #34d399; --bear: #f87171; --near: #fbbf24; --accent: #7aa2ff;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
         font: 14px/1.5 system-ui, "Segoe UI", sans-serif; }
  .wrap { max-width: 1140px; margin: 0 auto; padding: 20px 24px 48px; }
  header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  h1 { font-size: 18px; margin: 0; letter-spacing: .2px; }
  .live { display: inline-flex; align-items: center; gap: 6px; color: var(--ink2); font-size: 12px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--bull); }
  .dot.stale { background: var(--mut); }
  .sub { color: var(--ink2); font-size: 12px; margin-left: auto; }
  .banner { display: none; margin: 12px 0 0; padding: 8px 12px; border-radius: 8px;
            background: rgba(251,191,36,.12); color: var(--near); font-size: 13px; }
  .banner.show { display: block; }

  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
          gap: 10px; margin: 18px 0; }
  .kpi { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
         padding: 10px 14px; }
  .kpi .l { color: var(--ink2); font-size: 12px; }
  .kpi .v { font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .kpi .v.bull { color: var(--bull); } .kpi .v.bear { color: var(--bear); }

  .controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 4px 0 14px; }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .seg button { background: transparent; color: var(--ink2); border: 0; padding: 6px 14px;
                font: inherit; cursor: pointer; }
  .seg button:hover { color: var(--ink); }
  .seg button.on { background: rgba(122,162,255,.14); color: var(--ink); }
  input[type=search] { background: var(--panel); border: 1px solid var(--line); color: var(--ink);
                       border-radius: 8px; padding: 6px 10px; font: inherit; width: 180px; }
  input[type=search]:focus { outline: 1px solid var(--accent); }
  select { background: var(--panel); border: 1px solid var(--line); color: var(--ink);
           border-radius: 8px; padding: 6px 10px; font: inherit; }

  .tablebox { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px;
              background: var(--panel); }
  table { width: 100%; border-collapse: collapse; min-width: 780px; }
  th, td { padding: 9px 12px; text-align: left; border-bottom: 1px solid var(--line);
           white-space: nowrap; }
  th { color: var(--ink2); font-size: 12px; font-weight: 600; text-transform: uppercase;
       letter-spacing: .4px; }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:hover { background: rgba(122,162,255,.06); }
  td.num, th.num { text-align: right;
    font-family: ui-monospace, Consolas, monospace; font-variant-numeric: tabular-nums; }
  .sym { font-weight: 600; }
  .badge { display: inline-block; padding: 2px 9px; border-radius: 999px;
           font-size: 12px; font-weight: 600; }
  .badge.bull { color: var(--bull); background: rgba(52,211,153,.12); }
  .badge.bear { color: var(--bear); background: rgba(248,113,113,.12); }
  .chip { display: inline-block; margin-left: 8px; padding: 1px 7px; border-radius: 999px;
          font-size: 11px; font-weight: 600; color: var(--near);
          background: rgba(251,191,36,.13); }
  .age, .det { color: var(--ink2); }
  .empty { padding: 28px; text-align: center; color: var(--mut); }
  footer { margin-top: 12px; color: var(--mut); font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Order Block Watch</h1>
    <span class="live"><span class="dot" id="dot"></span><span id="livetext">connecting…</span></span>
    <span class="sub" id="meta"></span>
  </header>
  <div class="banner" id="banner">Connection to the scanner lost — retrying…</div>

  <div class="kpis">
    <div class="kpi"><div class="l">Untouched zones</div><div class="v" id="k-total">–</div></div>
    <div class="kpi"><div class="l">Bullish (demand)</div><div class="v bull" id="k-bull">–</div></div>
    <div class="kpi"><div class="l">Bearish (supply)</div><div class="v bear" id="k-bear">–</div></div>
    <div class="kpi"><div class="l">Symbols scanned</div><div class="v" id="k-syms">–</div></div>
    <div class="kpi"><div class="l">Next close</div><div class="v" id="k-close">–</div></div>
  </div>

  <div class="controls">
    <div class="seg" id="dirseg">
      <button data-d="all" class="on">All</button>
      <button data-d="bullish">Bullish</button>
      <button data-d="bearish">Bearish</button>
    </div>
    <input type="search" id="q" placeholder="Filter symbol…">
    <select id="sort">
      <option value="newest">Newest first</option>
      <option value="closest">Closest to price</option>
      <option value="symbol">Symbol A–Z</option>
    </select>
  </div>

  <div class="tablebox">
    <table>
      <thead><tr>
        <th>Symbol</th><th>Direction</th>
        <th class="num">Zone bottom</th><th class="num">Zone top</th>
        <th class="num">Last price</th><th class="num">Distance</th>
        <th>Age</th><th>Detected (UTC)</th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <div class="empty" id="empty" style="display:none">No untouched zones right now.</div>
  </div>
  <footer id="foot"></footer>
</div>

<script>
let data = null, lastFetch = 0, dir = 'all', q = '', sortMode = 'newest';

const $ = (id) => document.getElementById(id);

function fmtPrice(v) {
  if (v == null) return '\\u2014';
  let s = v.toFixed(10).replace(/0+$/, '').replace(/\\.$/, '');
  return s === '' ? '0' : s;
}
function fmtAge(sec) {
  if (sec < 3600) return Math.max(1, Math.round(sec / 60)) + 'm';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ' + Math.round((sec % 3600) / 60) + 'm';
  return Math.floor(sec / 86400) + 'd ' + Math.floor((sec % 86400) / 3600) + 'h';
}
function fmtUtc(ts) {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' +
         p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

async function load() {
  try {
    const res = await fetch('/api/zones', { cache: 'no-store' });
    data = await res.json();
    lastFetch = Date.now();
    render();
  } catch (err) { /* tick() shows the stale banner */ }
}

function render() {
  if (!data) return;
  const meta = data.meta || {};
  const zones = data.zones || [];
  const bull = zones.filter(z => z.dir === 'bullish').length;

  $('k-total').textContent = zones.length;
  $('k-bull').textContent = bull;
  $('k-bear').textContent = zones.length - bull;
  $('k-syms').textContent = meta.symbols != null ? meta.symbols : '\\u2014';
  $('meta').textContent = (meta.source || '') + ' \\u00b7 ' + (meta.interval || '');

  let rows = zones.filter(z => dir === 'all' || z.dir === dir);
  if (q) rows = rows.filter(z => z.symbol.includes(q));
  const nowSec = Date.now() / 1000;
  rows.sort((a, b) => {
    if (sortMode === 'closest') {
      const da = a.distPct == null ? 1e9 : Math.abs(a.distPct);
      const db = b.distPct == null ? 1e9 : Math.abs(b.distPct);
      return da - db;
    }
    if (sortMode === 'symbol') return a.symbol.localeCompare(b.symbol);
    return b.detectedTime - a.detectedTime;
  });

  const tbody = $('rows');
  tbody.textContent = '';
  for (const z of rows) {
    const tr = document.createElement('tr');
    const td = (cls) => { const el = document.createElement('td'); if (cls) el.className = cls; tr.appendChild(el); return el; };

    td('sym').textContent = z.symbol;

    const badge = document.createElement('span');
    badge.className = 'badge ' + (z.dir === 'bullish' ? 'bull' : 'bear');
    badge.textContent = z.dir;
    td().appendChild(badge);

    td('num').textContent = fmtPrice(z.bottom);
    td('num').textContent = fmtPrice(z.top);
    td('num').textContent = fmtPrice(z.price);

    const distTd = td('num');
    if (z.distPct == null) distTd.textContent = '\\u2014';
    else if (z.distPct < 0) distTd.textContent = 'inside';
    else {
      distTd.textContent = z.distPct.toFixed(2) + '%';
      if (z.distPct <= 0.5) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = 'near';
        distTd.appendChild(chip);
      }
    }

    td('age').textContent = fmtAge(nowSec - z.detectedTime);
    td('det').textContent = fmtUtc(z.detectedTime);
    tbody.appendChild(tr);
  }
  $('empty').style.display = rows.length ? 'none' : 'block';
}

function tick() {
  const now = Date.now();
  const stale = !lastFetch || now - lastFetch > 20000;
  $('dot').classList.toggle('stale', stale);
  $('banner').classList.toggle('show', stale && lastFetch > 0);
  if (lastFetch) {
    $('livetext').textContent = 'updated ' + Math.round((now - lastFetch) / 1000) + 's ago';
    $('foot').textContent = 'Zones shown are fresh order blocks that price has not touched since detection. ' +
      'Data refreshes every 5s from the local scanner.';
  }
  const meta = data && data.meta;
  if (meta && meta.nextClose) {
    const left = Math.round(meta.nextClose - now / 1000);
    $('k-close').textContent = left > 0
      ? Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0')
      : 'scanning\\u2026';
  }
}

$('dirseg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  dir = b.dataset.d;
  for (const x of $('dirseg').children) x.classList.toggle('on', x === b);
  render();
});
$('q').addEventListener('input', (e) => { q = e.target.value.trim().toUpperCase(); render(); });
$('sort').addEventListener('change', (e) => { sortMode = e.target.value; render(); });

load();
setInterval(load, 5000);
setInterval(tick, 1000);
</script>
</body>
</html>
"""
