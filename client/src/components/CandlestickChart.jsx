import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { createChart, createSeriesMarkers, CandlestickSeries, LineSeries, LineStyle } from 'lightweight-charts';
import { RectanglesPrimitive } from './rectanglesPrimitive.js';

export const CandlestickChart = forwardRef(function CandlestickChart(
  { initialData, trendlines, markers, segments, boxes },
  ref
) {
  const containerRef = useRef(null);
  const chartInstanceRef = useRef(null);
  const trendlineSeriesRef = useRef(new Map());
  const lastDataRef = useRef(new Map());
  const markersApiRef = useRef(null);
  const segmentSeriesRef = useRef(new Map());
  const boxesPrimitiveRef = useRef(null);

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
      chart.remove();
      chartInstanceRef.current = null;
      markersApiRef.current = null;
      boxesPrimitiveRef.current = null;
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

  // Horizontal inducement level lines, one short 2-point LineSeries per
  // level: a solid bar from the swing that built the level to the candle that
  // consumed it. Reconciled by level id so an update only touches the lines
  // whose geometry actually changed.
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
      let entry = have.get(id);
      if (!entry) {
        entry = {
          series: chart.addSeries(LineSeries, {
            color: seg.side === 'high' ? '#ef5350' : '#26a69a',
            lineWidth: 2,
            lineStyle: LineStyle.Solid,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            autoscaleInfoProvider: () => null,
          }),
          price: NaN,
          fromTime: NaN,
          toTime: NaN,
        };
        have.set(id, entry);
      }

      if (entry.price !== seg.price || entry.fromTime !== seg.fromTime || entry.toTime !== seg.toTime) {
        entry.series.setData([
          { time: seg.fromTime, value: seg.price },
          { time: seg.toTime, value: seg.price },
        ]);
        entry.price = seg.price;
        entry.fromTime = seg.fromTime;
        entry.toTime = seg.toTime;
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
