/**
 * Two-step destructive button without the browser's native confirm dialog
 * (WKWebView has no confirm/alert panel, so that dialog is a silent Cancel in
 * the Mac app).
 * First click arms it (`Confirm remove`) for 3s; only the second click calls
 * onConfirm, never the second click of a double-click. Width is reserved for the
 * longer label, so nothing shifts.
 */
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { SettingsButton } from './SettingsButton'

export const CONFIRM_ARM_MS = 3000

/**
 * The second click of a double-click (or more): the confirm step appears under the pointer,
 * so that click lands on it, and a double-click would skip the question (a reviewer signed a
 * phone out that way). A confirm ignores it; a keyboard press (detail 0) still confirms.
 */
export function isRepeatClick(e: Pick<MouseEvent, 'detail'>): boolean {
  return e.detail > 1
}

export interface InlineConfirmButtonProps {
  onConfirm: () => void | Promise<unknown>
  label?: string
  confirmLabel?: string
  disabled?: boolean
  /** `text` for a non-destructive two-step action (Show QR); default `danger`. */
  variant?: 'danger' | 'text'
  /** Drawn as a plain text button until armed, red only while it asks to confirm (a list's row action). */
  quiet?: boolean
  'data-testid'?: string
  'aria-label'?: string
}

export function InlineConfirmButton({
  onConfirm,
  label = 'Remove',
  confirmLabel = 'Confirm remove',
  disabled,
  variant = 'danger',
  quiet,
  'data-testid': testId,
  'aria-label': ariaLabel,
}: InlineConfirmButtonProps) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const disarm = () => {
    clearTimeout(timer.current)
    setArmed(false)
  }
  const onClick = (e: MouseEvent) => {
    if (armed && isRepeatClick(e)) return
    if (!armed) {
      setArmed(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setArmed(false), CONFIRM_ARM_MS)
      return
    }
    disarm()
    void onConfirm()
  }
  return (
    <SettingsButton
      variant={quiet ? (armed ? 'danger' : 'text') : variant}
      reserve={[label, confirmLabel]}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && armed) {
          e.stopPropagation()
          disarm()
        }
      }}
      disabled={disabled}
      data-testid={testId}
      data-armed={armed ? 'true' : 'false'}
      aria-label={ariaLabel && !armed ? ariaLabel : undefined}
    >
      {armed ? confirmLabel : label}
    </SettingsButton>
  )
}
