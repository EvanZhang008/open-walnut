import { useState, useCallback, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { CronToast } from '../common/CronToast';

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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readCollapsed);
  const location = useLocation();
  const isMainPage = location.pathname === '/';

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
      <button className="sidebar-toggle" onClick={toggleSidebar} aria-label="Toggle sidebar">
        &#9776;
      </button>
      <Sidebar
        open={sidebarOpen}
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleSidebarCollapse}
      />
      {sidebarOpen && <div className="sidebar-overlay" onClick={closeSidebar} />}
      <main
        className="main-content"
        style={isMainPage ? { padding: 0, overflow: 'hidden' } : undefined}
      >
        {children}
      </main>
      <CronToast />
    </div>
  );
}
