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
// from entry to target and a red risk band from entry to stop, with the entry
// line between them and a label carrying the R multiple.

const PROFIT_FILL = 'rgba(38, 166, 154, 0.18)';
const PROFIT_LINE = 'rgba(38, 166, 154, 0.9)';
const RISK_FILL = 'rgba(239, 83, 80, 0.18)';
const RISK_LINE = 'rgba(239, 83, 80, 0.9)';
const ENTRY_LINE = 'rgba(255, 255, 255, 0.85)';
const SELECTED_GLOW = 'rgba(240, 185, 11, 0.95)';

function fmtPrice(v) {
  const abs = Math.abs(v);
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return v.toFixed(decimals);
}

class DrawingsPaneView {
  constructor(source) {
    this._source = source;
    this._drawn = [];
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
        const risk = Math.abs(d.entry - d.stop);
        const reward = Math.abs(d.target - d.entry);
        const rr = risk > 0 ? reward / risk : 0;
        this._drawn.push({
          type: 'position',
          x1,
          x2,
          yEntry,
          yTarget,
          yStop,
          selected,
          label: `${d.dir === 'long' ? 'LONG' : 'SHORT'}  ${rr.toFixed(2)}R`,
          sub: `E ${fmtPrice(d.entry)}  T ${fmtPrice(d.target)}  S ${fmtPrice(d.stop)}`,
        });
      } else if (d.kind === 'line') {
        const x1 = xOf(d.time1);
        const x2 = xOf(d.time2);
        const y1 = yOf(d.price1);
        const y2 = yOf(d.price2);
        if ([x1, x2, y1, y2].some((v) => v === null)) continue;
        this._drawn.push({ type: 'line', x1, y1, x2, y2, color: d.color, selected });
      } else if (d.kind === 'box') {
        const x1 = xOf(Math.min(d.time1, d.time2));
        const x2 = xOf(Math.max(d.time1, d.time2));
        const y1 = yOf(Math.max(d.price1, d.price2));
        const y2 = yOf(Math.min(d.price1, d.price2));
        if ([x1, x2, y1, y2].some((v) => v === null)) continue;
        this._drawn.push({ type: 'box', x1, y1, x2, y2, color: d.color, selected });
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

              ctx.fillStyle = '#d1d4dc';
              ctx.font = `${Math.round(11 * vr)}px sans-serif`;
              ctx.fillText(d.label, x + 4 * hr, Math.min(yT, yS) - 6 * vr);
              ctx.fillStyle = '#9aa0aa';
              ctx.font = `${Math.round(10 * vr)}px sans-serif`;
              ctx.fillText(d.sub, x + 4 * hr, Math.max(yT, yS) + 12 * vr);
            } else if (d.type === 'line') {
              ctx.strokeStyle = d.selected ? SELECTED_GLOW : d.color;
              ctx.lineWidth = Math.max(d.selected ? 3 : 2, Math.floor((d.selected ? 3 : 2) * hr));
              ctx.beginPath();
              ctx.moveTo(d.x1 * hr, d.y1 * vr);
              ctx.lineTo(d.x2 * hr, d.y2 * vr);
              ctx.stroke();
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

  updateAllViews() {
    this._view.update();
  }

  paneViews() {
    return [this._view];
  }
}
