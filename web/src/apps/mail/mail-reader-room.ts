/**
 * The reader's room in the three-pane console, and the clicked row that must stay under the pointer.
 *
 * With nothing in the reader slot (no message, no composer, no Ask drawer) the reader is a narrow
 * hint column and the message list takes the rest of the width (mail.css, `data-reader='blank'`):
 * an empty reader holding half the window while every subject and route target wrapped beside it was
 * the 2026-11-22 review's blocker. The moment something opens, the list goes back to the width the
 * person dragged (or the default), so its rows reflow: the rows above the one just clicked grow
 * taller and would push it down, out from under the pointer, possibly off the pane.
 *
 * `useRowStaysPut` undoes that move. It notes which row a press or an Enter/Space landed on and
 * where it stood, and in the layout effect of the flip (before paint) scrolls the list so that row
 * stands where it was. The correction reads the row's position AFTER layout, so Chromium's own
 * scroll anchoring, if it moved anything, is measured rather than added to; WebKit has none, and the
 * correction alone does the job there. A row that is now taller than what is left below it is then
 * brought fully into view. An open that no press explains (a deep link, a restored state) only
 * brings the selected row into view.
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { PANE_BOUNDS } from './mail-pane-widths';

/** A press older than this did not cause the open being laid out now. */
const PRESS_FRESH_MS = 3_000;

const ROW = '.mail-list-pane .mail-row';

interface Press { row: HTMLElement; top: number; at: number }

export function useRowStaysPut(consoleRef: RefObject<HTMLElement | null>, reading: boolean, active: boolean): void {
  const press = useRef<Press | null>(null);

  useEffect(() => {
    const box = consoleRef.current;
    if (!box || !active) return;
    const note = (event: Event) => {
      if (event instanceof PointerEvent && event.button !== 0) return;
      if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return;
      if (!(event.target instanceof Element)) return;
      const row = event.target.closest<HTMLElement>(ROW);
      if (!row) return;
      press.current = { row, top: row.getBoundingClientRect().top, at: Date.now() };
    };
    box.addEventListener('pointerdown', note, true);
    box.addEventListener('keydown', note, true);
    return () => {
      box.removeEventListener('pointerdown', note, true);
      box.removeEventListener('keydown', note, true);
    };
  }, [consoleRef, active]);

  const was = useRef(reading);
  useLayoutEffect(() => {
    const opened = reading && !was.current;
    was.current = reading;
    if (!opened || !active) return;
    const box = consoleRef.current;
    const kept = press.current;
    press.current = null;
    if (!box) return;
    const fresh = kept && kept.row.isConnected && Date.now() - kept.at < PRESS_FRESH_MS ? kept : null;
    const row = fresh?.row ?? box.querySelector<HTMLElement>(`${ROW}.selected`);
    if (!row) return;
    const scroller = row.closest<HTMLElement>('.mail-rows');
    if (fresh && scroller) scroller.scrollTop += row.getBoundingClientRect().top - fresh.top;
    if (!scroller) return;
    const view = scroller.getBoundingClientRect();
    const now = row.getBoundingClientRect();
    if (now.top < view.top || now.bottom > view.bottom) row.scrollIntoView({ block: 'nearest' });
  }, [consoleRef, reading, active]);
}

/**
 * The room the folders column may take while the list is the flexible column (nothing to read): the
 * console less the list's own minimum, so a drag here still leaves a layout the reading view honours.
 */
export function blankAccountsRoom(consoleWidth: number): number {
  return consoleWidth - PANE_BOUNDS.list.min;
}
