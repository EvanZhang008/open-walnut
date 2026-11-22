import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * The element's own content width, kept current by a ResizeObserver (a pane is
 * resized on its own, never only with the window). Measured before the first
 * paint, so a layout chosen from it does not flash. 0 until it is measured.
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}
