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
