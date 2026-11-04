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

export function followResumes(leave: FollowLeave | null, scrollTop: number, gap: number): boolean {
  if (!leave) return true;
  if (scrollTop > leave.leftAt + 0.5) return true;
  return gap <= 2 && leave.highestSinceLeft < leave.leftAt - RETURN_FROM_ABOVE_PX;
}
