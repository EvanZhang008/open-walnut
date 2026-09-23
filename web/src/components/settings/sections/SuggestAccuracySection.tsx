import { SuggestAccuracyPanel } from './SuggestAccuracyPanel';

/**
 * Read-only receipt for the draft column's auto-suggestions. It used to sit at the
 * bottom of "Tasks & Sessions"; it is a diagnostic, not a knob, so it has its own
 * pane under Diagnostics. Standalone, the panel draws the pane itself so its
 * Refresh can sit in the pane header (N26).
 */
export function SuggestAccuracySection() {
  return <SuggestAccuracyPanel standalone />;
}
