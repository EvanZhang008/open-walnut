/**
 * R3-19: does a sideways scroller hide content past an edge? The wide lanes
 * row fades the edge that has more lanes behind it, so a pane that shows
 * exactly three lanes still says a fourth exists (overlay scrollbars show
 * nothing at rest). Updated on scroll, on resize of the row and its content.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface ScrollEdges { left: boolean; right: boolean }

const SLACK = 2;

export function scrollEdges(el: Pick<HTMLElement, 'scrollLeft' | 'scrollWidth' | 'clientWidth'>): ScrollEdges {
  const max = el.scrollWidth - el.clientWidth;
  return { left: el.scrollLeft > SLACK, right: max - el.scrollLeft > SLACK };
}

/** A callback ref for the scroller, and its edges. */
export function useScrollEdges(): [(el: HTMLElement | null) => void, ScrollEdges] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [edges, setEdges] = useState<ScrollEdges>({ left: false, right: false });
  const frame = useRef(0);
  useEffect(() => {
    if (!el) return;
    const update = () => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        const next = scrollEdges(el);
        setEdges((cur) => (cur.left === next.left && cur.right === next.right ? cur : next));
      });
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    for (const child of Array.from(el.children)) ro?.observe(child);
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(update) : null;
    mo?.observe(el, { childList: true });
    return () => {
      cancelAnimationFrame(frame.current);
      el.removeEventListener('scroll', update);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [el]);
  const ref = useCallback((node: HTMLElement | null) => setEl(node), []);
  return [ref, edges];
}
