import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { NotificationToaster } from '../common/NotificationToaster';
import { OperationErrorBridge } from '../common/OperationErrorBridge';

import { FocusDock } from '../dock/FocusDock';
import { TasksProvider } from '@/contexts/TasksContext';
import { NotificationProvider } from '@/contexts/notifications';
import { FocusBarProvider, useFocusBarContext } from '@/contexts/FocusBarContext';
import { lockScroll, unlockScroll } from '@/hooks/useModalOverlay';
import { perf } from '@/utils/perf-logger';
import { installTimeTracker } from '@/utils/time-tracking';

interface AppShellProps {
  children: ReactNode;
}

const MOBILE_SIDEBAR_QUERY = '(max-width: 768px)';
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

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
  const [isMobileSidebar, setIsMobileSidebar] = useState(
    () => window.matchMedia(MOBILE_SIDEBAR_QUERY).matches,
  );
  const location = useLocation();
  const isMainPage = location.pathname === '/';
  // Full-bleed pages own their whole canvas (multi-pane layouts with internal
  // scrolling) — no content-area padding, no outer scrollbar. Everything else
  // keeps the default 24px page gutter.
  const isFullBleed = isMainPage
    || location.pathname.startsWith('/notes')
    // A plugin app owns its whole canvas — the iframe fills the content area.
    || location.pathname.startsWith('/apps');
  const focusBar = useFocusBarContext();
  const contentRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);

  // A route owns the next screen. Never carry the mobile navigation modal or
  // its backdrop across that transition.
  useEffect(() => {
    setSidebarOpen(false);
    if (!isMainPage && contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
  }, [location.pathname, isMainPage]);

  useEffect(() => {
    const media = window.matchMedia(MOBILE_SIDEBAR_QUERY);
    const handleChange = () => {
      setIsMobileSidebar(media.matches);
      if (!media.matches) setSidebarOpen(false);
    };
    handleChange();
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  // Print perf waterfall 3s after mount (all initial fetches should be settled)
  useEffect(() => {
    const timer = setTimeout(() => perf.summary(), 3000);
    return () => clearTimeout(timer);
  }, []);

  // Human time tracking: ONE set of document listeners for the whole app
  // lifetime (AppShell wraps every route). Installed once — the pathname is
  // read through a ref so the tracker never captures a stale route.
  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;
  useEffect(() => installTimeTracker({ getPathname: () => pathnameRef.current }), []);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
    requestAnimationFrame(() => sidebarToggleRef.current?.focus());
  }, []);

  const closeSidebarForNavigation = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  useEffect(() => {
    if (!sidebarOpen || !isMobileSidebar) return;

    lockScroll();
    const focusFrame = requestAnimationFrame(() => {
      const currentLink = sidebarRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
      const firstControl = sidebarRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (currentLink ?? firstControl)?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeSidebar();
        return;
      }
      if (event.key !== 'Tab') return;

      const sidebarControls = sidebarRef.current
        ? [...sidebarRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
          .filter((element) => element.getClientRects().length > 0)
        : [];
      const controls = [sidebarToggleRef.current, ...sidebarControls]
        .filter((element): element is HTMLElement => element !== null);
      if (controls.length === 0) return;

      const activeIndex = controls.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.shiftKey
        ? (activeIndex <= 0 ? controls.length - 1 : activeIndex - 1)
        : (activeIndex === controls.length - 1 ? 0 : activeIndex + 1);
      if (activeIndex === -1 || nextIndex === activeIndex) return;
      event.preventDefault();
      controls[nextIndex]?.focus();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown);
      unlockScroll();
    };
  }, [closeSidebar, isMobileSidebar, sidebarOpen]);

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
      <button
        ref={sidebarToggleRef}
        className="sidebar-toggle"
        onClick={toggleSidebar}
        aria-label="Toggle sidebar"
        aria-controls="primary-sidebar"
        aria-expanded={isMobileSidebar ? sidebarOpen : undefined}
      >
        &#9776;
      </button>
      <Sidebar
        asideRef={sidebarRef}
        open={sidebarOpen}
        collapsed={sidebarCollapsed}
        isMobile={isMobileSidebar}
        onNavigate={closeSidebarForNavigation}
        onToggleCollapse={toggleSidebarCollapse}
      />
      {sidebarOpen && isMobileSidebar && (
        <button
          type="button"
          className="sidebar-overlay"
          onClick={closeSidebar}
          aria-label="Close navigation"
          tabIndex={-1}
        />
      )}
      <main className="main-content" inert={sidebarOpen && isMobileSidebar}>
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
