import { useCallback, useEffect, useRef, useState } from 'react';
import { getMovers } from '../services/api.js';

// Strip under the header ranking the market's biggest 24h movers. Every row is
// a tradable spot pair (the server filters through its catalog), so clicking one
// loads it on the chart — which is the point of the bar: spot a move, open it.
//
// Gainers and losers are one toggle rather than two half-width lists: twelve
// rows already fill the strip, and a 24-row bar is a thing you scroll past
// instead of read.

// Matches the server's ticker cache TTL — polling faster only costs round trips.
const REFRESH_MS = 30_000;
const LIMIT = 12;
const QUOTE = 'USDT';
const COLLAPSED_KEY = 'binance-candles:movers-collapsed';

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function formatPercent(n) {
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

// Volumes span $1M to $10B, so a fixed unit would either lose all precision at
// the bottom or run to eleven digits at the top.
function formatVolume(n) {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${Math.round(n / 1e3)}K`;
}

// Prices run from 8-decimal microcaps to 5-figure BTC; significant digits are
// what matters, not a fixed scale.
function formatPrice(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return n.toPrecision(4);
}

export function MoversBar({ symbol, onSymbolChange }) {
  const [side, setSide] = useState('gainers');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [collapsed, setCollapsed] = useState(readCollapsed);

  // `data` is read by the poll only to decide whether a failure should blank the
  // bar, so it goes through a ref — depending on it would restart the interval
  // on every successful refresh.
  const hasDataRef = useRef(false);
  hasDataRef.current = data != null;

  const load = useCallback((signal) => {
    return getMovers({ quote: QUOTE, limit: LIMIT, signal })
      .then((next) => {
        setData(next);
        setError(null);
      })
      .catch((err) => {
        if (signal?.aborted) return;
        console.error('failed to load movers', err);
        // Keep the last good list on screen — stale rankings beat an empty bar,
        // and the timestamp already says how old they are.
        if (!hasDataRef.current) setError(err.message);
      });
  }, []);

  // Poll while the bar is open AND the tab is visible: a chart left open in a
  // background tab would otherwise refresh all day for nobody. Becoming visible
  // refetches immediately rather than waiting out the interval.
  useEffect(() => {
    if (collapsed) return undefined;

    let controller = new AbortController();
    let timer = null;

    const tick = () => {
      controller.abort();
      controller = new AbortController();
      load(controller.signal);
    };

    const start = () => {
      if (timer) return;
      tick();
      timer = setInterval(tick, REFRESH_MS);
    };

    const stop = () => {
      clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => (document.hidden ? stop() : start());

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      controller.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [collapsed, load]);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        // Private-mode / quota: the toggle still works, it just won't persist.
      }
      return next;
    });
  };

  const rows = data ? data[side] : [];
  const stamp = data ? new Date(data.fetchedAt).toLocaleTimeString() : null;

  return (
    <div className={`movers-bar ${collapsed ? 'collapsed' : ''}`}>
      <button
        type="button"
        className="movers-toggle"
        onClick={toggleCollapsed}
        title={collapsed ? 'Show 24h movers' : 'Hide 24h movers'}
      >
        <span className="movers-caret">{collapsed ? '▸' : '▾'}</span> Movers
      </button>

      {!collapsed && (
        <>
          <div className="movers-sides">
            {['gainers', 'losers'].map((s) => (
              <button
                key={s}
                type="button"
                className={`movers-side ${side === s ? 'active' : ''} ${s}`}
                onClick={() => setSide(s)}
                title={
                  s === 'gainers'
                    ? `Biggest 24h risers quoted in ${QUOTE}`
                    : `Biggest 24h fallers quoted in ${QUOTE}`
                }
              >
                {s === 'gainers' ? '▲ Gainers' : '▼ Losers'}
              </button>
            ))}
          </div>

          <div className="movers-list">
            {rows.length > 0 ? (
              rows.map((r) => (
                <button
                  key={r.symbol}
                  type="button"
                  className={`mover ${r.changePercent >= 0 ? 'up' : 'down'} ${
                    r.symbol === symbol ? 'current' : ''
                  }`}
                  onClick={() => onSymbolChange(r.symbol)}
                  title={`${r.symbol} — last ${formatPrice(r.lastPrice)} ${r.quoteAsset}, 24h volume ${formatVolume(
                    r.quoteVolume
                  )}. Click to chart it.`}
                >
                  <span className="mover-asset">{r.baseAsset}</span>
                  <span className="mover-change">{formatPercent(r.changePercent)}</span>
                </button>
              ))
            ) : (
              // Three distinct empty states. A loaded-but-empty list is not a
              // loading state, and saying "loading" forever is the one thing
              // this strip must not do.
              <span className="movers-status">
                {error
                  ? `Movers unavailable — ${error}`
                  : !data
                    ? 'Loading 24h movers…'
                    : `No ${QUOTE} pair clears the ${formatVolume(data.minQuoteVolume)} volume floor`}
              </span>
            )}
          </div>

          {stamp && (
            <span
              className="movers-stamp"
              title={`24h rolling change for ${QUOTE} pairs above ${formatVolume(
                data.minQuoteVolume
              )} of 24h volume (${data.pool} qualify). Refreshes every ${REFRESH_MS / 1000}s.`}
            >
              {stamp}
            </span>
          )}
        </>
      )}
    </div>
  );
}
