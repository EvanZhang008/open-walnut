import { Fragment, useState, useEffect, type RefObject } from 'react';
import { setNotificationCenterOpen } from '@/stores/notification-center-open';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { linkTargetFor } from '@/utils/last-location';
import { isPhoneLayout, usePhoneLayout } from '@/hooks/usePhoneLayout';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { useAudioCapture } from '@/hooks/useAudioCapture';
import { useAppActivity, useAppCatalog } from '@/apps/hooks';
import { appPathMatches } from '@/apps/registry';
import { useRailItemsShown } from '@/apps/rail-items';
import { QuickBarRailButton } from '@/components/quickbar/QuickBarRailButton';
import { FocusRailButton } from '@/focus-spaces/FocusRail';
import { useFocusAppModes } from '@/focus-spaces/useFocusApps';
import { AgendaIcon, ChatBubbleIcon, OrgChartIcon, PuzzleIcon, ScratchpadIcon, TaskPanelIcon } from '@/apps/icons';
import {
  hideApp,
  keepAppOnSidebar,
  markAppClosed,
  moveAppPreference,
  resetAppOrder,
  updateAppDisposition,
} from '@/apps/store';
import { useExperimental } from '@/hooks/useExperimental';
import type { RegisteredApp } from '@/apps/registry';
import { useNotifications, attentionHeld, quietLabel, railBadge, railCount, railDot } from '@/contexts/notifications';
import '@/styles/notification-quiet.css';
import { NotificationPanel } from '@/components/common/NotificationPanel';
import { OPEN_CENTER_EVENT } from '@/utils/open-anywhere';
import { PluginBoundary } from '@/components/common/PluginBoundary';
import { SidebarStatusItems } from './SidebarStatusItems';
import { setUpdateNoticeDock } from '@/components/common/update-notice-dock';
import { useLendAppUpdateToasts } from './useAppUpdateActions';
import { useRailPeek } from './useRailPeek';
import { RailItemPill } from './RailItemPill';
import { sideBarPageOf, toggleSideBarPane, usePageSideBar } from './page-side-bar';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu';
import { openAppWindow } from '@/popout/openPopout';
import { buildSidebarAppMenu } from './sidebar-app-menu';
import { bellPresentation } from '@/utils/host-attention';
import { useAttentionDots } from '@/hooks/useAttentionDots';
import { useLocalClaudeRecheck } from '@/utils/local-claude-recheck';
import { hostSettingsHref } from '@/utils/host-settings-nav';
import { HostStatusDot } from '@/components/sessions/path-selector/HostStatusDot';
import { HOME_CHAT_VISIBLE_DEFAULT, readHomeChatVisible, showHomeChatToggle } from '@/pages/home-panel-flags';
import '@/styles/attention-banner.css';
import '@/styles/bell-dot.css';
import '@/styles/phone-pages.css';
import { PhoneNotificationBell } from './PhoneNotificationBell';

// Twins of MainPage's keys: localStorage, so the toggles read the same state the
// page restores after a relaunch (sessionStorage dies with the Mac app's web view).
// The chat's key and its hidden-by-default rule come from the one shared reader.
const LS_TODO_VISIBLE_KEY = 'open-walnut-home-todo-visible';
const LS_CALENDAR_VISIBLE_KEY = 'open-walnut-home-calendar-visible';
const LS_SCRATCHPAD_VISIBLE_KEY = 'open-walnut-home-scratchpad-visible';

// Home Dock controls stay outside the shared Core, Native Plugin, and Webview App Registry.

interface SidebarProps {
  asideRef: RefObject<HTMLElement | null>;
  open: boolean;
  collapsed: boolean;
  isMobile: boolean;
  onNavigate: () => void;
  onToggleCollapse: () => void;
}

/**
 * Pages a phone's drawer leaves out (N2-16): the Tasks dashboard is a two-pane
 * desktop table, and on a phone the home screen IS the task list.
 */
export function isDesktopOnlyApp(app: { kind?: string; path?: string }): boolean {
  return app.kind === 'core' && app.path === '/tasks';
}

export function Sidebar({
  asideRef,
  open,
  collapsed,
  isMobile,
  onNavigate,
  onToggleCollapse,
}: SidebarProps) {
  const { hasIssues, health, loading: healthLoading } = useSystemHealth();
  const apps = useAppCatalog();
  // In a focus space: a plugin App hidden there leaves the rail (focus-spaces/useFocusApps.ts).
  const focusAppModes = useFocusAppModes();
  // Experiment apps_stay_open: apps opened from anywhere, kept here until closed (empty when off).
  const activity = useAppActivity(apps);
  const appsStayOpen = useExperimental('apps_stay_open');
  // Built-in rail entries the user took off the rail on the Apps page (apps/rail-items.ts).
  const railShown = useRailItemsShown();
  const navigate = useNavigate();
  const location = useLocation();
  // A host problem is a notification, never a card on the page: a warn dot on the
  // Settings entry, and the bell carries a dot for hosts or the local Claude Code.
  const { railSettingsDot: hostAttention, bellReason } = useAttentionDots({ pathname: location.pathname, hash: location.hash, health, healthLoading });
  // The sign-in re-check lives here, not in a card: it runs whichever surface is on screen.
  useLocalClaudeRecheck(health, healthLoading);
  // overrideLinks: a rail row is an <a> only because SPA routing needs one:
  // "Open Link in New Tab" is not what right-clicking an app icon is for.
  // ignorePressSelection: WebKit (the Mac app) selects the word under a right-press, and that
  // selection used to hand the gesture to the native menu, so this one never opened on a label.
  const appMenu = useContextMenu<RegisteredApp>({ overrideLinks: true, ignorePressSelection: true });
  const audio = useAudioCapture();
  const { notify, attentionCount, quiet, feed } = useNotifications();
  useLendAppUpdateToasts(notify);
  // Quiet (Do Not Disturb): nothing on the rail asks for attention (quiet-model.ts).
  const quietNow = attentionHeld(quiet);
  const railAttention = railCount(attentionCount, quietNow);
  const [notifOpen, setNotifOpen] = useState(false);
  // The toaster leaves out a permission toast the open panel already shows.
  useEffect(() => { setNotificationCenterOpen(notifOpen); return () => setNotificationCenterOpen(false); }, [notifOpen]);
  const bell = bellPresentation({ reason: bellReason, attentionCount, hasIssues, quiet: quietNow, quietLabel: quietNow ? quietLabel(quiet) : '', collapsed });
  const [statusOpen, setStatusOpen] = useState(false);
  // Collapsed, the icon under the pointer (or keyboard focus) grows out over the page with
  // its name, that one only (useRailPeek, RailItemPill). Panels the rail opens block it.
  const peek = useRailPeek({
    enabled: collapsed && !isMobile,
    blocked: notifOpen || statusOpen,
    hold: appMenu.state !== null,
  });
  const cls = `sidebar${open ? ' open' : ''}${collapsed ? ' collapsed' : ''}`;
  // Bridge audio capture errors into the unified toaster. useAudioCapture still
  // owns lastError (it resets recording state + handles the no-WS local failure);
  // here we just mirror it into a toast and immediately clear so the provider
  // owns the lifecycle. Ephemeral — never lands in the feed.
  useEffect(() => {
    if (!audio.lastError) return;
    notify({
      kind: 'audio-error', toastReason: 'failure', severity: 'error', title: 'Recording error',
      body: audio.lastError, persistent: false,
      dedupKey: `audio:${audio.lastError}`,
    });
    audio.clearError();
  }, [audio.lastError, audio.clearError, notify]);

  // Panel visibility state — synced from MainPage via custom events
  const [chatVisible, setChatVisible] = useState<boolean>(
    () => readHomeChatVisible(localStorage)
  );
  // The Ask Walnut toggle itself: absent until the chat spot has been opened once
  // (home-panel-flags.ts). Flips on the first open and never back within a load.
  const [chatToggleShown, setChatToggleShown] = useState<boolean>(
    () => showHomeChatToggle(localStorage, readHomeChatVisible(localStorage))
  );
  const [todoVisible, setTodoVisible] = useState<boolean>(
    () => localStorage.getItem(LS_TODO_VISIBLE_KEY) !== 'false'
  );
  const [calendarPanelVisible, setCalendarPanelVisible] = useState<boolean>(
    () => localStorage.getItem(LS_CALENDAR_VISIBLE_KEY) === 'true'
  );
  const [scratchpadVisible, setScratchpadVisible] = useState<boolean>(
    () => localStorage.getItem(LS_SCRATCHPAD_VISIBLE_KEY) === 'true'
  );

  useEffect(() => {
    const handleChatVisible = (e: Event) => {
      const visible = (e as CustomEvent).detail?.visible ?? HOME_CHAT_VISIBLE_DEFAULT;
      setChatVisible(visible);
      if (visible) setChatToggleShown(true);
    };
    const handleTodoVisible = (e: Event) => {
      setTodoVisible((e as CustomEvent).detail?.visible ?? true);
    };
    const handleCalendarVisible = (e: Event) => {
      setCalendarPanelVisible((e as CustomEvent).detail?.visible ?? false);
    };
    const handleScratchpadVisible = (e: Event) => {
      setScratchpadVisible((e as CustomEvent).detail?.visible ?? false);
    };
    // Clicking a persistent toast's body opens the notification center.
    const handleOpenCenter = () => { setNotifOpen(true); };
    window.addEventListener('main:chat-visible', handleChatVisible);
    window.addEventListener('main:todo-visible', handleTodoVisible);
    window.addEventListener('main:calendar-visible', handleCalendarVisible);
    window.addEventListener('main:scratchpad-visible', handleScratchpadVisible);
    window.addEventListener(OPEN_CENTER_EVENT, handleOpenCenter);
    return () => {
      window.removeEventListener('main:chat-visible', handleChatVisible);
      window.removeEventListener('main:todo-visible', handleTodoVisible);
      window.removeEventListener('main:calendar-visible', handleCalendarVisible);
      window.removeEventListener('main:scratchpad-visible', handleScratchpadVisible);
      window.removeEventListener(OPEN_CENTER_EVENT, handleOpenCenter);
    };
  }, []);

  // The task panel and Ask Walnut control panels OF the home page: from another route
  // they bring the user home first, and only ever open a panel there, never hide it.
  // Where the tap happens is the URL now, not the route last drawn: the router commits a
  // location in a transition, so right after a drawer link to a slow page (Settings on a
  // phone) it still reads the old one. Read as home, the tap opened the chat over Settings
  // and never went home (2026-11-02, phone-back-gesture on CI).
  const homeToggle = (event: string, visible: boolean) => () => {
    if (window.location.pathname === '/') { window.dispatchEvent(new CustomEvent(event)); return; }
    // On a phone the drawer's own history entry becomes home (like a drawer
    // link), so back from the panel never lands on a stale drawer entry.
    navigate('/', isPhoneLayout() ? { replace: true } : undefined);
    if (!visible) window.dispatchEvent(new CustomEvent(event));
  };
  const handleToggleChat = homeToggle('dock:activate-chat', chatVisible);
  const handleToggleTodo = homeToggle('sidebar:toggle-todo', todoVisible);
  // The Agenda and the Scratchpad open beside the page on screen (PageSideBar), Home's own
  // column on Home: never a trip home. Each page keeps what it has open (page-side-bar.ts).
  const sideBarPage = sideBarPageOf(location.pathname);
  const sideBar = usePageSideBar(sideBarPage);
  const agendaOpen = sideBarPage === null ? calendarPanelVisible : sideBar.view.agenda;
  const scratchpadOpen = sideBarPage === null ? scratchpadVisible : sideBar.view.scratchpad;
  // Where the tap happens is the URL, as for the Home toggles below: right after a rail link
  // to a slow page the drawn route can still be the old one.
  const sideBarToggle = (event: string, pane: 'agenda' | 'scratchpad') => () => {
    const here = sideBarPageOf(window.location.pathname);
    if (here === null) window.dispatchEvent(new CustomEvent(event));
    else toggleSideBarPane(here, pane);
  };
  const handleToggleCalendarPanel = sideBarToggle('sidebar:toggle-calendar', 'agenda');
  const handleToggleScratchpad = sideBarToggle('sidebar:toggle-scratchpad', 'scratchpad');
  // The org is a page of its own (pages/OrgPage.tsx): Main and the project leads.
  const orgActive = location.pathname === '/org';
  const handleOpenOrg = () => {
    if (window.location.pathname !== '/org') navigate('/org', isPhoneLayout() ? { replace: true } : undefined);
  };
  // A phone mounts neither the agenda nor the scratchpad panel (spec 5.1), so
  // their toggles would be controls that do nothing there (N3).
  const phone = usePhoneLayout();
  const homePanelToggles = railShown['home-todo'] || (chatToggleShown && railShown['home-chat']) ? (
    <div className="sidebar-home-panels" role="group" aria-label="Home panels">
      {railShown['home-todo'] && (
      <button
        className={`sidebar-link sidebar-panel-toggle app-task-panel-toggle${todoVisible ? ' active' : ''}`}
        data-choice-exempt="sidebar nav link that shows the Home task panel"
        onClick={handleToggleTodo}
        aria-label={todoVisible ? 'Hide task panel' : 'Show task panel'}
        aria-expanded={todoVisible} aria-controls="home-task-navigation"
      >
        <TaskPanelIcon />
        <span className="sidebar-label">Task panel</span>
      </button>
      )}
      {chatToggleShown && railShown['home-chat'] && (
        <button
          className={`sidebar-link sidebar-panel-toggle${chatVisible ? ' active' : ''}`}
          onClick={handleToggleChat}
          aria-label="Quick question"
        >
          <ChatBubbleIcon />
          <span className="sidebar-label">Quick question</span>
        </button>
      )}
    </div>
  ) : null;
  // The side bars open beside whatever page is on screen, so they are not Home's: their own
  // group, apart from Home's panels, holding only them (Evan, 2026-11-10). A phone mounts
  // neither, so the group is not drawn there.
  const sideBarGroup = !phone && (railShown['home-agenda'] || railShown['home-scratchpad']) ? (
    <div className="sidebar-side-bar-group" role="group" aria-label="Side bars" data-testid="sidebar-side-bar-group">
      <div className="sidebar-group-caption sidebar-label" aria-hidden="true">Side bar</div>
      {railShown['home-agenda'] && (
      <button
        className={`sidebar-link sidebar-panel-toggle${agendaOpen ? ' active' : ''}`}
        onClick={handleToggleCalendarPanel}
        aria-pressed={agendaOpen}
        data-testid="sidebar-toggle-calendar"
      >
        <AgendaIcon />
        <span className="sidebar-label">Agenda</span>
      </button>
      )}
      {railShown['home-scratchpad'] && (
      <button
        className={`sidebar-link sidebar-panel-toggle${scratchpadOpen ? ' active' : ''}`}
        onClick={handleToggleScratchpad}
        aria-pressed={scratchpadOpen}
        data-testid="sidebar-toggle-scratchpad"
      >
        <ScratchpadIcon />
        <span className="sidebar-label">Scratchpad</span>
      </button>
      )}
    </div>
  ) : null;
  // Org is a page, not a Home panel: its own top-level entry, the rail's first row.
  // `sidebar-panel-toggle` only for the button reset and the phone drawer's close-on-tap.
  const orgEntry = (
    <button
      className={`sidebar-link sidebar-panel-toggle sidebar-org-link${orgActive ? ' active' : ''}`}
      onClick={handleOpenOrg}
      aria-label="Org"
      aria-current={orgActive ? 'page' : undefined}
      title="The CEO and your VPs: what each is doing and what needs you"
      data-testid="sidebar-org"
    >
      <OrgChartIcon />
      <span className="sidebar-label">Org</span>
    </button>
  );
  // A home panel toggle counts as navigation too: on a phone the panel it opens
  // (Ask Walnut, the agenda, the scratchpad) is the next screen, and the drawer
  // left open would cover it.
  const handleNavClick = (event: React.MouseEvent<HTMLElement>) => {
    if ((event.target as Element).closest('a[href], .sidebar-panel-toggle')) onNavigate();
  };

  // Right-click on an app icon (sidebar-app-menu.ts says what each row does and when it shows).
  const buildAppMenu = (app: RegisteredApp): ContextMenuItem[] => buildSidebarAppMenu(
    app,
    { sidebar: apps.sidebar, open: activity.open, phone },
    {
      openWindow: (item) => { openAppWindow(item.key); },
      keepOnSidebar: keepAppOnSidebar,
      closeOpen: (item) => closeOpenApp(item),
      move: moveAppPreference,
      resetOrder: resetAppOrder,
      unpin: (item) => updateAppDisposition(item.key, 'unpinned'),
      // The person's own Hide (store.ts hideApp closes it as well). While open apps stay on the
      // Sidebar, hiding the app on screen leaves its page too, like Close.
      hide: (item) => { hideApp(item.key); if (appsStayOpen) leaveIfOnScreen(item); },
      manage: () => navigate('/apps'),
    },
  );

  // One rail row for an app, the same for a Sidebar app and an open one (apps_stay_open).
  const appLink = (app: RegisteredApp) => {
    const Icon = app.icon;
    const icon = Icon ? (
      app.kind === 'native' && app.pluginId ? (
        <PluginBoundary
          pluginId={app.pluginId}
          pluginName={app.pluginName ?? app.title}
          resetKey={app.generation}
          compact
          fallback={<PuzzleIcon />}
        >
          <Icon size={18} />
        </PluginBoundary>
      ) : <Icon size={18} />
    ) : app.iconUrl ? (
      <img src={app.iconUrl} alt="" className="sidebar-app-icon" />
    ) : <PuzzleIcon />;
    // Where the link goes: the section's remembered location (Calendar's
    // view+date, Settings' pane, …), the bare path when there is none. While
    // ON the app the link points at the current URL, so clicking the active
    // icon is a no-op instead of a reset to an older remembered state.
    const onThisApp = app.path !== '/' && appPathMatches(app, location.pathname);
    const hostDot = railDot(hostAttention, quietNow) && app.kind === 'core' && app.path === '/settings';
    const badge = railBadge(app.badge, quietNow);
    const target = app.path === '/' ? '/'
      : onThisApp ? `${location.pathname}${location.search}${location.hash}`
      : hostDot ? hostSettingsHref()
      : linkTargetFor(app.path);
    return (
      <NavLink
        key={`${app.key}:${app.generation}`}
        to={target}
        end={app.path === '/' || app.exactPath}
        className={navLinkClass}
        data-testid={app.kind === 'core'
          ? `sidebar-core-app-${app.id}`
          : `sidebar-app-${app.kind === 'webview' ? app.id : app.key}`}
        data-app-kind={app.kind}
        // The link carries the one name; the dot inside it is decorative.
        {...(hostDot ? { 'aria-label': `${app.title}: remote hosts need attention` } : {})}
        onContextMenu={(e) => appMenu.open(e, app)}
      >
        {icon}
        <span className="sidebar-label">{app.title}</span>
        {hostDot && (
          <HostStatusDot dot={{ kind: 'warn', title: `${app.title}: remote hosts need attention` }} className="sidebar-host-dot" decorative />
        )}
        {badge === 'dot' ? (
          <span className="notification-badge-dot" />
        ) : typeof badge === 'number' && badge > 0 ? (
          <span className="notification-badge-count">{badge > 99 ? '99+' : badge}</span>
        ) : badge && typeof badge === 'object' ? (
          // A status, not a count: muted so it never reads as things to deal with.
          <span className="notification-badge-count notification-badge-muted" data-testid={`sidebar-app-badge-${app.key}`}>{badge.text}</span>
        ) : null}
      </NavLink>
    );
  };

  const openApps = activity.open.filter((app) => !(phone && isDesktopOnlyApp(app)));
  // Closing the app on screen also leaves it: its page with no row would be a page you
  // cannot get back to from the rail. The Apps page keeps it under Recently used.
  const leaveIfOnScreen = (app: RegisteredApp) => {
    if (appPathMatches(app, window.location.pathname)) navigate('/apps');
  };
  const closeOpenApp = (app: RegisteredApp) => {
    markAppClosed(app.key);
    leaveIfOnScreen(app);
  };

  return (
    <aside
      id="primary-sidebar"
      ref={asideRef}
      className={cls}
      role={isMobile ? 'dialog' : undefined}
      aria-label={isMobile ? 'Primary navigation' : undefined}
      aria-modal={isMobile ? open : undefined}
      aria-hidden={isMobile && !open ? true : undefined}
      inert={isMobile && !open}
      {...peek.handlers}
    >
      <div className="sidebar-header">
        <button
          className="btn btn-icon sidebar-collapse-btn"
          onClick={onToggleCollapse}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <HamburgerIcon />
        </button>
        <span className="sidebar-label">
          <WalnutIcon /> Walnut
        </span>
      </div>
      <nav className="sidebar-nav" onClick={handleNavClick}>
        {/* `sidebar`, not `pinned`: an App whose effective placement is 'settings'
            (declared by its plugin, or chosen in an older build) has no row here;
            it opens from the Apps page until the user switches it on there. */}
        {railShown.org && orgEntry}
        {apps.sidebar.filter((app) => !(phone && isDesktopOnlyApp(app)) && !(focusAppModes && app.pluginId && focusAppModes(app.pluginId) === 'off')).map((app) => {
          const link = appLink(app);
          return app.path === '/' ? (
            <Fragment key={`${app.key}:${app.generation}`}>
              <div className="sidebar-home-group">{link}{homePanelToggles}</div>
              {sideBarGroup}
            </Fragment>
          ) : link;
        })}
        {openApps.length > 0 && (
          <div className="sidebar-open-apps" role="group" aria-label="Open apps" data-testid="sidebar-open-apps">
            <div className="sidebar-group-caption sidebar-label" aria-hidden="true">Open</div>
            {openApps.map((app) => (
              <div key={`${app.key}:${app.generation}`} className="sidebar-open-app" data-testid={`sidebar-open-app-${app.key}`}>
                {appLink(app)}
                <button
                  type="button"
                  className="sidebar-open-app-close"
                  onClick={() => closeOpenApp(app)}
                  aria-label={`Close ${app.title}`}
                  title={`Close ${app.title}`}
                  data-testid={`sidebar-open-app-close-${app.key}`}
                >
                  <CloseIcon />
                </button>
              </div>
            ))}
          </div>
        )}
      </nav>

      {/* Notification — bottom area. Recording is started from Settings → Audio
          Capture; only an ACTIVE recording shows here, so the live timer and its
          stop control are never hidden while audio is being captured. */}
      <div className="sidebar-notification-area">
        {audio.available && audio.recording && (
          <button
            className="sidebar-link sidebar-recording-btn recording-active"
            onClick={audio.toggleRecording}
            aria-label="Stop recording"
          >
            <RecordingIcon recording loading={false} />
            <span className="sidebar-label">{formatDuration(audio.totalDuration)}</span>
          </button>
        )}
        {/* The update notice docks here, in the flow, so it covers nothing (StaleBuildPill). */}
        {!isMobile && <div className="sidebar-update-dock" ref={setUpdateNoticeDock} />}
        {/* Plugin status items (a live ring each), above the bell; nothing when none is live.
            Voice lives in Settings > Voice (its recordings included) since 2026-10-26. */}
        <SidebarStatusItems onOpenChange={setStatusOpen} />
        {/* The focus the person is in, or Focus (experiment focus_workspace). */}
        <FocusRailButton />
        {/* A tool, not a page: with the bell, right above it (2026-11-20, the user), never at the top. */}
        <QuickBarRailButton />
        <button
          className="sidebar-link sidebar-notification-btn"
          onClick={() => setNotifOpen(!notifOpen)}
          // Quiet mode: the one visible trace is a moon on the bell and a tooltip
          // naming who holds quiet; no count or dot until it ends (quiet-model.ts).
          title={bell.title}
          aria-label={bell.ariaLabel}
          {...(quietNow ? { 'data-quiet': 'true' } : {})}
        >
          <BellIcon />
          {quietNow && <span className="quiet-moon" aria-hidden="true">☾</span>}
          <span className="sidebar-label">Notifications</span>
          {/* Amber count = things waiting on the human (asks + unread letters).
              Errors never badge a number: they read as a diagnosis inside the
              panel, not a permanent red counter on the bell. */}
          {railAttention > 0 && (
            <span className="notification-badge-count notification-badge-attention">{railAttention > 99 ? '99+' : railAttention}</span>
          )}
          {/* A host or Claude Code reason wears the rail Settings entry's warn look; the older system dot keeps its own. */}
          {(bell.dot || bell.cornerDot) && (
            <span className={`notification-badge-dot${bell.cornerDot ? ' is-corner' : ''}${bell.dotKind === 'attention' ? ' is-host-warn' : ''}`} />
          )}
        </button>
      </div>

      {appMenu.state && (
        <ContextMenu
          point={appMenu.state.point}
          items={buildAppMenu(appMenu.state.payload)}
          onClose={appMenu.close}
          ariaLabel={`${appMenu.state.payload.title} app actions`}
          testId="sidebar-app-ctx-menu"
        />
      )}

      {/* Phone: the bell lives in the top bar (portalled), the drawer keeps its own. */}
      {/* One count rule (C55, N2-05): the bar's bell says the drawer row's number. */}
      <PhoneNotificationBell count={railAttention} open={notifOpen} onOpen={() => setNotifOpen(true)} />
      <NotificationPanel
        open={notifOpen}
        onClose={() => setNotifOpen(false)}
        sidebarCollapsed={collapsed}
      />
      {peek.item && <RailItemPill item={peek.item} grow={peek.grow} handlers={peek.pillHandlers} onGone={peek.pillGone} />}
    </aside>
  );
}

function navLinkClass({ isActive }: { isActive: boolean }) {
  return `sidebar-link${isActive ? ' active' : ''}`;
}

/* Inline SVG icons */

function WalnutIcon() {
  return (
    <img src="/walnut-icon.png" alt="Walnut" className="sidebar-open-walnut-icon" />
  );
}

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function HamburgerIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}


function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M7 7l10 10M17 7L7 17" />
    </svg>
  );
}

function RecordingIcon({ recording, loading }: { recording: boolean; loading?: boolean }) {
  const fill = loading ? 'var(--fg-muted)' : recording ? 'var(--error)' : 'none';
  const stroke = loading ? 'var(--fg-muted)' : recording ? 'var(--error)' : 'currentColor';
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="6" fill={fill} stroke={stroke} />
      <circle cx="12" cy="12" r="10" />
    </svg>
  );
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
