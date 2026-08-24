// Two layouts for the same chart: the full analysis workspace and
// OPRSTRATEGY, a price-action one. Switching to OPRSTRATEGY hides every
// analysis overlay — the per-interval trendlines and the whole SMC suite —
// without forgetting the selections, so 'analysis' comes back exactly as it
// was left, and draws the strategy's own overlay instead: each day's opening
// price range (00:25–00:35 UTC, see utils/opr.js). OPRSTRATEGY also pins the
// chart to its one instrument, XAUUSD — the analysis symbol is kept and
// restored on switch-back. Interval, replay and manual drawings are shared.
const WORKSPACES = [
  {
    id: 'analysis',
    label: 'Analysis',
    hint: 'Full workspace: per-interval trendlines and the SMC overlays',
  },
  {
    id: 'opr',
    label: 'OPRSTRATEGY',
    hint: 'OPRSTRATEGY workspace: XAUUSD only — bare candles with each day’s OPR — the 00:25–00:35 UTC opening range (the 00:25 + 00:30 candles on 5m) as a box, with its high/low lines running to the end of the day. Drawn only once the second candle closes, and only when the range is 300–1900 pips tall. No trendlines, no SMC; the analysis symbol and setup are kept and restored when you switch back.',
  },
];

export function WorkspaceSwitcher({ workspace, onChange }) {
  return (
    <div className="workspace-switcher" role="tablist" aria-label="Chart workspace">
      {WORKSPACES.map((w) => (
        <button
          key={w.id}
          type="button"
          role="tab"
          aria-selected={workspace === w.id}
          title={w.hint}
          className={`workspace-tab ${workspace === w.id ? 'active' : ''}`}
          onClick={() => onChange(w.id)}
        >
          {w.label}
        </button>
      ))}
    </div>
  );
}
