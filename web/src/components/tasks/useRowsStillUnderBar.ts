/**
 * Rows stay where they are while a bar comes and goes above their scroller (the task panel's
 * multi-select bar, right under its toolbar). The bar takes its height from the top of the list's
 * scroll box, so the box scrolls by the same amount: a row the pointer is over stays under it, and a
 * third Cmd/Ctrl-click lands on the row the person aimed at, not one 44px lower (2026-11-17, review).
 *
 * useScrollAnchor cannot do it: it holds a row in its box's own coordinates, and here the whole box
 * moves. Only the outermost box that scrolls is moved (what is inside it moves with it). A list
 * shorter than its box has nothing to scroll by, so there the rows still move; at a list's end the
 * browser's own clamp already keeps them, which is why the box's offset is followed by its scroll
 * events rather than read back after the bar left.
 */
import { useLayoutEffect, useRef, type RefObject } from 'react';

/** The space the bar takes in its column: its box and its vertical margins. */
function takenBy(bar: HTMLElement): number {
  const style = getComputedStyle(bar);
  return bar.getBoundingClientRect().height + (Number.parseFloat(style.marginTop) || 0) + (Number.parseFloat(style.marginBottom) || 0);
}

function scrolls(box: HTMLElement): boolean {
  if (box.scrollHeight <= box.clientHeight + 1) return false;
  const y = getComputedStyle(box).overflowY;
  return y === 'auto' || y === 'scroll';
}

/** The boxes that scroll now, minus any inside another of them. */
function outermostScrolling(refs: readonly RefObject<HTMLElement | null>[]): HTMLElement[] {
  const live = refs.map((r) => r.current).filter((b): b is HTMLElement => !!b && b.isConnected && scrolls(b));
  return live.filter((b) => !live.some((other) => other !== b && other.contains(b)));
}

export function useRowsStillUnderBar(
  barRef: RefObject<HTMLElement | null>,
  shown: boolean,
  scrollerRefs: readonly RefObject<HTMLElement | null>[],
): void {
  // The space already given back by scrolling, and each moved box's offset as last seen.
  const state = useRef({ taken: 0, boxes: new Map<HTMLElement, number>() });
  const refsRef = useRef(scrollerRefs);
  refsRef.current = scrollerRefs;

  useLayoutEffect(() => {
    const s = state.current;
    if (!shown) {
      // The bar has left this commit (layout effects run after the DOM changed): scroll back.
      for (const [box, top] of s.boxes) if (box.isConnected) box.scrollTop = Math.max(0, top - s.taken);
      s.taken = 0;
      s.boxes.clear();
      return;
    }
    const bar = barRef.current;
    if (!bar) return;
    const follow = (e: Event) => { const box = e.currentTarget as HTMLElement; s.boxes.set(box, box.scrollTop); };
    const apply = () => {
      if (!bar.isConnected) return;
      const next = takenBy(bar);
      const d = next - s.taken;
      if (Math.abs(d) < 0.5) return;
      if (s.boxes.size === 0) {
        for (const box of outermostScrolling(refsRef.current)) {
          s.boxes.set(box, box.scrollTop);
          box.addEventListener('scroll', follow, { passive: true });
        }
      }
      for (const [box, top] of s.boxes) { box.scrollTop = top + d; s.boxes.set(box, box.scrollTop); }
      s.taken = next;
    };
    apply();
    // Its height changes too: the count's words wrap the row ("9 selected" to "10 selected"). A scroll
    // changes no size, so the observer is never fed back.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply);
    ro?.observe(bar);
    return () => {
      ro?.disconnect();
      for (const box of s.boxes.keys()) box.removeEventListener('scroll', follow);
    };
  }, [shown, barRef]);
}
