/**
 * The arithmetic of keeping a row in place, apart from the DOM so it can be pinned without a browser
 * (`useScrollAnchor` is the hook that measures and scrolls).
 */

/** Where the anchor row was, measured from the scroll box's top edge, and the box's scroll then. */
export interface AnchorMark {
  top: number;
  scrollTop: number;
}

/**
 * How far the anchor row moved IN THE CONTENT because something above it changed height, in px.
 * Positive means it was pushed down.
 *
 * A scroll since the mark is taken out first. A wheel or a key moves the box before its `scroll`
 * event is dispatched (that waits for the next frame), and a render in between would otherwise read
 * the person's own scroll as drift and scroll them back.
 */
export function anchorDrift(mark: AnchorMark, top: number, scrollTop: number): number {
  const expected = mark.top - (scrollTop - mark.scrollTop);
  return top - expected;
}

/**
 * The scroll position that puts the anchor row back where the mark saw it, or `scrollTop` itself
 * when nothing has to move.
 *
 * Normally the current position plus the drift: whatever the person scrolled since the mark stays
 * theirs. The exception is the browser's CLAMP. When the content got shorter while the box sat at
 * its end, the browser has already pulled the position up by the lost height, and that pull is part
 * of `scrollTop`. Adding the drift on top would count the same rows twice (a 28px row leaving above
 * the view at the end of the list threw every row 28px down). So at the end, after a pull, the
 * position is worked out from the mark's instead, and capped at the end.
 */
export function anchoredScrollTop(mark: AnchorMark, top: number, scrollTop: number, max: number): number {
  const drift = anchorDrift(mark, top, scrollTop);
  if (Math.abs(drift) < ANCHOR_SLOP_PX) return scrollTop;
  const clamped = scrollTop >= max - ANCHOR_SLOP_PX && scrollTop < mark.scrollTop;
  const target = clamped ? mark.scrollTop + drift : scrollTop + drift;
  return Math.max(0, Math.min(max, target));
}

/** Under half a pixel is subpixel layout, not a move: correcting it would fight rounding forever. */
export const ANCHOR_SLOP_PX = 0.5;

/**
 * A scroll box another keeper holds for a moment carries this attribute (a fold toggle, which
 * `useFoldAnchor` keeps in place by its clicked row), and `useScrollAnchor` leaves the box to it:
 * two keepers correcting one move undo each other, and the fold's keeper lets go of any scroll it
 * did not make. The keeper dispatches `SCROLL_RELEASED_EVENT` on the box when it lets go.
 */
export const SCROLL_HELD_ATTR = 'data-scroll-held';
export const SCROLL_RELEASED_EVENT = 'walnut-scroll-released';
