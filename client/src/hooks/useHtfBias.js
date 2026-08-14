import { useEffect, useMemo, useRef, useState } from 'react';
import { getCandles } from '../services/api.js';
import { toChartBar } from '../utils/normalizeCandle.js';
import { computeMarketStructure } from '../utils/marketStructure.js';

// Higher-timeframe bias for a lower-timeframe trader: run the same 5/5 market
// structure engine on each HTF and report its trend, so a 15m chart carries the
// 4h/1h context that decides whether a long is with or against the bigger move.
//
// Replay-safe: during a session the candles are cut to the replay cursor's
// wall-clock time, so the panel shows the bias as it stood at that moment. A
// candle counts only once CLOSED (its successor has opened) — the same rule
// useBarReplay applies to trendlines, which keeps a still-forming HTF candle's
// final direction (future knowledge) off the panel.

const HISTORY_LIMIT = 400; // ample for 5/5 pivots + several structure events

export function useHtfBias({ symbol, intervals, cursorSec, active = true }) {
  const [candlesByInterval, setCandlesByInterval] = useState({});
  const [loading, setLoading] = useState(false);
  // Serialises fetches so a slow response for a previous symbol can never
  // overwrite the current one's data.
  const tokenRef = useRef(0);

  const key = intervals.join(',');

  useEffect(() => {
    if (!active) {
      setCandlesByInterval({});
      return;
    }
    const token = ++tokenRef.current;
    let cancelled = false;
    setLoading(true);
    setCandlesByInterval({});

    Promise.all(
      intervals.map((i) =>
        getCandles(symbol, i, HISTORY_LIMIT)
          .then((data) => [i, data.map(toChartBar)])
          .catch(() => [i, []])
      )
    )
      .then((pairs) => {
        if (cancelled || token !== tokenRef.current) return;
        setCandlesByInterval(Object.fromEntries(pairs));
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled && token === tokenRef.current) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // `key` stands in for the intervals array so a fresh literal doesn't refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, key, active]);

  // Trend per interval, recomputed when the data or the replay cursor moves.
  const bias = useMemo(() => {
    const out = {};
    for (const i of intervals) {
      const all = candlesByInterval[i];
      if (!all || all.length === 0) {
        out[i] = null;
        continue;
      }
      let bars = all;
      if (cursorSec != null) {
        // Keep only candles CLOSED by the cursor: a candle is closed once the
        // next one has opened, so the trailing bar is held back until the
        // cursor passes its successor's open.
        let end = 0;
        while (end + 1 < all.length && all[end + 1].time <= cursorSec) end++;
        bars = all.slice(0, end);
      }
      out[i] = bars.length ? computeMarketStructure(bars).trend : null;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candlesByInterval, key, cursorSec]);

  // Aligned when every requested timeframe agrees and none is unknown.
  const values = intervals.map((i) => bias[i]);
  const allBullish = values.length > 0 && values.every((v) => v === 'bullish');
  const allBearish = values.length > 0 && values.every((v) => v === 'bearish');

  return { bias, allBullish, allBearish, loading };
}
