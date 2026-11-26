/** What a session timeline's rows are, read the one way by every pass that walks them. */

/** A timeline row (or a block holding rows): not the arrow pill, a hover strip or a card layer. */
export function isTimelineRow(n: Node): n is HTMLElement {
  return n instanceof HTMLElement && (n.matches('[data-message-id]') || !!n.querySelector('[data-message-id]'));
}

/** The reader has text selected in this box (a cut, or content taken out, would drop what they hold). */
export function selectionInside(el: HTMLElement | null): boolean {
  if (!el || typeof document === 'undefined') return false;
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  return el.contains(sel.anchorNode) || el.contains(sel.focusNode);
}
