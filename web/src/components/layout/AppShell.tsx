import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
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
import { useAppCatalog } from '@/apps/hooks';
import { hydrateHostStatus } from '@/hooks/useHostStatus';
import { startHostDismissPruner } from '@/utils/host-banner-dismiss';
import { HostBannerAnnouncer } from '../common/HostBannerAnnouncer';
import { PHONE_LAYOUT_QUERY } from '@/hooks/usePhoneLayout';
import {
  installPhoneOverlayHistory, usePhoneOverlay, usePhoneOverlayEdgeSwipe, isStandaloneDisplay,
} from '@/hooks/usePhoneOverlayHistory';
import { useVisualViewportInset } from '@/hooks/useVisualViewportInset';
import { usePhoneResync } from '@/hooks/usePhoneResync';
import { installStandaloneLinks } from '@/utils/standalone-links';
import { PhoneTopBar } from './PhoneTopBar';
import '@/styles/phone-layout.css';
import '@/styles/phone-fixes.css';
import '@/styles/phone-fixes-r2.css';
import '@/styles/phone-fixes-r3.css';
import '@/styles/phone-session-r3.css';
import '@/styles/phone-pages-r3.css';
import '@/styles/phone-fixes-r4.css';
import { installInputModality } from '@/utils/input-modality';

installInputModality();

interface AppShellProps {
  children: ReactNode;
}

const MOBILE_SIDEBAR_QUERY = PHONE_LAYOUT_QUERY;
/** After the home page's own first-paint fetches, before a human reaches the picker. */
const HOST_STATUS_HYDRATE_DELAY_MS = 1500;
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
  const apps = useAppCatalog();
  const isMainPage = location.pathname === '/';
  const activeApp = apps.findByPath(location.pathname);
  const isFullBleed = activeApp?.fullBleed ?? location.pathname.startsWith('/apps/');
  const focusBar = useFocusBarContext();
  const contentRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();

  // Phone chrome: the back-gesture stack, the keyboard inset, the resync on
  // return, the Home Screen app's edge swipe and its file links.
  useEffect(() => { installPhoneOverlayHistory(); }, []);
  useVisualViewportInset(isMobileSidebar);
  usePhoneResync(isMobileSidebar);
  usePhoneOverlayEdgeSwipe();
  useEffect(() => (isMobileSidebar && isStandaloneDisplay() ? installStandaloneLinks() : undefined), [isMobileSidebar]);

  // The drawer is the first phone layer: back closes it.
  const drawerLayer = usePhoneOverlay({
    id: 'drawer',
    kind: 'drawer',
    open: sidebarOpen && isMobileSidebar,
    bar: null,
    onClose: ({ fromHistory }) => {
      setSidebarOpen(false);
      if (fromHistory) requestAnimationFrame(() => sidebarToggleRef.current?.focus());
    },
  });
  const closeDrawerLayer = drawerLayer.close;

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

  // Remote-host connect status is read once per app load, AFTER the first paint's
  // own fetches (the home page's critical path must not queue behind it), so the
  // folder picker, Settings and the System pane open with the answer already in
  // hand instead of a "checking" state.
  useEffect(() => {
    const timer = setTimeout(() => { void hydrateHostStatus(); }, HOST_STATUS_HYDRATE_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  // Banner dismissals expire on host frames whether or not a card is mounted
  // (the user may sit on /notes the whole time).
  useEffect(() => startHostDismissPruner(), []);

  // Human time tracking: ONE set of document listeners for the whole app
  // lifetime (AppShell wraps every route). Installed once: the pathname is
  // read through a ref so the tracker never captures a stale route.
  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;
  useEffect(() => installTimeTracker({ getPathname: () => pathnameRef.current }), []);

  const toggleSidebar = useCallback(() => {
    if (sidebarOpen && isMobileSidebar) { closeDrawerLayer(); return; }
    setSidebarOpen((prev) => !prev);
  }, [closeDrawerLayer, isMobileSidebar, sidebarOpen]);

  const closeSidebar = useCallback(() => {
    if (isMobileSidebar) closeDrawerLayer();
    else setSidebarOpen(false);
    requestAnimationFrame(() => sidebarToggleRef.current?.focus());
  }, [closeDrawerLayer, isMobileSidebar]);

  // A home panel toggle in the drawer (Ask Walnut, the agenda) opens the next
  // layer: the drawer leaves through history first, and that layer's push
  // waits for it, so back from the panel lands on the page under the drawer.
  const closeSidebarForNavigation = useCallback(() => {
    if (isMobileSidebar) closeDrawerLayer();
    else setSidebarOpen(false);
  }, [closeDrawerLayer, isMobileSidebar]);

  // Drawer links on the phone REPLACE the drawer's history entry, so back from
  // Notes lands on the page the drawer was opened over. Native capture: it runs
  // before React's Link handler, which then sees defaultPrevented and skips its
  // own push; the click still bubbles to Sidebar's onNavigate.
  useEffect(() => {
    const aside = sidebarRef.current;
    if (!aside || !isMobileSidebar) return undefined;
    const onClick = (ev: MouseEvent) => {
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      const a = (ev.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || !aside.contains(a) || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname.startsWith('/api/')) return;
      ev.preventDefault();
      navigate(`${url.pathname}${url.search}${url.hash}`, { replace: true });
      closeDrawerLayer();
    };
    aside.addEventListener('click', onClick, true);
    return () => aside.removeEventListener('click', onClick, true);
  }, [closeDrawerLayer, isMobileSidebar, navigate]);

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
    <div className="app-shell app-shell-navigation">
      {/* The phone's top bar (hidden on wider screens): the drawer's menu button and
          the name of the page on screen. It sits outside <main> so it stays usable
          while the open drawer makes <main> inert, and above the drawer so the same
          button closes it. Every page starts below it, the full-bleed ones too. */}
      {isMobileSidebar && (
        <PhoneTopBar
          pageTitle={activeApp?.title ?? 'Walnut'}
          menuRef={sidebarToggleRef}
          menuExpanded={sidebarOpen}
          onMenu={toggleSidebar}
        />
      )}
      <Sidebar
        asideRef={sidebarRef}
        open={sidebarOpen}
        // The phone drawer always shows its labels: the icon-only rail is a desktop
        // width preference (synced from the desktop), and a drawer has the room.
        collapsed={sidebarCollapsed && !isMobileSidebar}
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
      <HostBannerAnnouncer />
    </div>
  );
}
