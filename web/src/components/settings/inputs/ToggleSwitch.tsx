/**
 * The one boolean control: a 38x22 switch, role=switch. Optimistic callers set
 * `busy` while the write is in flight (aria-busy; the control stays enabled so
 * a second flip wins). With `name`, a visually hidden checkbox mirrors the value
 * for FormData forms, and a bubbling input + change event is dispatched on it
 * after each flip so native form listeners (autosave) still fire.
 */
import { useEffect, useRef } from 'react'
import '@/styles/settings-controls.css'

interface ToggleSwitchProps {
  checked: boolean
  onChange: (v: boolean) => void
  id?: string
  name?: string
  disabled?: boolean
  busy?: boolean
  /** Legacy inline label (rows should use SettingsRow label + htmlFor instead). */
  label?: string
  'aria-label'?: string
  'aria-labelledby'?: string
  'data-testid'?: string
}

export function ToggleSwitch({
  checked,
  onChange,
  id,
  name,
  disabled,
  busy,
  label,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'data-testid': testId,
}: ToggleSwitchProps) {
  const mirror = useRef<HTMLInputElement>(null)
  const flipped = useRef(false)

  useEffect(() => {
    if (!flipped.current) return
    flipped.current = false
    const el = mirror.current
    if (!el) return
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }, [checked])

  const button = (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-busy={busy ? true : undefined}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      data-testid={testId}
      disabled={disabled}
      // WebKit only tabs to buttons with an explicit tabindex (N20).
      tabIndex={disabled ? undefined : 0}
      className={`toggle-switch settings-switch${checked ? ' toggle-on' : ''}`}
      onClick={() => {
        if (disabled) return
        if (name) flipped.current = true
        onChange(!checked)
      }}
    >
      <span className="toggle-thumb" />
    </button>
  )
  const hidden = name ? (
    <input
      ref={mirror}
      type="checkbox"
      name={name}
      checked={checked}
      readOnly
      tabIndex={-1}
      aria-hidden="true"
      className="settings-visually-hidden"
    />
  ) : null

  if (!label) {
    return (
      <>
        {button}
        {hidden}
      </>
    )
  }
  return (
    <label className="toggle-switch-label" htmlFor={id}>
      <span className="toggle-text">{label}</span>
      {button}
      {hidden}
    </label>
  )
}
