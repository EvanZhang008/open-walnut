/**
 * Icons shared by the transcript's pin affordances: the per-message hover strip
 * (MessageMetaRow) and the selection pill that pins a passage
 * (QuotePinSelectionBar). One glyph for one meaning — a second hand-drawn pin
 * would read as a different action.
 */

/** Pin glyph, outline when unpinned and filled once pinned (the only state the
 *  row shows — the TOC is the other half of the feedback). */
export const ICON_PIN = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9.5 2.5l4 4-1.4 1.4-.7-.7-2.5 2.5.4 2.6-1 1-4.6-4.6 1-1 2.6.4 2.5-2.5-.7-.7z" />
    <path d="M5.2 10.8L2.5 13.5" />
  </svg>
);

export const ICON_PIN_FILLED = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9.5 2.5l4 4-1.4 1.4-.7-.7-2.5 2.5.4 2.6-1 1-4.6-4.6 1-1 2.6.4 2.5-2.5-.7-.7z" />
    <path d="M5.2 10.8L2.5 13.5" fill="none" />
  </svg>
);
