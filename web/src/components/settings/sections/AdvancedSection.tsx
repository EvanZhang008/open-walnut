import { useState, useEffect } from 'react';
import type { Config } from '@walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { NumberInput } from '../inputs/NumberInput';
import { ListEditor } from '../inputs/ListEditor';
import { apiGet, apiPost, apiDelete } from '@/api/client';
import { UI_ONLY_CATEGORIES, useUiOnlySettings, setShowUiOnlyCategory, type UiOnlyCategory } from '@/hooks/useDeveloperSettings';
import { updateConfig } from '@/api/config';

interface ApiKeyEntry {
  name: string;
  key: string;
  created_at: string;
}

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

export function AdvancedSection({ config, onSave }: Props) {
  // Git versioning
  const git = config.git_versioning ?? {};
  const [gitEnabled, setGitEnabled] = useState(git.enabled ?? true);
  const [gitPush, setGitPush] = useState(git.push_enabled ?? false);
  const [gitDebounce, setGitDebounce] = useState<number | undefined>(git.commit_debounce_ms ?? 30000);
  const [gitPushInterval, setGitPushInterval] = useState<number | undefined>(git.push_interval_ms ?? 600000);

  // Exec security
  const exec = config.tools?.exec ?? {};
  const [execDeny, setExecDeny] = useState<string[]>(exec.deny ?? []);
  const [execAllow, setExecAllow] = useState<string[]>(exec.allow ?? []);
  const [execTimeout, setExecTimeout] = useState<number | undefined>(exec.timeout);
  const [execMaxOutput, setExecMaxOutput] = useState<number | undefined>(exec.max_output);

  // Subagent defaults
  const sub = config.agent?.subagent ?? {};
  const [subModel, setSubModel] = useState(sub.model ?? '');
  const [subMaxConcurrent, setSubMaxConcurrent] = useState<number | undefined>(sub.max_concurrent);
  const [subMaxRounds, setSubMaxRounds] = useState<number | undefined>(sub.max_tool_rounds);
  const [subDenied, setSubDenied] = useState<string[]>(sub.denied_tools ?? []);

  // API keys
  const [apiKeys, setApiKeys] = useState<ApiKeyEntry[]>([]);
  const [newKeyName, setNewKeyName] = useState('');

  // Developer — per-category UI Only toggles
  const uiOnlySettings = useUiOnlySettings();

  // Raw config
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    const g = config.git_versioning ?? {};
    setGitEnabled(g.enabled ?? true);
    setGitPush(g.push_enabled ?? false);
    setGitDebounce(g.commit_debounce_ms ?? 30000);
    setGitPushInterval(g.push_interval_ms ?? 600000);

    const e = config.tools?.exec ?? {};
    setExecDeny(e.deny ?? []);
    setExecAllow(e.allow ?? []);
    setExecTimeout(e.timeout);
    setExecMaxOutput(e.max_output);

    const s = config.agent?.subagent ?? {};
    setSubModel(s.model ?? '');
    setSubMaxConcurrent(s.max_concurrent);
    setSubMaxRounds(s.max_tool_rounds);
    setSubDenied(s.denied_tools ?? []);
  }, [config]);

  useEffect(() => {
    apiGet<{ keys: ApiKeyEntry[] }>('/api/auth/keys')
      .then((r) => setApiKeys(r.keys ?? []))
      .catch(() => {/* ignore — endpoint may not exist */});
  }, []);

  const handleSave = async () => {
    await onSave({
      git_versioning: {
        enabled: gitEnabled,
        push_enabled: gitPush,
        commit_debounce_ms: gitDebounce,
        push_interval_ms: gitPushInterval,
      },
      tools: {
        ...config.tools,
        exec: {
          ...config.tools?.exec,
          deny: execDeny.length ? execDeny : undefined,
          allow: execAllow.length ? execAllow : undefined,
          timeout: execTimeout,
          max_output: execMaxOutput,
        },
      },
      agent: {
        ...config.agent,
        subagent: {
          ...config.agent?.subagent,
          model: subModel || undefined,
          max_concurrent: subMaxConcurrent,
          max_tool_rounds: subMaxRounds,
          denied_tools: subDenied.length ? subDenied : undefined,
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
    } catch {
      // silently fail
    }
  };

  const handleDeleteKey = async (name: string) => {
    try {
      await apiDelete(`/api/auth/keys/${encodeURIComponent(name)}`);
      setApiKeys((prev) => prev.filter((k) => k.name !== name));
    } catch {
      // silently fail
    }
  };

  const handleToggleUiOnly = async (category: UiOnlyCategory, checked: boolean) => {
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
    <SectionCard id="advanced" title="Advanced" description="Git versioning, exec security, subagent defaults, API keys, developer options." onSave={handleSave}>
      {/* Git Versioning */}
      <details className="settings-collapsible" open>
        <summary className="settings-collapsible-title">Git Versioning</summary>
        <div className="settings-collapsible-body">
          <div className="form-group">
            <ToggleSwitch id="git-enabled" checked={gitEnabled} onChange={setGitEnabled} label="Enable Git Auto-Commit" />
          </div>
          <div className="form-group">
            <ToggleSwitch id="git-push" checked={gitPush} onChange={setGitPush} label="Enable Push to Remote" />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="git-debounce">Commit Debounce</label>
              <NumberInput id="git-debounce" value={gitDebounce} onChange={setGitDebounce} suffix="ms" placeholder="30000" min={1000} />
            </div>
            <div className="form-group">
              <label htmlFor="git-interval">Push Interval</label>
              <NumberInput id="git-interval" value={gitPushInterval} onChange={setGitPushInterval} suffix="ms" placeholder="600000" min={10000} />
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
            <ListEditor items={execDeny} onChange={setExecDeny} placeholder="Add deny pattern..." />
          </div>
          <div className="form-group">
            <label>Allow Patterns</label>
            <ListEditor items={execAllow} onChange={setExecAllow} placeholder="Add allow pattern..." />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="exec-timeout">Timeout</label>
              <NumberInput id="exec-timeout" value={execTimeout} onChange={setExecTimeout} suffix="ms" placeholder="Default" min={0} />
            </div>
            <div className="form-group">
              <label htmlFor="exec-max">Max Output</label>
              <NumberInput id="exec-max" value={execMaxOutput} onChange={setExecMaxOutput} suffix="chars" placeholder="Default" min={0} />
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
            <input id="sub-model" type="text" value={subModel} onChange={(e) => setSubModel(e.target.value)} placeholder="Same as main model" />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="sub-concurrent">Max Concurrent</label>
              <NumberInput id="sub-concurrent" value={subMaxConcurrent} onChange={setSubMaxConcurrent} placeholder="20" min={1} />
            </div>
            <div className="form-group">
              <label htmlFor="sub-rounds">Max Tool Rounds</label>
              <NumberInput id="sub-rounds" value={subMaxRounds} onChange={setSubMaxRounds} placeholder="30" min={1} />
            </div>
          </div>
          <div className="form-group">
            <label>Denied Tools</label>
            <ListEditor items={subDenied} onChange={setSubDenied} placeholder="Add tool name..." />
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
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => handleDeleteKey(k.name)}>
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="list-editor-add" style={{ marginTop: apiKeys.length ? 8 : 0 }}>
            <input
              type="text"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              placeholder="Key name (e.g., ios-app)"
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreateKey(); } }}
            />
            <button type="button" className="btn btn-sm" onClick={handleCreateKey} disabled={!newKeyName.trim()}>
              Create Key
            </button>
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
                  checked={uiOnlySettings[cat.key]}
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
            <pre className="settings-raw-config">
              {JSON.stringify(config, null, 2)}
            </pre>
          )}
        </div>
      </details>
    </SectionCard>
  );
}
