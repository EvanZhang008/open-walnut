import { useRef, useEffect, useCallback } from 'react';
import type { Config } from '@walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { UI_ONLY_CATEGORIES, setShowUiOnlyCategory, type UiOnlyCategory } from '@/hooks/useDeveloperSettings';
import { updateConfig } from '@/api/config';

interface Props { config: Config; onSave: (partial: Partial<Config>) => Promise<void>; }

export function AdvancedSection({ config, onSave }: Props) {
  // Use refs for all form values — avoids useState entirely (React 19 crash workaround)
  const formRef = useRef<HTMLFormElement>(null);

  // Read helpers
  const git = config.git_versioning ?? {};
  const exec = config.tools?.exec ?? {};
  const sub = config.agent?.subagent ?? {};

  const handleSave = useCallback(async () => {
    const f = formRef.current;
    if (!f) return;
    const fd = new FormData(f);
    const val = (name: string) => (fd.get(name) as string) ?? '';
    const num = (name: string) => { const v = val(name); return v ? Number(v) : undefined; };
    const bool = (name: string) => fd.get(name) === 'on';

    await onSave({
      git_versioning: {
        enabled: bool('git-enabled'),
        push_enabled: bool('git-push'),
        commit_debounce_ms: num('git-debounce'),
        push_interval_ms: num('git-interval'),
      },
      tools: {
        ...config.tools,
        exec: {
          ...config.tools?.exec,
          timeout: num('exec-timeout'),
          max_output: num('exec-max'),
        },
      },
      agent: {
        ...config.agent,
        subagent: {
          ...config.agent?.subagent,
          model: val('sub-model') || undefined,
          max_concurrent: num('sub-concurrent'),
          max_tool_rounds: num('sub-rounds'),
        },
      },
    });
  }, [config, onSave]);

  const handleToggleUiOnly = async (category: UiOnlyCategory, checked: boolean) => {
    setShowUiOnlyCategory(category, checked);
    try {
      const ds: Record<string, boolean> = {};
      for (const cat of UI_ONLY_CATEGORIES) {
        const key = `show_ui_only_${cat.key.replace(/-/g, '_')}`;
        ds[key] = cat.key === category ? checked : localStorage.getItem(`walnut:show_ui_only_${cat.key}`) === 'true';
      }
      await updateConfig({ developer: ds } as Partial<Config>);
    } catch {
      setShowUiOnlyCategory(category, !checked);
    }
  };

  // Read dev settings from localStorage directly (no hook)
  const getDevChecked = (key: string) => {
    try { return localStorage.getItem(`walnut:show_ui_only_${key}`) === 'true'; }
    catch { return false; }
  };

  return (
    <SectionCard id="advanced" title="Advanced" description="Git versioning, exec security, subagent defaults, developer options." onSave={handleSave}>
      <div ref={formRef as React.RefObject<HTMLFormElement>} style={{ display: 'contents' }}>
        {/* Git Versioning */}
        <details className="settings-collapsible" open>
          <summary className="settings-collapsible-title">Git Versioning</summary>
          <div className="settings-collapsible-body">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <input type="checkbox" name="git-enabled" defaultChecked={git.enabled !== false} style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
              Enable Git Auto-Commit
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <input type="checkbox" name="git-push" defaultChecked={git.push_enabled === true} style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
              Enable Push to Remote
            </label>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="git-debounce">Commit Debounce (ms)</label>
                <input id="git-debounce" name="git-debounce" type="number" defaultValue={git.commit_debounce_ms ?? 30000} min={1000} />
              </div>
              <div className="form-group">
                <label htmlFor="git-interval">Push Interval (ms)</label>
                <input id="git-interval" name="git-interval" type="number" defaultValue={git.push_interval_ms ?? 600000} min={10000} />
              </div>
            </div>
          </div>
        </details>

        {/* Exec Security */}
        <details className="settings-collapsible">
          <summary className="settings-collapsible-title">Exec Security</summary>
          <div className="settings-collapsible-body">
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="exec-timeout">Timeout (ms)</label>
                <input id="exec-timeout" name="exec-timeout" type="number" defaultValue={exec.timeout ?? ''} placeholder="Default" min={0} />
              </div>
              <div className="form-group">
                <label htmlFor="exec-max">Max Output (chars)</label>
                <input id="exec-max" name="exec-max" type="number" defaultValue={exec.max_output ?? ''} placeholder="Default" min={0} />
              </div>
            </div>
            {exec.deny?.length ? (
              <p className="text-sm text-muted">Deny patterns: {exec.deny.join(', ')}</p>
            ) : null}
            {exec.allow?.length ? (
              <p className="text-sm text-muted">Allow patterns: {exec.allow.join(', ')}</p>
            ) : null}
          </div>
        </details>

        {/* Subagent Defaults */}
        <details className="settings-collapsible">
          <summary className="settings-collapsible-title">Subagent Defaults</summary>
          <div className="settings-collapsible-body">
            <div className="form-group">
              <label htmlFor="sub-model">Default Model</label>
              <input id="sub-model" name="sub-model" type="text" defaultValue={sub.model ?? ''} placeholder="Same as main model" />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="sub-concurrent">Max Concurrent</label>
                <input id="sub-concurrent" name="sub-concurrent" type="number" defaultValue={sub.max_concurrent ?? ''} placeholder="20" min={1} />
              </div>
              <div className="form-group">
                <label htmlFor="sub-rounds">Max Tool Rounds</label>
                <input id="sub-rounds" name="sub-rounds" type="number" defaultValue={sub.max_tool_rounds ?? ''} placeholder="30" min={1} />
              </div>
            </div>
          </div>
        </details>

        {/* Developer */}
        <details className="settings-collapsible">
          <summary className="settings-collapsible-title">Developer</summary>
          <div className="settings-collapsible-body">
            <p className="text-sm text-muted" style={{ margin: '0 0 12px 0' }}>
              Show &ldquo;UI Only&rdquo; messages in chat by category.
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
        </details>

        {/* Raw Config */}
        <details className="settings-collapsible">
          <summary className="settings-collapsible-title">Raw Config</summary>
          <div className="settings-collapsible-body">
            <pre className="settings-raw-config">{JSON.stringify(config, null, 2)}</pre>
          </div>
        </details>
      </div>
    </SectionCard>
  );
}
