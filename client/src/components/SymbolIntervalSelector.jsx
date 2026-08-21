import { SymbolSearch } from './SymbolSearch.jsx';

// `symbols` is the server's configured set — the pairs it streams by default.
// They are the shortlist the search opens on, not the limit of what can be
// charted; anything on Binance spot is reachable by typing.
export function SymbolIntervalSelector({ symbol, interval, symbols, intervals, onSymbolChange, onIntervalChange }) {
  return (
    <div className="selector-bar">
      <SymbolSearch symbol={symbol} defaultSymbols={symbols} onSymbolChange={onSymbolChange} />
      <div className="interval-toggle">
        {intervals.map((i) => (
          <button
            key={i}
            type="button"
            className={i === interval ? 'active' : ''}
            onClick={() => onIntervalChange(i)}
          >
            {i}
          </button>
        ))}
      </div>
    </div>
  );
}
