/**
 * useMoreBelow: is anything of a scrolling list past its bottom edge, and is the list not already
 * scrolled down there? Put the answer on the box as `data-more="true"`: the overlay family fades the
 * foot of such a box (overlay-family.css), so a list cut by its height cap reads as a list that goes
 * on, not as one that ends on half a row.
 *
 * 2026-11-04: a context menu capped in a short window hid 42% of its items behind a flush-cut border.
 * 2026-11-22 audit: the slash command list cut its last row in half above "Refresh list".
 *
 * A LAYOUT effect, so the attribute is on the box in the same paint the capped list first appears in,
 * read again on the next few frames and whenever the box resizes or scrolls: the cap often arrives
 * from a measured placement a commit later, and a single read then saw no overflow.
 */
import { useLayoutEffect, useState, type RefObject } from 'react';

export function useMoreBelow(ref: RefObject<HTMLElement | null>, deps: readonly unknown[]): boolean {
  const [more, setMore] = useState(false);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const read = () => {
      const over = box.scrollHeight - box.clientHeight;
      setMore(over > 1 && box.scrollTop < over - 1);
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
