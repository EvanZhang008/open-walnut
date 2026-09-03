import { useCallback, useEffect, useRef, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { AUTOSAVE_DELAY_MS } from '@/hooks/useAutoSave';
import { apiGet, apiPost } from '@/api/client';

interface KeepAwakeStatus {
  state: {
    supported: boolean;
    enabled: boolean;
    holding: boolean;
    reason: string;
    runningLocalSessions: number;
    battery: { pct: number; onAc: boolean } | null;
    online: boolean | null;
    needsSudo: boolean;
    setupDone: boolean | null;
    checkedAt: string | null;
  };
  sudoSetupCommand: string;
}

interface Props { config: Config; onSave: (partial: Partial<Config>) => Promise<void>; }

export function AdvancedSection({ config, onSave }: Props) {

  // Read helpers
  const git = config.git_versioning ?? {};
  const exec = config.tools?.exec ?? {};
  const sub = config.agent?.subagent ?? {};
  const keepAwake = config.keep_awake ?? {};
  const offlineReleaseMinutes = keepAwake.offline_grace_minutes ?? 5;

  // Keep-Awake live status (macOS console feature; route 404s elsewhere → hidden)
  const [kaStatus, setKaStatus] = useState<KeepAwakeStatus | null>(null);
  useEffect(() => {
    apiGet<KeepAwakeStatus>('/api/keep-awake').then(setKaStatus).catch(() => setKaStatus(null));
  }, []);
  const refreshKaStatus = useCallback(() => {
    // Force a poll so a toggle takes effect immediately, not after the next minute tick.
    apiPost<KeepAwakeStatus>('/api/keep-awake/poll').then(setKaStatus).catch(() => {});
  }, []);

  // One-click setup: server pops the native macOS password dialog (osascript).
  const [kaSettingUp, setKaSettingUp] = useState(false);
  const [kaSetupError, setKaSetupError] = useState<string | null>(null);
  const runKaSetup = useCallback(async () => {
    setKaSettingUp(true);
    setKaSetupError(null);
    try {
      const res = await apiPost<{ ok: boolean; detail: string; state: KeepAwakeStatus['state'] }>('/api/keep-awake/setup');
      if (res.ok) {
        setKaStatus((prev) => prev ? { ...prev, state: res.state } : prev);
      } else if (res.detail !== 'canceled') {
        setKaSetupError(res.detail);
      }
    } catch (err) {
      setKaSetupError((err as Error).message);
    } finally {
      setKaSettingUp(false);
    }
  }, []);

  const handleSave = useCallback(async () => {
    // SectionCard renders a <form id="advanced"> — look it up directly.
    // (A ref on the inner <div> won't work with FormData.)
    const f = document.getElementById('advanced') as HTMLFormElement | null;
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
      keep_awake: {
        enabled: bool('ka-enabled'),
        battery_floor_pct: num('ka-battery'),
        offline_grace_minutes: num('ka-offline'),
        linger_minutes: num('ka-linger'),
      },
      session_server: {
        ...config.session_server,
        enabled: bool('sdk-enabled'),
        port: num('sdk-port') ?? 7890,
      },
    });
    // Re-evaluate immediately so the toggle takes effect without waiting a minute.
    refreshKaStatus();
  }, [config, onSave, refreshKaStatus]);

  // Auto-save: this section uses uncontrolled inputs (defaultValue/defaultChecked + FormData),
  // so there's no React state to fingerprint — and config-prop refreshes don't reset the DOM
  // inputs, so there's no save→reset loop to guard against. Just debounce on form edits.
  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;
  useEffect(() => {
    const form = document.getElementById('advanced');
    if (!form) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const onEdit = () => {
      clearTimeout(t);
      t = setTimeout(() => handleSaveRef.current().catch(() => {}), AUTOSAVE_DELAY_MS);
    };
    form.addEventListener('input', onEdit);
    form.addEventListener('change', onEdit);
    return () => {
      clearTimeout(t);
      form.removeEventListener('input', onEdit);
      form.removeEventListener('change', onEdit);
    };
  }, []);

  return (
    <SectionCard id="advanced" title="Advanced" description="Git versioning, exec security, subagent defaults, developer options. Changes save automatically." onSave={handleSave} showSave={false}>
      <div style={{ display: 'contents' }}>
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

        {/* Keep Awake (macOS console only — hidden when the route reports unsupported) */}
        {kaStatus?.state.supported !== false && (
          <details className="settings-collapsible" onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) refreshKaStatus(); }}>
            <summary className="settings-collapsible-title">
              Keep Mac Awake During Sessions (Even Lid Closed)
              {kaStatus?.state.enabled && (
                kaStatus.state.needsSudo
                  ? <span style={{ marginLeft: 8, fontWeight: 400, color: 'var(--warning, #b58900)' }}>⚠️ Setup needed</span>
                  : kaStatus.state.holding
                    ? <span style={{ marginLeft: 8, fontWeight: 400 }}>🟢 Active</span>
                    : <span className="text-muted" style={{ marginLeft: 8, fontWeight: 400 }}>✓ On</span>
              )}
            </summary>
            <div className="settings-collapsible-body">
              <p className="text-sm text-muted" style={{ margin: '0 0 12px 0' }}>
                While local sessions run, Walnut prevents <strong>system sleep</strong>,
                including with the lid closed. Closing the lid turns connected screens off
                while sessions keep running. Connect an iPhone hotspot yourself. If internet stays unavailable
                for {offlineReleaseMinutes} minutes, Walnut restores normal sleep.
              </p>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <input type="checkbox" name="ka-enabled" defaultChecked={keepAwake.enabled === true} style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
                Enable Keep-Awake
              </label>
              {kaStatus?.state.setupDone === false ? (
                <div style={{ border: '1px solid var(--warning, #b58900)', borderRadius: 6, padding: '10px 12px', marginBottom: 12 }}>
                  <p style={{ margin: '0 0 8px 0', fontWeight: 600, color: 'var(--warning, #b58900)' }}>
                    ⚠️ One-time setup needed — click below and enter your Mac password
                  </p>
                  <button type="button" className="btn-primary" onClick={runKaSetup} disabled={kaSettingUp}>
                    {kaSettingUp ? 'Waiting for password dialog…' : 'Set Up Now'}
                  </button>
                  {kaSetupError && (
                    <p className="text-sm" style={{ margin: '8px 0 0 0', color: 'var(--error, #dc322f)' }}>
                      Failed: {kaSetupError}. Manual fallback — run in Terminal:
                      <br /><code style={{ wordBreak: 'break-all' }}>{kaStatus.sudoSetupCommand}</code>
                    </p>
                  )}
                </div>
              ) : kaStatus?.state.setupDone === true ? (
                <p className="text-sm" style={{ margin: '0 0 12px 0', color: 'var(--success, #2aa198)' }}>
                  ✅ Setup complete — Walnut can keep the Mac awake.
                </p>
              ) : null}
              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="ka-battery">Battery Floor (%)</label>
                  <input id="ka-battery" name="ka-battery" type="number" defaultValue={keepAwake.battery_floor_pct ?? ''} placeholder="30" min={5} max={95} />
                </div>
                <div className="form-group">
                  <label htmlFor="ka-offline">Offline Release (min)</label>
                  <input id="ka-offline" name="ka-offline" type="number" defaultValue={keepAwake.offline_grace_minutes ?? ''} placeholder="5" min={1} />
                </div>
                <div className="form-group">
                  <label htmlFor="ka-linger">Linger After Last Session (min)</label>
                  <input id="ka-linger" name="ka-linger" type="number" defaultValue={keepAwake.linger_minutes ?? ''} placeholder="5" min={0} />
                </div>
              </div>
              <p className="text-sm text-muted" style={{ margin: '4px 0 12px 0' }}>
                Using an iPhone hotspot? Connect it yourself from the macOS Wi-Fi menu.
                Walnut does not control Wi-Fi. If internet stays unavailable for the
                offline-release window, normal system sleep is restored.
              </p>
              {kaStatus && (
                <div className="text-sm" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span>
                    Status: {kaStatus.state.holding
                      ? '🟢 Staying awake — safe to close the lid'
                      : kaStatus.state.enabled ? `⚪ Will sleep normally (${kaStatus.state.reason})` : '⚪ Disabled'}
                    {' · '}{kaStatus.state.runningLocalSessions} local session{kaStatus.state.runningLocalSessions === 1 ? '' : 's'} running
                    {kaStatus.state.battery ? ` · battery ${kaStatus.state.battery.pct}%${kaStatus.state.battery.onAc ? ' (AC)' : ''}` : ''}
                    {kaStatus.state.online === false ? ' · offline' : ''}
                  </span>
                </div>
              )}
            </div>
          </details>
        )}

        {/* SDK Session Server — a developer switch (Agent SDK server instead of CLI
            sessions). It used to sit in the Sessions card next to everyday knobs. */}
        <details className="settings-collapsible">
          <summary className="settings-collapsible-title">SDK Session Server</summary>
          <div className="settings-collapsible-body">
            <div className="form-group">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  name="sdk-enabled"
                  id="sdk-enabled"
                  defaultChecked={config.session_server?.enabled ?? false}
                  style={{ width: 16, height: 16, accentColor: 'var(--accent)' }}
                />
                Use the Agent SDK server instead of CLI sessions
              </label>
            </div>
            <div className="form-group">
              <label htmlFor="sdk-port">SDK Server Port</label>
              <input
                type="number"
                name="sdk-port"
                id="sdk-port"
                defaultValue={config.session_server?.port ?? 7890}
                min={1024}
                max={65535}
                style={{ maxWidth: 160 }}
              />
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
