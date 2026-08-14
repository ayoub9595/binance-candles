import { useCallback, useEffect, useRef, useState } from 'react';
import { getCandles, ensureHistory } from '../services/api.js';
import { toChartBar } from '../utils/normalizeCandle.js';

// Candles shown before the replay start date so the chart (and swing
// detection) has context, and how far past the start date one session can
// play before hitting "end of data".
const CONTEXT_LIMIT = 500;
const FORWARD_LIMIT = 5000;

// Playback speeds in candles per second.
export const REPLAY_SPEEDS = [1, 2, 5, 10];

const INTERVAL_UNIT_SEC = { m: 60, h: 3600, d: 86400, w: 604800, M: 2592000 };

export function intervalToSec(interval) {
  const match = /^(\d+)([mhdwM])$/.exec(interval);
  return match ? Number(match[1]) * INTERVAL_UNIT_SEC[match[2]] : 60;
}

// Everything strictly before startMs is context, everything from startMs on
// is fed forward bar-by-bar. Both come back ascending. A still-forming candle
// (isClosed false — only ever the very latest one) would replay a partial
// snapshot as if it were finished history, so it is dropped.
async function fetchReplayRange(symbol, interval, startMs) {
  // The startup backfill only holds the most recent ~1000 candles per combo,
  // so replaying an older day needs the server to pull the missing history
  // from Binance first. Idempotent — instant once the range is covered. A
  // failure here isn't fatal: whatever IS stored may still cover the range,
  // and the forward fetch below reports "no candles" if it doesn't.
  const contextFromMs = startMs - CONTEXT_LIMIT * intervalToSec(interval) * 1000;
  await ensureHistory(symbol, interval, contextFromMs).catch((err) => {
    console.warn(`history ensure failed for ${symbol} ${interval} — replaying from stored data only`, err);
  });

  const [context, forward] = await Promise.all([
    getCandles(symbol, interval, CONTEXT_LIMIT, { endTime: startMs - 1 }),
    getCandles(symbol, interval, FORWARD_LIMIT, { startTime: startMs }),
  ]);
  return {
    context: context.filter((c) => c.isClosed !== false).map(toChartBar),
    forward: forward.filter((c) => c.isClosed !== false).map(toChartBar),
    // Raw length before filtering: a full page means the window was capped,
    // i.e. "end of data" is really "end of the loaded window".
    forwardCapped: forward.length >= FORWARD_LIMIT,
  };
}

// How many leading candles of `arr` have CLOSED by cursorSec. A candle's
// close is taken to be its successor's open, so revealing by close never
// leaks a still-forming candle's final OHLC into the replay (and data gaps
// only ever delay a reveal, never rush it). The trailing candle has no
// successor and therefore stays hidden until the cursor passes the next one.
function closedCount(arr, cursorSec, fromCount = 0) {
  let p = fromCount;
  while (p + 1 < arr.length && arr[p + 1].time <= cursorSec) p++;
  return p;
}

// Bar-replay ("feed forward") session for the chart: pick a start date, the
// chart truncates there, then historical candles stream in one-by-one under a
// play/pause/step/speed transport. Trendline overlays replay too: each
// enabled interval's candles are cut to the replay cursor so the channels are
// recomputed from only what was known "at the time".
export function useBarReplay({ symbol, interval, enabledTrendlines, onMainBar, onRewind, onExit }) {
  const [active, setActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [cursor, setCursor] = useState(-1);
  const [total, setTotal] = useState(0);
  const [windowCapped, setWindowCapped] = useState(false);
  const [contextBars, setContextBars] = useState(null);
  const [trendlineCandles, setTrendlineCandles] = useState({});
  const [sessionId, setSessionId] = useState(0);

  // main: forward bars for the chart interval; byInterval/pointers: full
  // candle arrays and how far into them the cursor has advanced, per
  // trendline interval; pending: intervals with an in-flight fetch.
  const emptyData = () => ({
    main: [],
    byInterval: new Map(),
    pointers: new Map(),
    pending: new Set(),
    startMs: 0,
    startSec: 0,
    intervalSec: 60,
  });
  const dataRef = useRef(emptyData());
  const cursorRef = useRef(-1);
  // Invalidates in-flight fetches when a session is exited or restarted.
  const sessionTokenRef = useRef(0);

  const onMainBarRef = useRef(onMainBar);
  onMainBarRef.current = onMainBar;
  const onRewindRef = useRef(onRewind);
  onRewindRef.current = onRewind;
  // Read inside the interval-switch effect, which must not re-run on
  // play/pause — a ref keeps it out of the dependency list.
  const playingRef = useRef(false);
  playingRef.current = playing;
  // Set when a re-anchor needs its first bar revealed once loading finishes.
  const pendingRevealRef = useRef(false);
  // Queued timeframe re-anchor ({ at, reveal, playing }) — declared here
  // because exit() clears it, and exit() is defined below.
  const startAtRef = useRef(null);
  const activeRef = useRef(false);
  activeRef.current = active;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const enabledTrendlinesRef = useRef(enabledTrendlines);
  enabledTrendlinesRef.current = enabledTrendlines;

  const exit = useCallback(() => {
    sessionTokenRef.current++;
    dataRef.current = emptyData();
    cursorRef.current = -1;
    // Drop any queued timeframe re-anchor so an exit (symbol switch, error,
    // ✕) can never be followed by a resurrected session.
    startAtRef.current = null;
    pendingRevealRef.current = false;
    setActive(false);
    setLoading(false);
    setPlaying(false);
    setError(null);
    setCursor(-1);
    setTotal(0);
    setWindowCapped(false);
    setContextBars(null);
    setTrendlineCandles({});
    // Lets the owner reset its own state (e.g. null stale live history) in
    // the same batch, whichever path exited — button, error, symbol switch.
    onExitRef.current?.();
  }, []);

  // resumePlaying: what `playing` should be once the data lands. A fresh
  // session autoplays; a timeframe re-anchor keeps whatever the transport was
  // doing before the switch, so a paused replay stays paused.
  const start = useCallback(
    async (startMs, { resumePlaying = true } = {}) => {
      const token = ++sessionTokenRef.current;
      const startSec = Math.floor(startMs / 1000);
      dataRef.current = { ...emptyData(), startMs, startSec, intervalSec: intervalToSec(interval) };
      cursorRef.current = -1;
      setActive(true);
      setLoading(true);
      setError(null);
      setPlaying(false);
      setCursor(-1);
      setTotal(0);
      setWindowCapped(false);
      setContextBars(null);
      setTrendlineCandles({});
      setSessionId((s) => s + 1);

      try {
        const intervals = enabledTrendlinesRef.current;
        const [main, ...trendlinePairs] = await Promise.all([
          fetchReplayRange(symbol, interval, startMs),
          ...intervals.map((i) => fetchReplayRange(symbol, i, startMs).then((r) => [i, r])),
        ]);
        if (token !== sessionTokenRef.current) return;

        if (main.forward.length === 0) {
          exit();
          setError('No candles found after that date.');
          return;
        }

        const data = dataRef.current;
        data.main = main.forward;
        // The last context candle may still be forming at the start time
        // (start picked mid-candle) — its final OHLC is future knowledge.
        let mainContext = main.context;
        while (mainContext.length && mainContext[mainContext.length - 1].time + data.intervalSec > startSec) {
          mainContext = mainContext.slice(0, -1);
        }
        const initialTrendlines = {};
        for (const [i, r] of trendlinePairs) {
          const combined = r.context.concat(r.forward);
          const p = closedCount(combined, startSec);
          data.byInterval.set(i, combined);
          data.pointers.set(i, p);
          initialTrendlines[i] = combined.slice(0, p);
        }
        setContextBars(mainContext);
        setTrendlineCandles(initialTrendlines);
        setTotal(main.forward.length);
        setWindowCapped(main.forwardCapped);
        setLoading(false);
        setPlaying(resumePlaying);
      } catch (err) {
        if (token !== sessionTokenRef.current) return;
        exit();
        setError(err.message || 'Failed to load replay data');
      }
    },
    [symbol, interval, exit]
  );

  const stepForward = useCallback(() => {
    const data = dataRef.current;
    const next = cursorRef.current + 1;
    if (next >= data.main.length) {
      setPlaying(false);
      return;
    }
    cursorRef.current = next;
    const bar = data.main[next];
    onMainBarRef.current?.(bar);
    setCursor(next);

    // Revealing bar N means "we are now just after bar N closed", so the
    // cursor time is the bar's close, and a trendline candle appears only
    // once it too has closed by then. Only intervals that actually gained
    // bars get a fresh array reference, so ChartPage's per-interval channel
    // memoization keeps working.
    const cursorSec = bar.time + data.intervalSec;
    let changed = null;
    for (const [i, arr] of data.byInterval) {
      const before = data.pointers.get(i);
      const p = closedCount(arr, cursorSec, before);
      if (p !== before) {
        data.pointers.set(i, p);
        (changed ??= {})[i] = arr.slice(0, p);
      }
    }
    if (changed) {
      setTrendlineCandles((prev) => ({ ...prev, ...changed }));
    }
  }, []);

  // Step one candle back. Unlike stepForward this cannot be incremental: the
  // main series has to shrink (the chart's setCandles replaces the whole array)
  // and every trendline pointer has to be recomputed from zero, since
  // closedCount only ever scans forward from a previous count. Cursor -1 is a
  // valid destination — the session sits at its start with only context shown.
  const stepBack = useCallback(() => {
    const data = dataRef.current;
    const prev = cursorRef.current - 1;
    if (cursorRef.current < 0) return;
    cursorRef.current = prev;
    setCursor(prev);
    setPlaying(false);

    // Rewind the trendline overlays to the new cursor time. At cursor -1 that
    // is the session's start time, matching what start() seeded them with.
    const cursorSec = prev >= 0 ? data.main[prev].time + data.intervalSec : data.startSec;
    const rewound = {};
    for (const [i, arr] of data.byInterval) {
      const p = closedCount(arr, cursorSec);
      data.pointers.set(i, p);
      rewound[i] = arr.slice(0, p);
    }
    setTrendlineCandles((prevMap) => ({ ...prevMap, ...rewound }));

    // Hand the owner the full truncated bar list so it can rewrite the chart
    // series and re-seed its SMC mirror from the same source of truth.
    onRewindRef.current?.(data.main.slice(0, prev + 1));
  }, []);

  // Playback clock.
  useEffect(() => {
    if (!active || loading || !playing) return;
    const id = setInterval(stepForward, 1000 / speed);
    return () => clearInterval(id);
  }, [active, loading, playing, speed, stepForward]);

  // A symbol switch invalidates the session outright — different instrument,
  // nothing to carry over. An INTERVAL switch instead re-anchors the session
  // at the same moment in time: the replay reloads on the new timeframe and
  // resumes at the bar covering the current cursor's wall-clock time, so
  // changing timeframe mid-replay keeps your place instead of dropping you
  // back to live. `startAtRef` carries that instant into the restart.
  const comboRef = useRef(`${symbol}:${interval}`);
  useEffect(() => {
    const combo = `${symbol}:${interval}`;
    if (comboRef.current === combo) return;
    const [prevSymbol] = comboRef.current.split(':');
    comboRef.current = combo;

    if (!activeRef.current) return;
    if (prevSymbol !== symbol) {
      exit();
      return;
    }
    // Resume time: the cursor bar's OPEN, so the same candle is the first one
    // revealed on the new timeframe (its close would skip past it). Before the
    // first step the session start is already the right anchor.
    const data = dataRef.current;
    const c = cursorRef.current;
    startAtRef.current = {
      at: c >= 0 ? data.main[c].time * 1000 : data.startMs,
      // A session that had not stepped yet re-anchors to its own start and
      // stays unstepped; otherwise reveal the bar covering that instant.
      reveal: c >= 0,
      playing: playingRef.current,
    };
  }, [symbol, interval, exit]);

  // Perform the re-anchor after the interval prop has actually changed, so
  // start() closes over the NEW interval. Runs in its own effect because
  // start() is recreated on every interval change and must not re-trigger the
  // combo effect above.
  useEffect(() => {
    const anchor = startAtRef.current;
    if (anchor == null) return;
    startAtRef.current = null;
    // The new timeframe's first forward bar is the one whose open covers the
    // anchor instant, so revealing it puts the cursor at the same moment in
    // time (rounded to the new candle's open — unavoidable when the grids
    // differ). stepForward runs once the load lands, via pendingRevealRef.
    pendingRevealRef.current = anchor.reveal;
    start(anchor.at, { resumePlaying: anchor.playing });
  }, [start]);

  // After a re-anchor the session sits at cursor -1 with the anchor bar as
  // main[0]; reveal it so the chart shows the same instant it did before the
  // timeframe switch rather than an empty forward window.
  useEffect(() => {
    if (!active || loading) return;
    if (!pendingRevealRef.current) return;
    pendingRevealRef.current = false;
    if (cursorRef.current < 0 && dataRef.current.main.length > 0) stepForward();
  }, [active, loading, stepForward]);

  // Trendlines toggled mid-replay: drop disabled intervals, fetch newly
  // enabled ones and cut them to the current cursor time.
  useEffect(() => {
    if (!active || loading) return;
    const data = dataRef.current;
    // `active` can be stale-true in the render pass where a symbol/interval
    // switch just exited the session (the combo effect above runs first and
    // clears dataRef) — an empty main array marks the session as dead.
    if (data.main.length === 0) return;
    const token = sessionTokenRef.current;

    let removed = false;
    for (const i of [...data.byInterval.keys()]) {
      if (!enabledTrendlines.includes(i)) {
        data.byInterval.delete(i);
        data.pointers.delete(i);
        removed = true;
      }
    }
    if (removed) {
      setTrendlineCandles((prev) =>
        Object.fromEntries(Object.entries(prev).filter(([i]) => enabledTrendlines.includes(i)))
      );
    }

    for (const i of enabledTrendlines) {
      if (data.byInterval.has(i) || data.pending.has(i)) continue;
      data.pending.add(i);
      fetchReplayRange(symbol, i, data.startMs)
        .then((r) => {
          if (token !== sessionTokenRef.current) return;
          data.pending.delete(i);
          // Toggled back off while the fetch was in flight — don't resurrect.
          if (!enabledTrendlinesRef.current.includes(i)) return;
          const combined = r.context.concat(r.forward);
          const cursorSec =
            cursorRef.current >= 0 ? data.main[cursorRef.current].time + data.intervalSec : data.startSec;
          const p = closedCount(combined, cursorSec);
          data.byInterval.set(i, combined);
          data.pointers.set(i, p);
          setTrendlineCandles((prev) => ({ ...prev, [i]: combined.slice(0, p) }));
        })
        .catch((err) => {
          if (token === sessionTokenRef.current) data.pending.delete(i);
          console.error(`failed to load ${i} replay trendline`, err);
        });
    }
  }, [active, loading, enabledTrendlines, symbol]);

  const play = useCallback(() => setPlaying(true), []);
  const pause = useCallback(() => setPlaying(false), []);

  return {
    active,
    loading,
    error,
    playing,
    speed,
    cursor,
    total,
    windowCapped,
    atEnd: active && total > 0 && cursor >= total - 1,
    atStart: active && cursor < 0,
    contextBars,
    trendlineCandles,
    sessionId,
    start,
    exit,
    play,
    pause,
    stepForward,
    stepBack,
    setSpeed,
  };
}
