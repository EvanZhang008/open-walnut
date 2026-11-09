/**
 * The app's taskbar, one for every page (2026-11-08, the user: "org view shoud also have this
 * minimze button adn bar, this should be global"). The app shell draws it under every page; the
 * lists are pages/sessionTaskbarStore.ts, the drawing SessionTaskbar.tsx. A click opens the
 * session where the user is: on the Org page the page's own way (a node's chat selects its node,
 * anything else opens in its side panel: OrgPage.tsx onOpenOnPage), on Home's strip anywhere else.
 * A desktop window only: a phone shows one surface at a time and has no bar.
 */
import { useLocation, useNavigate } from 'react-router-dom';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { usePhoneLayout } from '@/hooks/usePhoneLayout';
import { openSessionOnHome } from '@/utils/open-session';
import { requestOpenOnPage } from '@/utils/taskbar-minimize';
import { closeChip, closeRecent, moveTaskbarChip, takeFromTaskbar, useTaskbarLists } from '@/pages/sessionTaskbarStore';
import { SessionTaskbar } from './SessionTaskbar';

export function AppTaskbar() {
  const phone = usePhoneLayout();
  const { chips, recent } = useTaskbarLists();
  const store = useTasksContextSafe();
  const navigate = useNavigate();
  const location = useLocation();
  if (phone) return null;
  const restore = (sessionId: string) => {
    if (location.pathname === '/org' || location.pathname.startsWith('/org/')) {
      // The Org page opens it its own way (a node's chat selects its node, anything else opens
      // beside the page, replacing the history entry on a desktop).
      if (requestOpenOnPage(sessionId)) { takeFromTaskbar(sessionId); return; }
      const params = new URLSearchParams(location.search);
      params.set('open', `session:${sessionId}`);
      navigate({ pathname: location.pathname, search: `?${params.toString()}` });
      takeFromTaskbar(sessionId);
      return;
    }
    // Home's strip takes it off the bar once its column opens (sessionTaskbar.ts).
    openSessionOnHome(sessionId, navigate);
  };
  return (
    <SessionTaskbar
      chips={chips}
      recent={recent}
      tasks={store?.tasks ?? []}
      onRestore={restore}
      onClose={closeChip}
      onCloseRecent={closeRecent}
      onMove={moveTaskbarChip}
    />
  );
}
