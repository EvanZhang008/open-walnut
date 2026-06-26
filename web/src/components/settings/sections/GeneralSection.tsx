import { useState, useEffect } from 'react';
import type { Config, TaskPriority } from '@open-walnut/core';
import { fetchConfig } from '@/api/config';
import { useAutoSave } from '@/hooks/useAutoSave';
import { SectionCard } from '../inputs/SectionCard';
import { ListEditor } from '../inputs/ListEditor';
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
  { value: '1', label: '1 Panel' },
  { value: '2', label: '2 Panels' },
  { value: 'auto', label: 'Auto' },
];

type BumpTier = 'focus' | 'satellite' | 'wait';
const BUMP_TIERS: BumpTier[] = ['focus', 'satellite', 'wait'];
// Defaults when a tier key is unset: focus off (preserve hand-ordered sprint), others on.
const bumpTierDefault = (tier: BumpTier): boolean => tier !== 'focus';

type BumpTiersState = Record<BumpTier, boolean>;
function resolveBumpTiers(config: Config): BumpTiersState {
  const cfg = config.ui?.bump_tiers;
  return BUMP_TIERS.reduce((acc, tier) => {
    acc[tier] = cfg?.[tier] ?? bumpTierDefault(tier);
    return acc;
  }, {} as BumpTiersState);
}

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
  const [defaultCategory, setDefaultCategory] = useState(config.defaults?.category ?? '');
  const [defaultPlatform, setDefaultPlatform] = useState(config.defaults?.platform ?? 'local');
  const [defaultProject, setDefaultProject] = useState(config.defaults?.project ?? '');
  const [localCategories, setLocalCategories] = useState<string[]>(config.local?.categories ?? []);
  const [bumpTiers, setBumpTiers] = useState<BumpTiersState>(() => resolveBumpTiers(config));

  useEffect(() => {
    setUserName(config.user?.name ?? '');
    setDefaultPriority(config.defaults?.priority ?? 'none');
    setDefaultCategory(config.defaults?.category ?? '');
    setDefaultPlatform(config.defaults?.platform ?? 'local');
    setDefaultProject(config.defaults?.project ?? '');
    setLocalCategories(config.local?.categories ?? []);
    setBumpTiers(resolveBumpTiers(config));
  }, [config]);

  const handleSave = async () => {
    // `ui` has multiple independent writers (e.g. session_panels via useSessionPanelMode),
    // and updateConfig REPLACES the whole `ui` key (not a deep merge). The `config` prop is a
    // page-load snapshot, so spreading config.ui here would clobber sibling keys written since.
    // Re-fetch the latest ui block right before merging our own field into it.
    const latest = await fetchConfig().catch(() => null);
    const baseUi = latest?.ui ?? config.ui;
    await onSave({
      user: { name: userName },
      defaults: {
        priority: defaultPriority,
        category: defaultCategory,
        platform: defaultPlatform,
        ...(defaultProject.trim() ? { project: defaultProject.trim() } : {}),
      },
      local: { ...config.local, categories: localCategories },
      ui: { ...baseUi, bump_tiers: bumpTiers },
    });
  };

  // Auto-save: write when local edits drift from the persisted config. The `baseline` is
  // recomputed from the config prop so a post-save refresh matches `current` and won't echo.
  useAutoSave({
    current: JSON.stringify({ userName, defaultPriority, defaultCategory, defaultPlatform, defaultProject, localCategories, bumpTiers }),
    baseline: JSON.stringify({
      userName: config.user?.name ?? '',
      defaultPriority: config.defaults?.priority ?? 'none',
      defaultCategory: config.defaults?.category ?? '',
      defaultPlatform: config.defaults?.platform ?? 'local',
      defaultProject: config.defaults?.project ?? '',
      localCategories: config.local?.categories ?? [],
      bumpTiers: resolveBumpTiers(config),
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
        <label>Tier visible limits</label>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          {(['focus', 'satellite', 'wait'] as const).map((tier) => (
            <label key={tier} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
              <span style={{ textTransform: 'capitalize' }}>{tier}</span>
              <input
                type="number"
                min={1}
                max={50}
                value={focusBar.tierLimits[tier]}
                onChange={(e) => {
                  const v = Math.max(1, Math.min(50, parseInt(e.target.value, 10) || 1));
                  focusBar.setTierLimits({ ...focusBar.tierLimits, [tier]: v });
                }}
                style={{ width: 52, textAlign: 'center' }}
                data-testid={`tier-limit-${tier}`}
              />
            </label>
          ))}
        </div>
        <p className="text-sm text-muted" style={{ margin: '4px 0 0' }}>
          Max cards visible per tier before scrolling
        </p>
      </div>

      <div className="form-group">
        <label>Move chatted task to top of its tier</label>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
          {BUMP_TIERS.map((tier) => (
            <label key={tier} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={bumpTiers[tier]}
                onChange={(e) => setBumpTiers((prev) => ({ ...prev, [tier]: e.target.checked }))}
                style={{ width: 16, height: 16, accentColor: 'var(--accent)' }}
                data-testid={`bump-tier-${tier}`}
              />
              <span style={{ textTransform: 'capitalize' }}>{tier}</span>
            </label>
          ))}
        </div>
        <p className="text-sm text-muted" style={{ margin: '4px 0 0' }}>
          Chatting with a pinned task bubbles it to the front of its tier. Off for Focus by default to preserve your manual sprint order.
        </p>
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
          Auto adjusts based on screen width
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
          <label htmlFor="settings-category">Default Category</label>
          <input
            id="settings-category"
            type="text"
            value={defaultCategory}
            onChange={(e) => setDefaultCategory(e.target.value)}
            placeholder="e.g., Inbox"
          />
        </div>
      </div>

      <div className="form-row">
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

        <div className="form-group">
          <label htmlFor="settings-project">Default Project <span className="text-muted">(optional)</span></label>
          <input
            id="settings-project"
            type="text"
            value={defaultProject}
            onChange={(e) => setDefaultProject(e.target.value)}
            placeholder="e.g., Inbox"
          />
        </div>
      </div>

      <div className="form-group">
        <label>Local-Only Categories</label>
        <p className="text-sm text-muted" style={{ margin: '-4px 0 4px' }}>
          Categories that are never synced to external services.
        </p>
        <ListEditor
          items={localCategories}
          onChange={setLocalCategories}
          placeholder="Add category..."
        />
      </div>
    </SectionCard>
  );
}
