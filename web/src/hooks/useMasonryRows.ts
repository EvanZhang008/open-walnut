/**
 * Packs a CSS grid's cards like a wall of bricks: each card spans as many thin rows as its height
 * needs, so a short card never leaves a tall gap under it beside a long one, and the cards still
 * read in their order, left to right (2026-11-21, the UI audit: the Org chart's uniform rows left
 * wide gaps under short cards).
 *
 * The grid opts in through `[data-packed]`, which this hook sets once it can measure: its CSS gives
 * that state `grid-auto-rows: <unitPx>px; row-gap: 0` and its items `align-self: start`, and the
 * column gap doubles as the gap under each card. Without ResizeObserver the grid stays a plain grid.
 */
import { useLayoutEffect, type RefObject } from 'react';

export function useMasonryRows(ref: RefObject<HTMLElement | null>, unitPx = 4): void {
  useLayoutEffect(() => {
    const grid = ref.current;
    if (!grid || typeof ResizeObserver === 'undefined') return;
    // offsetHeight, not the client rect: the sheet's open animation scales it.
    const fit = (el: HTMLElement) => {
      const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
      el.style.gridRowEnd = `span ${Math.max(1, Math.ceil((el.offsetHeight + gap) / unitPx))}`;
    };
    const sizes = new ResizeObserver((entries) => { for (const e of entries) fit(e.target as HTMLElement); });
    const watch = () => {
      for (const el of Array.from(grid.children)) {
        if (!(el instanceof HTMLElement)) continue;
        sizes.observe(el);
        fit(el);
      }
    };
    grid.dataset.packed = '';
    watch();
    // A card added or removed (a new VP, a router, a fold) is measured too.
    const added = new MutationObserver(watch);
    added.observe(grid, { childList: true });
    return () => {
      sizes.disconnect();
      added.disconnect();
      delete grid.dataset.packed;
      for (const el of Array.from(grid.children)) if (el instanceof HTMLElement) el.style.gridRowEnd = '';
    };
  }, [ref, unitPx]);
}
