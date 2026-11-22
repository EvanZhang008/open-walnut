/**
 * The settings button: the shared button family (`.btn .btn-sm`, styles/buttons.css), 28px (34px as
 * a page's own action in its header, where every page's main action has the default height),
 * sentence case. It adds only behaviour: its width never changes with its text (the longest
 * labels it can show, children, busyLabel and reserve, are stacked in the same grid cell as
 * hidden pseudo-elements, `.btn-reserve`), busy, and holdFocus.
 */
import { createContext, useContext, type ButtonHTMLAttributes, ReactNode } from 'react'
import { keepPress } from './press-keeps-target'
import '@/styles/settings-controls.css'

/**
 * Each variant is a variant of the family: ghost is the quiet tool key (a list row's Edit and
 * Remove), text the link key, danger the quiet red key, and danger-confirm the solid red key that
 * confirms a destructive step.
 */
const VARIANT_CLASS = { default: '', primary: ' btn-primary', ghost: ' btn-ghost', text: ' btn-link', danger: ' btn-ghost btn-danger', 'danger-confirm': ' btn-primary btn-danger' } as const

export interface SettingsButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof VARIANT_CLASS
  busy?: boolean
  /** Shown instead of children while busy, e.g. `Refreshing...`. */
  busyLabel?: string
  /** Other labels this button may show; the widest one reserves the width. */
  reserve?: string[]
  /**
   * Disabled or busy, it stays focusable (aria-disabled, the press ignored) instead of `disabled`:
   * a button that starts work keeps the focus while it runs (2026-11-04 Remote Hosts review: a
   * disabled button drops the focus to the page, and WebKit drops it later with no event).
   */
  holdFocus?: boolean
  children?: ReactNode
  'data-testid'?: string
}

/**
 * The size of the settings buttons below it: small (28px) in rows and cards, the family's default
 * (34px) in a page's header (SettingsSection's PaneHeader), so a page's main action ("Add host")
 * is as tall as every other page's ("New routine", "New message").
 */
export const SettingsButtonSize = createContext<'small' | 'default'>('small')

/** The two longest labels the button may show (character count). */
export function reserveLabels(candidates: ReadonlyArray<string | undefined>): [string, string] {
  const uniq = Array.from(new Set(candidates.filter((c): c is string => !!c)))
  uniq.sort((a, b) => b.length - a.length)
  return [uniq[0] ?? '', uniq[1] ?? '']
}

export function SettingsButton({
  variant = 'default',
  busy = false,
  busyLabel,
  reserve,
  children,
  className,
  disabled,
  holdFocus = false,
  onClick,
  onPointerDown,
  ...rest
}: SettingsButtonProps) {
  const size = useContext(SettingsButtonSize)
  const off = disabled || busy
  const showing = busy && busyLabel ? busyLabel : children
  // Reserved labels ride on pseudo-elements (data attributes), so they take
  // space without entering textContent or the accessible name.
  const [r1, r2] = reserveLabels([...(reserve ?? []), busyLabel, typeof children === 'string' ? children : undefined])
  return (
    <button
      type="button"
      // WebKit only tabs to buttons with an explicit tabindex (N20); a caller's own wins.
      tabIndex={0}
      {...rest}
      className={`btn${size === 'small' ? ' btn-sm' : ''}${VARIANT_CLASS[variant]}${className ? ` ${className}` : ''}`}
      data-variant={variant}
      disabled={off && !holdFocus}
      aria-disabled={off && holdFocus ? true : rest['aria-disabled']}
      aria-busy={busy ? true : rest['aria-busy']}
      onClick={(e) => { if (off && holdFocus) { e.preventDefault(); return } onClick?.(e) }}
      // A press keeps this button even if the row moves under it before the release (press-keeps-target.ts).
      onPointerDown={(e) => { onPointerDown?.(e); if (!e.defaultPrevented) keepPress(e.currentTarget, e) }}
    >
      <span className="btn-reserve" data-r1={r1 || undefined} data-r2={r2 || undefined}>
        <span className="btn-label">{showing}</span>
      </span>
    </button>
  )
}
