import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCandles, ensureHistory } from '../services/api.js';
import { useCandleSocket } from '../hooks/useCandleSocket.js';
import { toChartBar } from '../utils/normalizeCandle.js';
import { computeSwingTrendline } from '../utils/swingTrendline.js';
import { computeInducements } from '../utils/inducement.js';
import { computeMarketStructure } from '../utils/marketStructure.js';
import { computeFvgOrderBlocks } from '../utils/orderBlocks.js';
import { computeFvgs } from '../utils/fvg.js';
import { useBarReplay, intervalToSec } from '../hooks/useBarReplay.js';
import { CandlestickChart } from './CandlestickChart.jsx';
import { SymbolIntervalSelector } from './SymbolIntervalSelector.jsx';
import { TrendlineToggles } from './TrendlineToggles.jsx';
import { ReplayControls } from './ReplayControls.jsx';

const TRENDLINE_PALETTE = ['#ab47bc', '#fb8c00', '#42a5f5', '#66bb6a', '#ec407a'];

// Candles loaded for the live chart (~15.6 days of 15m, ~5.2 days of 5m).
const LIVE_HISTORY_LIMIT = 1500;

export function ChartPage({ symbol, interval, instruments, onSymbolChange, onIntervalChange }) {
  const [history, setHistory] = useState(null);
  const [error, setError] = useState(null);
  const [enabledTrendlines, setEnabledTrendlines] = useState([]);
  const [trendlineCandles, setTrendlineCandles] = useState({});
  // Bumped when a replay session exits, to refetch live data that went stale
  // (and was deliberately not updated) while replaying.
  const [reloadKey, setReloadKey] = useState(0);
  const [idmEnabled, setIdmEnabled] = useState(false);
  const [msEnabled, setMsEnabled] = useState(false);
  const [obEnabled, setObEnabled] = useState(false);
  const [fvgEnabled, setFvgEnabled] = useState(false);
  // The bars currently on the main chart, mirrored for the SMC computations
  // (inducement, market structure, order blocks): live history + socket
  // ticks, or replay context + revealed bars. Kept in a ref (mutated in hot
  // per-bar paths) with a version counter that only ticks while a consumer
  // is on, so the mirror is always current but costs no re-renders when all
  // are off.
  const [barsVersion, setBarsVersion] = useState(0);
  const mainBarsRef = useRef([]);
  const smcActiveRef = useRef(false);
  smcActiveRef.current = idmEnabled || msEnabled || obEnabled || fvgEnabled;
  const chartRef = useRef(null);
  const channelCacheRef = useRef(new Map());
  // The active replay session's context bars (everything before the start
  // date). Mirrored in a ref so the rewind callback can prepend them without
  // reaching for `replay`, which it is defined inside of.
  const contextBarsRef = useRef(null);

  const pushMainBar = useCallback((bar) => {
    const arr = mainBarsRef.current;
    const last = arr[arr.length - 1];
    if (last && last.time === bar.time) {
      arr[arr.length - 1] = bar; // forming candle tick
    } else {
      arr.push(bar);
      // Live sessions accumulate forever — bound the mirror. 6000 comfortably
      // exceeds a full replay window (500 context + 5000 forward), so a
      // replay session is never trimmed mid-flight.
      if (arr.length > 6000) arr.splice(0, arr.length - 5000);
    }
    if (smcActiveRef.current) setBarsVersion((v) => v + 1);
  }, []);

  const replay = useBarReplay({
    symbol,
    interval,
    enabledTrendlines,
    onMainBar: (bar) => {
      chartRef.current?.updateCandle(bar);
      pushMainBar(bar);
    },
    // Stepping back: the hook hands over the truncated forward-bar list. The
    // chart series has to be rewritten wholesale (update() can't remove bars),
    // and the SMC mirror is rebuilt as context + revealed so every detector
    // recomputes from exactly the bars visible now. The detectors are
    // prefix-stable, so this yields precisely what they showed on the way up.
    onRewind: (revealed) => {
      // seededFromRef holds the session's context bars (set during render by
      // the seeding block below) — read via the ref rather than `replay`, which
      // is still in its own initializer here.
      const bars = (contextBarsRef.current ?? []).concat(revealed);
      chartRef.current?.setCandles(bars);
      mainBarsRef.current = bars;
      if (smcActiveRef.current) setBarsVersion((v) => v + 1);
    },
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
    // The startup backfill may hold fewer candles than we want to show —
    // ensure the depth exists first (backfills from Binance once per combo,
    // instant on every later load).
    const fromMs = Date.now() - LIVE_HISTORY_LIMIT * intervalToSec(interval) * 1000;
    ensureHistory(symbol, interval, fromMs)
      .catch(() => {}) // stored data may cover enough; the fetch decides
      .then(() => getCandles(symbol, interval, LIVE_HISTORY_LIMIT))
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

  // Seed the inducement mirror synchronously during render, keyed on the
  // identity of the chart's base data (live history load or a replay
  // session's context bars) — an effect would run after paint and let the
  // freshly-mounted chart show one frame of markers computed from the
  // previous session's bars. The mirror then grows through pushMainBar
  // (socket ticks / replay steps).
  const seedSource = replayActive ? replay.contextBars : history;
  const seededFromRef = useRef(null);
  if (seedSource && seededFromRef.current !== seedSource) {
    seededFromRef.current = seedSource;
    mainBarsRef.current = seedSource.slice();
  }
  // Only a live replay session has context bars to prepend on rewind; outside
  // one there is nothing to rewind to.
  contextBarsRef.current = replayActive ? replay.contextBars : null;

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
        const bar = toChartBar(candle);
        chartRef.current?.updateCandle(bar);
        pushMainBar(bar);
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
    [symbol, interval, enabledTrendlines, replayActive, pushMainBar]
  );

  const { connected } = useCandleSocket(combos, handleUpdate);

  // Inducement markers + level lines, recomputed from the mirrored bars on
  // every version tick (live tick or replay step) and on any base-data swap
  // (seedSource identity). Reads the ref during render, which is safe here:
  // every mutation path either bumps barsVersion (while a consumer is on) or
  // changes seedSource, so the memo can never be left holding stale output.
  const inducement = useMemo(() => {
    if (!idmEnabled) return null;
    void barsVersion; // dependency: ref mutations signal through this counter
    void seedSource; // dependency: base-data swaps reseed the ref in render
    return computeInducements(mainBarsRef.current);
  }, [idmEnabled, barsVersion, seedSource]);

  // Only taken inducements are drawn — a solid bar from the swing that built
  // the liquidity to the candle that grabbed it. Pending levels and sweep
  // arrows stay off the chart (kept in the util, unused here by choice).
  // Display cap: each line is its own series, so keep the most recent 40.
  const sweptIdmSegments = useMemo(() => {
    if (!inducement) return null;
    return inducement.segments.filter((s) => s.swept).slice(-40);
  }, [inducement]);

  // IDM display: only the ~dozen most recent taken lines (pivot→take bar)
  // keep the chart calm, plus the pending ones still extending with each new
  // bar. Every pullback now arms its own level, so pending is capped too —
  // each segment is its own chart series, and an untaken stack in a long
  // trend can otherwise run to dozens. Detection stays uncapped; this trims
  // display only.
  const idmLineSegments = useMemo(() => {
    if (!idmEnabled || !inducement) return null;
    const taken = inducement.segments.filter((s) => s.swept).slice(-12);
    const pending = inducement.segments.filter((s) => !s.swept).slice(-12);
    return [...taken, ...pending];
  }, [idmEnabled, inducement]);

  // --- Order blocks: FVG-anchored. The candle before each gap's
  // displacement candle is the origin zone (demand under bullish gaps,
  // supply over bearish ones). Fresh zones extend right; mitigated ones
  // freeze dimmed at their first tap. Caps bound rendering work only.
  const obData = useMemo(() => {
    if (!obEnabled) return null;
    void barsVersion;
    void seedSource;
    return computeFvgOrderBlocks(mainBarsRef.current);
  }, [obEnabled, barsVersion, seedSource]);

  const obBoxes = useMemo(() => {
    if (!obData) return null;
    const toBox = (b) => ({
      time1: b.fromTime,
      time2: b.toTime,
      price1: b.top,
      price2: b.bottom,
      fillColor: b.dir === 'bullish'
        ? `rgba(38, 166, 154, ${b.mitigated ? 0.07 : 0.16})`
        : `rgba(239, 83, 80, ${b.mitigated ? 0.07 : 0.16})`,
      borderColor: b.dir === 'bullish'
        ? `rgba(38, 166, 154, ${b.mitigated ? 0.25 : 0.55})`
        : `rgba(239, 83, 80, ${b.mitigated ? 0.25 : 0.55})`,
    });
    const mitigated = obData.boxes.filter((b) => b.mitigated).slice(-40).map(toBox);
    const fresh = obData.boxes.filter((b) => !b.mitigated).slice(-30).map(toBox);
    return [...mitigated, ...fresh];
  }, [obData]);

  // --- Fair value gaps: every 3-candle imbalance, no size threshold. Open
  // gaps draw bright and extend right; filled ones stay visible as dimmed
  // boxes frozen at their fill bar. Caps bound the rendering work only —
  // detection itself is uncapped.
  const fvg = useMemo(() => {
    if (!fvgEnabled) return null;
    void barsVersion;
    void seedSource;
    return computeFvgs(mainBarsRef.current);
  }, [fvgEnabled, barsVersion, seedSource]);

  const fvgBoxes = useMemo(() => {
    if (!fvg) return null;
    const toBox = (b) => ({
      time1: b.fromTime,
      time2: b.toTime,
      price1: b.top,
      price2: b.bottom,
      fillColor: b.dir === 'bullish'
        ? `rgba(66, 165, 245, ${b.filled ? 0.07 : 0.14})`
        : `rgba(251, 140, 0, ${b.filled ? 0.07 : 0.14})`,
      borderColor: b.dir === 'bullish'
        ? `rgba(66, 165, 245, ${b.filled ? 0.25 : 0.5})`
        : `rgba(251, 140, 0, ${b.filled ? 0.25 : 0.5})`,
    });
    const filled = fvg.boxes.filter((b) => b.filled).slice(-60).map(toBox);
    const open = fvg.boxes.filter((b) => !b.filled).slice(-30).map(toBox);
    return [...filled, ...open];
  }, [fvg]);

  // The chart takes one boxes collection — merge whichever zone features are on.
  const chartBoxes = useMemo(() => {
    if (!obBoxes && !fvgBoxes) return null;
    return [...(obBoxes ?? []), ...(fvgBoxes ?? [])];
  }, [obBoxes, fvgBoxes]);

  // Market structure: BOS/CHoCH labels on the break candles plus the current
  // direction for the header badge. Same mirror, same no-lookahead guarantees
  // as inducement.
  const structure = useMemo(() => {
    if (!msEnabled) return null;
    void barsVersion;
    void seedSource;
    return computeMarketStructure(mainBarsRef.current);
  }, [msEnabled, barsVersion, seedSource]);

  const msMarkers = useMemo(() => {
    if (!structure) return null;
    // shape with size 0 renders just the text — a clean floating label
    return structure.events.map((e) => ({
      time: e.time,
      position: e.dir === 'bullish' ? 'aboveBar' : 'belowBar',
      color: e.dir === 'bullish' ? '#26a69a' : '#ef5350',
      shape: e.dir === 'bullish' ? 'arrowUp' : 'arrowDown',
      size: 0,
      text: e.type,
    }));
  }, [structure]);
  const msTrend = structure ? structure.trend : null;

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
          <div className="trendline-toggles">
            <span className="trendline-label">SMC:</span>
            <button
              type="button"
              title="Mark liquidity sweeps of swing highs/lows on the chart interval"
              className={`trendline-chip ${idmEnabled ? 'active' : ''}`}
              style={{ '--chip-color': '#f0b90b' }}
              onClick={() => setIdmEnabled((v) => !v)}
            >
              IDM
            </button>
            <button
              type="button"
              title="Label BOS/CHoCH breaks and show the current structure direction"
              className={`trendline-chip ${msEnabled ? 'active' : ''}`}
              style={{ '--chip-color': '#5c6bc0' }}
              onClick={() => setMsEnabled((v) => !v)}
            >
              Structure
            </button>
            <button
              type="button"
              title="Order blocks: the candle before each fair value gap's displacement candle"
              className={`trendline-chip ${obEnabled ? 'active' : ''}`}
              style={{ '--chip-color': '#26c6da' }}
              onClick={() => setObEnabled((v) => !v)}
            >
              OB
            </button>
            <button
              type="button"
              title="Draw open fair value gaps (3-candle imbalances) until price fills them"
              className={`trendline-chip ${fvgEnabled ? 'active' : ''}`}
              style={{ '--chip-color': '#42a5f5' }}
              onClick={() => setFvgEnabled((v) => !v)}
            >
              FVG
            </button>
          </div>
          <ReplayControls replay={replay} onExit={replay.exit} />
        </div>
        <div className="status-group">
          {msEnabled && (
            <span className={`status structure-${msTrend ?? 'none'}`}>
              {msTrend === 'bullish' ? 'Bullish ▲' : msTrend === 'bearish' ? 'Bearish ▼' : 'Structure —'}
            </span>
          )}
          {replayActive ? (
            <span className="status replaying">Replay</span>
          ) : (
            <span className={`status ${connected ? 'connected' : 'disconnected'}`}>
              {connected ? 'Live' : 'Connecting...'}
            </span>
          )}
        </div>
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
          <CandlestickChart
            key="live"
            ref={chartRef}
            initialData={history}
            trendlines={trendlineConfigs}
            markers={msMarkers}
            segments={idmLineSegments}
            boxes={chartBoxes}
          />
        )}
        {replayActive && replay.loading && (
          <div className="loading">
            Loading replay data... (older dates are backfilled from Binance on first use — can take a minute)
          </div>
        )}
        {replayActive && !replay.loading && (
          <CandlestickChart
            key={`replay-${replay.sessionId}`}
            ref={chartRef}
            initialData={replay.contextBars}
            trendlines={trendlineConfigs}
            markers={msMarkers}
            segments={idmLineSegments}
            boxes={chartBoxes}
          />
        )}
      </div>
    </div>
  );
}
