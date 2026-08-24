import { OptionsMenu } from './OptionsMenu.jsx';

// One dropdown for the per-interval trendline overlays. The interval's own
// series color is the row's swatch, so the menu reads the same way the chips
// did — just stacked instead of strung across the header.
export function TrendlineToggles({ intervals, enabled, colorFor, onToggle }) {
  return (
    <OptionsMenu
      label="Trend lines"
      title="Swing trendlines drawn per interval"
      options={intervals.map((i) => ({
        id: i,
        label: i,
        hint: `${i} swing trendlines`,
        color: colorFor(i),
        active: enabled.includes(i),
        onToggle: () => onToggle(i),
      }))}
    />
  );
}
