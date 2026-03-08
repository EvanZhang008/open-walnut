import { useState, useEffect, useReducer } from 'react';
import type { Config } from '@walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { NumberInput } from '../inputs/NumberInput';
import { ListEditor } from '../inputs/ListEditor';
import { apiGet, apiPost, apiDelete } from '@/api/client';
import { UI_ONLY_CATEGORIES, useUiOnlySettings, setShowUiOnlyCategory, type UiOnlyCategory } from '@/hooks/useDeveloperSettings';
import { updateConfig } from '@/api/config';

// Isolated component — useUiOnlySettings triggers re-renders that must not cascade
function DeveloperToggles() {
  const uiOnlySettings = useUiOnlySettings();

  const handleToggle = async (category: UiOnlyCategory, checked: boolean) => {
    setShowUiOnlyCategory(category, checked);
    try {
      const devSettings: Record<string, boolean> = {};
      for (const cat of UI_ONLY_CATEGORIES) {
        devSettings[`show_ui_only_${cat.key.replace(/-/g, '_')}`] = cat.key === category ? checked : uiOnlySettings[cat.key];
      }
      await updateConfig({ developer: devSettings } as Partial<Config>);
    } catch {
      setShowUiOnlyCategory(category, !checked);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {UI_ONLY_CATEGORIES.map((cat) => (
        <label key={cat.key} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={uiOnlySettings[cat.key]}
            onChange={(e) => handleToggle(cat.key, e.target.checked)}
            style={{ width: 16, height: 16, accentColor: 'var(--accent)', flexShrink: 0 }}
          />
          <span>{cat.label}</span>
          <span className="text-sm text-muted" style={{ marginLeft: 4 }}>&mdash; {cat.description}</span>
        </label>
      ))}
    </div>
  );
}

interface ApiKeyEntry { name: string; key: string; created_at: string; }

// Single state object to avoid React 19 multi-useState reconciliation bugs
interface FormState {
  gitEnabled: boolean; gitPush: boolean; gitDebounce: string; gitPushInterval: string;
  execDeny: string[]; execAllow: string[]; execTimeout: string; execMaxOutput: string;
  subModel: string; subMaxConcurrent: string; subMaxRounds: string; subDenied: string[];
}

function initForm(config: Config): FormState {
  const g = config.git_versioning ?? {};
  const e = config.tools?.exec ?? {};
  const s = config.agent?.subagent ?? {};
  return {
    gitEnabled: g.enabled ?? true, gitPush: g.push_enabled ?? false,
    gitDebounce: String(g.commit_debounce_ms ?? ''), gitPushInterval: String(g.push_interval_ms ?? ''),
    execDeny: e.deny ?? [], execAllow: e.allow ?? [],
    execTimeout: String(e.timeout ?? ''), execMaxOutput: String(e.max_output ?? ''),
    subModel: s.model ?? '', subMaxConcurrent: String(s.max_concurrent ?? ''),
    subMaxRounds: String(s.max_tool_rounds ?? ''), subDenied: s.denied_tools ?? [],
  };
}

type FormAction = Partial<FormState>;
function formReducer(state: FormState, action: FormAction): FormState {
  return { ...state, ...action };
}

interface Props { config: Config; onSave: (partial: Partial<Config>) => Promise<void>; }

export function AdvancedSection({ config, onSave }: Props) {
  const [f, update] = useReducer(formReducer, config, initForm);
  const [apiKeys, setApiKeys] = useState<ApiKeyEntry[]>([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [showRaw, setShowRaw] = useState(false);

  // Sync form state when config changes from outside
  useEffect(() => { update(initForm(config)); }, [config]);

  useEffect(() => {
    apiGet<{ keys: ApiKeyEntry[] }>('/api/auth/keys')
      .then((r) => setApiKeys(r.keys ?? []))
      .catch(() => {});
  }, []);

  const handleSave = async () => {
    const num = (v: string) => v ? Number(v) : undefined;
    await onSave({
      git_versioning: {
        enabled: f.gitEnabled, push_enabled: f.gitPush,
        commit_debounce_ms: num(f.gitDebounce), push_interval_ms: num(f.gitPushInterval),
      },
      tools: {
        ...config.tools,
        exec: {
          ...config.tools?.exec,
          deny: f.execDeny.length ? f.execDeny : undefined,
          allow: f.execAllow.length ? f.execAllow : undefined,
          timeout: num(f.execTimeout), max_output: num(f.execMaxOutput),
        },
      },
      agent: {
        ...config.agent,
        subagent: {
          ...config.agent?.subagent,
          model: f.subModel || undefined,
          max_concurrent: num(f.subMaxConcurrent), max_tool_rounds: num(f.subMaxRounds),
          denied_tools: f.subDenied.length ? f.subDenied : undefined,
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
            <ToggleSwitch id="git-enabled" checked={f.gitEnabled} onChange={(v) => update({ gitEnabled: v })} label="Enable Git Auto-Commit" />
          </div>
          <div className="form-group">
            <ToggleSwitch id="git-push" checked={f.gitPush} onChange={(v) => update({ gitPush: v })} label="Enable Push to Remote" />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="git-debounce">Commit Debounce</label>
              <NumberInput id="git-debounce" value={f.gitDebounce ? Number(f.gitDebounce) : undefined} onChange={(v) => update({ gitDebounce: String(v ?? '') })} suffix="ms" placeholder="30000" min={1000} />
            </div>
            <div className="form-group">
              <label htmlFor="git-interval">Push Interval</label>
              <NumberInput id="git-interval" value={f.gitPushInterval ? Number(f.gitPushInterval) : undefined} onChange={(v) => update({ gitPushInterval: String(v ?? '') })} suffix="ms" placeholder="600000" min={10000} />
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
            <ListEditor items={f.execDeny} onChange={(v) => update({ execDeny: v })} placeholder="Add deny pattern..." />
          </div>
          <div className="form-group">
            <label>Allow Patterns</label>
            <ListEditor items={f.execAllow} onChange={(v) => update({ execAllow: v })} placeholder="Add allow pattern..." />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="exec-timeout">Timeout</label>
              <NumberInput id="exec-timeout" value={f.execTimeout ? Number(f.execTimeout) : undefined} onChange={(v) => update({ execTimeout: String(v ?? '') })} suffix="ms" placeholder="Default" min={0} />
            </div>
            <div className="form-group">
              <label htmlFor="exec-max">Max Output</label>
              <NumberInput id="exec-max" value={f.execMaxOutput ? Number(f.execMaxOutput) : undefined} onChange={(v) => update({ execMaxOutput: String(v ?? '') })} suffix="chars" placeholder="Default" min={0} />
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
            <input id="sub-model" type="text" value={f.subModel} onChange={(e) => update({ subModel: e.target.value })} placeholder="Same as main model" />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="sub-concurrent">Max Concurrent</label>
              <NumberInput id="sub-concurrent" value={f.subMaxConcurrent ? Number(f.subMaxConcurrent) : undefined} onChange={(v) => update({ subMaxConcurrent: String(v ?? '') })} placeholder="20" min={1} />
            </div>
            <div className="form-group">
              <label htmlFor="sub-rounds">Max Tool Rounds</label>
              <NumberInput id="sub-rounds" value={f.subMaxRounds ? Number(f.subMaxRounds) : undefined} onChange={(v) => update({ subMaxRounds: String(v ?? '') })} placeholder="30" min={1} />
            </div>
          </div>
          <div className="form-group">
            <label>Denied Tools</label>
            <ListEditor items={f.subDenied} onChange={(v) => update({ subDenied: v })} placeholder="Add tool name..." />
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
          <DeveloperToggles />
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
