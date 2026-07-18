import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { NotificationToaster } from '../common/NotificationToaster';
import { OperationErrorBridge } from '../common/OperationErrorBridge';

import { FocusDock } from '../dock/FocusDock';
import { TasksProvider } from '@/contexts/TasksContext';
import { NotificationProvider } from '@/contexts/notifications';
import { FocusBarProvider, useFocusBarContext } from '@/contexts/FocusBarContext';
import { perf } from '@/utils/perf-logger';

interface AppShellProps {
  children: ReactNode;
}

function readCollapsed(): boolean {
  try {
    // Default to collapsed when no preference stored (first visit)
    return localStorage.getItem('open-walnut-sidebar-collapsed') !== 'false';
  } catch {
    return true;
  }
}

export function AppShell({ children }: AppShellProps) {
  return (
    <TasksProvider>
      <NotificationProvider>
        <FocusBarProvider>
          <AppShellInner>{children}</AppShellInner>
        </FocusBarProvider>
      </NotificationProvider>
    </TasksProvider>
  );
}

function AppShellInner({ children }: AppShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readCollapsed);
  const location = useLocation();
  const isMainPage = location.pathname === '/';
  // Full-bleed pages own their whole canvas (multi-pane layouts with internal
  // scrolling) — no content-area padding, no outer scrollbar. Everything else
  // keeps the default 24px page gutter.
  const isFullBleed = isMainPage || location.pathname.startsWith('/notes');
  const focusBar = useFocusBarContext();
  const contentRef = useRef<HTMLDivElement>(null);

  // Scroll content area to top on route change (non-home pages)
  useEffect(() => {
    if (!isMainPage && contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
  }, [location.pathname, isMainPage]);

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
        localStorage.setItem('open-walnut-sidebar-collapsed', String(next));
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
      <main className="main-content">
        <div
          ref={contentRef}
          className="app-content-area"
          style={isFullBleed ? { padding: 0, overflow: 'hidden' } : undefined}
        >
          {children}
        </div>
        {!isMainPage && focusBar.visible && <FocusDock focusBar={focusBar} />}
      </main>
      <NotificationToaster />
      <OperationErrorBridge />
    </div>
  );
}
