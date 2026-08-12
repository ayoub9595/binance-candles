import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { createChart, CandlestickSeries, LineSeries } from 'lightweight-charts';

export const CandlestickChart = forwardRef(function CandlestickChart({ initialData, trendlines }, ref) {
  const containerRef = useRef(null);
  const chartInstanceRef = useRef(null);
  const trendlineSeriesRef = useRef(new Map());
  const lastDataRef = useRef(new Map());

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

    series.setData(initialData || []);
    if (initialData?.length) {
      chart.timeScale().fitContent();
    }

    return () => {
      chart.remove();
      chartInstanceRef.current = null;
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

  useImperativeHandle(ref, () => ({
    updateCandle(bar) {
      chartInstanceRef.current?.series.update(bar);
    },
  }));

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
});
