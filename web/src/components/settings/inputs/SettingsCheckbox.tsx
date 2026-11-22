/**
 * A multi-select list row (calendars, session modes, consent ticks): checkbox on
 * the LEFT on the label's first line, the label after it wrapping in full, the
 * whole row clickable. The box is the shared drawn native
 * checkbox (`.wn-check`, controls/Checkbox.tsx), so it stays focusable, Space
 * toggles it, and specs can `.check()` it.
 */
import type { ReactNode } from 'react'
import '@/styles/settings-controls.css'
import '@/styles/choice-controls.css'

export interface SettingsCheckboxProps {
  id?: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  /** A tooltip for the row (the label itself is always shown in full). */
  title?: string
  label: ReactNode
  /** Before the label, e.g. a calendar colour dot. */
  leading?: ReactNode
  /** Right end, e.g. a `Read only` tag. */
  trailing?: ReactNode
  'data-testid'?: string
}

export function SettingsCheckbox({
  id,
  checked,
  onChange,
  disabled,
  title,
  label,
  leading,
  trailing,
  'data-testid': testId,
}: SettingsCheckboxProps) {
  return (
    <label
      className={`settings-row settings-checkbox-row${checked ? ' is-checked' : ''}`}
      title={title}
      aria-disabled={disabled ? true : undefined}
    >
      <input
        id={id}
        type="checkbox"
        className="wn-check settings-checkbox-input"
        checked={checked}
        disabled={disabled}
        // WebKit only tabs to checkboxes with an explicit tabindex (N20).
        tabIndex={disabled ? undefined : 0}
        data-testid={testId}
        onChange={(e) => onChange(e.target.checked)}
      />
      {leading}
      <span className="settings-checkbox-label">{label}</span>
      {trailing !== undefined && trailing !== null && trailing !== false && (
        <span className="settings-checkbox-trailing">{trailing}</span>
      )}
    </label>
  )
}
