import { memo, useRef } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import type { NavigateFunction } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { MainPage } from './pages/MainPage';
import { DashboardPage } from './pages/DashboardPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { SearchPage } from './pages/SearchPage';
import { SessionsPage } from './pages/SessionsPage';
import { SettingsPage } from './pages/SettingsPage';
import { CronPage } from './pages/CronPage';
import { UsagePage } from './pages/UsagePage';
import { AgentsPage } from './pages/AgentsPage';
import { CommandsPage } from './pages/CommandsPage';
import { TimelinePage } from './pages/TimelinePage';
import { MemoryPage } from './pages/MemoryPage';

/**
 * Memoized MainPage — only re-renders when `visible` prop changes.
 * Uses React.memo to prevent re-renders from parent route changes.
 */
const StableMainPage = memo(MainPage);

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const isHome = location.pathname === '/';

  // Stable ref for navigate — MainPage reads this ref instead of calling
  // useNavigate() directly, which would cause re-renders on every route change
  // (React Router context updates bypass React.memo).
  const navigateRef = useRef<NavigateFunction>(navigate);
  navigateRef.current = navigate;

  return (
    <AppShell>
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
        <Route path="/search" element={<SearchPage />} />
        <Route path="/sessions" element={<SessionsPage />} />
        <Route path="/memory" element={<MemoryPage />} />
        <Route path="/cron" element={<CronPage />} />
        <Route path="/usage" element={<UsagePage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/commands" element={<CommandsPage />} />
        <Route path="/timeline" element={<TimelinePage />} />
        <Route path="/chat" element={<Navigate to="/" replace />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/dashboard" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
