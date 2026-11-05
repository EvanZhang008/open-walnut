import { useLayoutEffect, useState } from 'react';

/** Below this width the session title row puts its labels on a line under the title. */
export const TITLE_ROW_TIGHT_PX = 440;

/**
 * Whether the session header's title row is narrow (a third column, a slim window), so
 * its labels (Wait, Cron, Trigger, Worker, Leader, the tags) move to a line under the
 * title, each in full, and the title keeps the whole first line. One width for the whole
 * row, never label by label. Read with a ResizeObserver rather than a CSS container
 * query: a container query needs layout containment on the row, which would make it the
 * containing block of any fixed-position child drawn inside it.
 *
 * Returns a callback ref for the row (it mounts after the record loads) and the answer.
 */
export function useTitleRowTight(): [(el: HTMLElement | null) => void, boolean] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [tight, setTight] = useState(false);
  // Before paint, so a narrow column never shows the words for one frame.
  useLayoutEffect(() => {
    if (!el) return;
    const read = () => {
      const w = el.getBoundingClientRect().width;
      setTight(w > 0 && w < TITLE_ROW_TIGHT_PX);
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, tight];
}
