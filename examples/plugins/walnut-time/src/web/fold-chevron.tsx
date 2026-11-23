/**
 * The host's fold chevron (DisclosureChevron in web/src/components/controls/Disclosure.tsx). A plugin
 * cannot import host components, so this draws the same markup with the host's classes, which place it
 * and turn it down while open. Never a text triangle (tests/web/disclosure-mark-guard.test.ts).
 */
export function FoldChevron({ open, inline }: { open: boolean; inline?: boolean }) {
  return (
    <span className={`wn-disclosure-chevron${open ? ' is-open' : ''}${inline ? ' is-inline' : ''}`} aria-hidden="true">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="6 3.5 10.5 8 6 12.5" />
      </svg>
    </span>
  )
}

/**
 * The host's direction icons (ICON_CHEVRON_LEFT / ICON_CHEVRON_RIGHT in web/src/components/common/Icons.tsx),
 * drawn the same way for the same reason: back and next, previous and next day, a crumb before the page.
 * Never a typed angle quote (tests/web/disclosure-mark-guard.test.ts checks this copy stays the host's).
 */
export function DirectionMark({ dir }: { dir: 'left' | 'right' }) {
  return (
    <span className="wn-dir-mark" aria-hidden="true">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <polyline points={dir === 'left' ? '10 3 5.5 8 10 13' : '6 3 10.5 8 6 13'} />
      </svg>
    </span>
  )
}
