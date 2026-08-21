import { computePositionStats, fmtMoney, fmtPct, fmtPrice } from '../utils/positionTool.js';

// Inputs panel for a selected position tool — TradingView's settings dialog,
// pared to the fields that change what the tool computes.
//
// Numeric entry exists because dragging cannot say "stop at exactly 61,800":
// the pointer resolves to whatever price that pixel row happens to be, which
// on a zoomed-out chart is tens of dollars per pixel. Every field here is the
// same value a drag edits, so the two stay interchangeable.
//
// Left out of TradingView's dialog on purpose: the Style tab's color and font
// pickers (the chart has one palette, and per-drawing colors would fight it)
// and the per-timeframe visibility panel.

const FIELDS = [
  { key: 'entry', label: 'Entry price', step: 'any', group: 'levels' },
  { key: 'target', label: 'Profit level', step: 'any', group: 'levels' },
  { key: 'stop', label: 'Stop level', step: 'any', group: 'levels' },
  { key: 'accountSize', label: 'Account size', step: 'any', group: 'risk' },
  { key: 'riskPct', label: 'Risk %', step: 'any', group: 'risk' },
  { key: 'lotSize', label: 'Lot size', step: 'any', group: 'risk' },
  { key: 'leverage', label: 'Leverage', step: 'any', group: 'risk' },
  { key: 'qtyPrecision', label: 'QTY precision', step: 1, group: 'risk' },
];

export function PositionSettings({ drawing, onChange, onRemove, onClose }) {
  if (!drawing || drawing.kind !== 'position') return null;
  const s = computePositionStats(drawing);
  const long = drawing.dir === 'long';

  // Levels stay ordered while typing, the same rule dragging enforces —
  // otherwise a half-typed number ("6" on the way to "61800") would silently
  // invert the tool.
  const setLevel = (key, value) => {
    const eps = Math.max(Math.abs(drawing.entry) * 1e-6, Number.MIN_VALUE);
    if (key === 'target') {
      return { target: long ? Math.max(value, drawing.entry + eps) : Math.min(value, drawing.entry - eps) };
    }
    if (key === 'stop') {
      return { stop: long ? Math.min(value, drawing.entry - eps) : Math.max(value, drawing.entry + eps) };
    }
    // Moving entry numerically carries the levels with it, preserving the
    // setup's shape — retyping an entry to re-anchor a plan should not also
    // silently change its R.
    const shift = value - drawing.entry;
    return { entry: value, target: drawing.target + shift, stop: drawing.stop + shift };
  };

  const onField = (key, raw) => {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    if (key === 'entry' || key === 'target' || key === 'stop') return onChange(setLevel(key, value));
    if (key === 'qtyPrecision') return onChange({ qtyPrecision: Math.max(0, Math.min(8, Math.round(value))) });
    // A zero or negative account, lot, leverage or risk makes the sizing math
    // meaningless rather than merely odd, so they clamp above zero.
    onChange({ [key]: Math.max(value, key === 'lotSize' ? 0 : 0.0000001) });
  };

  const field = (f) => (
    <label key={f.key} className="pos-field">
      <span>{f.label}</span>
      <input
        type="number"
        step={f.step}
        value={drawing[f.key] ?? ''}
        onChange={(e) => onField(f.key, e.target.value)}
      />
    </label>
  );

  return (
    <div className="pos-settings" onPointerDown={(e) => e.stopPropagation()}>
      <div className="pos-settings-head">
        <span className={`pos-dir ${long ? 'long' : 'short'}`}>{long ? 'LONG' : 'SHORT'}</span>
        <span className="pos-rr">{s.rr.toFixed(2)}R</span>
        <button type="button" className="pos-close" onClick={onClose} title="Close">
          ✕
        </button>
      </div>

      <div className="pos-grid">{FIELDS.filter((f) => f.group === 'levels').map(field)}</div>
      <div className="pos-sep" />
      <div className="pos-grid">{FIELDS.filter((f) => f.group === 'risk').map(field)}</div>

      <div className="pos-stats">
        <div>
          <span>Qty</span>
          <b>{s.qty.toFixed(s.qtyPrecision)}</b>
        </div>
        <div>
          <span>Profit</span>
          <b className="up">
            {fmtMoney(s.profitAmount)} <em>{fmtPct(s.targetPct)}</em>
          </b>
        </div>
        <div>
          <span>Loss</span>
          <b className="down">
            {fmtMoney(-s.lossAmount)} <em>{fmtPct(s.stopPct)}</em>
          </b>
        </div>
        <div>
          <span>Size</span>
          <b>{fmtMoney(s.notional)}</b>
        </div>
        <div>
          <span>Margin</span>
          <b>{fmtMoney(s.margin)}</b>
        </div>
        <div>
          <span>Ticks</span>
          <b>
            {s.targetTicks} / {s.stopTicks}
          </b>
        </div>
      </div>

      {/* Flagged, not silently corrected: a lot size the risk budget cannot
          buy one of gives qty 0, and every money figure below it reads 0. */}
      {s.qty === 0 && (
        <div className="pos-warn">
          Risk budget buys less than one lot — raise Risk % or lower Lot size.
          <span> (needs ≈ {fmtPrice(s.riskPerUnit * (drawing.lotSize || 0))} per lot)</span>
        </div>
      )}

      <div className="pos-toggles">
        <label>
          <input
            type="checkbox"
            checked={drawing.alwaysShowStats !== false}
            onChange={(e) => onChange({ alwaysShowStats: e.target.checked })}
          />
          Always show stats
        </label>
        <label>
          <input
            type="checkbox"
            checked={!!drawing.compactStats}
            onChange={(e) => onChange({ compactStats: e.target.checked })}
          />
          Compact stats
        </label>
        <button type="button" className="pos-delete" onClick={onRemove}>
          Delete
        </button>
      </div>
    </div>
  );
}
