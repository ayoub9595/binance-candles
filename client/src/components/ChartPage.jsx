import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCandles, ensureHistory } from '../services/api.js';
import { useCandleSocket } from '../hooks/useCandleSocket.js';
import { toChartBar } from '../utils/normalizeCandle.js';
import { computeSwingTrendline } from '../utils/swingTrendline.js';
import { computeObTopBreaks } from '../utils/obTopBreak.js';
import { computePivotConnectors } from '../utils/pivotConnectors.js';
import { computeMarketStructure } from '../utils/marketStructure.js';
import { computeFvgOrderBlocks } from '../utils/orderBlocks.js';
import { computeFvgs } from '../utils/fvg.js';
import { useBarReplay, intervalToSec, REPLAY_FORWARD_LIMIT } from '../hooks/useBarReplay.js';
import { useHtfBias } from '../hooks/useHtfBias.js';
import { useDrawingTools } from '../hooks/useDrawingTools.js';
import { DrawingToolbar } from './DrawingToolbar.jsx';
import { PositionSettings } from './PositionSettings.jsx';
import { CandlestickChart } from './CandlestickChart.jsx';
import { SymbolIntervalSelector } from './SymbolIntervalSelector.jsx';
import { MoversBar } from './MoversBar.jsx';
import { TrendlineToggles } from './TrendlineToggles.jsx';
import { ReplayControls } from './ReplayControls.jsx';

const TRENDLINE_PALETTE = ['#ab47bc', '#fb8c00', '#42a5f5', '#66bb6a', '#ec407a'];

// Candles loaded for the live chart (~15.6 days of 15m, ~5.2 days of 5m).
const LIVE_HISTORY_LIMIT = 1500;

// Higher timeframes whose structure trend forms the trading bias. Ordered
// highest-first, which is how the panel reads top-down.
const HTF_BIAS_INTERVALS = ['4h', '1h'];

// Overlay palette for everything swing-related, kept as raw rgb triples so the
// same hue can be re-tinted per importance tier without maintaining a parallel
// list of hex constants. High side = the candle-down red, low side = the
// candle-up teal, matching the series colors so a level reads as belonging to
// the swing it came from.
const SWING_HIGH_RGB = '239, 83, 80';
const SWING_LOW_RGB = '38, 166, 154';

// Display caps. Every segment is its own chart series, so an uncapped overlay
// is a real rendering cost, not just visual noise: detection stays complete
// (the utils return everything, keeping them prefix-stable) and only what
// reaches the chart is trimmed to the most recent entries. The IDM cap
// applies per population (broken and still-pending lines are trimmed
// separately — see obIdm), so the worst case is twice its number.
const IDM_LINE_CAP = 20;
const CONNECTOR_CHAINS_PER_SIDE = 4;

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
  // Keep only order blocks whose move broke the summit that gave their bottom
  // (demand) / the valley that gave their top (supply). Its own toggle rather
  // than a rider on the IDM chip: IDM means "draw the inducement lines", and
  // quietly having it also delete most of the order blocks made zones vanish
  // for no visible reason.
  const [idmObEnabled, setIdmObEnabled] = useState(false);
  const [htfEnabled, setHtfEnabled] = useState(false);
  // The bars currently on the main chart, mirrored for the SMC computations
  // (market structure, order blocks and their inducements): live history + socket
  // ticks, or replay context + revealed bars. Kept in a ref (mutated in hot
  // per-bar paths) with a version counter that only ticks while a consumer
  // is on, so the mirror is always current but costs no re-renders when all
  // are off.
  const [barsVersion, setBarsVersion] = useState(0);
  const mainBarsRef = useRef([]);
  const smcActiveRef = useRef(false);
  smcActiveRef.current = idmEnabled || msEnabled || obEnabled || fvgEnabled || idmObEnabled;
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

  // Seed the SMC bars mirror synchronously during render, keyed on the
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

  // Pivot connector chains: consecutive swing highs (and consecutive swing
  // lows) of one structure leg joined by a sloped dotted line, terminating at
  // the break that ends the leg — the "relate the top candles" reading aid
  // from the reference indicator. Same tracker (5/5) as the BOS/CHoCH labels,
  // so the chains always break where the structure does. Computed with the
  // exact pattern of the other overlays: the mirror is read through the ref,
  // and barsVersion / seedSource are the dependencies that signal it changed.
  const connectors = useMemo(() => {
    if (!idmEnabled) return null;
    void barsVersion; // dependency: ref mutations signal through this counter
    void seedSource; // dependency: base-data swaps reseed the ref in render
    return computePivotConnectors(mainBarsRef.current);
  }, [idmEnabled, barsVersion, seedSource]);

  // Connector chains are structural context, not signals, so they sit below
  // everything else in weight: dotted, 1px, ~0.35 alpha. Only the last few
  // legs per side are drawn — older chains are still returned by the util
  // (it stays uncapped and prefix-stable), just not rendered.
  const connectorSegments = useMemo(() => {
    if (!connectors) return null;
    const lastPerSide = (side) =>
      connectors.chains.filter((c) => c.side === side).slice(-CONNECTOR_CHAINS_PER_SIDE);
    return [...lastPerSide('high'), ...lastPerSide('low')].map((c) => ({
      // Namespaced: chain ids are per-side/per-leg (`high:3`) and would
      // otherwise be free to collide with an IDM level id.
      id: `conn:${c.id}`,
      points: c.points,
      color: `rgba(${c.side === 'high' ? SWING_HIGH_RGB : SWING_LOW_RGB}, 0.35)`,
      lineStyle: 'dotted',
      lineWidth: 1,
    }));
  }, [connectors]);

  // --- Higher-timeframe bias (4h + 1h) for trading the lower timeframe. The
  // panel is context, not an overlay: it reports each HTF's structure trend so
  // a 15m entry can be judged with or against the bigger move. Declared ahead
  // of the order-block memos because the OB overlay is gated on it.
  //
  // In replay the cursor's wall-clock time cuts the HTF candles, so the panel
  // shows the bias as it stood then — same no-lookahead guarantee as the rest.
  // Live (cursor null) it just uses everything loaded.
  const htfCursorSec = useMemo(() => {
    if (!replayActive) return null;
    const revealed = replay.cursor;
    // Before the first step "now" is the session's start date itself — the
    // same instant useBarReplay seeds its trendline overlays with, so the two
    // overlays agree at the same cursor. The last context bar's OPEN would be
    // up to a full chart interval earlier (start() trims context so its last
    // bar CLOSED before the start), which is not lookahead but does mean the
    // panel a user reads before pressing play describes an older moment than
    // the date they picked, and then jumps on the first step.
    if (revealed < 0) return replay.startMs > 0 ? Math.floor(replay.startMs / 1000) : 0;
    // The revealed bar's CLOSE is "now" in replay terms.
    return mainBarsRef.current.length
      ? mainBarsRef.current[mainBarsRef.current.length - 1].time + intervalToSec(interval)
      : 0;
  }, [replayActive, replay.cursor, replay.startMs, interval, barsVersion]);

  const htfSpanSec = useMemo(() => {
    const pages = Math.max(1, Math.ceil((replay.total || 0) / REPLAY_FORWARD_LIMIT));
    return pages * REPLAY_FORWARD_LIMIT * intervalToSec(interval);
  }, [replay.total, interval]);

  const htf = useHtfBias({
    symbol,
    intervals: HTF_BIAS_INTERVALS,
    cursorSec: htfCursorSec,
    // Anchor the fetch to the simulated window, not the live one. Without it
    // the hook pulls the most recent N candles per timeframe and then cuts
    // them to the cursor, so a session started far enough back leaves nothing
    // before the cursor and every bias reads unknown — the panel shows "—" and
    // the gate below would silently never open.
    anchorMs: replayActive ? replay.startMs : null,
    // How far this session can actually play, so the HTF window is sized to it
    // rather than to a flat constant a 1h/4h chart would outrun. Quantised to
    // whole replay pages: the session grows a page at a time, so this changes
    // once per extension instead of on every bar.
    spanSec: htfSpanSec,
    active: htfEnabled,
  });

  // Which order-block directions may reach the chart. The OB and HTF chips
  // COMPOSE: with HTF off the overlay is exactly what it has always been, and
  // with HTF on only zones that trade with an aligned 4h+1h bias survive —
  // that alignment is the whole premise of the simulation, so a zone against
  // it is noise. 'both' means ungated; null means the gate is shut and nothing
  // renders.
  const obAllowedDir = useMemo(() => {
    if (!htfEnabled) return 'both';
    // Loading is "bias not known yet", NOT "no bias". Falling through to
    // 'both' here would flash the full ungated overlay for a frame on every
    // session start, symbol switch and re-anchor, so an unresolved gate blocks
    // rather than guesses.
    if (htf.loading) return null;
    if (htf.allBullish) return 'bullish';
    if (htf.allBearish) return 'bearish';
    // Timeframes disagree, or one of them is unknown — neither side has the
    // higher-timeframe backing the gate exists to require.
    return null;
  }, [htfEnabled, htf.loading, htf.allBullish, htf.allBearish]);

  // --- Skip to the next setup: fast-forward the simulation to the next bar
  // on which an order block prints. With the HTF chip on, only zones with the
  // higher timeframes behind them count — a DEMAND zone under an
  // aligned-bullish 4h+1h, or a SUPPLY zone under an aligned-bearish one;
  // with it off, the next zone of the requested side counts outright. Bars in
  // between are revealed exactly as stepping would reveal them, so landing
  // there is identical to having walked it by hand.
  //
  // Not lookahead: the scan reads bars the cursor has not reached, but every
  // test it applies is causal. An order block is decided entirely by its gap
  // and the candles BEHIND it, so a full-range run identifies the same zones,
  // on the same bars, that a prefix run at each candidate would — this
  // is the prefix-stability the detectors are built for, used to answer the
  // question once instead of once per candidate. The bias likewise comes from
  // biasAt(), which only counts HTF candles closed by that bar.
  const [skipNote, setSkipNote] = useState(null);
  // Any cursor movement makes a "nothing found" note stale.
  useEffect(() => setSkipNote(null), [replay.cursor, replay.sessionId]);

  // One scan, parameterised by side, so the two directions cannot drift apart:
  // the bearish skip is the bullish one with the zone direction and the
  // alignment test mirrored, and nothing else.
  const skipToAlignedOb = useCallback(
    (dir) => {
      const forward = replay.getForwardBars();
      if (!forward.length) return;

      // Detection times of matching zones across the whole session.
      // `detectedTime` is the gap's third candle — the bar the zone first
      // became known on, two bars after its origin — which is the bar a replay
      // can first act on it.
      const { boxes } = computeFvgOrderBlocks((replay.contextBars ?? []).concat(forward));
      const printedAt = new Set(boxes.filter((b) => b.dir === dir).map((b) => b.detectedTime));

      const intervalSec = intervalToSec(interval);
      for (let k = replay.cursor + 1; k < forward.length; k++) {
        const bar = forward[k];
        // Cheap test first: alignment is only worth computing on the handful of
        // bars that actually print a zone.
        if (!printedAt.has(bar.time)) continue;
        // The alignment gate belongs to the HTF chip; with it off, the next
        // zone of the requested side is the destination, no questions asked.
        if (htfEnabled) {
          const at = htf.biasAt(bar.time + intervalSec);
          if (!(dir === 'bullish' ? at.allBullish : at.allBearish)) continue;
        }
        replay.jumpTo(k);
        return;
      }
      // "Ahead" means ahead in what is LOADED. A capped window may still have
      // more session behind it, so say so rather than implying the search was
      // exhaustive — playing to the edge pages the next chunk in, after which
      // the same click searches further.
      const side =
        dir === 'bullish'
          ? htfEnabled ? 'aligned-bull demand' : 'demand'
          : htfEnabled ? 'aligned-bear supply' : 'supply';
      setSkipNote(
        replay.windowCapped
          ? `no ${side} OB in the loaded window`
          : `no ${side} OB ahead`
      );
    },
    [replay, interval, htf, htfEnabled]
  );

  const skipToAlignedBullOb = useCallback(() => skipToAlignedOb('bullish'), [skipToAlignedOb]);
  const skipToAlignedBearOb = useCallback(() => skipToAlignedOb('bearish'), [skipToAlignedOb]);

  // The same hunt, pointed backwards: rewind to the most recent zone of the
  // side BEHIND the cursor (HTF-gated identically when the chip is on). The
  // scan is the forward one mirrored — same detection, same gate — and the
  // landing is honest for the same reason stepBack is: everything the rewind
  // shows was already revealed once.
  const skipBackToOb = useCallback(
    (dir) => {
      const forward = replay.getForwardBars();
      if (!forward.length) return;
      const { boxes } = computeFvgOrderBlocks((replay.contextBars ?? []).concat(forward));
      const printedAt = new Set(boxes.filter((b) => b.dir === dir).map((b) => b.detectedTime));
      const intervalSec = intervalToSec(interval);
      for (let k = replay.cursor - 1; k >= 0; k--) {
        const bar = forward[k];
        if (!printedAt.has(bar.time)) continue;
        if (htfEnabled) {
          const at = htf.biasAt(bar.time + intervalSec);
          if (!(dir === 'bullish' ? at.allBullish : at.allBearish)) continue;
        }
        replay.jumpBackTo(k);
        return;
      }
      const side =
        dir === 'bullish'
          ? htfEnabled ? 'aligned-bull demand' : 'demand'
          : htfEnabled ? 'aligned-bear supply' : 'supply';
      setSkipNote(`no ${side} OB behind`);
    },
    [replay, interval, htf, htfEnabled]
  );
  const skipBackToBullOb = useCallback(() => skipBackToOb('bullish'), [skipBackToOb]);
  const skipBackToBearOb = useCallback(() => skipBackToOb('bearish'), [skipBackToOb]);

  // The skips only need 4h/1h structure while the HTF chip is on (it supplies
  // the alignment gate). HTF on but still loading means the gate is unknown,
  // so block rather than guess; HTF off skips to the next zone outright.
  const skipDisabled = (htfEnabled && htf.loading) || replay.loading || replay.atEnd;
  // The backwards pair cares about the start edge, not the end one — skipping
  // back from the very end of the data is precisely its use case.
  const skipBackDisabled = (htfEnabled && htf.loading) || replay.loading || replay.atStart;
  const skipBackTitleFor = (dir) =>
    htfEnabled && htf.loading
      ? 'Loading 4h/1h history…'
      : dir === 'bull'
        ? htfEnabled
          ? 'Skip back to the previous demand order block printed while 4h+1h were aligned bullish'
          : 'Skip back to the previous demand order block'
        : htfEnabled
          ? 'Skip back to the previous supply order block printed while 4h+1h were aligned bearish'
          : 'Skip back to the previous supply order block';
  const skipTitleFor = (dir) =>
    htfEnabled && htf.loading
      ? 'Loading 4h/1h history…'
      : dir === 'bull'
        ? htfEnabled
          ? 'Skip to the next demand order block printed while 4h+1h are aligned bullish'
          : 'Skip to the next demand order block (turn on HTF to require 4h+1h aligned bullish)'
        : htfEnabled
          ? 'Skip to the next supply order block printed while 4h+1h are aligned bearish'
          : 'Skip to the next supply order block (turn on HTF to require 4h+1h aligned bearish)';

  // --- Order blocks: FVG-anchored. Each gap resolves to at most one zone by
  // walking back from the candle before its displacement candle — past any
  // candle that swallowed that one whole while still leaving the imbalance
  // intact, and dropped entirely if the origin never dug past the candle
  // behind it (see orderBlocks.js). Demand under bullish gaps, supply over
  // bearish ones. Fresh zones extend right; mitigated ones freeze dimmed at
  // their first tap. Caps bound rendering work only.
  const obData = useMemo(() => {
    // Two consumers: the OB boxes overlay, and the IDM overlay — which draws
    // each zone's inducement line even when the boxes themselves are off.
    if (!obEnabled && !idmEnabled) return null;
    void barsVersion;
    void seedSource;
    return computeFvgOrderBlocks(mainBarsRef.current);
  }, [obEnabled, idmEnabled, barsVersion, seedSource]);

  // Summit-break verdicts for the OB×IDM filter, one per zone: did the move
  // off this order block break the summit its decline fell from (demand) /
  // the valley its rally rose from (supply)? Computed against the same mirror
  // on the same tick as obData — obData's identity is the change signal, so
  // no separate barsVersion dependency is needed.
  const obTopBreaks = useMemo(() => {
    if ((!idmObEnabled && !idmEnabled) || !obData) return null;
    return computeObTopBreaks(mainBarsRef.current, obData.boxes);
  }, [idmObEnabled, idmEnabled, obData]);

  // The IDM overlay, based on order blocks: the only inducements drawn are
  // the ones order blocks answer to — each zone's walk-back top (see
  // computeObTopBreaks) as a level line from the top candle to its break bar
  // (solid, full strength once broken) or extending right while the zone is
  // fresh and the break is pending (dotted, faded). Zones that died un-broken
  // draw nothing: their inducement relationship failed. Several zones born of
  // one decline share a top, so lines dedupe by (side, top bar, price) with a
  // broken line beating a pending twin. Markers tag break bars in the app's
  // classic take colors; the LINES keep the user's swapped palette (tops
  // green, bottoms red).
  const obIdm = useMemo(() => {
    if (!idmEnabled || !obData || !obTopBreaks) return null;
    const bars = mainBarsRef.current;
    const lastTime = bars.length ? bars[bars.length - 1].time : 0;
    const broke = new Map(); // key -> line
    const pending = new Map();
    for (const b of obData.boxes) {
      const v = obTopBreaks.get(b.id);
      if (!v) continue;
      const side = b.dir === 'bullish' ? 'high' : 'low';
      const key = `${side}:${v.targetTime}:${v.targetPrice}`;
      if (v.broke) {
        if (!broke.has(key)) {
          broke.set(key, { id: `obidm:${key}`, side, price: v.targetPrice, fromTime: v.targetTime, toTime: v.breakTime });
        }
      } else if (!b.mitigated && !pending.has(key)) {
        pending.set(key, { id: `obidm:${key}`, side, price: v.targetPrice, fromTime: v.targetTime, toTime: lastTime });
      }
    }
    // A top that one zone already broke needs no pending twin from a sibling.
    for (const key of broke.keys()) pending.delete(key);

    const recent = (m) => [...m.values()].sort((a, s) => a.fromTime - s.fromTime).slice(-IDM_LINE_CAP);
    const rgb = (side) => (side === 'high' ? SWING_LOW_RGB : SWING_HIGH_RGB);
    const toSeg = (s, isBroke) => ({
      id: s.id,
      points: [
        { time: s.fromTime, value: s.price },
        { time: s.toTime, value: s.price },
      ],
      color: `rgba(${rgb(s.side)}, ${isBroke ? 1 : 0.55})`,
      lineStyle: isBroke ? 'solid' : 'dotted',
      lineWidth: isBroke ? 2 : 1,
    });
    const brokeLines = recent(broke);
    const markerSeen = new Set();
    const markers = [];
    for (const s of brokeLines) {
      const mk = `${s.side}:${s.toTime}`;
      if (markerSeen.has(mk)) continue; // one bar can take several tops — one tag
      markerSeen.add(mk);
      markers.push(
        s.side === 'high'
          ? { time: s.toTime, position: 'aboveBar', color: '#ef5350', shape: 'arrowDown', size: 0, text: 'IDM' }
          : { time: s.toTime, position: 'belowBar', color: '#26a69a', shape: 'arrowUp', size: 0, text: 'IDM' }
      );
    }
    return {
      segments: [...brokeLines.map((s) => toSeg(s, true)), ...recent(pending).map((s) => toSeg(s, false))],
      markers,
    };
  }, [idmEnabled, obData, obTopBreaks]);

  // The chart takes one segments collection. Connectors go first for reading
  // order, not for z-order: lightweight-charts paints in series CREATION order
  // and the reconciler only creates a series the first time it sees an id, so
  // a chain that appears mid-session lands on top of IDM levels that already
  // existed. At 1px / 0.35 alpha that costs nothing visually, which is why it
  // is left alone rather than fixed with an explicit z option.
  const chartSegments = useMemo(() => {
    if (!obIdm && !connectorSegments) return null;
    return [...(connectorSegments ?? []), ...(obIdm?.segments ?? [])];
  }, [obIdm, connectorSegments]);

  const obBoxes = useMemo(() => {
    // obData also feeds the IDM overlay now, so its presence no longer implies
    // the OB chip — boxes draw only when their own chip asked for them.
    if (!obEnabled || !obData) return null;
    // Gate shut (HTF on, but the timeframes disagree or the bias hasn't
    // resolved): draw nothing at all rather than falling back to everything.
    if (!obAllowedDir) return null;

    // Third composing chip: with the filter on, only zones whose MOVE broke
    // their summit survive — the swing high whose decline gave the zone its
    // bottom; THE order block is the one whose move off it breaks that summit
    // (supply mirrors: the swing low its rally rose from). The break may take
    // any number of bars, as long as it lands no later than the bar that
    // first trades back into the zone — see computeObTopBreaks for the
    // summit/window rules. Zones still waiting on their break are hidden, not
    // faded: pending and failed are indistinguishable until the future
    // arrives, and the filter's promise is "everything drawn has already done
    // it". Zones computeObTopBreaks returned no verdict for — no top behind
    // them anywhere in the loaded window — are hidden by the same rule.
    // 'off' is the unfiltered tier — truthy, so nothing is dropped when the
    // filter is off.
    // Gate on the CHIP, not on the verdicts existing — the IDM overlay also
    // computes obTopBreaks now, and boxes must not get silently filtered just
    // because the lines are on.
    const brokeTop = (b) =>
      idmObEnabled && obTopBreaks ? (obTopBreaks.get(b.id)?.broke ? 'broke' : null) : 'off';

    // Opacity is looked up per (tier, state), never MULTIPLIED — compounding
    // two dimming factors once produced 0.042-alpha fills that read as a
    // broken overlay rather than a filtered one.
    //
    // 'off' keeps the original weights, so switching the filter off leaves the
    // chart looking exactly as it always has. With the filter ON the survivors
    // are the few zones that already broke their leg's top, so they are drawn
    // stronger than the unfiltered set.
    const ALPHA = {
      /* eslint-disable key-spacing */
      'off:fresh':       [0.16, 0.55],
      'off:mitigated':   [0.07, 0.25],
      'broke:fresh':     [0.26, 0.95],
      'broke:mitigated': [0.17, 0.72],
      /* eslint-enable key-spacing */
    };

    const toBox = (b) => {
      const rgb = b.dir === 'bullish' ? '38, 166, 154' : '239, 83, 80';
      const [fill, border] = ALPHA[`${b.idmTier}:${b.mitigated ? 'mitigated' : 'fresh'}`];
      return {
        time1: b.fromTime,
        time2: b.toTime,
        price1: b.top,
        price2: b.bottom,
        fillColor: `rgba(${rgb}, ${fill})`,
        borderColor: `rgba(${rgb}, ${border})`,
      };
    };

    // Both filters run BEFORE the mitigated/fresh split, so the caps below
    // always spend their budget on zones that actually draw — filtering after
    // would let suppressed zones eat slots and thin the overlay out.
    const gated = obData.boxes
      .filter((b) => obAllowedDir === 'both' || b.dir === obAllowedDir)
      .map((b) => ({ ...b, idmTier: brokeTop(b) }))
      .filter((b) => b.idmTier);

    const mitigated = gated.filter((b) => b.mitigated).slice(-40).map(toBox);
    const fresh = gated.filter((b) => !b.mitigated).slice(-30).map(toBox);
    return [...mitigated, ...fresh];
  }, [obData, obAllowedDir, obTopBreaks, idmObEnabled, obEnabled]);

  // Three chips can independently empty this overlay, and an empty chart looks
  // identical to a broken one. The chip's tooltip is the only place that can
  // answer "where did my order blocks go?", so it reports the live count and
  // which filter is responsible rather than restating what an order block is.
  const obChipTitle = useMemo(() => {
    const base = "Order blocks: the candle a fair value gap launched from — the candle before the gap's displacement candle, or the candle that swallowed it whole while leaving the gap intact.";
    if (!obEnabled) return `${base} Click to show them.`;
    if (!obAllowedDir) {
      return htf.loading
        ? `${base} Hidden while 4h/1h history loads.`
        : `${base} Hidden: HTF is on and 4h/1h are not aligned.`;
    }
    const gate = obAllowedDir === 'both' ? 'both directions' : `${obAllowedDir} only (4h+1h aligned)`;
    const filter = idmObEnabled ? ', top-break filter on' : '';
    return `${base} Showing ${obBoxes?.length ?? 0} — ${gate}${filter}.`;
  }, [obEnabled, obAllowedDir, obBoxes, htf.loading, idmObEnabled]);

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
  // as the other overlays.
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

  // The chart takes ONE marker list, so structure labels and IDM takes are
  // merged here. lightweight-charts requires markers in ascending time order
  // and silently misplaces them otherwise; the two sources are each already
  // sorted but interleave, so the merged array must be re-sorted. Times are
  // numeric seconds (toChartBar), so a numeric compare is enough. Only major
  // takes carry a marker — the util deliberately emits none for minor levels,
  // which is what keeps the chart from filling with IDM tags.
  // obIdm is already gated on the IDM chip, so non-null implies the chip is
  // on; the explicit idmEnabled guard is belt-and-braces against that gating
  // ever loosening.
  const chartMarkers = useMemo(() => {
    const idmMarkers = idmEnabled && obIdm ? obIdm.markers : null;
    if (!msMarkers && !idmMarkers) return null;
    return [...(msMarkers ?? []), ...(idmMarkers ?? [])].sort((a, b) => a.time - b.time);
  }, [msMarkers, obIdm, idmEnabled]);

  // Manual drawing tools (long/short positions, trend lines, boxes). Stored
  // per symbol+interval in memory for the session.
  const draw = useDrawingTools({ symbol, interval });

  // Direct manipulation. The chart reports WHAT was grabbed and where the
  // pointer now is; the drawing model decides what that means for the shape
  // (which level moves, and how far it may go before the tool turns inside
  // out). Splitting it that way keeps pixel concerns in the chart and price
  // concerns in the hook.
  const handleDrawingDrag = useCallback(
    ({ id, part, price, time, dPrice, dTime }) =>
      draw.dragDrawing(id, part, { price, time, dPrice, dTime }),
    [draw.dragDrawing]
  );

  // The selected drawing, when it is a position — the settings panel only
  // applies to that kind, and lines/boxes have nothing to configure.
  const selectedPosition = useMemo(
    () => draw.drawings.find((d) => d.id === draw.selectedId && d.kind === 'position') ?? null,
    [draw.drawings, draw.selectedId]
  );

  // Delete removes the selected drawing, the convention every charting tool
  // shares. Skipped while a form control has focus, so backspacing in the
  // replay date field doesn't quietly delete a position behind it.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (!draw.selectedId) return;
      e.preventDefault();
      draw.remove(draw.selectedId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draw.selectedId, draw.remove]);

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
              title="Each order block's own inducement — the top that created it: solid once the zone's move broke it, dotted while the break is pending — plus swing-to-swing connector chains"
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
            {/* Muted when the chip is on but the HTF gate is currently
                blocking, so "my order blocks vanished" has an answer on the
                chip itself — the panel next to it says which way 4h/1h read. */}
            <button
              type="button"
              title={obChipTitle}
              className={`trendline-chip ${obEnabled ? 'active' : ''} ${obEnabled && !obBoxes?.length ? 'gated' : ''}`}
              style={{ '--chip-color': '#26c6da' }}
              onClick={() => setObEnabled((v) => !v)}
            >
              OB
            </button>
            <button
              type="button"
              title="Keep only order blocks whose move broke their summit — for a demand zone, the nearest high above it that its decline fell from; for a supply zone, the nearest low below it that its rally rose from. The break must land no later than the bar that first trades back into the zone; zones still waiting on it stay hidden. This filter is strict, so the OB chip dims when it leaves nothing."
              className={`trendline-chip ${idmObEnabled ? 'active' : ''}`}
              style={{ '--chip-color': '#ab47bc' }}
              onClick={() => setIdmObEnabled((v) => !v)}
            >
              OB×IDM
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
            <button
              type="button"
              title="Show 4h and 1h structure trend as higher-timeframe bias for lower-timeframe entries"
              className={`trendline-chip ${htfEnabled ? 'active' : ''}`}
              style={{ '--chip-color': '#66bb6a' }}
              onClick={() => setHtfEnabled((v) => !v)}
            >
              HTF
            </button>
          </div>
          <ReplayControls
            replay={replay}
            onExit={replay.exit}
            onSkipBull={skipToAlignedBullOb}
            onSkipBear={skipToAlignedBearOb}
            onSkipBackBull={skipBackToBullOb}
            onSkipBackBear={skipBackToBearOb}
            skipDisabled={skipDisabled}
            skipBackDisabled={skipBackDisabled}
            skipBullTitle={skipTitleFor('bull')}
            skipBearTitle={skipTitleFor('bear')}
            skipBackBullTitle={skipBackTitleFor('bull')}
            skipBackBearTitle={skipBackTitleFor('bear')}
            skipNote={skipNote}
          />
        </div>
        <div className="status-group">
          {htfEnabled && (
            <span className={`htf-bias ${htf.allBullish ? 'aligned-bull' : htf.allBearish ? 'aligned-bear' : ''}`}>
              {HTF_BIAS_INTERVALS.map((i) => {
                const t = htf.bias[i];
                return (
                  <span key={i} className={`htf-cell htf-${t ?? 'none'}`} title={`${i} market structure trend`}>
                    {i} {t === 'bullish' ? '▲' : t === 'bearish' ? '▼' : '—'}
                  </span>
                );
              })}
              {htf.allBullish && <span className="htf-verdict bull">ALIGNED BULL</span>}
              {htf.allBearish && <span className="htf-verdict bear">ALIGNED BEAR</span>}
            </span>
          )}
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
      {/* Between the header and the chart: clicking a mover is just a symbol
          change, so it goes through the same handler the search box uses. */}
      <MoversBar symbol={symbol} onSymbolChange={onSymbolChange} />
      <div className={`chart-container ${draw.tool ? 'drawing' : ''}`}>
        {/* Drawing rail overlays the chart's left edge, TradingView-style.
            Rendered whenever a chart is on screen (live or replay). */}
        {/* Inputs panel for the selected position — the numeric half of the
            tool, floating over the chart the way TradingView's dialog does. */}
        {selectedPosition && (
          <PositionSettings
            drawing={selectedPosition}
            onChange={(patch) => draw.updateDrawing(selectedPosition.id, patch)}
            onRemove={() => draw.remove(selectedPosition.id)}
            onClose={() => draw.setSelectedId(null)}
          />
        )}
        {(history || replayActive) && (
          <DrawingToolbar
            tool={draw.tool}
            onSelect={draw.selectTool}
            awaiting={draw.awaiting}
            count={draw.drawings.length}
            onClear={draw.clearAll}
          />
        )}
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
            markers={chartMarkers}
            segments={chartSegments}
            boxes={chartBoxes}
            drawings={draw.drawings}
            selectedDrawingId={draw.selectedId}
            onChartClick={draw.handleChartClick}
            onDrawingSelect={draw.setSelectedId}
            onDrawingDrag={handleDrawingDrag}
            toolActive={draw.tool != null}
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
            markers={chartMarkers}
            segments={chartSegments}
            boxes={chartBoxes}
            drawings={draw.drawings}
            selectedDrawingId={draw.selectedId}
            onChartClick={draw.handleChartClick}
            onDrawingSelect={draw.setSelectedId}
            onDrawingDrag={handleDrawingDrag}
            toolActive={draw.tool != null}
          />
        )}
      </div>
    </div>
  );
}
