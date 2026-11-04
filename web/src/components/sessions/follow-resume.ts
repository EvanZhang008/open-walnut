/**
 * When a scroll in the timeline's bottom band turns follow-bottom back on.
 *
 * Only the reader turns following off (wheel up, a finger moving down the
 * screen, a move they asked for), and only the reader turns it back on, by
 * bringing the view back down: below where they left, or back at the very end
 * after going up. Two scrolls inside the band are not that:
 *
 *  - a flick's momentum moving UP, which has no input event of its own and whose
 *    first frames sit inside the band;
 *  - the late echo of the app's own follow write, delivered after the touch that
 *    left: the view did not move at all, and is often still at the end.
 *
 * Either one turned following back on, and the echo guard then snapped the rest
 * of the reader's flick back to the bottom once 500 ms had passed since the
 * finger lifted (2026-11-03, WebKit: phone-touch-scroll-while-streaming.spec.ts,
 * half its runs; on a loaded CI runner the same shape undid a Chromium pan).
 */
export interface FollowLeave {
  /** scrollTop when the reader turned following off. */
  leftAt: number;
  /** The smallest scrollTop since then (the highest the view has been). */
  highestSinceLeft: number;
}

/**
 * How far up the view must have gone before coming back to the end counts as the
 * reader's return: a flick's first momentum frames (and a half-pixel step on a
 * high-density screen) move 1 or 2px up from an end-aligned leave, and that is
 * still the very end.
 */
export const RETURN_FROM_ABOVE_PX = 8;

/**
 * How long after the reader's own downward input (a wheel down, a finger moving
 * up the screen, End or Page Down) the scroll it causes still counts as theirs.
 * The same half second the echo guard gives input before a scroll.
 */
export const READER_DOWN_MS = 500;

/**
 * `readerDown`: the reader's own input moved the view DOWN just now. The 8px
 * rule above exists for scrolls no input explains (upward momentum, the echo
 * of a write); a downward input that lands at the end is the reader's return
 * however short the trip up was. Without it, a wheel 1px up and back to the
 * end left following off for good, so the transcript stopped keeping its tail
 * above a growing composer (2026-11-04, composer-in-flow.webkit.spec.ts, every
 * run after 5d9ea90b1), and on a trackpad a small nudge up did the same.
 */
export function followResumes(leave: FollowLeave | null, scrollTop: number, gap: number, readerDown = false): boolean {
  if (!leave) return true;
  if (scrollTop > leave.leftAt + 0.5) return true;
  if (gap > 2) return false;
  return readerDown || leave.highestSinceLeft < leave.leftAt - RETURN_FROM_ABOVE_PX;
}

/**
 * The reader's downward input arriving while the view already sits at the end:
 * the push moves nothing, so no scroll event will carry it. Only at the end:
 * mid-history, a second wheel tick below where they left is reading on, never
 * a return (review of the 2026-11-04 fix: it pulled the view down to the end).
 */
export function downInputResumesAtEnd(leave: FollowLeave | null, scrollTop: number, gap: number): boolean {
  return !!leave && gap <= 2 && followResumes(leave, scrollTop, gap, true);
}
