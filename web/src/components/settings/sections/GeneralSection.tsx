import { useState, useEffect } from 'react';
import type { Config, TaskPriority } from '@open-walnut/core';
import { useAutoSave } from '@/hooks/useAutoSave';
import { SectionCard } from '../inputs/SectionCard';
import { useTheme, type ThemePreference } from '@/hooks/useTheme';
import { useFocusBarContext } from '@/contexts/FocusBarContext';
import { useSessionPanelMode, type SessionPanelMode } from '@/hooks/useSessionPanelMode';
import { useIntegrations } from '@/hooks/useIntegrations';

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const PANEL_OPTIONS: { value: SessionPanelMode; label: string }[] = [
  { value: '1', label: '1' },
  { value: '2', label: '2' },
  { value: '3', label: '3' },
  { value: '4', label: '4' },
  { value: '5', label: '5' },
  { value: 'auto', label: 'Auto' },
];

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

export function GeneralSection({ config, onSave }: Props) {
  const { theme, setTheme } = useTheme();
  const focusBar = useFocusBarContext();
  const { mode: panelMode, setMode: setPanelMode } = useSessionPanelMode();
  const integrations = useIntegrations();
  const [userName, setUserName] = useState(config.user?.name ?? '');
  const [defaultPriority, setDefaultPriority] = useState<TaskPriority>(config.defaults?.priority ?? 'none');
  const [defaultPlatform, setDefaultPlatform] = useState(config.defaults?.platform ?? 'local');
  const [defaultProject, setDefaultProject] = useState(config.defaults?.project ?? '');

  useEffect(() => {
    setUserName(config.user?.name ?? '');
    setDefaultPriority(config.defaults?.priority ?? 'none');
    setDefaultPlatform(config.defaults?.platform ?? 'local');
    setDefaultProject(config.defaults?.project ?? '');
  }, [config]);

  const handleSave = async () => {
    await onSave({
      user: { name: userName },
      defaults: {
        priority: defaultPriority,
        platform: defaultPlatform,
        // Empty = Inbox. Never persist a literal "Inbox" — that would create a real project.
        ...(defaultProject.trim() ? { project: defaultProject.trim() } : {}),
      },
    });
  };

  // Auto-save: write when local edits drift from the persisted config. The `baseline` is
  // recomputed from the config prop so a post-save refresh matches `current` and won't echo.
  useAutoSave({
    current: JSON.stringify({ userName, defaultPriority, defaultPlatform, defaultProject }),
    baseline: JSON.stringify({
      userName: config.user?.name ?? '',
      defaultPriority: config.defaults?.priority ?? 'none',
      defaultPlatform: config.defaults?.platform ?? 'local',
      defaultProject: config.defaults?.project ?? '',
    }),
    save: handleSave,
  });

  return (
    <SectionCard id="general" title="General" description="Changes save automatically." onSave={handleSave} showSave={false}>
      <div className="form-group">
        <label>Theme</label>
        <div className="theme-picker">
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`theme-picker-btn${theme === opt.value ? ' active' : ''}`}
              onClick={() => setTheme(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="form-group">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={focusBar.visible}
            onChange={(e) => focusBar.setVisible(e.target.checked)}
            style={{ width: 16, height: 16, accentColor: 'var(--accent)' }}
          />
          Show Focus Bar
          <span className="text-sm text-muted" style={{ marginLeft: 4 }}>&mdash; pinned task dock at the bottom</span>
        </label>
      </div>

      <div className="form-group">
        <label>Session Panels</label>
        <div className="theme-picker">
          {PANEL_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`theme-picker-btn${panelMode === opt.value ? ' active' : ''}`}
              onClick={() => setPanelMode(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className="text-sm text-muted" style={{ margin: '4px 0 0' }}>
          How many sessions sit side by side. Auto adjusts based on screen width; more
          panels means narrower columns &mdash; each one is a live session.
        </p>
      </div>

      <div className="form-group">
        <label htmlFor="settings-name">User Name</label>
        <input
          id="settings-name"
          type="text"
          value={userName}
          onChange={(e) => setUserName(e.target.value)}
          placeholder="Your name"
        />
      </div>

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="settings-priority">Default Priority</label>
          <select
            id="settings-priority"
            value={defaultPriority}
            onChange={(e) => setDefaultPriority(e.target.value as TaskPriority)}
          >
            <option value="none">None (untriaged)</option>
            <option value="backlog">Backlog</option>
            <option value="important">Important</option>
            <option value="immediate">Immediate</option>
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="settings-project">Default Project <span className="text-muted">(optional)</span></label>
          <input
            id="settings-project"
            type="text"
            value={defaultProject}
            onChange={(e) => setDefaultProject(e.target.value)}
            placeholder="Leave empty for Inbox"
          />
          <p className="text-sm text-muted" style={{ margin: '4px 0 0' }}>
            Where new tasks land when no project is given. Empty means Inbox.
          </p>
        </div>
      </div>

      <div className="form-group">
        <label htmlFor="settings-platform">Default Platform</label>
        <select
          id="settings-platform"
          value={defaultPlatform}
          onChange={(e) => setDefaultPlatform(e.target.value)}
        >
          <option value="local">Local (this device — instant)</option>
          {integrations.map((i) => (
            <option key={i.id} value={i.id}>{i.name}</option>
          ))}
        </select>
        <p className="text-sm text-muted" style={{ margin: '4px 0 0' }}>
          Where new tasks from quick-add (&ldquo;Add to Focus&rdquo;) are created. Local is
          instant and never synced; pick an external service to sync new captures there.
        </p>
      </div>
    </SectionCard>
  );
}
