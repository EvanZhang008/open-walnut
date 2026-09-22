import { useState } from 'react';
import { detectInputClient } from '@/utils/input-latency-monitor';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAppCatalog } from '@/apps/hooks';
import { ContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu';
import { APP_SHORTCUTS_KEY, TASK_SHORTCUTS_KEY, useNavigationPreference } from '@/hooks/useNavigationPreference';

interface Props {
  todoVisible: boolean;
  onToggleTodo: () => void;
  onNotifications: () => void;
  onVoice: () => void;
  attentionCount: number;
  recording: boolean;
  onStopRecording: () => void;
}

export function AppTopBar({ todoVisible, onToggleTodo, onNotifications, onVoice, attentionCount, recording, onStopRecording }: Props) {
  const apps = useAppCatalog();
  const navigate = useNavigate();
  const location = useLocation();
  const [appShortcuts, setAppShortcuts] = useNavigationPreference(APP_SHORTCUTS_KEY);
  const [taskShortcuts, setTaskShortcuts] = useNavigationPreference(TASK_SHORTCUTS_KEY);
  const [menu, setMenu] = useState<{ x: number; y: number; origin: HTMLElement } | null>(null);
  const items: ContextMenuItem[] = [
    ...apps.sidebar.map(app => ({ key: app.key, label: app.title, onSelect: () => navigate(app.path) })),
    { divider: true },
    { key: 'apps', label: `${appShortcuts ? 'Hide' : 'Show'} app shortcuts`, onSelect: () => setAppShortcuts(!appShortcuts) },
    { key: 'tasks', label: `${taskShortcuts ? 'Hide' : 'Show'} task quick views`, onSelect: () => setTaskShortcuts(!taskShortcuts) },
    { key: 'chat', label: 'Toggle Ask Walnut', onSelect: () => { navigate('/'); window.dispatchEvent(new CustomEvent('dock:activate-chat')); } },
    { divider: true },
    { key: 'voice', label: 'Voice history', onSelect: onVoice },
    { key: 'notifications', label: 'Notifications', onSelect: onNotifications },
  ];
  return (
    <header className={`app-topbar${detectInputClient() === 'mac-app' ? ' is-native-mac' : ''}`}>
      <button type="button" className="app-topbar-button app-task-panel-toggle"
        aria-label={todoVisible ? 'Hide task panel' : 'Show task panel'}
        aria-expanded={todoVisible} aria-controls="home-task-navigation"
        onClick={() => { if (location.pathname !== '/') { navigate('/'); if (!todoVisible) onToggleTodo(); } else onToggleTodo(); }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></svg>
      </button>
      <button type="button" className="app-topbar-button app-menu-trigger" aria-label="Walnut menu" aria-haspopup="menu" aria-expanded={!!menu}
        onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: rect.left, y: rect.bottom, origin: event.currentTarget }); }}>
        Walnut <span aria-hidden="true">⌄</span>
      </button>
      {location.pathname !== '/' && <span className="app-topbar-page">{apps.findByPath(location.pathname)?.title}</span>}
      <div className="app-topbar-actions">
        {recording && <button type="button" className="app-topbar-button recording-active" onClick={onStopRecording}>Stop recording</button>}
        <button type="button" className="app-topbar-button" aria-label="Notifications" onClick={onNotifications}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M10 21h4" /></svg>
          {attentionCount > 0 && <span className="app-topbar-count">{attentionCount > 99 ? '99+' : attentionCount}</span>}
        </button>
      </div>
      {menu && <ContextMenu point={menu} items={items} onClose={() => setMenu(null)} returnFocus={menu.origin} ariaLabel="Walnut menu" />}
    </header>
  );
}
