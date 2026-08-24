// Minimal series primitive that paints text labels anchored to a price level
// over a time span — lightweight-charts has no built-in floating text. Used by
// the OPR overlay to write each range's high/low value above its line. Same
// pattern as rectanglesPrimitive: labels are set via setLabels(), coordinates
// are recomputed by the library on every layout pass through updateAllViews().
//
// A label is { time1, time2, price, text, color }: the text sits just above
// `price`, anchored at time1 but sliding along to the visible left edge while
// any part of [time1, time2] is on screen — so a level's value stays readable
// however far into the day you have scrolled, exactly like TradingView pins
// its line labels.

const FONT_PX = 11;
const PAD_X_PX = 4;
const PAD_Y_PX = 3;

class LabelsPaneView {
  constructor(source) {
    this._source = source;
    this._drawn = [];
  }

  update() {
    const { chart, series, labels } = this._source;
    if (!chart || !series) {
      this._drawn = [];
      return;
    }
    const timeScale = chart.timeScale();
    const visible = timeScale.getVisibleRange();
    this._drawn = [];
    if (!visible) return;

    for (const l of labels) {
      const t1 = Math.max(Math.min(l.time1, l.time2), visible.from);
      const t2 = Math.min(Math.max(l.time1, l.time2), visible.to);
      if (t1 > t2) continue; // span fully offscreen
      const x = timeScale.timeToCoordinate(t1);
      const y = series.priceToCoordinate(l.price);
      if (x === null || y === null) continue;
      this._drawn.push({ x, y, text: l.text, color: l.color });
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
          ctx.font = `${Math.round(FONT_PX * vr)}px -apple-system, system-ui, sans-serif`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          for (const d of drawn) {
            ctx.fillStyle = d.color;
            ctx.fillText(d.text, d.x * hr + PAD_X_PX * hr, d.y * vr - PAD_Y_PX * vr);
          }
        });
      },
    };
  }
}

export class LabelsPrimitive {
  constructor() {
    this.chart = null;
    this.series = null;
    this.labels = [];
    this._requestUpdate = null;
    this._view = new LabelsPaneView(this);
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

  setLabels(labels) {
    this.labels = labels || [];
    this._requestUpdate?.();
  }

  updateAllViews() {
    this._view.update();
  }

  paneViews() {
    return [this._view];
  }
}
