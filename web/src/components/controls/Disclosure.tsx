/**
 * Disclosure: a chevron and a label that show or hide what is under them (standard.md, "Choice
 * controls"). The chevron points right when closed and turns down when open (one rotation rule,
 * read from aria-expanded). `DisclosureButton` is the whole control; a header that is already a
 * button of its own (a row with a count and actions) puts `DisclosureChevron` inside it and sets
 * aria-expanded on itself.
 *
 * `MenuCaret` is the other mark: the small down chevron of a key that opens a menu or picker
 * ("Plan v", "Snooze v"). It points down and flips while the menu is open (`.btn[aria-expanded]
 * .btn-caret` in styles/buttons.css). Both are SVG, never a text triangle
 * (tests/web/disclosure-mark-guard.test.ts).
 */
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import '@/styles/choice-controls.css'

/** `inline`: the chevron starts a run of text ("v Earlier questions"), not a flex row: it sits on the line's middle. */
export function DisclosureChevron({ open, size = 12, className, inline }: { open?: boolean; size?: number; className?: string; inline?: boolean }) {
  return (
    <span className={`wn-disclosure-chevron${open ? ' is-open' : ''}${inline ? ' is-inline' : ''}${className ? ` ${className}` : ''}`} aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="6 3.5 10.5 8 6 12.5" />
      </svg>
    </span>
  )
}

/**
 * The caret of a key that opens a menu. `className` replaces `btn-caret` (a site's own caret slot);
 * `wn-menu-caret` stays, so the caret flips while its key's aria-expanded is true on any key, a
 * `.btn` or not (choice-controls.css). The chevron fills its box's width, so the 6 px caret takes
 * the room the old typed one did and a row that fits its keys by width (the composer's, measured
 * to the pixel) keeps its break points.
 */
export function MenuCaret({ size = 6, className }: { size?: number; className?: string }) {
  return (
    <span className={`wn-menu-caret ${className ?? 'btn-caret'}`} aria-hidden="true">
      <svg width={size} height={size} viewBox="1 1 14 14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="1.5 5 8 11.5 14.5 5" />
      </svg>
    </span>
  )
}

export interface DisclosureButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** The button itself (focus it back after a menu closes). */
  ref?: Ref<HTMLButtonElement>
  expanded: boolean
  /** Fill the line (a section header). */
  block?: boolean
  /** After the label, e.g. a count. */
  trailing?: ReactNode
  /** Inside a line of small text (a row's 16 px info line): the line's own size, no taller. */
  inline?: boolean
}

/**
 * With no children it is the chevron alone (a tree row's fold; give it an aria-label), a small
 * square. The chevron turns by `expanded` itself, so a row that carries its open state another way
 * (a listbox option, which takes no aria-expanded: pass `aria-expanded={undefined}`) turns it too.
 */
export function DisclosureButton({ expanded, block, trailing, inline, className, children, ...rest }: DisclosureButtonProps) {
  const iconOnly = children === undefined || children === null || children === false
  return (
    <button
      type="button"
      aria-expanded={expanded}
      {...rest}
      className={`wn-disclosure${block ? ' wn-disclosure-block' : ''}${inline ? ' wn-disclosure-inline' : ''}${iconOnly ? ' wn-disclosure-icon' : ''}${className ? ` ${className}` : ''}`}
    >
      <DisclosureChevron open={expanded} />
      {!iconOnly && <span className="wn-disclosure-label">{children}</span>}
      {trailing}
    </button>
  )
}
