import { usageDisplayName } from '@/utils/usageLabels';

export interface Chip {
  key: string;
  label: string;   // dimension label, e.g. "Source"
  value: string;   // display value
  onRemove: () => void;
}

interface Props {
  chips: Chip[];
  onClearAll?: () => void;
}

/**
 * Shows the currently active cross-filter as removable chips. Renders nothing
 * when no drill-in filters are set (the date range lives in the tab bar, not
 * here, unless it's a custom range — the parent decides what to pass in).
 */
export function UsageFilterChips({ chips, onClearAll }: Props) {
  if (chips.length === 0) return null;
  return (
    <div className="usage-filter-chips">
      <span className="usage-filter-chips-label">Filtered by</span>
      {chips.map((c) => (
        <button key={c.key} className="usage-chip" onClick={c.onRemove} title="Remove filter">
          <span className="usage-chip-dim">{c.label}</span>
          <span className="usage-chip-val">{c.value}</span>
          <span className="usage-chip-x">×</span>
        </button>
      ))}
      {chips.length > 1 && onClearAll && (
        <button className="usage-chip-clear-all" onClick={onClearAll}>Clear all</button>
      )}
    </div>
  );
}

/** Helper to render a drill-in value the same way tables do. */
export function chipValue(name: string): string {
  return usageDisplayName(name);
}
