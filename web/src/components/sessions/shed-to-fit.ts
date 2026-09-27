import { useLayoutEffect } from 'react';

/**
 * Keep the most detail that fits: sets `data-shed` on `el` to the lowest level
 * (0..max) at which nothing inside overflows. Re-measured after every render (the
 * text may have changed) and on resize. CSS decides what each level hides, so the
 * order in which detail goes is written in one place and holds at any width, font
 * or density.
 */
export function useShedToFit(el: HTMLElement | null, max: number): void {
  useLayoutEffect(() => { if (el) fit(el, max); });
  useLayoutEffect(() => {
    if (!el) return;
    const observer = new ResizeObserver(() => fit(el, max));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, max]);
}

function fit(el: HTMLElement, max: number): void {
  let level = 0;
  el.dataset.shed = '0';
  while (level < max && overflowing(el)) el.dataset.shed = String(++level);
}

function overflowing(el: HTMLElement): boolean {
  if (el.scrollWidth > el.clientWidth + 1) return true;
  for (const node of el.querySelectorAll<HTMLElement>('[data-shed-watch]')) {
    if (node.getClientRects().length > 0 && node.scrollWidth > node.clientWidth + 1) return true;
  }
  return false;
}
