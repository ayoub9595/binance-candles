import { useCallback, useEffect, useState } from 'react';
import { ChartPage } from './components/ChartPage.jsx';
import { getInstruments } from './services/api.js';
import { DEFAULT_SYMBOL, DEFAULT_INTERVAL } from './config.js';

// The symbol is no longer constrained to the server's configured list — any
// tradable spot pair can be searched — so it is persisted here rather than
// re-derived from /instruments on every load. Without this, reloading after
// searching a pair would silently drop you back on BTCUSDT.
const SYMBOL_KEY = 'binance-candles:symbol';

// Which chart workspace is on screen: 'analysis' (trendlines + SMC available)
// or 'opr' (OPRSTRATEGY — bare candles, overlay menus hidden). Persisted like
// the symbol so a reload lands in the workspace you were working in.
const WORKSPACE_KEY = 'binance-candles:workspace';

function storedSymbol() {
  try {
    const raw = localStorage.getItem(SYMBOL_KEY);
    return /^[A-Z0-9]{4,20}$/.test(raw ?? '') ? raw : DEFAULT_SYMBOL;
  } catch {
    return DEFAULT_SYMBOL;
  }
}

function storedWorkspace() {
  try {
    return localStorage.getItem(WORKSPACE_KEY) === 'opr' ? 'opr' : 'analysis';
  } catch {
    return 'analysis';
  }
}

export default function App() {
  const [instruments, setInstruments] = useState(null);
  const [error, setError] = useState(null);
  const [symbol, setSymbol] = useState(storedSymbol);
  const [selectedInterval, setSelectedInterval] = useState(DEFAULT_INTERVAL);
  const [workspace, setWorkspace] = useState(storedWorkspace);

  const loadInstruments = useCallback(() => {
    setError(null);
    getInstruments()
      .then((data) => {
        setInstruments(data);
        // Intervals ARE still constrained: the server only ingests and
        // backfills the ones it is configured for.
        setSelectedInterval((i) => (data.intervals.includes(i) ? i : data.intervals[0]));
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    loadInstruments();
  }, [loadInstruments]);

  const changeSymbol = useCallback((next) => {
    setSymbol(next);
    try {
      localStorage.setItem(SYMBOL_KEY, next);
    } catch {
      // Private-mode / quota: the session still works, it just won't persist.
    }
  }, []);

  const changeWorkspace = useCallback((next) => {
    setWorkspace(next);
    try {
      localStorage.setItem(WORKSPACE_KEY, next);
    } catch {
      // Private-mode / quota: the session still works, it just won't persist.
    }
  }, []);

  if (error) {
    return (
      <div className="app-status">
        <p className="error">Failed to load instruments: {error}</p>
        <button type="button" onClick={loadInstruments}>
          Retry
        </button>
      </div>
    );
  }

  if (!instruments) {
    return <div className="app-status">Loading...</div>;
  }

  return (
    <ChartPage
      symbol={symbol}
      interval={selectedInterval}
      instruments={instruments}
      workspace={workspace}
      onWorkspaceChange={changeWorkspace}
      onSymbolChange={changeSymbol}
      onIntervalChange={setSelectedInterval}
    />
  );
}
