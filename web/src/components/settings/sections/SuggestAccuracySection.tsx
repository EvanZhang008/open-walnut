import { SectionCard } from '../inputs/SectionCard';
import { SuggestAccuracyPanel, SUGGEST_ACCURACY_BLURB } from './SuggestAccuracyPanel';

/**
 * Read-only receipt for the draft column's auto-suggestions. It used to sit at the
 * bottom of "Tasks & Sessions"; it is a diagnostic, not a knob, so it has its own
 * card under Diagnostics.
 */
export function SuggestAccuracySection() {
  return (
    <SectionCard id="suggest-accuracy" title="Suggestion Accuracy" description={SUGGEST_ACCURACY_BLURB}>
      <SuggestAccuracyPanel standalone />
    </SectionCard>
  );
}
