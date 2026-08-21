import { memo, useEffect, useRef } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { NavigateFunction } from 'react-router-dom';
import { openSessionOnHome } from './utils/open-session';
import { AppShell } from './components/layout/AppShell';
import { DebugCrashProbe } from './components/common/AppErrorBoundary';
import { MainPage } from './pages/MainPage';
import { DashboardPage } from './pages/DashboardPage';
import { TaskDetailPage } from './pages/TaskDetailPage';

import { SettingsPage } from './pages/SettingsPage';
import { RoutinesPage } from './pages/RoutinesPage';

import { AgentsPage } from './pages/AgentsPage';
import { CommandsPage } from './pages/CommandsPage';
import { SkillsPage } from './pages/SkillsPage';

import { MemoryPage } from './pages/MemoryPage';
import { NotesPage } from './pages/NotesPage';
import { CalendarPage } from './pages/CalendarPage';
import { PluginAppPage } from './pages/PluginAppPage';

import { PopoutRoot } from './popout/PopoutRoot';



/**
 * Memoized MainPage — only re-renders when `visible` prop changes.
 * Uses React.memo to prevent re-renders from parent route changes.
 */
const StableMainPage = memo(MainPage);

/**
 * Legacy /sessions?id=… deep links (notifications, session-ref markdown,
 * bookmarks) reroute to the home page's session columns. MainPage is always
 * mounted, so the open-session event is received even before navigation.
 */
function SessionsRedirect() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const id = searchParams.get('id');
  useEffect(() => {
    // replace:true — a push here would trap the back button in the redirect.
    if (id) openSessionOnHome(id, (to) => navigate(to, { replace: true }));
    else navigate('/', { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

export function App() {
  const location = useLocation();
  const navigate = useNavigate();

  // Pop-out windows render a single view with NO app shell / providers / sidebar.
  // Fork here, before <AppShell>, so they never mount MainPage or TasksProvider.
  const isPopout = location.pathname.startsWith('/popout');
  if (isPopout) return <PopoutRoot />;

  const isHome = location.pathname === '/';

  // Stable ref for navigate — MainPage reads this ref instead of calling
  // useNavigate() directly, which would cause re-renders on every route change
  // (React Router context updates bypass React.memo).
  const navigateRef = useRef<NavigateFunction>(navigate);
  navigateRef.current = navigate;

  return (
    <AppShell>
      {/* E2E/QA crash probe — throws once when its sessionStorage flag is set. */}
      <DebugCrashProbe />
      {/* MainPage is always mounted — hidden via CSS class when another route is active.
          This preserves all React state (chat, tasks, WebSocket, focused task, scroll position)
          across navigation to other pages and back. The CSS class is in globals.css. */}
      <div className={isHome ? 'main-page-wrapper' : 'main-page-wrapper main-page-wrapper-hidden'}>
        <StableMainPage visible={isHome} navigateRef={navigateRef} />
      </div>
      <Routes>
        {/* Explicit match for / prevents the catch-all from redirecting home in a loop */}
        <Route path="/" element={null} />
        <Route path="/tasks" element={<DashboardPage />} />
        <Route path="/tasks/:id" element={<TaskDetailPage />} />
        <Route path="/search" element={<Navigate to="/" replace />} />
        {/* Dedicated sessions page removed — session deep links open on the
            home page's session columns (the primary surface). */}
        <Route path="/sessions" element={<SessionsRedirect />} />
        <Route path="/memory" element={<MemoryPage />} />
        <Route path="/notes" element={<NotesPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/routines" element={<RoutinesPage />} />
        <Route path="/cron" element={<Navigate to="/routines" replace />} />
        <Route path="/usage" element={<Navigate to="/settings#usage" replace />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/commands" element={<CommandsPage />} />
        <Route path="/skills" element={<SkillsPage />} />
        <Route path="/hooks" element={<Navigate to="/settings#hooks" replace />} />
        <Route path="/repos" element={<Navigate to="/settings#repositories" replace />} />
        <Route path="/timeline" element={<Navigate to="/settings#timeline" replace />} />
        <Route path="/chat" element={<Navigate to="/" replace />} />
        <Route path="/settings" element={<SettingsPage />} />
        {/* Plugin-provided app pages (sandboxed iframes) — must stay above the
            catch-all, which would otherwise bounce them home. */}
        <Route path="/apps/:appId" element={<PluginAppPage />} />
        <Route path="/dashboard" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
