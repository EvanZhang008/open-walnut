/**
 * Small chrome pieces of EngineSettingsPopover: one option of the scope switch
 * and the (i) About button. Kept apart so the popover file stays readable; the
 * rules each piece encodes are written next to it.
 */
import { forwardRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { EngineSettingsWriteScope } from '@/api/engine-settings';

export interface ScopeOptionButtonProps {
  value: EngineSettingsWriteScope;
  label: string;
  checked: boolean;
  /** Locked for now (a save in flight, no view yet) or unavailable for good. */
  disabled: boolean;
  /** The engine keeps no project file for this session: a lock glyph and the reason as the tooltip. */
  unavailable: boolean;
  reasonId: string;
  title: string | undefined;
  onPointerDown: (e: ReactPointerEvent) => void;
  onClick: () => void;
}

/**
 * One segment of the "Save changes to" radiogroup. ONE Tab stop for the group
 * (the checked option); arrows move between the options in the parent.
 * aria-disabled, never the disabled attribute: the option keeps its tooltip and
 * its reason for a screen reader.
 */
export function ScopeOptionButton(props: ScopeOptionButtonProps) {
  const { value, label, checked, disabled, unavailable, reasonId, title, onPointerDown, onClick } = props;
  return (
    <button
      type="button"
      role="radio"
      className={`engine-settings-scope-option${disabled ? ' is-disabled' : ''}${unavailable ? ' is-unavailable' : ''}`}
      data-scope={value}
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      aria-describedby={unavailable ? reasonId : undefined}
      title={title}
      tabIndex={checked ? 0 : -1}
      onPointerDown={onPointerDown}
      onClick={onClick}
    >
      {unavailable && (
        <svg className="engine-settings-scope-lock" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
          <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
        </svg>
      )}
      {label}
    </button>
  );
}

export interface AboutButtonProps {
  expanded: boolean;
  controlsId: string | undefined;
  /** No view yet: drawn from the first frame so the header keeps its shape, but inert. */
  disabled: boolean;
  onToggle: () => void;
}

/** The (i) glyph in the header corner next to Close; opens the About overlay. */
export const AboutButton = forwardRef<HTMLButtonElement, AboutButtonProps>(function AboutButton(props, ref) {
  const { expanded, controlsId, disabled, onToggle } = props;
  return (
    <button
      ref={ref}
      type="button"
      className="engine-settings-about"
      aria-label="About these settings"
      title="About these settings"
      aria-expanded={expanded}
      aria-controls={controlsId}
      disabled={disabled}
      onClick={onToggle}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
        <circle cx="8" cy="8" r="6.5" />
        <path d="M8 7.2v4" />
        <circle cx="8" cy="4.9" r="0.6" fill="currentColor" stroke="none" />
      </svg>
    </button>
  );
});
