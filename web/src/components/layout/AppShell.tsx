import { useState, useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { TaskUndoProvider } from '@/undo/TaskUndoContext';
import { ShortcutsHelpHost } from '@/keyboard/ShortcutsHelp';
import { KeyboardCommandsHost } from '@/keyboard/KeyboardCommandsHost';
import { useLocation, useNavigate } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { NotificationToaster } from '../common/NotificationToaster';
import { OperationErrorBridge } from '../common/OperationErrorBridge';

import { FocusDock } from '../dock/FocusDock';
import { AppTaskbar } from '@/components/sessions/AppTaskbar';
import { TasksProvider } from '@/contexts/TasksContext';
import { NotificationProvider } from '@/contexts/notifications';
import { FocusBarProvider, useFocusBarContext } from '@/contexts/FocusBarContext';
import { lockScroll, unlockScroll } from '@/hooks/useModalOverlay';
import { perf } from '@/utils/perf-logger';
import { installTimeTracker } from '@/utils/time-tracking';
import { useAppCatalog, useTrackOpenedApp } from '@/apps/hooks';
import { hydrateHostStatus } from '@/hooks/useHostStatus';
import { startHostDismissPruner } from '@/utils/host-banner-dismiss';
import { HostProblemNotices } from '../common/HostProblemNotices';
import { TransferDialogHost } from '../transfer/TransferDialogHost';
import { ContentActionsHost } from '../content/ContentActionsHost';
import { PHONE_LAYOUT_QUERY } from '@/hooks/usePhoneLayout';
import {
  installPhoneOverlayHistory, usePhoneOverlay, usePhoneOverlayEdgeSwipe, isStandaloneDisplay,
} from '@/hooks/usePhoneOverlayHistory';
import { useVisualViewportInset } from '@/hooks/useVisualViewportInset';
import { useConnectionWatch, usePhoneResync } from '@/hooks/usePhoneResync';
import { installStandaloneLinks } from '@/utils/standalone-links';
import { PageTopBar } from './PageTopBar';
import { AwayLine } from './AwayLine';
import { ConnectionLine } from './ConnectionLine';
import { PageSideBar } from './PageSideBar';
import { SIDE_BAR_LAYOUT_EVENT, pageAreaLeft } from './page-side-bar';
import { fullscreenArea } from './fullscreen-area';
import { createLeadSlide, type LeadSlide } from '@/utils/layout-slide';
import { forgetRailWidths, railWidth } from './rail-width';
import { traceInteraction } from '@/utils/interaction-timer';
import { ScratchpadHost } from './ScratchpadHost';
import '@/styles/phone-layout.css';
import '@/styles/phone-fixes.css';
import '@/styles/phone-fixes-r2.css';
import '@/styles/phone-fixes-r3.css';
import '@/styles/phone-session-r3.css';
import '@/styles/phone-pages-r3.css';
import '@/styles/phone-fixes-r4.css';
import { installInputModality } from '@/utils/input-modality';
import { contentAreaStyle } from './content-area-style';
import { isHomePath } from '@/utils/home-path';

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

/** After a layout change (or none): the page stays where its slide has it, then rests. */
function followSlide(leadSlide: LeadSlide, main: HTMLElement | null, shell: HTMLElement | null): void {
  if (!main || !shell) return;
  const slide = leadSlide.land(main);
  if (!slide) { shell.classList.remove('is-sliding'); return; }
  const done = () => { if (!leadSlide.running()) shell.classList.remove('is-sliding'); };
  slide.finished.then(done, done);
}

export function AppShell({ children }: AppShellProps) {
  return (
    <TasksProvider>
      <NotificationProvider>
        <FocusBarProvider>
          <TaskUndoProvider>
            <AppShellInner>{children}</AppShellInner>
            <ShortcutsHelpHost />
            <KeyboardCommandsHost />
          </TaskUndoProvider>
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
  // Home is drawn on its redirect paths too (`/sessions?id=`, `/tasks/:id`: home-path.ts), so it is
  // the app there, full bleed from the first frame: a deep link drew Home inside the page padding
  // until the router reached `/`, then everything on it jumped 24 px up and left.
  const isMainPage = isHomePath(location.pathname);
  const activeApp = apps.findByPath(isMainPage ? '/' : location.pathname);
  // Experiment apps_stay_open: the app on screen stays on the Sidebar until it is closed.
  useTrackOpenedApp(activeApp);
  const isFullBleed = activeApp?.fullBleed ?? location.pathname.startsWith('/apps/');
  const focusBar = useFocusBarContext();
  const contentRef = useRef<HTMLDivElement>(null);
  // Where the page area starts: a full screen panel fills the tab beside the
  // sidebar, and beside the page's Agenda and Scratchpad side bar when it is open,
  // which stays usable like the rail (fullscreen-tab.css reads --fullscreen-left;
  // 0 on a phone). It is the side bar's right edge while it shows, beside the page.
  const mainRef = useRef<HTMLElement>(null);
  // The page's slide under way after a rail toggle (below), ended early when a sheet goes full screen.
  const [leadSlide] = useState(createLeadSlide);
  // The window's one scratchpad editor (ScratchpadHost) mounts with the first wide layout and then
  // stays, through a switch to the phone layout too: unmounting it there ended a save under way and
  // lost the words typed after it. A phone that never was wide never loads it.
  const scratchpadHostSeen = useRef(false);
  if (!isMobileSidebar) scratchpadHostSeen.current = true;
  const scratchpadHostKept = scratchpadHostSeen.current;
  useEffect(() => {
    const main = mainRef.current;
    const area = contentRef.current;
    if (!main || !area) return;
    // Written only while a full screen sheet reads it (fullscreen-area.ts): a custom property
    // on <html> restyles the whole document, 57 to 96 ms a write in the Mac app, and this
    // fires on every frame the page area changes width.
    const unbind = fullscreenArea.bind(() => pageAreaLeft(main), () => leadSlide.settle());
    const moved = () => fullscreenArea.moved();
    const resized = () => { forgetRailWidths(); moved(); };
    const ro = new ResizeObserver(moved);
    ro.observe(main);
    ro.observe(area);
    window.addEventListener('resize', resized);
    window.addEventListener(SIDE_BAR_LAYOUT_EVENT, moved);
    return () => { unbind(); ro.disconnect(); window.removeEventListener('resize', resized); window.removeEventListener(SIDE_BAR_LAYOUT_EVENT, moved); };
  }, [leadSlide]);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();

  // Phone chrome: the back-gesture stack, the keyboard inset, the resync on
  // return, the Home Screen app's edge swipe and its file links.
  useEffect(() => { installPhoneOverlayHistory(); }, []);
  useVisualViewportInset(isMobileSidebar);
  usePhoneResync(isMobileSidebar);
  useConnectionWatch();
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
  // its backdrop across that transition. Only a drawer opened BEFORE the route
  // changed goes: the router commits its location in a transition, so on a slow
  // phone a page (Settings) lands after its URL did, and a drawer opened in that
  // gap closed itself under the finger, or its Back undid the next tap's route
  // (2026-11-02, phone-back-gesture on CI). The drawer records the URL it opened on.
  const drawerOpenedOn = useRef<string | null>(null);
  useEffect(() => { drawerOpenedOn.current = sidebarOpen ? window.location.pathname : null; }, [sidebarOpen]);
  useEffect(() => {
    if (drawerOpenedOn.current !== location.pathname) setSidebarOpen(false);
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

  // The rail's width changes in ONE layout and the page slides to its new place on the
  // compositor (utils/layout-slide.ts). The slide starts at the click and the layout, which
  // holds the main thread for 150 ms and more on a full page, lands under it.
  const shellRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // The phone layout has no rail beside the page: a slide under way ends where it is.
    if (isMobileSidebar) leadSlide.settle();
    followSlide(leadSlide, mainRef.current, shellRef.current);
  }, [sidebarCollapsed, isMobileSidebar, leadSlide]);
  useEffect(() => () => leadSlide.settle(), [leadSlide]);
  // What the toggle reads at the click, without being made again on every render:
  // the layout's state, the layout kind, and what the newest click asked for.
  const collapsedRef = useRef(sidebarCollapsed);
  collapsedRef.current = sidebarCollapsed;
  const mobileRef = useRef(isMobileSidebar);
  mobileRef.current = isMobileSidebar;
  const askedRef = useRef(sidebarCollapsed);
  // The newest click's lead while its layout change is still to come.
  const newestLead = useRef<Animation | null>(null);
  if (!newestLead.current && !leadSlide.running()) askedRef.current = sidebarCollapsed;

  const toggleSidebarCollapse = useCallback(() => {
    // In the log as `[perf] interaction {name: sidebar-toggle, ms}`: the click to the first
    // painted frame, in the build the user runs.
    traceInteraction('sidebar-toggle');
    const main = mainRef.current;
    const shell = shellRef.current;
    const next = !askedRef.current;
    askedRef.current = next;
    const apply = () => {
      newestLead.current = null;
      try {
        localStorage.setItem('open-walnut-sidebar-collapsed', String(next));
      } catch { /* ignore */ }
      if (next !== collapsedRef.current) { setSidebarCollapsed(next); return; }
      // Two clicks before the layout changed: it stays as it is, and the page slides back.
      followSlide(leadSlide, main, shell);
    };
    // A sheet that is full screen is fixed to the window: a transform on the page would
    // carry it along, so the rail snaps under it. The phone's drawer does not move the page.
    const lead = main && shell && !mobileRef.current && !fullscreenArea.inUse()
      ? leadSlide.lead(main, railWidth(shell, next) - railWidth(shell, collapsedRef.current))
      : null;
    if (!lead || !shell) { apply(); return; }
    newestLead.current = lead;
    shell.classList.add('is-sliding');
    // The layout changes once this frame, the slide's first, is on its way to the screen.
    // A newer click has its own turn (or changed the layout at once): this one's is dropped.
    // A lead a full screen sheet ended early still changes the layout.
    requestAnimationFrame(() => window.setTimeout(() => { if (newestLead.current === lead) apply(); }, 0));
  }, [leadSlide]);

  return (
    <div ref={shellRef} className="app-shell app-shell-navigation">
      {/* The phone's top bar (hidden on wider screens): the drawer's menu button and
          the name of the page on screen. It sits outside <main> so it stays usable
          while the open drawer makes <main> inert, and above the drawer so the same
          button closes it. Every page starts below it, the full-bleed ones too. */}
      {isMobileSidebar && (
        <PageTopBar
          pathname={location.pathname}
          app={activeApp}
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
      {/* data-app-path: the app the shell has drawn, the one useTrackOpenedApp records. It trails
          the URL while a navigation renders (the router draws a route in a transition), so a
          browser test waits on it, not on the URL, before it leaves an app (openApp in
          tests/e2e/browser/apps-store-helpers.ts). */}
      <main ref={mainRef} className="main-content" inert={sidebarOpen && isMobileSidebar} data-app-path={activeApp?.path}>
        {/* A host replica's console while the Mac is away (nothing otherwise). */}
        <AwayLine />
        {/* This console's own server is not answering (the phone says it under its top bar). */}
        {!isMobileSidebar && <ConnectionLine />}
        {/* The page and, on its left edge, the Agenda and Scratchpad side bar (PageSideBar):
            any page but Home, which keeps its own column. Not on a phone, where neither pane
            mounts (the rail has no toggle for them there). */}
        <div className="main-content-row">
          {!isMobileSidebar && <PageSideBar />}
          {scratchpadHostKept && <ScratchpadHost />}
          <div
            ref={contentRef}
            className="app-content-area"
            style={contentAreaStyle(isFullBleed)}
          >
            {children}
          </div>
        </div>
        {/* The taskbar of minimized and recent sessions, the same on every page. */}
        <AppTaskbar />
        {!isMainPage && focusBar.visible && <FocusDock focusBar={focusBar} />}
      </main>
      <NotificationToaster />
      <OperationErrorBridge />
      <HostProblemNotices />
      <TransferDialogHost />
      <ContentActionsHost />
    </div>
  );
}
