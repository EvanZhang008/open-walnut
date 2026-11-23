/**
 * useMoreBelow: is anything of a scrolling list past its bottom edge, and is the list not already
 * scrolled down there? Put the answer on the box as `data-more="true"`: the overlay family fades the
 * foot of such a box (overlay-family.css), so a list cut by its height cap reads as a list that goes
 * on, not as one that ends on half a row.
 *
 * 2026-11-04: a context menu capped in a short window hid 42% of its items behind a flush-cut border.
 * 2026-11-22 audit: the slash command list cut its last row in half above "Refresh list".
 * A few pixels over is not more: under 12px below the fold the list reads as ending (no fade).
 *
 * A LAYOUT effect, so the attribute is on the box in the same paint the capped list first appears in,
 * read again on the next few frames and whenever the box resizes or scrolls: the cap often arrives
 * from a measured placement a commit later, and a single read then saw no overflow.
 */
import { useLayoutEffect, useState, type RefObject } from 'react';

/** Pixels below the fold that still read as the list's end, not as more rows. */
const SLACK = 12;

export function useMoreBelow(ref: RefObject<HTMLElement | null>, deps: readonly unknown[]): boolean {
  const [more, setMore] = useState(false);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    // Less than SLACK px below is not "more": the fade (22px) would only dim the list's real last
    // line (2026-11-23 review: a mention palette 4px over its cap faded its closing status line).
    const read = () => {
      const left = box.scrollHeight - box.clientHeight - box.scrollTop;
      setMore(left > SLACK);
    };
    read();
    let frame = 0;
    let left = 3;
    const tick = () => {
      read();
      if (left > 0) { left -= 1; frame = requestAnimationFrame(tick); }
    };
    frame = requestAnimationFrame(tick);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(read) : null;
    observer?.observe(box);
    box.addEventListener('scroll', read);
    return () => {
      cancelAnimationFrame(frame);
      left = 0;
      observer?.disconnect();
      box.removeEventListener('scroll', read);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return more;
}
