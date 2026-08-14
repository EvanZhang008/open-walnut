import { useState, useEffect, type RefObject } from 'react';
import { NavLink } from 'react-router-dom';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { useAudioCapture } from '@/hooks/useAudioCapture';
import { useNotifications } from '@/contexts/notifications';
import { NotificationPanel } from '@/components/common/NotificationPanel';
import { VoicePanel } from '@/components/common/VoicePanel';
import { subscribeVoiceStatus, getVoiceStatus, type VoiceStatus } from '@/utils/voice-status';

const SS_CHAT_VISIBLE_KEY = 'open-walnut-home-chat-visible';
const SS_TODO_VISIBLE_KEY = 'open-walnut-home-todo-visible';
const SS_CALENDAR_VISIBLE_KEY = 'open-walnut-home-calendar-visible';

// The sidebar carries ONLY the daily surfaces (panels + Home/Tasks/Notes/Calendar/
// Routines) plus Settings. Management pages (Agents, Skills, Commands, Memory,
// Repositories, Hooks) and audio recording live in the Settings sidebar's Manage
// group / Audio Capture, so this list can never grow back into an icon wall.

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
  const audio = useAudioCapture();
  const { notify, unreadCount } = useNotifications();
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
        <NavLink to="/" end className={navLinkClass} title={collapsed ? 'Home' : undefined}>
          <HomeIcon />
          <span className="sidebar-label">Home</span>
        </NavLink>
        <NavLink to="/tasks" className={navLinkClass} title={collapsed ? 'Tasks' : undefined}>
          <TasksIcon />
          <span className="sidebar-label">Tasks</span>
        </NavLink>
        <NavLink to="/notes" className={navLinkClass} title={collapsed ? 'Notes' : undefined}>
          <NotesIcon />
          <span className="sidebar-label">Notes</span>
        </NavLink>
        <NavLink to="/calendar" className={navLinkClass} title={collapsed ? 'Calendar' : undefined}>
          <CalendarIcon />
          <span className="sidebar-label">Calendar</span>
        </NavLink>

        <NavLink to="/routines" className={navLinkClass} title={collapsed ? 'Routines' : undefined}>
          <ScheduleIcon />
          <span className="sidebar-label">Routines</span>
        </NavLink>

        <NavLink to="/settings" className={navLinkClass} title={collapsed ? 'Settings' : undefined}>
          <SettingsIcon />
          <span className="sidebar-label">Settings</span>
        </NavLink>
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
          {unreadCount > 0 ? (
            <span className="notification-badge-count">{unreadCount > 99 ? '99+' : unreadCount}</span>
          ) : hasIssues ? (
            <span className="notification-badge-dot" />
          ) : null}
        </button>
      </div>

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

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

function TasksIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  );
}


function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function ScheduleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}


function NotesIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

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
