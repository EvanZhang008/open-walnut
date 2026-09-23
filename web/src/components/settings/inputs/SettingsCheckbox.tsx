/**
 * A multi-select list row (calendars, session modes): checkbox on the LEFT,
 * label after it, the whole row clickable. The native input is kept (visually
 * transparent, stacked over the drawn box) so it stays focusable, Space toggles
 * it, and specs can `.check()` it.
 */
import type { ReactNode } from 'react'
import { CheckGlyph } from '../settings-glyphs'
import '@/styles/settings-controls.css'

export interface SettingsCheckboxProps {
  id?: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  /** Full text for long names that are truncated. */
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
      <span className="settings-checkbox-control">
        <input
          id={id}
          type="checkbox"
          className="settings-checkbox-input"
          checked={checked}
          disabled={disabled}
          // WebKit only tabs to checkboxes with an explicit tabindex (N20).
          tabIndex={disabled ? undefined : 0}
          data-testid={testId}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="settings-checkbox-box" aria-hidden="true">
          <CheckGlyph size={12} />
        </span>
      </span>
      {leading}
      <span className="settings-checkbox-label">{label}</span>
      {trailing !== undefined && trailing !== null && trailing !== false && (
        <span className="settings-checkbox-trailing">{trailing}</span>
      )}
    </label>
  )
}
