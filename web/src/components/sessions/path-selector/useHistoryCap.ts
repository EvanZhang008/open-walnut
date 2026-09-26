/**
 * The history cap for the list on screen now (history-cap.ts): measured after
 * every render that changes the rows, and again when the list resizes (a
 * window made taller gets its 8 rows back). The panel's height is fixed, so
 * the answer does not feed back into the list's height: one re-measure after
 * the cap changes settles it.
 */
import { useLayoutEffect, useState, type RefObject } from 'react';
import { HISTORY_CAP, historyCapFor, measureHistoryCap } from './history-cap';

export function useHistoryCap(listRef: RefObject<HTMLElement | null>, active: boolean, rowsKey: unknown): number {
  const [cap, setCap] = useState(HISTORY_CAP);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!active || !list) return;
    const measure = () => {
      const m = measureHistoryCap(list);
      if (!m) return;
      const next = historyCapFor(m);
      setCap((c) => (c === next ? c : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    return () => ro.disconnect();
  }, [listRef, active, rowsKey]);
  return cap;
}
