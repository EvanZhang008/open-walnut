import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * Left indent that puts a second header line under the title block, whatever
 * sits before it (back label, path crumbs). The title block is the row's
 * flex:1 item, so anything that moves its left edge also resizes it: one
 * ResizeObserver on it (plus the first measure) covers every change without
 * measuring on each render. `null` until measured (CSS default indent).
 *
 * The title ELEMENT can be replaced while the header stays mounted (a pending
 * page becoming its question swaps the title node), so the observer follows the
 * current node: watching the detached one measured an indent of 0.
 */
export function useSubtitleIndent(
  containerRef: RefObject<HTMLElement | null>,
  titleRef: RefObject<HTMLElement | null>,
): number | null {
  const [pad, setPad] = useState<number | null>(null);
  const watched = useRef<{ el: HTMLElement | null; ro: ResizeObserver | null }>({ el: null, ro: null });
  // No deps on purpose: a cheap identity check every commit, work only on a new node.
  useLayoutEffect(() => {
    const title = titleRef.current;
    if (title === watched.current.el) return;
    watched.current.ro?.disconnect();
    watched.current = { el: title, ro: null };
    const measure = () => {
      const box = containerRef.current;
      if (!box || !title || !title.isConnected) return;
      // The second line starts at the container's CONTENT edge: its own
      // padding-left is already in front of it (the stack header's 6px).
      const inset = parseFloat(getComputedStyle(box).paddingLeft) || 0;
      const next = Math.max(0, Math.round(title.getBoundingClientRect().left - box.getBoundingClientRect().left - inset));
      setPad((prev) => (prev === next ? prev : next));
    };
    measure();
    if (!title || typeof ResizeObserver === 'undefined') return;
    // The title can MOVE without resizing (the crumbs before it fold or grow as
    // the path changes), so its row siblings and the header are watched too.
    const ro = new ResizeObserver(measure);
    ro.observe(title);
    if (containerRef.current) ro.observe(containerRef.current);
    for (const sib of Array.from(title.parentElement?.children ?? [])) if (sib !== title) ro.observe(sib);
    watched.current.ro = ro;
  });
  useLayoutEffect(() => () => { watched.current.ro?.disconnect(); watched.current = { el: null, ro: null }; }, []);
  return pad;
}
