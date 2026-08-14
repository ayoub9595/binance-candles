// TradingView-style drawing rail: a narrow vertical icon strip pinned to the
// left edge of the chart pane, with icon-only buttons, tooltips on hover and
// a separated utility group at the bottom.

// Inline SVGs keep the rail dependency-free and let each icon inherit
// currentColor, so active/hover states need no per-icon styling.
const Icon = {
  cursor: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M5 3l14 8-6 1.5L10 19z" strokeLinejoin="round" />
    </svg>
  ),
  long: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="4" width="18" height="7" rx="1" opacity="0.55" />
      <rect x="3" y="13" width="18" height="7" rx="1" />
      <path d="M12 20V4M12 4l-3 3M12 4l3 3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  short: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="4" width="18" height="7" rx="1" />
      <rect x="3" y="13" width="18" height="7" rx="1" opacity="0.55" />
      <path d="M12 4v16M12 20l-3-3M12 20l3-3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  line: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 19L20 5" strokeLinecap="round" />
      <circle cx="4" cy="19" r="2" fill="currentColor" stroke="none" />
      <circle cx="20" cy="5" r="2" fill="currentColor" stroke="none" />
    </svg>
  ),
  box: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="4" y="6" width="16" height="12" rx="1" />
    </svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 7h16M10 7V5h4v2M6 7l1 13h10l1-13" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

const TOOLS = [
  { id: null, icon: Icon.cursor, label: 'Cursor', hint: 'Pan and zoom the chart' },
  { id: 'long', icon: Icon.long, label: 'Long Position', hint: 'Click entry, then target' },
  { id: 'short', icon: Icon.short, label: 'Short Position', hint: 'Click entry, then target' },
  { id: 'line', icon: Icon.line, label: 'Trend Line', hint: 'Click both endpoints' },
  { id: 'box', icon: Icon.box, label: 'Rectangle', hint: 'Click opposite corners' },
];

export function DrawingToolbar({ tool, onSelect, awaiting, count, onClear }) {
  return (
    <div className="draw-rail">
      {TOOLS.map((t) => {
        const active = tool === t.id;
        return (
          <button
            key={t.id ?? 'cursor'}
            type="button"
            className={`draw-rail-btn ${active ? 'active' : ''}`}
            // The cursor entry clears the active tool rather than selecting one.
            onClick={() => onSelect(t.id)}
            aria-pressed={active}
          >
            {t.icon}
            <span className="draw-rail-tip">
              {t.label}
              <em>{t.hint}</em>
            </span>
          </button>
        );
      })}

      {count > 0 && (
        <>
          <div className="draw-rail-sep" />
          <button type="button" className="draw-rail-btn danger" onClick={onClear}>
            {Icon.trash}
            <span className="draw-rail-tip">
              Remove Drawings
              <em>{count} on this chart</em>
            </span>
          </button>
        </>
      )}

      {tool && (
        <div className="draw-rail-status" title="Clicks remaining for the active tool">
          {awaiting === 2 ? '1' : '2'}
        </div>
      )}
    </div>
  );
}
