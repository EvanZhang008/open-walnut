/**
 * G9 on WebKit: while the pointer holds the layout, the card under it keeps its
 * place on screen. The freeze keeps every card's lane and order, but a card
 * above the hovered one may still grow (its status, a parked note) and push it
 * down. Chromium's scroll anchoring absorbs that; WebKit has none, so after
 * every board commit the nearest scrolling ancestor of the hovered card is
 * scrolled by however far the card moved. A scroll (the user's or this one's)
 * takes the card's new place as the place to keep.
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

const CARD = '[data-testid="kanban-card"]';

interface Anchor { el: HTMLElement; top: number }

function scrollParent(el: HTMLElement, stop: HTMLElement | null): HTMLElement | null {
  for (let p = el.parentElement; p && p !== stop?.parentElement; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/** `at` is the pointer's last client position; `held` is the pointer hold. */
export function useHoverAnchor(root: RefObject<HTMLElement | null>, held: boolean, at: () => { x: number | null; y: number | null }): void {
  const anchor = useRef<Anchor | null>(null);

  useEffect(() => {
    if (!held) { anchor.current = null; return; }
    const pick = (x: number | null, y: number | null) => {
      if (x === null || y === null) { anchor.current = null; return; }
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>(CARD) ?? null;
      anchor.current = el && root.current?.contains(el) ? { el, top: el.getBoundingClientRect().top } : null;
    };
    const p = at();
    pick(p.x, p.y);
    const onMove = (e: PointerEvent) => pick(e.clientX, e.clientY);
    const onScroll = () => { const a = anchor.current; if (a?.el.isConnected) a.top = a.el.getBoundingClientRect().top; };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('scroll', onScroll, true);
      anchor.current = null;
    };
  }, [held]); // eslint-disable-line react-hooks/exhaustive-deps

  // Every commit: put the hovered card back where it was.
  useLayoutEffect(() => {
    const a = anchor.current;
    if (!a) return;
    // Gone, or hidden (no box): nothing to keep in place.
    if (!a.el.isConnected || a.el.getClientRects().length === 0) { anchor.current = null; return; }
    const moved = a.el.getBoundingClientRect().top - a.top;
    if (Math.abs(moved) < 0.5) return;
    const s = scrollParent(a.el, root.current);
    if (s) s.scrollTop += moved;
    a.top = a.el.getBoundingClientRect().top;
  });
}
