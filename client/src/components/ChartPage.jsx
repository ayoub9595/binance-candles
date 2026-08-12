import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCandles } from '../services/api.js';
import { useCandleSocket } from '../hooks/useCandleSocket.js';
import { toChartBar } from '../utils/normalizeCandle.js';
import { computeSwingTrendline } from '../utils/swingTrendline.js';
import { useBarReplay } from '../hooks/useBarReplay.js';
import { CandlestickChart } from './CandlestickChart.jsx';
import { SymbolIntervalSelector } from './SymbolIntervalSelector.jsx';
import { TrendlineToggles } from './TrendlineToggles.jsx';
import { ReplayControls } from './ReplayControls.jsx';

const TRENDLINE_PALETTE = ['#ab47bc', '#fb8c00', '#42a5f5', '#66bb6a', '#ec407a'];

export function ChartPage({ symbol, interval, instruments, onSymbolChange, onIntervalChange }) {
  const [history, setHistory] = useState(null);
  const [error, setError] = useState(null);
  const [enabledTrendlines, setEnabledTrendlines] = useState([]);
  const [trendlineCandles, setTrendlineCandles] = useState({});
  // Bumped when a replay session exits, to refetch live data that went stale
  // (and was deliberately not updated) while replaying.
  const [reloadKey, setReloadKey] = useState(0);
  const chartRef = useRef(null);
  const channelCacheRef = useRef(new Map());

  const replay = useBarReplay({
    symbol,
    interval,
    enabledTrendlines,
    onMainBar: (bar) => chartRef.current?.updateCandle(bar),
    // Null history in the same batch as any exit (button, load error, symbol
    // switch) so the stale pre-replay chart never remounts for a frame
    // before the reloadKey effect below refetches it.
    onExit: () => setHistory(null),
  });
  const replayActive = replay.active;

  const colorFor = useCallback(
    (i) => {
      const idx = instruments.intervals.indexOf(i);
      return TRENDLINE_PALETTE[idx % TRENDLINE_PALETTE.length] || '#888888';
    },
    [instruments.intervals]
  );

  useEffect(() => {
    let cancelled = false;
    setHistory(null);
    setError(null);
    getCandles(symbol, interval, 500)
      .then((data) => {
        if (!cancelled) setHistory(data.map(toChartBar));
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, interval, reloadKey]);

  // Symbol changed (or a replay session exited) while some trendlines were
  // already on: clear synchronously (mirrors the history-null above) so a
  // fast-resolving main fetch never paints stale prices onto the
  // freshly-remounted chart's trendlines while the slower per-interval
  // re-fetch is still in flight.
  useEffect(() => {
    if (enabledTrendlines.length === 0) return;
    let cancelled = false;
    setTrendlineCandles({});
    Promise.all(
      enabledTrendlines.map((i) => getCandles(symbol, i, 500).then((data) => [i, data.map(toChartBar)]))
    )
      .then((pairs) => {
        // Merge, don't replace: a trendline toggled on while this reload was
        // in flight already wrote its own (current-symbol) data — the map was
        // cleared synchronously above, so everything present is fresh.
        if (!cancelled) setTrendlineCandles((prev) => ({ ...prev, ...Object.fromEntries(pairs) }));
      })
      .catch((err) => console.error('failed to reload trendline data for new symbol', err));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, reloadKey]);

  const toggleTrendline = useCallback(
    (i) => {
      setEnabledTrendlines((prev) => {
        if (prev.includes(i)) {
          return prev.filter((x) => x !== i);
        }
        // During a replay the hook fetches this interval's range-bound data
        // instead; live data would be refetched on exit anyway (reloadKey).
        if (!replayActive) {
          getCandles(symbol, i, 500)
            .then((data) => {
              setTrendlineCandles((prevData) => ({ ...prevData, [i]: data.map(toChartBar) }));
            })
            .catch((err) => console.error(`failed to load ${i} trendline`, err));
        }
        return [...prev, i];
      });
    },
    [symbol, replayActive]
  );

  const combos = useMemo(() => {
    const map = new Map();
    map.set(`${symbol}:${interval}`, { symbol, interval });
    for (const i of enabledTrendlines) {
      map.set(`${symbol}:${i}`, { symbol, interval: i });
    }
    return [...map.values()];
  }, [symbol, interval, enabledTrendlines]);

  const handleUpdate = useCallback(
    (candle) => {
      // While replaying, the chart shows the past — don't let live ticks
      // leak in. Live state is refetched wholesale when the replay exits.
      if (replayActive) return;
      if (candle.symbol !== symbol) return;
      if (candle.interval === interval) {
        chartRef.current?.updateCandle(toChartBar(candle));
      }
      if (enabledTrendlines.includes(candle.interval)) {
        const bar = toChartBar(candle);
        setTrendlineCandles((prev) => {
          const arr = prev[candle.interval] || [];
          const last = arr[arr.length - 1];
          const nextArr = last && last.time === bar.time ? [...arr.slice(0, -1), bar] : [...arr, bar];
          return { ...prev, [candle.interval]: nextArr };
        });
      }
    },
    [symbol, interval, enabledTrendlines, replayActive]
  );

  const { connected } = useCandleSocket(combos, handleUpdate);

  // In replay mode the trendlines are computed from the hook's cursor-cut
  // arrays, so the channels only "know" what had happened at the replay time.
  const activeTrendlineCandles = replayActive ? replay.trendlineCandles : trendlineCandles;

  // Per-interval memoized channel computation: a tick only replaces the ticked
  // interval's entry in the candles map, so every other interval's candle
  // array reference is untouched here — only the changed one recomputes.
  const trendlineConfigs = useMemo(
    () =>
      enabledTrendlines.map((i) => {
        const candles = activeTrendlineCandles[i] || [];
        const cached = channelCacheRef.current.get(i);
        let channel;
        if (cached && cached.candles === candles) {
          channel = cached.channel;
        } else {
          channel = computeSwingTrendline(candles);
          channelCacheRef.current.set(i, { candles, channel });
        }
        return {
          interval: i,
          color: colorFor(i),
          resistanceData: channel.resistance,
          supportData: channel.support,
        };
      }),
    [enabledTrendlines, activeTrendlineCandles, colorFor]
  );

  // Refetch live data on ANY replay exit — the ✕ button, but also the hook's
  // auto-exit on a symbol/interval switch or a failed replay load. Live
  // updates were ignored for the whole replay, so both history and trendline
  // candles are stale by now.
  const wasReplayingRef = useRef(false);
  useEffect(() => {
    if (wasReplayingRef.current && !replayActive) {
      setReloadKey((k) => k + 1);
    }
    wasReplayingRef.current = replayActive;
  }, [replayActive]);

  return (
    <div className="chart-page">
      <div className="chart-header">
        <div className="chart-controls">
          <SymbolIntervalSelector
            symbol={symbol}
            interval={interval}
            symbols={instruments.symbols}
            intervals={instruments.intervals}
            onSymbolChange={onSymbolChange}
            onIntervalChange={onIntervalChange}
          />
          <TrendlineToggles
            intervals={instruments.intervals}
            enabled={enabledTrendlines}
            colorFor={colorFor}
            onToggle={toggleTrendline}
          />
          <ReplayControls replay={replay} onExit={replay.exit} />
        </div>
        {replayActive ? (
          <span className="status replaying">Replay</span>
        ) : (
          <span className={`status ${connected ? 'connected' : 'disconnected'}`}>
            {connected ? 'Live' : 'Connecting...'}
          </span>
        )}
      </div>
      <div className="chart-container">
        {/* `error` belongs to the live history fetch — it must not blank an
            active replay, which fetches its own data. */}
        {!replayActive && error && <div className="error">{error}</div>}
        {!replayActive && !error && !history && <div className="loading">Loading candles...</div>}
        {!replayActive && !error && history && history.length === 0 && (
          <div className="loading">No candles yet for this pair — still backfilling, try again shortly.</div>
        )}
        {!replayActive && !error && history && (
          <CandlestickChart key="live" ref={chartRef} initialData={history} trendlines={trendlineConfigs} />
        )}
        {replayActive && replay.loading && <div className="loading">Loading replay data...</div>}
        {replayActive && !replay.loading && (
          <CandlestickChart
            key={`replay-${replay.sessionId}`}
            ref={chartRef}
            initialData={replay.contextBars}
            trendlines={trendlineConfigs}
          />
        )}
      </div>
    </div>
  );
}
