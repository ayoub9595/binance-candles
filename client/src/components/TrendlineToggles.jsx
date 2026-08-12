export function TrendlineToggles({ intervals, enabled, colorFor, onToggle }) {
  return (
    <div className="trendline-toggles">
      <span className="trendline-label">Trend lines:</span>
      {intervals.map((i) => (
        <button
          key={i}
          type="button"
          className={`trendline-chip ${enabled.includes(i) ? 'active' : ''}`}
          style={{ '--chip-color': colorFor(i) }}
          onClick={() => onToggle(i)}
        >
          {i}
        </button>
      ))}
    </div>
  );
}
