/**
 * PinTierPicker — the shared "which tier does this new task land in" control.
 *
 * ONE definition for every create surface (session launcher footer, Quick Task
 * confirm panel) so the pinned area can't drift between them again: tiers are
 * always visible, one click pins, clicking the active tier unpins. Callers own
 * any stickiness — the session launcher remembers its pick as the next launch's
 * default, the quick-task panel deliberately does not.
 */

import { PIN_TIER_POLICY } from '@open-walnut/core';
import type { FocusTier } from '@/api/focus';
import { useFocusBarContextSafe } from '@/contexts/FocusBarContext';

interface Props {
  value: FocusTier | undefined;
  /** Receives the RESOLVED tier (undefined = the user unpinned). */
  onChange: (tier: FocusTier | undefined) => void;
  /** Inline caption before the buttons. Omit when the host row already labels it. */
  label?: string;
  disabled?: boolean;
}

export function PinTierPicker({ value, onChange, label, disabled }: Props) {
  // Safe variant: renders fine outside the FocusBarProvider (degrades to built-ins only).
  const customTiers = useFocusBarContextSafe()?.customTiers ?? [];
  return (
    <div className="pin-tier-options" role="group" aria-label="Pin new task to tier">
      {label && <span className="pin-tier-label">{label}</span>}
      {/* ONE segmented control (like the Claude|Codex engine toggle), not a row of
          independent pills: the tiers are mutually exclusive answers to the same
          question, and separate pills read as unrelated buttons. */}
      <div className="pin-tier-seg">
        {PIN_TIER_POLICY.map((t) => {
          const active = value === t.tier;
          return (
            <button
              key={t.tier}
              type="button"
              // Tier color comes from CSS keyed on the tier class, and ONLY while
              // active: painting every button its brand color made inactive Focus
              // (blue) look selected next to active Satellite (grey).
              className={`pin-tier-btn pin-tier-${t.tier}${active ? ' active' : ''}`}
              disabled={disabled}
              // Toggle off when re-clicking the active tier — clicking the visible
              // active state is exactly the "don't pin this one" gesture.
              onClick={() => onChange(active ? undefined : t.tier)}
              // Tooltip = the SAME policy line the quick-task prompt is built from,
              // so the AI's guess and the user's mental model share one definition.
              title={`${t.guidance}${active ? ' (click to unpin)' : ''}`}
              aria-pressed={active}
            >
              {t.label}
            </button>
          );
        })}
        {customTiers.map((ct) => {
          const active = value === ct.id;
          return (
            <button
              key={ct.id}
              type="button"
              className={`pin-tier-btn pin-tier-custom${active ? ' active' : ''}`}
              disabled={disabled}
              onClick={() => onChange(active ? undefined : ct.id)}
              title={`Custom tier "${ct.label}"${active ? ' (click to unpin)' : ''}`}
              aria-pressed={active}
            >
              {ct.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
