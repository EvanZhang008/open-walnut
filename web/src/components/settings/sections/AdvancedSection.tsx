import { useState, useEffect } from 'react';
import type { Config } from '@walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { NumberInput } from '../inputs/NumberInput';
import { ListEditor } from '../inputs/ListEditor';
import { apiGet, apiPost, apiDelete } from '@/api/client';
import { UI_ONLY_CATEGORIES, setShowUiOnlyCategory, type UiOnlyCategory } from '@/hooks/useDeveloperSettings';
import { updateConfig } from '@/api/config';

interface ApiKeyEntry { name: string; key: string; created_at: string; }
interface Props { config: Config; onSave: (partial: Partial<Config>) => Promise<void>; }

// Helper: safely read from config, never return undefined/null for state init
function initGit(c: Config) {
  const g = c.git_versioning ?? {};
  return {
    enabled: g.enabled !== false,
    push: g.push_enabled === true,
    debounce: g.commit_debounce_ms ?? 30000,
    interval: g.push_interval_ms ?? 600000,
  };
}

function initExec(c: Config) {
  const e = c.tools?.exec ?? {};
  return {
    deny: Array.isArray(e.deny) ? e.deny : [],
    allow: Array.isArray(e.allow) ? e.allow : [],
    timeout: typeof e.timeout === 'number' ? e.timeout : NaN,
    maxOutput: typeof e.max_output === 'number' ? e.max_output : NaN,
  };
}

function initSub(c: Config) {
  const s = c.agent?.subagent ?? {};
  return {
    model: String(s.model ?? ''),
    maxConcurrent: typeof s.max_concurrent === 'number' ? s.max_concurrent : NaN,
    maxRounds: typeof s.max_tool_rounds === 'number' ? s.max_tool_rounds : NaN,
    denied: Array.isArray(s.denied_tools) ? s.denied_tools : [],
  };
}

export function AdvancedSection({ config, onSave }: Props) {
  // Use concrete initial values — never undefined (React 19 crashes on undefined state diffs)
  const [git, setGit] = useState(() => initGit(config));
  const [exec, setExec] = useState(() => initExec(config));
  const [sub, setSub] = useState(() => initSub(config));
  const [apiKeys, setApiKeys] = useState<ApiKeyEntry[]>([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    setGit(initGit(config));
    setExec(initExec(config));
    setSub(initSub(config));
  }, [config]);

  useEffect(() => {
    apiGet<{ keys: ApiKeyEntry[] }>('/api/auth/keys')
      .then((r) => setApiKeys(r.keys ?? []))
      .catch(() => {});
  }, []);

  // Developer toggles — read directly from localStorage (no useSyncExternalStore)
  const readDevSettings = () => {
    const result: Record<string, boolean> = {};
    for (const cat of UI_ONLY_CATEGORIES) {
      try { result[cat.key] = localStorage.getItem(`walnut:show_ui_only_${cat.key}`) === 'true'; }
      catch { result[cat.key] = false; }
    }
    return result;
  };
  const [devSettings, setDevSettings] = useState(readDevSettings);

  const handleToggleUiOnly = async (category: UiOnlyCategory, checked: boolean) => {
    setShowUiOnlyCategory(category, checked);
    setDevSettings((prev) => ({ ...prev, [category]: checked }));
    try {
      const ds: Record<string, boolean> = {};
      const current = readDevSettings();
      for (const cat of UI_ONLY_CATEGORIES) {
        ds[`show_ui_only_${cat.key.replace(/-/g, '_')}`] = cat.key === category ? checked : current[cat.key];
      }
      await updateConfig({ developer: ds } as Partial<Config>);
    } catch {
      setShowUiOnlyCategory(category, !checked);
      setDevSettings((prev) => ({ ...prev, [category]: !checked }));
    }
  };

  const handleSave = async () => {
    const numOrUndef = (v: number) => isNaN(v) ? undefined : v;
    await onSave({
      git_versioning: {
        enabled: git.enabled, push_enabled: git.push,
        commit_debounce_ms: git.debounce, push_interval_ms: git.interval,
      },
      tools: {
        ...config.tools,
        exec: {
          ...config.tools?.exec,
          deny: exec.deny.length ? exec.deny : undefined,
          allow: exec.allow.length ? exec.allow : undefined,
          timeout: numOrUndef(exec.timeout), max_output: numOrUndef(exec.maxOutput),
        },
      },
      agent: {
        ...config.agent,
        subagent: {
          ...config.agent?.subagent,
          model: sub.model || undefined,
          max_concurrent: numOrUndef(sub.maxConcurrent), max_tool_rounds: numOrUndef(sub.maxRounds),
          denied_tools: sub.denied.length ? sub.denied : undefined,
        },
      },
    });
  };

  const handleCreateKey = async () => {
    if (!newKeyName.trim()) return;
    try {
      const result = await apiPost<{ name: string; key: string }>('/api/auth/keys', { name: newKeyName.trim() });
      setApiKeys((prev) => [...prev, { ...result, created_at: new Date().toISOString() }]);
      setNewKeyName('');
    } catch { /* silently fail */ }
  };

  const handleDeleteKey = async (name: string) => {
    try {
      await apiDelete(`/api/auth/keys/${encodeURIComponent(name)}`);
      setApiKeys((prev) => prev.filter((k) => k.name !== name));
    } catch { /* silently fail */ }
  };

  return (
    <SectionCard id="advanced" title="Advanced" description="Git versioning, exec security, subagent defaults, API keys, developer options." onSave={handleSave}>
      {/* Git Versioning */}
      <details className="settings-collapsible" open>
        <summary className="settings-collapsible-title">Git Versioning</summary>
        <div className="settings-collapsible-body">
          <div className="form-group">
            <ToggleSwitch id="git-enabled" checked={git.enabled} onChange={(v) => setGit((p) => ({ ...p, enabled: v }))} label="Enable Git Auto-Commit" />
          </div>
          <div className="form-group">
            <ToggleSwitch id="git-push" checked={git.push} onChange={(v) => setGit((p) => ({ ...p, push: v }))} label="Enable Push to Remote" />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="git-debounce">Commit Debounce</label>
              <NumberInput id="git-debounce" value={git.debounce} onChange={(v) => setGit((p) => ({ ...p, debounce: v ?? 30000 }))} suffix="ms" placeholder="30000" min={1000} />
            </div>
            <div className="form-group">
              <label htmlFor="git-interval">Push Interval</label>
              <NumberInput id="git-interval" value={git.interval} onChange={(v) => setGit((p) => ({ ...p, interval: v ?? 600000 }))} suffix="ms" placeholder="600000" min={10000} />
            </div>
          </div>
        </div>
      </details>

      {/* Exec Security */}
      <details className="settings-collapsible">
        <summary className="settings-collapsible-title">Exec Security</summary>
        <div className="settings-collapsible-body">
          <div className="form-group">
            <label>Deny Patterns</label>
            <ListEditor items={exec.deny} onChange={(v) => setExec((p) => ({ ...p, deny: v }))} placeholder="Add deny pattern..." />
          </div>
          <div className="form-group">
            <label>Allow Patterns</label>
            <ListEditor items={exec.allow} onChange={(v) => setExec((p) => ({ ...p, allow: v }))} placeholder="Add allow pattern..." />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="exec-timeout">Timeout</label>
              <NumberInput id="exec-timeout" value={isNaN(exec.timeout) ? undefined : exec.timeout} onChange={(v) => setExec((p) => ({ ...p, timeout: v ?? NaN }))} suffix="ms" placeholder="Default" min={0} />
            </div>
            <div className="form-group">
              <label htmlFor="exec-max">Max Output</label>
              <NumberInput id="exec-max" value={isNaN(exec.maxOutput) ? undefined : exec.maxOutput} onChange={(v) => setExec((p) => ({ ...p, maxOutput: v ?? NaN }))} suffix="chars" placeholder="Default" min={0} />
            </div>
          </div>
        </div>
      </details>

      {/* Subagent Defaults */}
      <details className="settings-collapsible">
        <summary className="settings-collapsible-title">Subagent Defaults</summary>
        <div className="settings-collapsible-body">
          <div className="form-group">
            <label htmlFor="sub-model">Default Model</label>
            <input id="sub-model" type="text" value={sub.model} onChange={(e) => setSub((p) => ({ ...p, model: e.target.value }))} placeholder="Same as main model" />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="sub-concurrent">Max Concurrent</label>
              <NumberInput id="sub-concurrent" value={isNaN(sub.maxConcurrent) ? undefined : sub.maxConcurrent} onChange={(v) => setSub((p) => ({ ...p, maxConcurrent: v ?? NaN }))} placeholder="20" min={1} />
            </div>
            <div className="form-group">
              <label htmlFor="sub-rounds">Max Tool Rounds</label>
              <NumberInput id="sub-rounds" value={isNaN(sub.maxRounds) ? undefined : sub.maxRounds} onChange={(v) => setSub((p) => ({ ...p, maxRounds: v ?? NaN }))} placeholder="30" min={1} />
            </div>
          </div>
          <div className="form-group">
            <label>Denied Tools</label>
            <ListEditor items={sub.denied} onChange={(v) => setSub((p) => ({ ...p, denied: v }))} placeholder="Add tool name..." />
          </div>
        </div>
      </details>

      {/* API Keys */}
      <details className="settings-collapsible">
        <summary className="settings-collapsible-title">API Keys</summary>
        <div className="settings-collapsible-body">
          {apiKeys.length > 0 && (
            <div className="settings-api-keys">
              {apiKeys.map((k) => (
                <div key={k.name} className="settings-api-key-row">
                  <span className="settings-api-key-name">{k.name}</span>
                  <code className="settings-api-key-value">{k.key.slice(0, 12)}...</code>
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => handleDeleteKey(k.name)}>Delete</button>
                </div>
              ))}
            </div>
          )}
          <div className="list-editor-add" style={{ marginTop: apiKeys.length ? 8 : 0 }}>
            <input type="text" value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)}
              placeholder="Key name (e.g., ios-app)"
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreateKey(); } }} />
            <button type="button" className="btn btn-sm" onClick={handleCreateKey} disabled={!newKeyName.trim()}>Create Key</button>
          </div>
        </div>
      </details>

      {/* Developer */}
      <details className="settings-collapsible">
        <summary className="settings-collapsible-title">Developer</summary>
        <div className="settings-collapsible-body">
          <p className="text-sm text-muted" style={{ margin: '0 0 12px 0' }}>
            Show &ldquo;UI Only&rdquo; messages in chat by category. All hidden by default to reduce noise.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {UI_ONLY_CATEGORIES.map((cat) => (
              <label key={cat.key} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={devSettings[cat.key] ?? false}
                  onChange={(e) => handleToggleUiOnly(cat.key, e.target.checked)}
                  style={{ width: 16, height: 16, accentColor: 'var(--accent)', flexShrink: 0 }}
                />
                <span>{cat.label}</span>
                <span className="text-sm text-muted" style={{ marginLeft: 4 }}>&mdash; {cat.description}</span>
              </label>
            ))}
          </div>
        </div>
      </details>

      {/* Raw Config Viewer */}
      <details className="settings-collapsible">
        <summary className="settings-collapsible-title">Raw Config</summary>
        <div className="settings-collapsible-body">
          <div className="form-group">
            <ToggleSwitch id="show-raw" checked={showRaw} onChange={setShowRaw} label="Show full config (read-only)" />
          </div>
          {showRaw && (
            <pre className="settings-raw-config">{JSON.stringify(config, null, 2)}</pre>
          )}
        </div>
      </details>
    </SectionCard>
  );
}
