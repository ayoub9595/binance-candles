import { useEffect, useRef, useState } from 'react';

// A navbar dropdown for a group of toggles: the trigger stays one short button
// in the header, the options stack vertically inside a popover. Replaces the
// long horizontal chip rows that used to run across the whole header.
//
// `options` is a list of { id, label, hint, color, active, gated, note,
// onToggle } — the same per-toggle data the chips carried, so the colors and
// tooltips are unchanged, only the layout moved.
export function OptionsMenu({ label, title, options }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  // Outside-click and Escape close the panel. Listeners are bound only while
  // open, so a closed menu costs nothing.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // The badge is the whole point of collapsing the row: with the chips hidden,
  // it is the only thing left saying how much SMC is currently drawn.
  const activeCount = options.filter((o) => o.active).length;

  return (
    <div className="options-menu" ref={rootRef}>
      <button
        type="button"
        title={title}
        className={`options-trigger ${open ? 'open' : ''} ${activeCount ? 'has-active' : ''}`}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
        {activeCount > 0 && <span className="options-count">{activeCount}</span>}
        <svg className="options-caret" viewBox="0 0 10 6" width="9" height="6" aria-hidden="true">
          <path
            d="M1 1l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {/* Toggling a row leaves the panel open — these are multi-select, and
          flipping three overlays should not cost three trips to the trigger. */}
      {open && (
        <div className="options-panel" role="menu">
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={o.active}
              title={o.hint}
              className={`options-row ${o.active ? 'active' : ''} ${o.gated ? 'gated' : ''}`}
              style={{ '--chip-color': o.color }}
              onClick={o.onToggle}
            >
              <span className="options-mark" aria-hidden="true" />
              <span className="options-text">
                <span className="options-name">{o.label}</span>
                {o.note && <em className="options-note">{o.note}</em>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
