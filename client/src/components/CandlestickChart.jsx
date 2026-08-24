import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { createChart, createSeriesMarkers, CandlestickSeries, LineSeries, LineStyle } from 'lightweight-charts';
import { RectanglesPrimitive } from './rectanglesPrimitive.js';
import { LabelsPrimitive } from './labelsPrimitive.js';
import { DrawingsPrimitive } from './drawingsPrimitive.js';

// Segment line styles arrive as plain strings so the callers (and the utils
// feeding them) never have to import the charting library just to describe an
// overlay. Unknown/absent -> Solid, which is what the original two-point
// inducement lines used.
const LINE_STYLE_BY_NAME = {
  solid: LineStyle.Solid,
  dotted: LineStyle.Dotted,
  dashed: LineStyle.Dashed,
};

// A `segments` item is either the styled multi-point form
//   { id, points: [{time, value}, ...], color, lineStyle, lineWidth }
// used by IDM levels and the pivot connector chains, or the legacy horizontal
// two-point form { id, side, price, fromTime, toTime }. The legacy shape is
// expanded here so any caller still emitting it keeps rendering unchanged.
function segmentPoints(seg) {
  if (seg.points) return seg.points;
  return [
    { time: seg.fromTime, value: seg.price },
    { time: seg.toTime, value: seg.price },
  ];
}

// Cheap content hash of a polyline. ChartPage recomputes every overlay on
// EVERY bar tick, so the points arrays are fresh references each render even
// when the geometry is byte-identical — comparing by reference would call
// setData() (a full series rewrite) on every line, every tick. Chains hold at
// most a handful of points, so joining them is far cheaper than the redraw it
// avoids.
function pointsSignature(points) {
  let sig = '';
  for (const p of points) sig += `${p.time}:${p.value}|`;
  return sig;
}

export const CandlestickChart = forwardRef(function CandlestickChart(
  {
    initialData,
    trendlines,
    markers,
    segments,
    boxes,
    labels,
    drawings,
    selectedDrawingId,
    onChartClick,
    onDrawingSelect,
    onDrawingDrag,
    toolActive,
  },
  ref
) {
  const containerRef = useRef(null);
  const chartInstanceRef = useRef(null);
  const trendlineSeriesRef = useRef(new Map());
  const lastDataRef = useRef(new Map());
  const markersApiRef = useRef(null);
  const segmentSeriesRef = useRef(new Map());
  const boxesPrimitiveRef = useRef(null);
  const labelsPrimitiveRef = useRef(null);
  const drawingsPrimitiveRef = useRef(null);
  // Click handler lives in a ref so subscribing once at mount still calls the
  // latest callback — resubscribing per render would thrash the chart.
  const onChartClickRef = useRef(onChartClick);
  onChartClickRef.current = onChartClick;
  // Same reason as onChartClick: the pointer listeners are bound once at mount
  // and must still see the latest callbacks and the current tool state.
  const onDrawingSelectRef = useRef(onDrawingSelect);
  onDrawingSelectRef.current = onDrawingSelect;
  const onDrawingDragRef = useRef(onDrawingDrag);
  onDrawingDragRef.current = onDrawingDrag;
  const toolActiveRef = useRef(toolActive);
  toolActiveRef.current = toolActive;
  // The in-flight drag: { id, part, price, time }, tracking the pointer's last
  // chart-space position so each move can be sent as a delta.
  const dragRef = useRef(null);

  useEffect(() => {
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { color: '#131722' },
        textColor: '#d1d4dc',
      },
      grid: {
        vertLines: { color: '#1e222d' },
        horzLines: { color: '#1e222d' },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        // Keep a fixed zoom as bars arrive. Without an explicit barSpacing the
        // scale keeps every bar on screen, so a replay feeding thousands of
        // candles compresses them further with each step ("zooming out"). With
        // a set spacing the newest bar is pinned rightOffset bars from the
        // right edge and the chart SCROLLS instead of rescaling. The user can
        // still zoom freely — this only sets the starting scale.
        barSpacing: 8,
        rightOffset: 12,
      },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderVisible: false,
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
    });

    chartInstanceRef.current = { chart, series };
    markersApiRef.current = createSeriesMarkers(series, []);
    boxesPrimitiveRef.current = new RectanglesPrimitive();
    series.attachPrimitive(boxesPrimitiveRef.current);
    // Text labels above the boxes so values stay readable over the fills.
    labelsPrimitiveRef.current = new LabelsPrimitive();
    series.attachPrimitive(labelsPrimitiveRef.current);
    // Attached after the zone boxes so user drawings paint on top of them.
    drawingsPrimitiveRef.current = new DrawingsPrimitive();
    series.attachPrimitive(drawingsPrimitiveRef.current);

    // Clicks carry chart coordinates the drawing tools need: the bar time and
    // the price under the cursor. `point` is missing when the click lands
    // outside the pane, and time is null past the last bar.
    const handleClick = (param) => {
      const cb = onChartClickRef.current;
      if (!cb || !param.point || param.time == null) return;
      const price = series.coordinateToPrice(param.point.y);
      if (price == null) return;
      cb({ time: param.time, price });
    };
    chart.subscribeClick(handleClick);

    // --- Direct manipulation of user drawings.
    //
    // The chart library owns mouse handling for pan/zoom, so grabbing a drawing
    // has to win that contest: these listeners are bound in the CAPTURE phase
    // on the container, which puts them ahead of the library's own handlers,
    // and disable handleScroll/handleScale for the duration of a drag so the
    // chart doesn't pan out from under the thing being dragged.
    //
    // Only live while no drawing TOOL is armed — with a tool selected, clicks
    // are placing points, and hijacking them to drag would make a half-placed
    // drawing impossible to finish.
    const el = containerRef.current;
    const atPointer = (ev) => {
      const rect = el.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      return {
        x,
        y,
        price: series.coordinateToPrice(y),
        // null once the pointer is past the newest bar — callers treat that as
        // "no time under the cursor" rather than clamping to the last one.
        time: chart.timeScale().coordinateToTime(x),
      };
    };

    const handlePointerDown = (ev) => {
      if (ev.button !== 0 || toolActiveRef.current) return;
      const prim = drawingsPrimitiveRef.current;
      if (!prim) return;
      const { x, y, price, time } = atPointer(ev);
      const hit = prim.hitTest(x, y);
      onDrawingSelectRef.current?.(hit ? hit.id : null);
      if (!hit || price == null) return;

      chart.applyOptions({ handleScroll: false, handleScale: false });
      dragRef.current = { ...hit, price, time };
      el.setPointerCapture?.(ev.pointerId);
      // Stop the library seeing this press at all, so no pan begins and no
      // click fires when the button comes back up.
      ev.preventDefault();
      ev.stopPropagation();
    };

    const CURSOR_FOR = { body: 'move', right: 'ew-resize', p1: 'grab', p2: 'grab' };

    const handlePointerMove = (ev) => {
      const drag = dragRef.current;
      const { x, y, price, time } = atPointer(ev);

      if (!drag) {
        // Hover feedback: what would this press grab? While a tool is armed the
        // inline cursor is cleared instead, so the container's crosshair class
        // shows through rather than a stale 'move' left over from a hover.
        if (toolActiveRef.current) {
          el.style.cursor = '';
          return;
        }
        const hit = drawingsPrimitiveRef.current?.hitTest(x, y);
        el.style.cursor = hit ? (CURSOR_FOR[hit.part] ?? 'ns-resize') : '';
        return;
      }

      if (price == null) return;
      onDrawingDragRef.current?.({
        id: drag.id,
        part: drag.part,
        price,
        time,
        dPrice: price - drag.price,
        dTime: time != null && drag.time != null ? time - drag.time : 0,
      });
      drag.price = price;
      if (time != null) drag.time = time;
      ev.preventDefault();
      ev.stopPropagation();
    };

    const endDrag = (ev) => {
      if (!dragRef.current) return;
      dragRef.current = null;
      chart.applyOptions({ handleScroll: true, handleScale: true });
      el.releasePointerCapture?.(ev.pointerId);
    };

    el.addEventListener('pointerdown', handlePointerDown, true);
    el.addEventListener('pointermove', handlePointerMove, true);
    el.addEventListener('pointerup', endDrag, true);
    // A cancelled pointer (window blur, touch interruption) must still restore
    // panning, or the chart silently stops responding to drags.
    el.addEventListener('pointercancel', endDrag, true);

    series.setData(initialData || []);
    if (initialData?.length) {
      // Deliberately NOT fitContent(): that recomputes barSpacing to squeeze
      // every bar into the viewport, discarding the fixed spacing configured
      // above and re-introducing the shrink-per-bar behaviour during replay.
      // Scrolling to the newest bar keeps the configured zoom and shows the
      // most recent history, which is what matters on load.
      chart.timeScale().scrollToRealTime();
    }

    return () => {
      chart.unsubscribeClick(handleClick);
      el.removeEventListener('pointerdown', handlePointerDown, true);
      el.removeEventListener('pointermove', handlePointerMove, true);
      el.removeEventListener('pointerup', endDrag, true);
      el.removeEventListener('pointercancel', endDrag, true);
      chart.remove();
      chartInstanceRef.current = null;
      markersApiRef.current = null;
      boxesPrimitiveRef.current = null;
      labelsPrimitiveRef.current = null;
      drawingsPrimitiveRef.current = null;
      segmentSeriesRef.current.clear();
      trendlineSeriesRef.current.clear();
      lastDataRef.current.clear();
    };
    // initialData is only used for the one-time setData() at chart creation;
    // ChartPage waits until history is loaded before mounting this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const { chart } = chartInstanceRef.current || {};
    if (!chart) return;

    // Adding/removing a series with a different granularity changes the merged
    // set of time-axis points, which shifts what a *logical* (bar-index) range
    // maps to — so capture/restore the visible window in actual time, not index,
    // to keep the user's zoom/pan stable across a trendline toggle.
    // Exception: when the user is at the right edge (following the newest
    // bars — always the case while a replay feeds forward), restoring a fixed
    // time range would pin the window and detach right-edge tracking, so
    // re-stick to real time instead. scrollPosition() is the bar offset
    // between the last bar and the right edge; negative means the user has
    // panned back into history.
    const timeScale = chart.timeScale();
    const followingRealTime = timeScale.scrollPosition() > -0.5;
    const visibleRange = timeScale.getVisibleRange();

    const activeIntervals = new Set(trendlines.map((t) => t.interval));

    for (const [interval, entry] of trendlineSeriesRef.current) {
      if (!activeIntervals.has(interval)) {
        chart.removeSeries(entry.resistance);
        chart.removeSeries(entry.support);
        trendlineSeriesRef.current.delete(interval);
        lastDataRef.current.delete(interval);
      }
    }

    for (const t of trendlines) {
      let entry = trendlineSeriesRef.current.get(t.interval);
      if (!entry) {
        entry = {
          // autoscaleInfoProvider excludes an extrapolated trendline (which can
          // project well outside the real price range) from stretching the
          // chart's auto-scaled price axis — only the candlesticks drive that.
          resistance: chart.addSeries(LineSeries, {
            color: t.color,
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: false,
            autoscaleInfoProvider: () => null,
          }),
          support: chart.addSeries(LineSeries, {
            color: t.color,
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: false,
            autoscaleInfoProvider: () => null,
          }),
        };
        trendlineSeriesRef.current.set(t.interval, entry);
      }

      // Only redraw a line whose underlying data reference actually changed —
      // ChartPage memoizes per-interval, so an unrelated interval's tick never
      // reaches here with a new reference for this one. Keeps a live tick from
      // triggering setData() (much heavier than the main series' .update()) on
      // every active interval's lines instead of just the one that changed.
      const last = lastDataRef.current.get(t.interval);
      if (!last || last.resistanceData !== t.resistanceData) {
        entry.resistance.setData(t.resistanceData || []);
      }
      if (!last || last.supportData !== t.supportData) {
        entry.support.setData(t.supportData || []);
      }
      lastDataRef.current.set(t.interval, { resistanceData: t.resistanceData, supportData: t.supportData });
    }

    if (followingRealTime) {
      timeScale.scrollToRealTime();
    } else if (visibleRange) {
      // Only restore when the update actually moved the window — a redundant
      // setVisibleRange still interrupts an in-progress user pan/zoom.
      const current = timeScale.getVisibleRange();
      if (!current || current.from !== visibleRange.from || current.to !== visibleRange.to) {
        timeScale.setVisibleRange(visibleRange);
      }
    }
  }, [trendlines]);

  // Inducement (or any) series markers — a plain declarative sync.
  useEffect(() => {
    markersApiRef.current?.setMarkers(markers || []);
  }, [markers]);

  // Zone boxes (order blocks) — drawn by the rectangles primitive.
  useEffect(() => {
    boxesPrimitiveRef.current?.setRects(boxes || []);
  }, [boxes]);

  // Floating text labels (OPR values) — their own primitive layer.
  useEffect(() => {
    labelsPrimitiveRef.current?.setLabels(labels || []);
  }, [labels]);

  // User drawings (positions, lines, boxes) — their own primitive layer.
  useEffect(() => {
    drawingsPrimitiveRef.current?.setDrawings(drawings || [], selectedDrawingId ?? null);
  }, [drawings, selectedDrawingId]);

  // Overlay polylines — one LineSeries per segment. Two kinds share this pool:
  // horizontal IDM level lines (an order block's inducement, top bar -> break
  // bar, or top bar -> last bar while the break is pending) and the sloped
  // pivot connector chains that link consecutive swing highs/lows within a
  // structure leg. Both are just "a styled list of points", so they reconcile
  // through the same id-keyed pass.
  //
  // Two independent things are diffed per series, because they change on
  // different schedules: GEOMETRY (the points, which grow/extend as bars
  // arrive) and STYLE (color/lineStyle/lineWidth, which for a given id only
  // ever changes when a pending inducement is broken and its dotted faded
  // line turns solid full-strength; connectors never restyle at all, so the
  // check is what keeps the other ~50 series untouched every tick).
  // Each is only pushed to the library when it actually differs — setData() and
  // applyOptions() both trigger a redraw, and this effect runs on every tick.
  // autoscaleInfoProvider keeps these overlays out of the price-axis fit, so a
  // stale far-away level can never stretch the candle scale.
  useEffect(() => {
    const { chart } = chartInstanceRef.current || {};
    if (!chart) return;

    const want = new Map((segments || []).map((s) => [s.id, s]));
    const have = segmentSeriesRef.current;

    for (const [id, entry] of have) {
      if (!want.has(id)) {
        chart.removeSeries(entry.series);
        have.delete(id);
      }
    }

    for (const [id, seg] of want) {
      const points = segmentPoints(seg);
      // Defaults reproduce the pre-styling behaviour for callers that only
      // send the legacy shape: solid 2px, red above / teal below.
      const color = seg.color ?? (seg.side === 'high' ? '#ef5350' : '#26a69a');
      const lineWidth = seg.lineWidth ?? 2;
      const lineStyle = LINE_STYLE_BY_NAME[seg.lineStyle] ?? LineStyle.Solid;

      let entry = have.get(id);
      if (!entry) {
        entry = {
          series: chart.addSeries(LineSeries, {
            color,
            lineWidth,
            lineStyle,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            autoscaleInfoProvider: () => null,
          }),
          // null (not '') so a segment whose points list is legitimately empty
          // still gets its one setData() and clears the series.
          sig: null,
          color,
          lineWidth,
          lineStyle,
        };
        have.set(id, entry);
      } else if (entry.color !== color || entry.lineWidth !== lineWidth || entry.lineStyle !== lineStyle) {
        entry.series.applyOptions({ color, lineWidth, lineStyle });
        entry.color = color;
        entry.lineWidth = lineWidth;
        entry.lineStyle = lineStyle;
      }

      const sig = pointsSignature(points);
      if (entry.sig !== sig) {
        entry.series.setData(points);
        entry.sig = sig;
      }
    }
  }, [segments]);

  useImperativeHandle(ref, () => ({
    updateCandle(bar) {
      chartInstanceRef.current?.series.update(bar);
    },
    // Stepping a replay backwards has to REMOVE the last bar, which
    // series.update() cannot do (it only appends or replaces the newest bar).
    // setData() is the only way to shrink the series, so the caller hands over
    // the whole truncated array. Kept off the hot forward path — that stays on
    // updateCandle — so the O(n) rewrite only happens on an explicit step back.
    setCandles(bars) {
      chartInstanceRef.current?.series.setData(bars);
    },
  }));

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
});
