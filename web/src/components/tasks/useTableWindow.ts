/**
 * The tasks table's window: which items are on screen, and the offsets the spacers use.
 *
 * Rows and group headers wrap their whole title (standard.md, "Text that does not fit"), so
 * each is its estimate (ROW_H, GROUP_H) or taller. Only the items that are rendered are measured (one ResizeObserver, about the
 * window's 50 rows, never the whole list): a measured height replaces the estimate in the
 * offsets and is kept when the row leaves the window, so the spacers stay what the full
 * list would be. A row above the visible part that turns out taller than its estimate
 * moves the scroll position by the difference, so the rows the user reads stay put on
 * every engine (the browser's own scroll anchoring is off on the scroller: Chromium only).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { OVERSCAN, itemHeights, offsetsFor, visibleRangeFor, type WindowItem } from './tasks-table-window';

/** A row and a group header carry their item key (TasksPageTable `row`, `groupHeader`); a ghost row keeps its fixed height. */
const MEASURED = ':scope > [data-win-key]';

export function useTableWindow(
  ref: React.RefObject<HTMLDivElement | null>,
  items: readonly WindowItem[],
  enabled: boolean,
): { offsets: number[]; range: [number, number] } {
  const measured = useRef(new Map<string, number>());
  const [version, setVersion] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const offsets = useMemo(() => offsetsFor(itemHeights(items, measured.current)), [items, version]);
  const range = useVisibleRange(ref, offsets, enabled);

  const estimate = useMemo(() => new Map(items.map((it) => [it.key, it.h])), [items]);
  const estimateRef = useRef(estimate);
  estimateRef.current = estimate;
  const roRef = useRef<ResizeObserver | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    let queued = 0;
    const ro = new ResizeObserver((entries) => {
      let changed = false;
      let shift = 0;
      const top = el.getBoundingClientRect().top;
      for (const e of entries) {
        const node = e.target as HTMLElement;
        const key = node.dataset.winKey;
        if (!key) continue;
        const h = e.borderBoxSize?.[0]?.blockSize ?? node.getBoundingClientRect().height;
        const before = measured.current.get(key) ?? estimateRef.current.get(key);
        if (before === undefined || Math.abs(h - before) < 0.5) continue;
        measured.current.set(key, h);
        changed = true;
        if (node.getBoundingClientRect().top < top) shift += h - before;
      }
      if (shift) el.scrollTop += shift;
      if (changed && !queued) queued = requestAnimationFrame(() => { queued = 0; setVersion((v) => v + 1); });
    });
    roRef.current = ro;
    return () => { ro.disconnect(); roRef.current = null; if (queued) cancelAnimationFrame(queued); };
  }, [ref, enabled]);

  // After every render: watch exactly the rows now in the window (a removed row is let go).
  useLayoutEffect(() => {
    const ro = roRef.current;
    const el = ref.current;
    if (!ro || !el) return;
    ro.disconnect();
    el.querySelectorAll<HTMLElement>(MEASURED).forEach((n) => ro.observe(n));
  });

  return { offsets, range };
}

/**
 * Which slice of the list is on screen.
 *
 * Deliberately NOT a scroll-triggered React render per pixel: the listener is passive
 * and coalesced into one rAF, and it only calls setState when the resulting slice
 * actually changes. Scrolling within the current window costs nothing.
 */
function useVisibleRange(
  ref: React.RefObject<HTMLDivElement | null>,
  offsets: number[],
  enabled: boolean,
): [number, number] {
  const [range, setRange] = useState<[number, number]>(
    () => visibleRangeFor(offsets, 0, 900, OVERSCAN),
  );
  const rangeRef = useRef(range);
  rangeRef.current = range;

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    let queued = false;
    const compute = () => {
      queued = false;
      const [start, stop] = visibleRangeFor(offsets, el.scrollTop, el.clientHeight, OVERSCAN);
      const [ps, pe] = rangeRef.current;
      if (ps !== start || pe !== stop) setRange([start, stop]);
    };
    const onScroll = () => { if (!queued) { queued = true; requestAnimationFrame(compute); } };
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    compute();
    return () => { el.removeEventListener('scroll', onScroll); ro.disconnect(); };
  }, [ref, offsets, enabled]);

  return range;
}
