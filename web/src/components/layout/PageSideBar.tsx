import { useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { CompanionColumn } from './HomeCompanionPanel';
import { sideBarPageOf, usePageSideBar } from './page-side-bar';

/** Hands focus back to the rail toggle that opens a pane (as Home's column does). */
function focusOpener(testId: string) {
  requestAnimationFrame(() => {
    const opener = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    if (opener?.getClientRects().length) opener.focus();
  });
}

/**
 * The Agenda and the Scratchpad beside any page but Home (page-side-bar.ts): two side bars on the
 * page's left edge, the Scratchpad right of the Agenda, opened from the rail's Agenda and
 * Scratchpad, kept open or shut and as wide as each was per page (CompanionColumn draws them and
 * their resize handles). On Home it draws nothing (Home's own are HomeCompanionPanel).
 */
export function PageSideBar() {
  const location = useLocation();
  const page = sideBarPageOf(location.pathname);
  const { view, setPane } = usePageSideBar(page);
  const tasks = useTasksContextSafe()?.tasks ?? [];
  const closeAgenda = useCallback(() => { setPane('agenda', false); focusOpener('sidebar-toggle-calendar'); }, [setPane]);
  const closeScratchpad = useCallback(() => { setPane('scratchpad', false); focusOpener('sidebar-toggle-scratchpad'); }, [setPane]);
  return (
    <CompanionColumn
      calendarOpen={page !== null && view.agenda}
      scratchpadOpen={page !== null && view.scratchpad}
      onCloseCalendar={closeAgenda}
      onCloseScratchpad={closeScratchpad}
      tasks={tasks}
      className="page-side-bar"
      testId="page-side-bar"
      place={page}
    />
  );
}
