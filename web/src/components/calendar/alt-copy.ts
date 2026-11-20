/**
 * Alt-drag (Option on a Mac) copies a calendar event, as desktop calendars do: the original
 * stays where it is and a new event lands where the copy is dropped. Alt decides at the drop,
 * and pressing or letting it go mid-drag switches between copy and move.
 *
 * Only events are copied. A task is one piece of work with its own session and history, so a
 * second copy of it is not what dragging means; Alt on a task chip is a plain move.
 */
import { useEffect, useRef } from 'react';
import type { CalendarItem } from './calendar-items';

export function canAltCopy(item: CalendarItem): boolean {
  return item.kind === 'event' && !item.event.readonly;
}

/** While a drag runs, tells `onAlt` each time Alt goes down or up without the pointer moving. */
export function useAltCopy(active: boolean, onAlt: (alt: boolean) => void): void {
  const latest = useRef(onAlt);
  latest.current = onAlt;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Alt') return;
      // On Windows a lone Alt would move focus to the browser's menu bar mid-drag.
      e.preventDefault();
      latest.current(e.type === 'keydown');
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
    };
  }, [active]);
}
