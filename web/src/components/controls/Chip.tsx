/**
 * Chip: a filter or an option that is on or off (standard.md, "Choice controls"). 24 px, 8 px
 * corner (a rounded rectangle, not a pill), 12 px. Off is a grey fill; on is the accent tint with
 * accent text. The on state is aria-pressed (a toggle or a filter), or aria-checked when the chip is
 * a role=radio inside a role=radiogroup. Several chips sit in a `ChipGroup` (wraps, 4 px apart).
 */
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
import '@/styles/choice-controls.css'

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** On. Sets aria-pressed (or aria-checked when role="radio" or "switch"). Left out: a one-shot
   *  action among chips (it does something once, it is never on), drawn off with no state. */
  pressed: boolean | undefined
  /** A number after the label (muted). */
  count?: ReactNode
  /** Before the label, e.g. a colour dot or an icon. */
  leading?: ReactNode
  /** After the label and count, e.g. a caret. */
  trailing?: ReactNode
}

export function Chip({ pressed, count, leading, trailing, className, children, role, ...rest }: ChipProps) {
  // role=switch: an on/off chip in a composer row (a page that goes with the next message).
  const state = pressed === undefined ? {}
    : role === 'radio' || role === 'option' || role === 'menuitemradio' || role === 'switch'
      ? { 'aria-checked': pressed }
      : { 'aria-pressed': pressed }
  return (
    <button type="button" role={role} {...state} {...rest} className={`wn-chip${pressed ? ' is-on' : ''}${className ? ` ${className}` : ''}`}>
      {leading}
      <span className="wn-chip-label">{children}</span>
      {/* The space keeps the count its own word in the chip's text and accessible name ("Sev 1 2",
          never "Sev 12"); a flex row draws no space-only text, so nothing moves on screen. */}
      {count !== undefined && count !== null && count !== false && <>{' '}<span className="wn-chip-count">{count}</span></>}
      {trailing}
    </button>
  )
}

export function ChipGroup({ className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div {...rest} className={`wn-chips${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  )
}
