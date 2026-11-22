/**
 * The one boolean control: a 38x22 switch (28x16 with size="sm", for a menu row or a dense
 * toolbar), role=switch. Optimistic callers set
 * `busy` while the write is in flight (aria-busy; the control stays enabled so
 * a second flip wins). With `name`, a visually hidden checkbox mirrors the value
 * for FormData forms, and a bubbling input + change event is dispatched on it
 * after each flip so native form listeners (autosave) still fire.
 */
import { useEffect, useRef } from 'react'
import { keepPress } from './press-keeps-target'
import '@/styles/settings-controls.css'
import '@/styles/choice-controls.css'

interface ToggleSwitchProps {
  checked: boolean
  /** Not called when `decorative`. */
  onChange?: (v: boolean) => void
  id?: string
  name?: string
  disabled?: boolean
  busy?: boolean
  /** Legacy inline label (rows should use SettingsRow label + htmlFor instead). */
  label?: string
  'aria-label'?: string
  'aria-labelledby'?: string
  /** The ControlGroup this switch is the master of (controls/ControlGroup.tsx). */
  'aria-controls'?: string
  'data-testid'?: string
  /** 'sm' = 28x16, for a menu row or a dense toolbar. */
  size?: 'md' | 'sm'
  /** Extra classes (placement only: margin, flex; never a look). */
  className?: string
  title?: string
  /**
   * Drawn only: an aria-hidden span with no role, focus or click of its own, for a row that is
   * itself the control (a menuitemcheckbox in a menu, whose aria-checked is the state). A button
   * inside that row would nest one control in another.
   */
  decorative?: boolean
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
  'aria-controls': ariaControls,
  'data-testid': testId,
  size,
  className,
  title,
  decorative,
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

  const classes = `toggle-switch settings-switch${size === 'sm' ? ' wn-switch-sm' : ''}${checked ? ' toggle-on' : ''}${className ? ` ${className}` : ''}`
  if (decorative) {
    // aria-checked only feeds the one stylesheet's on rule; the span is hidden from assistive tech.
    return (
      <span aria-hidden="true" aria-checked={checked} data-testid={testId} className={classes}>
        <span className="toggle-thumb" />
      </span>
    )
  }

  const button = (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-busy={busy ? true : undefined}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-controls={ariaControls}
      data-testid={testId}
      title={title}
      disabled={disabled}
      // WebKit only tabs to buttons with an explicit tabindex (N20).
      tabIndex={disabled ? undefined : 0}
      className={classes}
      onClick={() => {
        if (disabled) return
        if (name) flipped.current = true
        onChange?.(!checked)
      }}
      // A press keeps this switch even if the row moves under it before the release (press-keeps-target.ts).
      onPointerDown={(e) => keepPress(e.currentTarget, e)}
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
