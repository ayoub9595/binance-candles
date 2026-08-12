import { useCallback, useEffect, useState } from 'react';
import { ChartPage } from './components/ChartPage.jsx';
import { getInstruments } from './services/api.js';
import { DEFAULT_SYMBOL, DEFAULT_INTERVAL } from './config.js';

export default function App() {
  const [instruments, setInstruments] = useState(null);
  const [error, setError] = useState(null);
  const [symbol, setSymbol] = useState(DEFAULT_SYMBOL);
  const [selectedInterval, setSelectedInterval] = useState(DEFAULT_INTERVAL);

  const loadInstruments = useCallback(() => {
    setError(null);
    getInstruments()
      .then((data) => {
        setInstruments(data);
        setSymbol((s) => (data.symbols.includes(s) ? s : data.symbols[0]));
        setSelectedInterval((i) => (data.intervals.includes(i) ? i : data.intervals[0]));
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    loadInstruments();
  }, [loadInstruments]);

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
      onSymbolChange={setSymbol}
      onIntervalChange={setSelectedInterval}
    />
  );
}
