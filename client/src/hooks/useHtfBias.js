import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCandles, ensureHistory } from '../services/api.js';
import { toChartBar } from '../utils/normalizeCandle.js';
import { createStructureTracker } from '../utils/priceActionStructure.js';
import { intervalToSec, REPLAY_FORWARD_LIMIT } from './useBarReplay.js';

// Higher-timeframe bias for a lower-timeframe trader: run the same 5/5 market
// structure engine on each HTF and report its trend, so a 15m chart carries the
// 4h/1h context that decides whether a long is with or against the bigger move.
//
// This drives an OVERLAY (the HTF-gated order blocks), not just a readout, so
// the bar is higher than "usually right": every way the answer can be unknown
// has to report unknown rather than the last thing that looked true. A gate
// that is confidently wrong is worse than one that stays shut. The three ways
// it could lie, and what stops each:
//   WHERE — with `anchorMs` the fetch window is re-centred on the replay
//   session's start date. An unbounded fetch returns the most RECENT candles,
//   which for a session anchored months back are entirely future to the
//   cursor: the slice below throws them all away and every bias reads null.
//   WHEN — the fetched candles are cut to the replay cursor's wall-clock time,
//   and a candle counts only once CLOSED (its successor has opened) — the same
//   rule useBarReplay applies to trendlines. Still-forming candles are dropped
//   on BOTH paths, because the structure engine fires CHoCH/BOS on `close` and
//   an unclosed candle's "close" is just the current tick.
//   HOW LONG — a fetched window is finite. Running off the end of one must
//   read unknown, not freeze at the last value while still looking current.

const HISTORY_LIMIT = 400; // ample for 5/5 pivots + several structure events

// Ceiling on the forward half of an anchored (replay) window. The count
// actually requested is derived from `spanSec` — how far the caller says its
// session can play — so a replay that pages past its first window asks for a
// correspondingly larger one (5000 x 15m is ~52 days: 1250 1h candles, 313 4h
// ones). The ceiling exists for large chart intervals, where the honest number
// is absurd: 5000 4h bars is over six years, i.e. ~55k 1h candles. When it
// bites, the window runs out mid-session and the `capped` flag below turns
// that into an explicit unknown instead of a frozen trend.
const HTF_FORWARD_MAX = 5000;

// Live windows want the latest candles; a replay window has to straddle its
// anchor — HISTORY_LIMIT of context behind it for the structure engine to have
// pivots to work with, then forward cover to play into.
//
// Returns { bars, capped }. `capped` means the forward page came back FULL,
// i.e. it stopped because we asked it to and there is more history past it —
// the case where the cursor can outrun the data. A short page is the genuine
// end of stored history, which is a different thing and must not be treated as
// exhaustion.
async function fetchBiasCandles(symbol, interval, anchorMs, spanSec) {
  // A candle that has not closed carries no confirmed structure for a 5/5
  // tracker, and its running `close` is just the current tick — an intrabar
  // spike through a pivot would fire a CHoCH that never happened and flip what
  // the chart draws. Dropped on both paths for that reason.
  const closedOnly = (rows) => rows.filter((c) => c.isClosed !== false).map(toChartBar);

  if (anchorMs == null) {
    const data = await getCandles(symbol, interval, HISTORY_LIMIT);
    return { bars: closedOnly(data), capped: false };
  }

  // Same reason fetchReplayRange() does this: the startup backfill only holds
  // the most recent ~1000 candles per combo, so anchoring on an older date
  // needs the server to pull the missing history from Binance first.
  // Idempotent, and a failure is not fatal — whatever IS stored may already
  // cover the range, and if it doesn't the fetches below just come back short
  // and the bias reads null rather than lying.
  const contextFromMs = anchorMs - HISTORY_LIMIT * intervalToSec(interval) * 1000;
  await ensureHistory(symbol, interval, contextFromMs).catch((err) => {
    console.warn(`history ensure failed for ${symbol} ${interval} — HTF bias from stored data only`, err);
  });

  const forwardLimit = Math.min(HTF_FORWARD_MAX, Math.ceil(spanSec / intervalToSec(interval)) + 2);
  const [context, forward] = await Promise.all([
    getCandles(symbol, interval, HISTORY_LIMIT, { endTime: anchorMs - 1 }),
    getCandles(symbol, interval, forwardLimit, { startTime: anchorMs }),
  ]);
  return {
    bars: closedOnly(context.concat(forward)),
    capped: forward.length >= forwardLimit,
  };
}

const NO_DATA = { symbol: null, anchor: null, byInterval: {} };

// How many of `bars` have CLOSED by cursorSec, under the same rule as the rest
// of the app: a candle is closed once its successor has opened, so the trailing
// candle is held back until the cursor passes the next one. Binary search
// rather than a walk, because the replay skip below asks this thousands of
// times in one pass.
function closedCount(bars, cursorSec) {
  let lo = 0;
  let hi = bars.length; // first index whose OPEN is past the cursor
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time <= cursorSec) lo = mid + 1;
    else hi = mid;
  }
  // lo counts candles that have opened; the last of them has not closed yet.
  return Math.max(0, Math.min(lo - 1, bars.length - 1));
}

// The single definition of "what was this timeframe's trend at `cursorSec`",
// shared by the live readout and the replay skip so the two can never drift
// apart. `timeline[n]` is the tracker's trend after stepping candle n, which is
// exactly what re-running the engine over bars.slice(0, n + 1) would return —
// the engine only ever reads backwards from the bar it is stepping.
function trendAtCursor(entry, timeline, cursorSec) {
  const bars = entry?.bars;
  if (!bars || bars.length === 0) return null;
  if (cursorSec == null) return timeline[bars.length - 1];
  const closed = closedCount(bars, cursorSec);
  // Cursor has reached the end of a window we know is truncated: from here the
  // count cannot advance, so the trend would hold its last value while still
  // presenting as current — a stale gate that looks live, the one failure mode
  // this hook must not have. Report unknown and let the caller shut. (Only when
  // `capped`: an untruncated window ending here is the real end of history,
  // where the last known trend IS the answer.)
  if (entry.capped && closed >= bars.length - 1) return null;
  return closed > 0 ? timeline[closed - 1] : null;
}

const TREND_NAME = { 1: 'bullish', '-1': 'bearish', 0: null };

export function useHtfBias({
  symbol,
  intervals,
  cursorSec,
  active = true,
  anchorMs = null,
  // How far forward an anchored window has to reach, in seconds. Grows when a
  // replay pages past its initial window.
  spanSec = REPLAY_FORWARD_LIMIT * 900,
}) {
  // Tagged with the window that produced it — see the identity check in the
  // bias memo for why the tag travels with the data instead of being implied.
  const [loaded, setLoaded] = useState(NO_DATA);
  const [loading, setLoading] = useState(false);
  // Serialises fetches so a slow response for a previous symbol can never
  // overwrite the current one's data.
  const tokenRef = useRef(0);
  // Bumped by the live refresh timer below; a fetch dependency, nothing else.
  const [refreshTick, setRefreshTick] = useState(0);

  const key = intervals.join(',');
  // useBarReplay reports 0 for "no session", so a caller can hand its
  // startMs straight through; normalising here means the live path is taken
  // for both null and 0 rather than anchoring a live chart at the epoch.
  const anchor = anchorMs > 0 ? anchorMs : null;

  // Two identities, because "refetch" and "the data I hold is invalid" are not
  // the same event:
  //   fetchIdentity — anything that changes WHICH candles to ask for, span
  //     included, so a replay paging past its window widens the HTF window too.
  //   dataIdentity  — only what makes the candles already in hand WRONG. A
  //     bigger span does not: every extra candle it adds is future to the
  //     cursor, so the bias for the current bar is unchanged. Flagging that
  //     refetch as `loading` would shut the OB gate and blink every zone off
  //     the chart at each seam, which is exactly the disappearing-order-block
  //     complaint this split exists to prevent.
  const fetchIdentity = `${symbol}|${key}|${anchor ?? 'live'}|${spanSec}`;
  const dataIdentity = `${symbol}|${key}|${anchor ?? 'live'}`;
  const dataIdentityRef = useRef(null);

  useEffect(() => {
    if (!active) {
      dataIdentityRef.current = null;
      setLoaded(NO_DATA);
      setLoading(false);
      return;
    }
    const token = ++tokenRef.current;
    let cancelled = false;
    // Data left over from a previous window needs no clearing: the identity
    // check in the bias memo already makes it inert.
    if (dataIdentityRef.current !== dataIdentity) {
      dataIdentityRef.current = dataIdentity;
      setLoading(true);
    }

    Promise.all(
      intervals.map((i) =>
        fetchBiasCandles(symbol, i, anchor, spanSec)
          .then((res) => [i, res])
          .catch(() => [i, { bars: [], capped: false }])
      )
    )
      .then((pairs) => {
        if (cancelled || token !== tokenRef.current) return;
        setLoaded({ symbol, anchor, byInterval: Object.fromEntries(pairs) });
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled && token === tokenRef.current) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // `fetchIdentity` stands in for symbol/key/anchor/span (and `key` for the
    // intervals array, so a fresh literal doesn't refetch). Starting,
    // re-anchoring (a timeframe switch), extending or exiting a session moves
    // the window; the token/cancelled guard is what keeps the losing fetch of
    // an overlapping pair from landing last.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchIdentity, active, refreshTick]);

  // Live, nothing above ever changes — no socket feeds this hook — so the bias
  // would sit frozen at whatever it was when the chip was switched on, and the
  // gate would keep admitting zones on a market that has since flipped. Wake
  // just after each close of the SHORTEST requested timeframe, the only moments
  // an HTF trend can change, and refetch. Anchored windows are exempt by
  // design: a replay's window is fixed by its start date, and its cursor — not
  // wall-clock time — decides what counts as known.
  useEffect(() => {
    if (!active || anchor != null) return;
    const stepSec = Math.min(...intervals.map(intervalToSec));
    let timer;
    const schedule = () => {
      const nowSec = Date.now() / 1000;
      const nextCloseSec = Math.ceil(nowSec / stepSec) * stepSec;
      // +5s of grace so the server has ingested the closed candle before we
      // ask for it; a refetch that lands early would just re-read the old one.
      timer = setTimeout(() => {
        setRefreshTick((t) => t + 1);
        schedule();
      }, (nextCloseSec - nowSec) * 1000 + 5000);
    };
    schedule();
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, anchor, key]);

  // Prefix trends per interval, built once per fetched window: one forward
  // pass of the structure engine recording its trend after every candle.
  // Reading position n out of it is identical to re-running the engine over
  // the first n+1 candles, which is what makes an arbitrary-cursor lookup
  // affordable — the replay skip evaluates thousands of candidate bars, and
  // re-running a 1900-candle engine per candidate would not be viable.
  //
  // Data is only the bias for the window it was fetched for. A symbol switch
  // or a session start/exit changes that window during RENDER, while the
  // refetch that replaces the data only runs an effect later — so identity,
  // not arrival, decides validity. Without this the frame right after exiting
  // a replay reads the anchored candles with cursorSec back to null, i.e.
  // computes a months-old trend as if it were current, and the gate opens on
  // it for that frame.
  const timelines = useMemo(() => {
    if (loaded.symbol !== symbol || loaded.anchor !== anchor) return null;
    const out = {};
    for (const i of intervals) {
      const bars = loaded.byInterval[i]?.bars;
      if (!bars?.length) continue;
      const tracker = createStructureTracker({ leftLength: 5, rightLength: 5 });
      const trends = new Array(bars.length);
      for (let n = 0; n < bars.length; n++) {
        tracker.step(bars, n);
        trends[n] = TREND_NAME[tracker.trend];
      }
      out[i] = trends;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, key, symbol, anchor]);

  // The bias as it stood at any cursor instant — null for "live/now". Exposed
  // so the replay's skip-to-setup scan can ask about bars it has not revealed
  // yet WITHOUT that being lookahead: each answer is computed only from HTF
  // candles closed by that bar, so it equals what the panel would have shown
  // had you stepped there by hand.
  const biasAt = useCallback(
    (at) => {
      const out = {};
      for (const i of intervals) {
        out[i] = timelines?.[i] ? trendAtCursor(loaded.byInterval[i], timelines[i], at) : null;
      }
      const values = intervals.map((i) => out[i]);
      return {
        bias: out,
        // Aligned when every requested timeframe agrees and none is unknown.
        allBullish: values.length > 0 && values.every((v) => v === 'bullish'),
        allBearish: values.length > 0 && values.every((v) => v === 'bearish'),
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timelines, loaded, key]
  );

  const now = useMemo(() => biasAt(cursorSec), [biasAt, cursorSec]);

  return { bias: now.bias, allBullish: now.allBullish, allBearish: now.allBearish, biasAt, loading };
}
