// Minimal series primitive that fills price/time rectangles on the chart
// pane — lightweight-charts has no built-in box drawing. Zones (order
// blocks) are set via setRects(); coordinates are recomputed by the library
// on every layout pass through updateAllViews().

class RectanglesPaneView {
  constructor(source) {
    this._source = source;
    this._drawn = [];
  }

  update() {
    const { chart, series, rects } = this._source;
    if (!chart || !series) {
      this._drawn = [];
      return;
    }
    const timeScale = chart.timeScale();
    const visible = timeScale.getVisibleRange();
    this._drawn = [];
    if (!visible) return;

    for (const r of rects) {
      // Clamp offscreen ends to the visible edge — timeToCoordinate returns
      // null outside the visible range, which would otherwise drop a box
      // that's only partially scrolled out of view.
      const t1 = Math.max(Math.min(r.time1, r.time2), visible.from);
      const t2 = Math.min(Math.max(r.time1, r.time2), visible.to);
      if (t1 > t2) continue; // fully offscreen
      const x1 = timeScale.timeToCoordinate(t1);
      const x2 = timeScale.timeToCoordinate(t2);
      const y1 = series.priceToCoordinate(Math.max(r.price1, r.price2));
      const y2 = series.priceToCoordinate(Math.min(r.price1, r.price2));
      if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
      this._drawn.push({ x1, x2, y1, y2, fill: r.fillColor, border: r.borderColor });
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
            const x = Math.min(d.x1, d.x2) * hr;
            const w = Math.max(Math.abs(d.x2 - d.x1) * hr, 1);
            const y = Math.min(d.y1, d.y2) * vr;
            const h = Math.max(Math.abs(d.y2 - d.y1) * vr, 1);
            ctx.fillStyle = d.fill;
            ctx.fillRect(x, y, w, h);
            if (d.border) {
              ctx.strokeStyle = d.border;
              ctx.lineWidth = Math.max(1, Math.floor(hr));
              ctx.strokeRect(x, y, w, h);
            }
          }
        });
      },
    };
  }
}

export class RectanglesPrimitive {
  constructor() {
    this.chart = null;
    this.series = null;
    this.rects = [];
    this._requestUpdate = null;
    this._view = new RectanglesPaneView(this);
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

  setRects(rects) {
    this.rects = rects || [];
    this._requestUpdate?.();
  }

  updateAllViews() {
    this._view.update();
  }

  paneViews() {
    return [this._view];
  }
}
