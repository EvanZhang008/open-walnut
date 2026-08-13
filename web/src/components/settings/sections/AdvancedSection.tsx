import { useCallback, useEffect, useRef, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { UI_ONLY_CATEGORIES, setShowUiOnlyCategory, type UiOnlyCategory } from '@/hooks/useDeveloperSettings';
import { updateConfig } from '@/api/config';
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
    lastHotspotAttempt: { at: string; ok: boolean; detail: string } | null;
    checkedAt: string | null;
  };
  sudoSetupCommand: string;
}

interface HotspotCandidate { ssid: string; likely: boolean }

interface Props { config: Config; onSave: (partial: Partial<Config>) => Promise<void>; }

export function AdvancedSection({ config, onSave }: Props) {

  // Read helpers
  const git = config.git_versioning ?? {};
  const exec = config.tools?.exec ?? {};
  const sub = config.agent?.subagent ?? {};
  const keepAwake = config.keep_awake ?? {};

  // Keep-Awake live status (macOS console feature; route 404s elsewhere → hidden)
  const [kaStatus, setKaStatus] = useState<KeepAwakeStatus | null>(null);
  useEffect(() => {
    apiGet<KeepAwakeStatus>('/api/keep-awake').then(setKaStatus).catch(() => setKaStatus(null));
  }, []);
  const refreshKaStatus = useCallback(() => {
    // Force a poll so a toggle takes effect immediately, not after the next minute tick.
    apiPost<KeepAwakeStatus>('/api/keep-awake/poll').then(setKaStatus).catch(() => {});
  }, []);

  // Hotspot SSID detection: saved Wi-Fi networks, hotspot-looking names first.
  const [kaCandidates, setKaCandidates] = useState<HotspotCandidate[] | null>(null);
  const [kaDetecting, setKaDetecting] = useState(false);
  const detectHotspots = useCallback(async () => {
    setKaDetecting(true);
    try {
      const res = await apiGet<{ candidates: HotspotCandidate[] }>('/api/keep-awake/hotspot-candidates');
      setKaCandidates(res.candidates);
    } catch {
      setKaCandidates([]);
    } finally {
      setKaDetecting(false);
    }
  }, []);
  const pickSsid = useCallback((ssid: string) => {
    const input = document.getElementById('ka-ssid') as HTMLInputElement | null;
    if (!input) return;
    input.value = ssid;
    // Uncontrolled form: fire 'input' so the section's autosave listener persists it.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    setKaCandidates(null);
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
        ...config.keep_awake,
        enabled: bool('ka-enabled'),
        battery_floor_pct: num('ka-battery'),
        offline_grace_minutes: num('ka-offline'),
        linger_minutes: num('ka-linger'),
        hotspot_ssid: val('ka-ssid') || undefined,
        // Empty = keep whatever is stored (the field shows a masked value in
        // cloud mode; never overwrite the real secret with the mask or '').
        ...(val('ka-password') && !val('ka-password').includes('••') ? { hotspot_password: val('ka-password') } : {}),
      },
    });
    // Re-evaluate immediately so the toggle takes effect without waiting a minute.
    refreshKaStatus();
  }, [config, onSave, refreshKaStatus]);

  // Auto-save: this section uses uncontrolled inputs (defaultValue/defaultChecked + FormData),
  // so there's no React state to fingerprint — and config-prop refreshes don't reset the DOM
  // inputs, so there's no save→reset loop to guard against. Just debounce on form edits.
  // The "Chat Notifications" checkboxes save themselves via handleToggleUiOnly (developer key,
  // which handleSave doesn't touch), so re-saving on their change is a harmless no-op.
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
          <details className="settings-collapsible">
            <summary className="settings-collapsible-title">Keep Mac Awake During Sessions</summary>
            <div className="settings-collapsible-body">
              <p className="text-sm text-muted" style={{ margin: '0 0 12px 0' }}>
                Advanced. Keeps the Mac running with the lid closed while local Claude Code
                sessions are active. Releases automatically on low battery or after a long
                offline stretch. Requires a one-time admin setup (shown below when needed).
              </p>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <input type="checkbox" name="ka-enabled" defaultChecked={keepAwake.enabled === true} style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
                Enable Keep-Awake
              </label>
              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="ka-battery">Battery Floor (%)</label>
                  <input id="ka-battery" name="ka-battery" type="number" defaultValue={keepAwake.battery_floor_pct ?? ''} placeholder="30" min={5} max={95} />
                </div>
                <div className="form-group">
                  <label htmlFor="ka-offline">Offline Grace (min)</label>
                  <input id="ka-offline" name="ka-offline" type="number" defaultValue={keepAwake.offline_grace_minutes ?? ''} placeholder="30" min={1} />
                </div>
                <div className="form-group">
                  <label htmlFor="ka-linger">Linger After Last Session (min)</label>
                  <input id="ka-linger" name="ka-linger" type="number" defaultValue={keepAwake.linger_minutes ?? ''} placeholder="5" min={0} />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="ka-ssid">iPhone Hotspot SSID (optional)</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input id="ka-ssid" name="ka-ssid" type="text" defaultValue={keepAwake.hotspot_ssid ?? ''} placeholder="Never auto-join" style={{ flex: 1 }} />
                    <button type="button" className="btn-secondary" onClick={detectHotspots} disabled={kaDetecting}>
                      {kaDetecting ? 'Detecting…' : 'Detect'}
                    </button>
                  </div>
                  {kaCandidates !== null && (
                    kaCandidates.length === 0 ? (
                      <p className="text-sm text-muted" style={{ margin: '6px 0 0 0' }}>
                        No saved Wi-Fi networks found. Join the hotspot once from the Wi-Fi menu, then detect again.
                      </p>
                    ) : (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                        {kaCandidates.slice(0, 8).map((c) => (
                          <button key={c.ssid} type="button" className="btn-secondary" onClick={() => pickSsid(c.ssid)} title={c.likely ? 'Looks like a phone hotspot' : 'Saved network'}>
                            {c.likely ? '📱 ' : ''}{c.ssid}
                          </button>
                        ))}
                      </div>
                    )
                  )}
                </div>
                <div className="form-group">
                  <label htmlFor="ka-password">Hotspot Password (optional if saved)</label>
                  <input id="ka-password" name="ka-password" type="password" defaultValue={keepAwake.hotspot_password ?? ''} placeholder="Keychain if already saved" autoComplete="off" />
                </div>
              </div>
              <p className="text-sm text-muted" style={{ margin: '4px 0 12px 0' }}>
                Hotspot join is best-effort: an iPhone hotspot is only visible while it is
                broadcasting (Personal Hotspot screen open, or &ldquo;Allow Others to Join&rdquo;
                with Maximize Compatibility).
              </p>
              {kaStatus && (
                <div className="text-sm" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span>
                    Status: {kaStatus.state.holding
                      ? '🟢 Holding awake'
                      : kaStatus.state.enabled ? `⚪ Not holding (${kaStatus.state.reason})` : '⚪ Disabled'}
                    {' · '}{kaStatus.state.runningLocalSessions} local session{kaStatus.state.runningLocalSessions === 1 ? '' : 's'} running
                    {kaStatus.state.battery ? ` · battery ${kaStatus.state.battery.pct}%${kaStatus.state.battery.onAc ? ' (AC)' : ''}` : ''}
                    {kaStatus.state.online === false ? ' · offline' : ''}
                  </span>
                  {kaStatus.state.enabled && kaStatus.state.needsSudo && (
                    <div>
                      <p style={{ margin: '8px 0 4px 0', color: 'var(--warning, #b58900)' }}>
                        One-time setup needed — run this in a terminal so Walnut may toggle sleep:
                      </p>
                      <pre className="settings-raw-config" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{kaStatus.sudoSetupCommand}</pre>
                    </div>
                  )}
                  {kaStatus.state.lastHotspotAttempt && (
                    <span className="text-muted">
                      Last hotspot attempt: {kaStatus.state.lastHotspotAttempt.ok ? 'joined' : 'failed'} ({kaStatus.state.lastHotspotAttempt.detail})
                    </span>
                  )}
                </div>
              )}
            </div>
          </details>
        )}

        {/* Chat Notifications */}
        <details className="settings-collapsible">
          <summary className="settings-collapsible-title">Chat Notifications</summary>
          <div className="settings-collapsible-body">
            <p className="text-sm text-muted" style={{ margin: '0 0 12px 0' }}>
              Choose which background notifications appear in chat. Checked = visible.
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
