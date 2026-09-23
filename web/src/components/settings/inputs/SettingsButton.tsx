/**
 * The settings button: 28px, sentence case. Its width never changes with its
 * text: the longest labels it can show (children, busyLabel, reserve) are
 * stacked in the same grid cell as visibility:hidden pseudo-elements, so the
 * widest one reserves the space without a hardcoded pixel width.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import '@/styles/settings-controls.css'

export interface SettingsButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'text' | 'danger'
  busy?: boolean
  /** Shown instead of children while busy, e.g. `Refreshing...`. */
  busyLabel?: string
  /** Other labels this button may show; the widest one reserves the width. */
  reserve?: string[]
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
  ...rest
}: SettingsButtonProps) {
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
      disabled={disabled || busy}
      aria-busy={busy ? true : undefined}
    >
      <span className="settings-button-stack" data-r1={r1 || undefined} data-r2={r2 || undefined}>
        <span className="settings-button-label">{showing}</span>
      </span>
    </button>
  )
}
