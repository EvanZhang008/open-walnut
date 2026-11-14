import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useLocation } from 'react-router-dom';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { useDragGesture } from '@/hooks/useDragGesture';
import { CompanionColumn } from './HomeCompanionPanel';
import { SIDE_BAR_LAYOUT_EVENT, SIDE_BAR_WIDTH_MIN, sideBarPageOf, sideBarWidth, usePageSideBar } from './page-side-bar';

/** Hands focus back to the rail toggle that opens a pane (as Home's column does). */
function focusOpener(testId: string) {
  requestAnimationFrame(() => {
    const opener = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    if (opener?.getClientRects().length) opener.focus();
  });
}

function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

/**
 * The Agenda and the Scratchpad beside any page but Home (page-side-bar.ts): one column on the
 * page's left edge, opened from the rail's Agenda and Scratchpad, kept open or shut and as wide
 * as it was per page. On Home it draws nothing (Home's own column is HomeCompanionPanel).
 */
export function PageSideBar() {
  const location = useLocation();
  const page = sideBarPageOf(location.pathname);
  const { view, setPane, setWidth } = usePageSideBar(page);
  const tasks = useTasksContextSafe()?.tasks ?? [];
  const windowWidth = useWindowWidth();
  const shown = sideBarWidth(view.width, windowWidth);
  // The width while a drag runs; written to the page's view once, when it ends.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const startRef = useRef(shown);
  const latestRef = useRef<number | null>(null);
  const { onPointerDown } = useDragGesture({
    cursor: 'col-resize',
    onStart: () => { startRef.current = shown; latestRef.current = null; },
    onMove: ({ dx }) => {
      const next = sideBarWidth(startRef.current + dx, window.innerWidth);
      latestRef.current = next;
      setDragWidth(next);
    },
    onEnd: ({ canceled }) => {
      const final = latestRef.current;
      setDragWidth(null);
      if (!canceled && final !== null) setWidth(final);
    },
  });
  const closeAgenda = useCallback(() => { setPane('agenda', false); focusOpener('sidebar-toggle-calendar'); }, [setPane]);
  const closeScratchpad = useCallback(() => { setPane('scratchpad', false); focusOpener('sidebar-toggle-scratchpad'); }, [setPane]);

  const width = dragWidth ?? shown;
  const agendaOpen = page !== null && view.agenda;
  const scratchpadOpen = page !== null && view.scratchpad;
  // The full screen area starts beside the side bar (AppShell): tell it when the bar moved.
  useLayoutEffect(() => { window.dispatchEvent(new Event(SIDE_BAR_LAYOUT_EVENT)); }, [agendaOpen, scratchpadOpen, width]);
  return (
    <CompanionColumn
      calendarOpen={agendaOpen}
      scratchpadOpen={scratchpadOpen}
      onCloseCalendar={closeAgenda}
      onCloseScratchpad={closeScratchpad}
      tasks={tasks}
      className="page-side-bar"
      testId="page-side-bar"
      place={page}
      style={{ '--page-side-bar-width': `${width}px` } as CSSProperties}
    >
      <div
        className={`page-side-bar-resize${dragWidth !== null ? ' resizing' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize side bar"
        aria-valuenow={width}
        aria-valuemin={SIDE_BAR_WIDTH_MIN}
        aria-valuemax={sideBarWidth(Number.MAX_SAFE_INTEGER, windowWidth)}
        tabIndex={0}
        data-testid="page-side-bar-resize"
        onPointerDown={onPointerDown}
        onKeyDown={(event) => {
          // The arrows widen and narrow it from the keyboard, 16px a press.
          const step = event.key === 'ArrowRight' ? 16 : event.key === 'ArrowLeft' ? -16 : 0;
          if (!step) return;
          event.preventDefault();
          setWidth(sideBarWidth(shown + step, window.innerWidth));
        }}
      />
    </CompanionColumn>
  );
}
