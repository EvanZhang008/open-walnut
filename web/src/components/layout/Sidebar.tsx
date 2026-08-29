import { useState, useEffect, type RefObject } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { useAudioCapture } from '@/hooks/useAudioCapture';
import { useAppCatalog } from '@/apps/hooks';
import { CalendarIcon, PuzzleIcon } from '@/apps/icons';
import { effectiveAppPlacement, supportsPlacementOverride } from '@/apps/preferences';
import {
  getAppPreferences,
  moveAppPreference,
  resetAppOrder,
  updateAppDisposition,
  updateAppPlacement,
} from '@/apps/store';
import type { RegisteredApp } from '@/apps/registry';
import { useNotifications } from '@/contexts/notifications';
import { NotificationPanel } from '@/components/common/NotificationPanel';
import { VoicePanel } from '@/components/common/VoicePanel';
import { PluginBoundary } from '@/components/common/PluginBoundary';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu';
import { subscribeVoiceStatus, getVoiceStatus, type VoiceStatus } from '@/utils/voice-status';

const SS_CHAT_VISIBLE_KEY = 'open-walnut-home-chat-visible';
const SS_TODO_VISIBLE_KEY = 'open-walnut-home-todo-visible';
const SS_CALENDAR_VISIBLE_KEY = 'open-walnut-home-calendar-visible';

// Home Dock controls stay outside the shared Core, Native Plugin, and Webview App Registry.

interface SidebarProps {
  asideRef: RefObject<HTMLElement | null>;
  open: boolean;
  collapsed: boolean;
  isMobile: boolean;
  onNavigate: () => void;
  onToggleCollapse: () => void;
}

export function Sidebar({
  asideRef,
  open,
  collapsed,
  isMobile,
  onNavigate,
  onToggleCollapse,
}: SidebarProps) {
  const cls = `sidebar${open ? ' open' : ''}${collapsed ? ' collapsed' : ''}`;
  const { hasIssues } = useSystemHealth();
  const apps = useAppCatalog();
  const navigate = useNavigate();
  // overrideLinks: a rail row is an <a> only because SPA routing needs one —
  // "Open Link in New Tab" is not what right-clicking an app icon is for.
  const appMenu = useContextMenu<RegisteredApp>({ overrideLinks: true });
  const audio = useAudioCapture();
  const { notify, attentionCount } = useNotifications();
  const [notifOpen, setNotifOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  // Live voice status (transcribing spinner / failure dot) from any MicButton.
  const [voiceStatus, setVoiceStatusState] = useState<VoiceStatus>(getVoiceStatus());
  useEffect(() => subscribeVoiceStatus(setVoiceStatusState), []);

  // Bridge audio capture errors into the unified toaster. useAudioCapture still
  // owns lastError (it resets recording state + handles the no-WS local failure);
  // here we just mirror it into a toast and immediately clear so the provider
  // owns the lifecycle. Ephemeral — never lands in the feed.
  useEffect(() => {
    if (!audio.lastError) return;
    notify({
      kind: 'audio-error', severity: 'error', title: 'Recording error',
      body: audio.lastError, persistent: false,
      dedupKey: `audio:${audio.lastError}`,
    });
    audio.clearError();
  }, [audio.lastError, audio.clearError, notify]);

  // Panel visibility state — synced from MainPage via custom events
  const [chatVisible, setChatVisible] = useState<boolean>(
    () => sessionStorage.getItem(SS_CHAT_VISIBLE_KEY) !== 'false'
  );
  const [todoVisible, setTodoVisible] = useState<boolean>(
    () => sessionStorage.getItem(SS_TODO_VISIBLE_KEY) !== 'false'
  );
  const [calendarPanelVisible, setCalendarPanelVisible] = useState<boolean>(
    () => sessionStorage.getItem(SS_CALENDAR_VISIBLE_KEY) === 'true'
  );

  useEffect(() => {
    const handleChatVisible = (e: Event) => {
      setChatVisible((e as CustomEvent).detail?.visible ?? true);
    };
    const handleTodoVisible = (e: Event) => {
      setTodoVisible((e as CustomEvent).detail?.visible ?? true);
    };
    const handleCalendarVisible = (e: Event) => {
      setCalendarPanelVisible((e as CustomEvent).detail?.visible ?? false);
    };
    // Clicking a persistent toast's body opens the notification center.
    const handleOpenCenter = () => setNotifOpen(true);
    window.addEventListener('main:chat-visible', handleChatVisible);
    window.addEventListener('main:todo-visible', handleTodoVisible);
    window.addEventListener('main:calendar-visible', handleCalendarVisible);
    window.addEventListener('notification:open-center', handleOpenCenter);
    return () => {
      window.removeEventListener('main:chat-visible', handleChatVisible);
      window.removeEventListener('main:todo-visible', handleTodoVisible);
      window.removeEventListener('main:calendar-visible', handleCalendarVisible);
      window.removeEventListener('notification:open-center', handleOpenCenter);
    };
  }, []);

  const handleToggleChat = () => {
    window.dispatchEvent(new CustomEvent('dock:activate-chat'));
  };
  const handleToggleTodo = () => {
    window.dispatchEvent(new CustomEvent('sidebar:toggle-todo'));
  };
  const handleToggleCalendarPanel = () => {
    window.dispatchEvent(new CustomEvent('sidebar:toggle-calendar'));
  };
  const handleNavClick = (event: React.MouseEvent<HTMLElement>) => {
    if ((event.target as Element).closest('a[href]')) onNavigate();
  };

  /**
   * Right-click on an app icon. The rail is the one surface where "this is in the
   * wrong place" is the obvious thought, and until now the only answer lived in
   * Settings → Plugins (and reordering had no UI at all). Ordering acts on the
   * SIDEBAR list, so "up"/"down" mean what the user sees, and the item is dropped
   * at the ends rather than offered as a no-op.
   *
   * Home and Settings carry lockVisibility (they are how you get back to
   * everything else), so unpin/hide never appear for them — the same rule
   * resolveApps already enforces, spelled out here so the menu can't offer an
   * action that would silently do nothing.
   */
  const buildAppMenu = (app: RegisteredApp): ContextMenuItem[] => {
    const list = apps.sidebar;
    const index = list.findIndex((item) => item.key === app.key);
    const placement = effectiveAppPlacement(app, getAppPreferences());
    return [
      { key: 'title', section: true, label: app.title },
      {
        key: 'up', label: 'Move up', when: index > 0,
        onSelect: () => moveAppPreference(list, app.key, 'up'),
      },
      {
        key: 'down', label: 'Move down', when: index >= 0 && index < list.length - 1,
        onSelect: () => moveAppPreference(list, app.key, 'down'),
      },
      { key: 'reset-order', label: 'Reset sidebar order', onSelect: resetAppOrder },
      { divider: true },
      {
        key: 'placement', label: placement === 'settings' ? 'Move to Sidebar' : 'Move to Settings',
        when: supportsPlacementOverride(app),
        onSelect: () => updateAppPlacement(app.key, placement === 'settings' ? 'sidebar' : 'settings'),
      },
      {
        key: 'unpin', label: 'Unpin from sidebar', when: !app.lockVisibility,
        title: 'Keeps the app reachable by deep link and in Settings',
        onSelect: () => updateAppDisposition(app.key, 'unpinned'),
      },
      {
        key: 'hide', label: 'Hide app', when: !app.lockVisibility, danger: true,
        onSelect: () => updateAppDisposition(app.key, 'hidden'),
      },
      { divider: true },
      { key: 'manage', label: 'Manage apps…', onSelect: () => navigate('/settings') },
    ];
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
    >
      <div className="sidebar-header">
        <button
          className="sidebar-collapse-btn"
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
        {/* Panel toggle buttons */}
        <button
          className={`sidebar-link sidebar-panel-toggle${chatVisible ? ' active' : ''}`}
          onClick={handleToggleChat}
          title={collapsed ? 'Chat' : undefined}
        >
          <ChatBubbleIcon />
          <span className="sidebar-label">Chat</span>
        </button>
        <button
          className={`sidebar-link sidebar-panel-toggle${todoVisible ? ' active' : ''}`}
          onClick={handleToggleTodo}
          title={collapsed ? 'Todo' : undefined}
        >
          <TodoListIcon />
          <span className="sidebar-label">Todo</span>
        </button>
        <button
          className={`sidebar-link sidebar-panel-toggle${calendarPanelVisible ? ' active' : ''}`}
          onClick={handleToggleCalendarPanel}
          title={collapsed ? 'Day agenda' : undefined}
          data-testid="sidebar-toggle-calendar"
        >
          <CalendarIcon />
          <span className="sidebar-label">Agenda</span>
        </button>
        <div className="sidebar-nav-divider" />
        {/* `sidebar`, not `pinned`: an App whose effective placement is 'settings'
            (declared by the App, or moved by the user from its plugin's row in
            Settings → Plugins) has its row in Settings → Manage and never here. */}
        {apps.sidebar.map((app) => {
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
          return (
            <NavLink
              key={`${app.key}:${app.generation}`}
              to={app.path}
              end={app.path === '/'}
              className={navLinkClass}
              title={collapsed ? app.title : undefined}
              data-testid={app.kind === 'core'
                ? `sidebar-core-app-${app.id}`
                : `sidebar-app-${app.kind === 'webview' ? app.id : app.key}`}
              data-app-kind={app.kind}
              onContextMenu={(e) => appMenu.open(e, app)}
            >
              {icon}
              <span className="sidebar-label">{app.title}</span>
              {app.badge === 'dot' ? (
                <span className="notification-badge-dot" />
              ) : typeof app.badge === 'number' && app.badge > 0 ? (
                <span className="notification-badge-count">{app.badge > 99 ? '99+' : app.badge}</span>
              ) : null}
            </NavLink>
          );
        })}
      </nav>

      {/* Notification — bottom area. Recording is started from Settings → Audio
          Capture; only an ACTIVE recording shows here, so the live timer and its
          stop control are never hidden while audio is being captured. */}
      <div className="sidebar-notification-area">
        {audio.available && audio.recording && (
          <button
            className="sidebar-link sidebar-recording-btn recording-active"
            onClick={audio.toggleRecording}
            title={collapsed ? `Recording ${formatDuration(audio.totalDuration)}` : undefined}
            aria-label="Stop recording"
          >
            <RecordingIcon recording loading={false} />
            <span className="sidebar-label">{formatDuration(audio.totalDuration)}</span>
          </button>
        )}
        <button
          className={`sidebar-link sidebar-voice-btn${voiceStatus.transcribing ? ' voice-transcribing' : ''}`}
          onClick={() => setVoiceOpen(!voiceOpen)}
          title={collapsed ? 'Voice history' : undefined}
          aria-label="Voice history"
        >
          <VoiceHistoryIcon transcribing={voiceStatus.transcribing} />
          <span className="sidebar-label">Voice</span>
          {voiceStatus.lastFailed && <span className="notification-badge-dot voice-failed-dot" />}
        </button>
        <button
          className="sidebar-link sidebar-notification-btn"
          onClick={() => setNotifOpen(!notifOpen)}
          title={collapsed ? 'Notifications' : undefined}
          aria-label="Notifications"
        >
          <BellIcon />
          <span className="sidebar-label">Notifications</span>
          {/* Amber count = things waiting on the human (asks + unread letters).
              Errors never badge a number — they read as a diagnosis inside the
              panel, not a permanent red counter on the bell. */}
          {attentionCount > 0 ? (
            <span className="notification-badge-count notification-badge-attention">{attentionCount > 99 ? '99+' : attentionCount}</span>
          ) : hasIssues ? (
            <span className="notification-badge-dot" />
          ) : null}
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

      <NotificationPanel
        open={notifOpen}
        onClose={() => setNotifOpen(false)}
        sidebarCollapsed={collapsed}
      />
      <VoicePanel
        open={voiceOpen}
        onClose={() => setVoiceOpen(false)}
        sidebarCollapsed={collapsed}
      />
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


function ChatBubbleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function TodoListIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  );
}

function VoiceHistoryIcon({ transcribing }: { transcribing: boolean }) {
  // Mic glyph; spins subtly via CSS while a transcription is in flight.
  return (
    <svg
      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round"
      className={transcribing ? 'voice-icon-transcribing' : undefined}
    >
      <rect x="9" y="1" width="6" height="12" rx="3" />
      <path d="M19 10v2a7 7 0 01-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
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
