export function SymbolIntervalSelector({ symbol, interval, symbols, intervals, onSymbolChange, onIntervalChange }) {
  return (
    <div className="selector-bar">
      <select value={symbol} onChange={(e) => onSymbolChange(e.target.value)}>
        {symbols.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
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
