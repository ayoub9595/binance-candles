// Series primitive for user drawings: long/short position tools, trend lines
// and boxes. Kept separate from RectanglesPrimitive (which renders detector
// zones) so user drawings and computed overlays never fight over one list.
//
// Drawing shapes, all in chart space (time in seconds, price absolute):
//   { kind: 'position', dir: 'long'|'short', time1, time2, entry, target, stop }
//   { kind: 'line',     time1, price1, time2, price2, color }
//   { kind: 'box',      time1, price1, time2, price2, color }
//
// Positions render as TradingView-style risk/reward tools: a green profit band
// from entry to target, a red risk band from entry to stop, the entry line
// between them, and per-zone readouts carrying the price, the % move from
// entry, and the R multiple.
//
// The primitive also owns HIT TESTING. It is the only place that knows where
// each drawing's parts ended up in pixel space, so asking it "what is under
// this point?" keeps that knowledge in one place — CandlestickChart drives the
// mouse, this decides what the mouse is on.
//
// Position statistics (quantity, money P/L, R multiple) come from
// computePositionStats — this file only lays the numbers out.

import { computePositionStats, fmtMoney, fmtPct, fmtPrice } from '../utils/positionTool.js';

const PROFIT_FILL = 'rgba(38, 166, 154, 0.18)';
const PROFIT_LINE = 'rgba(38, 166, 154, 0.9)';
const RISK_FILL = 'rgba(239, 83, 80, 0.18)';
const RISK_LINE = 'rgba(239, 83, 80, 0.9)';
const ENTRY_LINE = 'rgba(255, 255, 255, 0.85)';
const SELECTED_GLOW = 'rgba(240, 185, 11, 0.95)';
const HANDLE_FILL = '#131722';

// Pixel slop for grabbing a line or an endpoint. Roughly a fingertip at mouse
// precision — wide enough to catch without swallowing neighbouring parts.
const GRAB_PX = 6;

class DrawingsPaneView {
  constructor(source) {
    this._source = source;
    this._drawn = [];
  }

  // Pixel geometry of everything currently on screen, newest last — which is
  // also paint order, so a reverse scan hit-tests the topmost drawing first.
  get drawn() {
    return this._drawn;
  }

  update() {
    const { chart, series, drawings, selectedId } = this._source;
    this._drawn = [];
    if (!chart || !series) return;
    const timeScale = chart.timeScale();

    // Coordinates for times outside the visible range come back null, so a
    // partially-scrolled drawing would vanish. Clamping both ends to the
    // visible window keeps the on-screen part drawn.
    const visible = timeScale.getVisibleRange();
    if (!visible) return;
    const xOf = (t) => timeScale.timeToCoordinate(Math.min(Math.max(t, visible.from), visible.to));
    const yOf = (p) => series.priceToCoordinate(p);

    for (const d of drawings) {
      const selected = d.id === selectedId;
      if (d.kind === 'position') {
        const x1 = xOf(Math.min(d.time1, d.time2));
        const x2 = xOf(Math.max(d.time1, d.time2));
        const yEntry = yOf(d.entry);
        const yTarget = yOf(d.target);
        const yStop = yOf(d.stop);
        if ([x1, x2, yEntry, yTarget, yStop].some((v) => v === null)) continue;
        const s = computePositionStats(d);
        // Stats follow TradingView's: each zone reports its price, the move
        // from entry as a percentage, the distance in ticks and what it is
        // worth in money at the sized quantity. Compact mode drops the ticks
        // and money, leaving price and percent — enough to read the shape of
        // the trade when several tools share a screen.
        const compact = d.compactStats;
        const zone = (price, pct, ticks, money) =>
          compact
            ? `${fmtPrice(price)}  ${fmtPct(pct)}`
            : `${fmtPrice(price)}  ${fmtPct(pct)}  ${ticks} ticks  ${fmtMoney(money)}`;
        this._drawn.push({
          type: 'position',
          id: d.id,
          x1,
          x2,
          yEntry,
          yTarget,
          yStop,
          selected,
          // "Always show stats" off mirrors TradingView: the numbers appear
          // only while the tool is selected, so a chart carrying several
          // positions is not buried in text.
          showStats: d.alwaysShowStats !== false || selected,
          head: `${d.dir === 'long' ? 'LONG' : 'SHORT'}  ·  ${s.rr.toFixed(2)}R`,
          targetText: `TP ${zone(d.target, s.targetPct, s.targetTicks, s.profitAmount)}`,
          stopText: `SL ${zone(d.stop, s.stopPct, s.stopTicks, -s.lossAmount)}`,
          entryText: `Entry ${fmtPrice(d.entry)}`,
          footText: compact
            ? null
            : `Qty ${s.qty.toFixed(s.qtyPrecision)}  ·  Risk ${fmtMoney(s.lossAmount)}` +
              `  ·  Size ${fmtMoney(s.notional)}  ·  Margin ${fmtMoney(s.margin)}`,
        });
      } else if (d.kind === 'line') {
        const x1 = xOf(d.time1);
        const x2 = xOf(d.time2);
        const y1 = yOf(d.price1);
        const y2 = yOf(d.price2);
        if ([x1, x2, y1, y2].some((v) => v === null)) continue;
        this._drawn.push({ type: 'line', id: d.id, x1, y1, x2, y2, color: d.color, selected });
      } else if (d.kind === 'box') {
        const x1 = xOf(Math.min(d.time1, d.time2));
        const x2 = xOf(Math.max(d.time1, d.time2));
        const y1 = yOf(Math.max(d.price1, d.price2));
        const y2 = yOf(Math.min(d.price1, d.price2));
        if ([x1, x2, y1, y2].some((v) => v === null)) continue;
        this._drawn.push({ type: 'box', id: d.id, x1, y1, x2, y2, color: d.color, selected });
      }
    }
  }

  renderer() {
    const drawn = this._drawn;
    return {
      draw(target) {
        target.useBitmapCoordinateSpace((scope) => {
          const ctx = scope.context;
          const hr = scope.horizontalPixelRatio;
          const vr = scope.verticalPixelRatio;

          // Text sits on translucent bands, so a label over a candle wick stays
          // readable without an opaque plate hiding the price action under it.
          const chip = (text, px, py, color, align = 'left') => {
            ctx.font = `${Math.round(10 * vr)}px sans-serif`;
            const w = ctx.measureText(text).width;
            const x = align === 'right' ? px - w - 6 * hr : px;
            ctx.fillStyle = 'rgba(19, 23, 34, 0.72)';
            ctx.fillRect(x - 3 * hr, py - 10 * vr, w + 6 * hr, 14 * vr);
            ctx.fillStyle = color;
            ctx.fillText(text, x, py);
          };

          const handle = (cx, cy) => {
            ctx.fillStyle = HANDLE_FILL;
            ctx.strokeStyle = SELECTED_GLOW;
            ctx.lineWidth = Math.max(1, Math.floor(1.5 * hr));
            ctx.beginPath();
            ctx.arc(cx, cy, 4 * hr, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          };

          for (const d of drawn) {
            if (d.type === 'position') {
              const x = Math.min(d.x1, d.x2) * hr;
              const w = Math.max(Math.abs(d.x2 - d.x1) * hr, 2);
              // Profit band: entry -> target. Risk band: entry -> stop.
              const yE = d.yEntry * vr;
              const yT = d.yTarget * vr;
              const yS = d.yStop * vr;
              ctx.fillStyle = PROFIT_FILL;
              ctx.fillRect(x, Math.min(yE, yT), w, Math.abs(yT - yE));
              ctx.fillStyle = RISK_FILL;
              ctx.fillRect(x, Math.min(yE, yS), w, Math.abs(yS - yE));

              ctx.lineWidth = Math.max(1, Math.floor(hr));
              ctx.strokeStyle = PROFIT_LINE;
              ctx.strokeRect(x, Math.min(yE, yT), w, Math.abs(yT - yE));
              ctx.strokeStyle = RISK_LINE;
              ctx.strokeRect(x, Math.min(yE, yS), w, Math.abs(yS - yE));

              ctx.strokeStyle = ENTRY_LINE;
              ctx.beginPath();
              ctx.moveTo(x, yE);
              ctx.lineTo(x + w, yE);
              ctx.stroke();

              if (d.selected) {
                ctx.strokeStyle = SELECTED_GLOW;
                ctx.lineWidth = Math.max(2, Math.floor(2 * hr));
                ctx.strokeRect(x, Math.min(yT, yS), w, Math.abs(yS - yT));
              }

              // Header above the whole tool; per-zone readouts inside their
              // own band, so each number sits next to the line it describes;
              // the sizing summary under the whole thing.
              if (d.showStats) {
                chip(d.head, x + 4 * hr, Math.min(yT, yS) - 6 * vr, '#d1d4dc');
                chip(d.targetText, x + w - 2 * hr, yT + 14 * vr, PROFIT_LINE, 'right');
                chip(d.stopText, x + w - 2 * hr, yS - 5 * vr, RISK_LINE, 'right');
                chip(d.entryText, x + 4 * hr, yE - 4 * vr, '#d1d4dc');
                if (d.footText) chip(d.footText, x + 4 * hr, Math.max(yT, yS) + 14 * vr, '#9aa0aa');
              }

              // Grab points, shown only on the selected tool so an unselected
              // chart stays clean.
              if (d.selected) {
                const mid = x + w / 2;
                handle(mid, yE);
                handle(mid, yT);
                handle(mid, yS);
                handle(x + w, yE);
              }
            } else if (d.type === 'line') {
              ctx.strokeStyle = d.selected ? SELECTED_GLOW : d.color;
              ctx.lineWidth = Math.max(d.selected ? 3 : 2, Math.floor((d.selected ? 3 : 2) * hr));
              ctx.beginPath();
              ctx.moveTo(d.x1 * hr, d.y1 * vr);
              ctx.lineTo(d.x2 * hr, d.y2 * vr);
              ctx.stroke();
              if (d.selected) {
                handle(d.x1 * hr, d.y1 * vr);
                handle(d.x2 * hr, d.y2 * vr);
              }
            } else if (d.type === 'box') {
              const x = Math.min(d.x1, d.x2) * hr;
              const w = Math.max(Math.abs(d.x2 - d.x1) * hr, 1);
              const y = Math.min(d.y1, d.y2) * vr;
              const h = Math.max(Math.abs(d.y2 - d.y1) * vr, 1);
              ctx.fillStyle = d.color.replace(/[\d.]+\)$/, '0.12)');
              ctx.fillRect(x, y, w, h);
              ctx.strokeStyle = d.selected ? SELECTED_GLOW : d.color;
              ctx.lineWidth = Math.max(d.selected ? 3 : 1, Math.floor(hr));
              ctx.strokeRect(x, y, w, h);
              if (d.selected) {
                handle(x, y);
                handle(x + w, y + h);
              }
            }
          }
        });
      },
    };
  }
}

export class DrawingsPrimitive {
  constructor() {
    this.chart = null;
    this.series = null;
    this.drawings = [];
    this.selectedId = null;
    this._requestUpdate = null;
    this._view = new DrawingsPaneView(this);
  }

  attached({ chart, series, requestUpdate }) {
    this.chart = chart;
    this.series = series;
    this._requestUpdate = requestUpdate;
  }

  detached() {
    this.chart = null;
    this.series = null;
    this._requestUpdate = null;
  }

  setDrawings(drawings, selectedId = null) {
    this.drawings = drawings || [];
    this.selectedId = selectedId;
    this._requestUpdate?.();
  }

  // What is under (x, y), in CSS pixels relative to the chart pane? Returns
  // { id, part } or null. Parts are the things a drag can move:
  //   position: 'entry' | 'target' | 'stop' | 'right' | 'body'
  //   line:     'p1' | 'p2' | 'body'
  //   box:      'p1' | 'p2' | 'body'
  // Scanned newest-first so the drawing painted on top is the one you grab,
  // and edges are tested before bodies so a handle on a band's boundary wins
  // over the band itself.
  hitTest(x, y) {
    const drawn = this._view.drawn;
    for (let i = drawn.length - 1; i >= 0; i--) {
      const d = drawn[i];
      if (d.type === 'position') {
        const left = Math.min(d.x1, d.x2);
        const right = Math.max(d.x1, d.x2);
        if (x < left - GRAB_PX || x > right + GRAB_PX) continue;
        if (Math.abs(x - right) <= GRAB_PX) return { id: d.id, part: 'right' };
        if (Math.abs(y - d.yEntry) <= GRAB_PX) return { id: d.id, part: 'entry' };
        if (Math.abs(y - d.yTarget) <= GRAB_PX) return { id: d.id, part: 'target' };
        if (Math.abs(y - d.yStop) <= GRAB_PX) return { id: d.id, part: 'stop' };
        const top = Math.min(d.yTarget, d.yStop);
        const bottom = Math.max(d.yTarget, d.yStop);
        if (y >= top && y <= bottom) return { id: d.id, part: 'body' };
      } else if (d.type === 'line') {
        if (Math.hypot(x - d.x1, y - d.y1) <= GRAB_PX) return { id: d.id, part: 'p1' };
        if (Math.hypot(x - d.x2, y - d.y2) <= GRAB_PX) return { id: d.id, part: 'p2' };
        // Distance from the point to the segment.
        const dx = d.x2 - d.x1;
        const dy = d.y2 - d.y1;
        const len2 = dx * dx + dy * dy;
        if (len2 > 0) {
          const t = Math.max(0, Math.min(1, ((x - d.x1) * dx + (y - d.y1) * dy) / len2));
          const px = d.x1 + t * dx;
          const py = d.y1 + t * dy;
          if (Math.hypot(x - px, y - py) <= GRAB_PX) return { id: d.id, part: 'body' };
        }
      } else if (d.type === 'box') {
        if (Math.hypot(x - d.x1, y - d.y1) <= GRAB_PX) return { id: d.id, part: 'p1' };
        if (Math.hypot(x - d.x2, y - d.y2) <= GRAB_PX) return { id: d.id, part: 'p2' };
        const left = Math.min(d.x1, d.x2);
        const right = Math.max(d.x1, d.x2);
        const top = Math.min(d.y1, d.y2);
        const bottom = Math.max(d.y1, d.y2);
        if (x >= left && x <= right && y >= top && y <= bottom) return { id: d.id, part: 'body' };
      }
    }
    return null;
  }

  updateAllViews() {
    this._view.update();
  }

  paneViews() {
    return [this._view];
  }
}
