/**
 * PinTierPicker — the shared "which tier does this new task land in" control.
 *
 * ONE definition for every create surface that shows a tier row (the Quick Task
 * confirm panel) so the pinned area can't drift between them again: tiers are
 * always visible, one click pins, "None" unpins. Callers own any stickiness;
 * the quick-task panel deliberately has none.
 */

import { BOARD_TIER_POLICY, shownTier, type FocusTier } from '@/api/focus';
import { useFocusBarContextSafe } from '@/contexts/FocusBarContext';
import { SegmentedControl } from '@/components/controls';

interface Props {
  value: FocusTier | undefined;
  /** Receives the RESOLVED tier (undefined = the user unpinned). */
  onChange: (tier: FocusTier | undefined) => void;
  /** Inline caption before the buttons. Omit when the host row already labels it. */
  label?: string;
  disabled?: boolean;
}

/** The segment for "not pinned": a custom tier id is always `ct_<...>`, so it never collides. */
const NO_TIER = 'none';

export function PinTierPicker({ value, onChange, label, disabled }: Props) {
  // Safe variant: renders fine outside the FocusBarProvider (degrades to built-ins only).
  const customTiers = useFocusBarContextSafe()?.customTiers ?? [];
  // A value in a retired tier (Parked) is drawn in Satellite, as the board draws it.
  const current = shownTier(value);
  // ONE segmented control (the tiers are mutually exclusive answers to the same question), with
  // "None" as its own segment: a radio group has no "click the picked one to clear it".
  const options = [
    { value: NO_TIER, label: 'None', title: 'Do not pin this task' },
    // Tooltip = the SAME policy line the quick-task prompt is built from, so the AI's guess and
    // the user's mental model share one definition.
    ...BOARD_TIER_POLICY.map((t) => ({ value: t.tier as string, label: t.label, title: t.guidance })),
    ...customTiers.map((ct) => ({ value: ct.id, label: ct.label, title: `Custom tier "${ct.label}"` })),
  ];
  return (
    <div className="pin-tier-options">
      {label && <span className="pin-tier-label">{label}</span>}
      <SegmentedControl
        aria-label="Pin new task to tier"
        value={current ?? NO_TIER}
        options={options}
        disabled={disabled}
        onChange={(v) => onChange(v === NO_TIER ? undefined : v)}
      />
    </div>
  );
}
