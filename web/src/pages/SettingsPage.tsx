import { useState, useEffect, type FormEvent } from 'react';
import type { Config, TaskPriority } from '@walnut/core';
import { fetchConfig, updateConfig } from '@/api/config';
import { apiGet, apiPut } from '@/api/client';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useTheme, type ThemePreference } from '@/hooks/useTheme';

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** Extract a human-readable label from a Bedrock model ID. */
function modelDisplayName(modelId: string): string {
  const lower = modelId.toLowerCase();
  if (lower.includes('opus') && lower.includes('4-6')) return 'Opus 4.6';
  if (lower.includes('opus') && lower.includes('4-')) return 'Opus 4';
  if (lower.includes('sonnet') && lower.includes('4-6')) return 'Sonnet 4.6';
  if (lower.includes('sonnet') && lower.includes('4-5')) return 'Sonnet 4.5';
  if (lower.includes('sonnet')) return 'Sonnet';
  if (lower.includes('haiku') && lower.includes('4-5')) return 'Haiku 4.5';
  if (lower.includes('haiku')) return 'Haiku';
  if (lower.includes('opus')) return 'Opus';
  // Fallback: show the raw ID truncated
  return modelId.length > 40 ? modelId.slice(0, 37) + '...' : modelId;
}

export function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Editable fields
  const [userName, setUserName] = useState('');
  const [defaultPriority, setDefaultPriority] = useState<TaskPriority>('none');
  const [defaultCategory, setDefaultCategory] = useState('');
  const [mainModel, setMainModel] = useState('');
  useEffect(() => {
    fetchConfig()
      .then((c) => {
        setConfig(c);
        setUserName(c.user?.name ?? '');
        setDefaultPriority(c.defaults?.priority ?? 'none');
        setDefaultCategory(c.defaults?.category ?? '');
        setMainModel(c.agent?.main_model ?? '');
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!config) return;
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      const newConfig = {
        ...config,
        user: { ...config.user, name: userName },
        defaults: { priority: defaultPriority, category: defaultCategory },
        agent: { ...config.agent, main_model: mainModel || undefined },
      };
      await updateConfig(newConfig);
      setConfig(newConfig as Config);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // ── Heartbeat checklist editor ──
  const [hbContent, setHbContent] = useState('');
  const [hbLoading, setHbLoading] = useState(true);
  const [hbSaving, setHbSaving] = useState(false);
  const [hbError, setHbError] = useState<string | null>(null);
  const [hbSuccess, setHbSuccess] = useState(false);

  useEffect(() => {
    apiGet<{ content: string }>('/api/heartbeat/checklist')
      .then((r) => setHbContent(r.content))
      .catch((e: Error) => setHbError(e.message))
      .finally(() => setHbLoading(false));
  }, []);

  const handleHbSave = async () => {
    setHbSaving(true);
    setHbError(null);
    setHbSuccess(false);
    try {
      await apiPut('/api/heartbeat/checklist', { content: hbContent });
      setHbSuccess(true);
      setTimeout(() => setHbSuccess(false), 3000);
    } catch (err) {
      setHbError((err as Error).message);
    } finally {
      setHbSaving(false);
    }
  };

  if (loading) return <LoadingSpinner />;
  if (!config && error) return <div className="empty-state"><p>Error: {error}</p></div>;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">Configuration and preferences</p>
      </div>

      <div className="card" style={{ maxWidth: 520 }}>
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
      </div>

      <form className="card" onSubmit={handleSave} style={{ maxWidth: 520 }}>
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
              placeholder="e.g., Work"
            />
          </div>
        </div>

        {config?.agent?.available_models && config.agent.available_models.length > 0 && (
          <div className="form-group">
            <label htmlFor="settings-main-model">Main AI Model</label>
            <select
              id="settings-main-model"
              value={mainModel}
              onChange={(e) => setMainModel(e.target.value)}
            >
              {config.agent.available_models.map((id) => (
                <option key={id} value={id}>{modelDisplayName(id)}</option>
              ))}
            </select>
            <p className="text-sm text-muted" style={{ marginTop: 4 }}>
              Model used by the main AI agent for chat and task processing.
            </p>
          </div>
        )}

        {config?.provider && (
          <div className="form-group">
            <label>Provider</label>
            <div className="text-sm text-muted" style={{ padding: '6px 0' }}>
              {config.provider.type}
              {config.provider.model && ` / ${config.provider.model}`}
            </div>
          </div>
        )}

        {config?.ms_todo?.client_id && (
          <div className="form-group">
            <label>MS To-Do Client ID</label>
            <div className="font-mono text-sm text-muted" style={{ padding: '6px 0' }}>
              {config.ms_todo.client_id}
            </div>
          </div>
        )}

        {error && <div className="text-sm" style={{ color: 'var(--error)', marginBottom: 8 }}>Error: {error}</div>}
        {success && <div className="text-sm" style={{ color: 'var(--success)', marginBottom: 8 }}>Settings saved.</div>}

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </form>

      {/* ── Heartbeat Checklist Editor ── */}
      <div className="card" style={{ maxWidth: 520, marginTop: 24 }}>
        <label id="heartbeat-label" htmlFor="heartbeat-editor">
          <h3 style={{ margin: '0 0 4px' }}>Heartbeat Checklist</h3>
        </label>
        <p className="text-sm text-muted" style={{ margin: '0 0 12px' }}>
          HEARTBEAT.md — the AI reads this periodically and acts on unchecked items.
        </p>
        {hbLoading ? (
          <LoadingSpinner />
        ) : (
          <>
            <textarea
              id="heartbeat-editor"
              aria-labelledby="heartbeat-label"
              value={hbContent}
              onChange={(e) => setHbContent(e.target.value)}
              rows={12}
              style={{
                width: '100%',
                fontFamily: 'var(--font-mono, monospace)',
                fontSize: 13,
                resize: 'vertical',
                padding: 8,
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: 'var(--bg-secondary)',
                color: 'var(--text)',
              }}
              placeholder="# Heartbeat Checklist&#10;- [ ] Check pipeline status&#10;- [ ] Review open PRs"
            />
            {hbError && <div className="text-sm" style={{ color: 'var(--error)', marginTop: 8 }}>Error: {hbError}</div>}
            {hbSuccess && <div className="text-sm" style={{ color: 'var(--success)', marginTop: 8 }}>Checklist saved.</div>}
            <div className="form-actions" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={hbSaving}
                onClick={handleHbSave}
              >
                {hbSaving ? 'Saving...' : 'Save Checklist'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
