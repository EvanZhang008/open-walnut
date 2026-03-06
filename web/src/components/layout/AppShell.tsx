import { useState, useCallback, useEffect, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { CronToast } from '../common/CronToast';
import { DataSafetyBanner } from '../common/DataSafetyBanner';
import { FocusDock } from '../dock/FocusDock';
import { TasksProvider } from '@/contexts/TasksContext';
import { FocusBarProvider, useFocusBarContext } from '@/contexts/FocusBarContext';
import { perf } from '@/utils/perf-logger';

interface AppShellProps {
  children: ReactNode;
}

function readCollapsed(): boolean {
  try {
    // Default to collapsed when no preference stored (first visit)
    return localStorage.getItem('walnut-sidebar-collapsed') !== 'false';
  } catch {
    return true;
  }
}

export function AppShell({ children }: AppShellProps) {
  return (
    <TasksProvider>
      <FocusBarProvider>
        <AppShellInner>{children}</AppShellInner>
      </FocusBarProvider>
    </TasksProvider>
  );
}

function AppShellInner({ children }: AppShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readCollapsed);
  const location = useLocation();
  const isMainPage = location.pathname === '/';
  const focusBar = useFocusBarContext();

  // Print perf waterfall 3s after mount (all initial fetches should be settled)
  useEffect(() => {
    const timer = setTimeout(() => perf.summary(), 3000);
    return () => clearTimeout(timer);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  const toggleSidebarCollapse = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('walnut-sidebar-collapsed', String(next));
      } catch { /* ignore */ }
      return next;
    });
  }, []);

  return (
    <div className="app-shell">
      <DataSafetyBanner />
      <button className="sidebar-toggle" onClick={toggleSidebar} aria-label="Toggle sidebar">
        &#9776;
      </button>
      <Sidebar
        open={sidebarOpen}
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleSidebarCollapse}
      />
      {sidebarOpen && <div className="sidebar-overlay" onClick={closeSidebar} />}
      <main className="main-content">
        <div
          className="app-content-area"
          style={isMainPage ? { padding: 0, overflow: 'hidden' } : undefined}
        >
          {children}
        </div>
        <FocusDock focusBar={focusBar} />
      </main>
      <CronToast />
    </div>
  );
}
