import { useState, useEffect } from 'react';
import type { Config } from '@open-walnut/core';
import { useAutoSave } from '@/hooks/useAutoSave';
import { SectionCard } from '../inputs/SectionCard';
import { useTheme, type ThemePreference } from '@/hooks/useTheme';
import { useFocusBarContext } from '@/contexts/FocusBarContext';
import { useSessionPanelMode, type SessionPanelMode } from '@/hooks/useSessionPanelMode';
import { UI_ONLY_CATEGORIES, setShowUiOnlyCategory, type UiOnlyCategory } from '@/hooks/useDeveloperSettings';
import { updateConfig } from '@/api/config';

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

// Read dev settings from localStorage directly (no hook).
// Respects defaultOn — raw localStorage.getItem would treat never-set keys as false.
const getDevChecked = (key: string) => {
  const catDef = UI_ONLY_CATEGORIES.find(c => c.key === key);
  const defaultVal = catDef?.defaultOn ?? false;
  try {
    const stored = localStorage.getItem(`open-walnut:show_ui_only_${key}`);
    if (stored !== null) return stored === 'true';
    return defaultVal;
  } catch { return defaultVal; }
};

const handleToggleUiOnly = async (category: UiOnlyCategory, checked: boolean) => {
  setShowUiOnlyCategory(category, checked);
  try {
    const ds: Record<string, boolean> = {};
    for (const cat of UI_ONLY_CATEGORIES) {
      const key = `show_ui_only_${cat.key.replace(/-/g, '_')}`;
      // Use getDevChecked (respects defaultOn) instead of raw localStorage
      // to avoid zeroing out defaultOn categories that were never explicitly set
      ds[key] = cat.key === category ? checked : getDevChecked(cat.key);
    }
    await updateConfig({ developer: ds } as Partial<Config>);
  } catch {
    setShowUiOnlyCategory(category, !checked);
  }
};

/**
 * Appearance and the person: theme, focus bar, panel count, name, and which
 * background notifications show up in chat. Task defaults live in Tasks.
 */
export function GeneralSection({ config, onSave }: Props) {
  const { theme, setTheme } = useTheme();
  const focusBar = useFocusBarContext();
  const { mode: panelMode, setMode: setPanelMode } = useSessionPanelMode();
  const [userName, setUserName] = useState(config.user?.name ?? '');

  useEffect(() => {
    setUserName(config.user?.name ?? '');
  }, [config]);

  const handleSave = async () => {
    await onSave({ user: { name: userName } });
  };

  // Auto-save: write when local edits drift from the persisted config. The `baseline` is
  // recomputed from the config prop so a post-save refresh matches `current` and won't echo.
  useAutoSave({
    current: JSON.stringify({ userName }),
    baseline: JSON.stringify({ userName: config.user?.name ?? '' }),
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

      {/* Chat Notifications — which background notices show in Ask Walnut. Saves itself
          through handleToggleUiOnly (the `developer` config key); nothing to fingerprint. */}
      <div className="form-group">
        <label>Chat Notifications</label>
        <p className="text-sm text-muted" style={{ margin: '-4px 0 8px' }}>
          Which background notifications appear in chat. Checked = visible.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {UI_ONLY_CATEGORIES.map((cat) => (
            <label key={cat.key} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                defaultChecked={getDevChecked(cat.key)}
                onChange={(e) => handleToggleUiOnly(cat.key, e.target.checked)}
                style={{ width: 16, height: 16, accentColor: 'var(--accent)', flexShrink: 0 }}
              />
              <span>{cat.label}</span>
              <span className="text-sm text-muted" style={{ marginLeft: 4 }}>&mdash; {cat.description}</span>
            </label>
          ))}
        </div>
      </div>
    </SectionCard>
  );
}
