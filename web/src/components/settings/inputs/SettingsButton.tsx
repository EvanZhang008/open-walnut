/**
 * The settings button: 28px, sentence case. Its width never changes with its
 * text: the longest labels it can show (children, busyLabel, reserve) are
 * stacked in the same grid cell as visibility:hidden pseudo-elements, so the
 * widest one reserves the space without a hardcoded pixel width.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { keepPress } from './press-keeps-target'
import '@/styles/settings-controls.css'

export interface SettingsButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'text' | 'danger'
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
      className={`settings-button settings-button-${variant}${className ? ` ${className}` : ''}`}
      disabled={off && !holdFocus}
      aria-disabled={off && holdFocus ? true : rest['aria-disabled']}
      aria-busy={busy ? true : rest['aria-busy']}
      onClick={(e) => { if (off && holdFocus) { e.preventDefault(); return } onClick?.(e) }}
      // A press keeps this button even if the row moves under it before the release (press-keeps-target.ts).
      onPointerDown={(e) => { onPointerDown?.(e); if (!e.defaultPrevented) keepPress(e.currentTarget, e) }}
    >
      <span className="settings-button-stack" data-r1={r1 || undefined} data-r2={r2 || undefined}>
        <span className="settings-button-label">{showing}</span>
      </span>
    </button>
  )
}
