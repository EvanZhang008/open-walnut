import { useState, useEffect } from 'react';
import { SESSION_MODES } from '@open-walnut/core';
import type { Config, SessionMode } from '@open-walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { NumberInput } from '../inputs/NumberInput';
import { KeyValueEditor } from '../inputs/KeyValueEditor';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { useAutoSave } from '@/hooks/useAutoSave';

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

export function SessionsSection({ config, onSave }: Props) {
  const [idleTimeout, setIdleTimeout] = useState<number | undefined>(config.session?.idle_timeout_minutes ?? 30);
  const [maxIdle, setMaxIdle] = useState<number | undefined>(config.session?.max_idle);
  const [sessionLimits, setSessionLimits] = useState<Record<string, string | number>>(config.session_limits ?? {});
  const [permissionPrompt, setPermissionPrompt] = useState(config.session?.permission_prompt ?? true);
  const [autoApproveBypass, setAutoApproveBypass] = useState(config.session?.auto_approve_bypass !== false);
  // Registry-driven (core/types.ts): every CLI permission mode, safest → loosest.
  // Default is ALL of them — the old ['bypass','plan'] default silently hid
  // plan/accept/auto/dontAsk from the toggle for anyone without explicit config.
  const ALL_MODES = SESSION_MODES;
  const DEFAULT_MODES: SessionMode[] = SESSION_MODES.map(m => m.id);
  const [enabledModes, setEnabledModes] = useState<SessionMode[]>(config.session?.enabled_modes ?? DEFAULT_MODES);
  const [sdkEnabled, setSdkEnabled] = useState(config.session_server?.enabled ?? false);
  const [sdkPort, setSdkPort] = useState<number | undefined>(config.session_server?.port ?? 7890);
  // Triage throttling (config.agent.triage)
  type TriageNotifyMode = 'off' | 'buffered' | 'realtime';
  const [triageNotifyMode, setTriageNotifyMode] = useState<TriageNotifyMode>(config.agent?.triage?.notify_mode ?? 'off');
  const [triageDebounce, setTriageDebounce] = useState<number | undefined>(config.agent?.triage?.debounce_minutes ?? 4);

  useEffect(() => {
    setIdleTimeout(config.session?.idle_timeout_minutes ?? 30);
    setMaxIdle(config.session?.max_idle);
    setSessionLimits(config.session_limits ?? {});
    setPermissionPrompt(config.session?.permission_prompt ?? true);
    setAutoApproveBypass(config.session?.auto_approve_bypass !== false);
    setEnabledModes(config.session?.enabled_modes ?? DEFAULT_MODES);
    setSdkEnabled(config.session_server?.enabled ?? false);
    setSdkPort(config.session_server?.port ?? 7890);
    setTriageNotifyMode(config.agent?.triage?.notify_mode ?? 'off');
    setTriageDebounce(config.agent?.triage?.debounce_minutes ?? 4);
  }, [config]);

  // Normalize the per-host limits to numbers. The KeyValueEditor yields strings while a
  // post-save config round-trip yields numbers; normalizing keeps the auto-save fingerprint
  // stable so semantically-equal values don't trigger repeated writes.
  const normalizeLimits = (raw: Record<string, string | number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) {
      out[k] = typeof v === 'number' ? v : parseInt(v, 10) || 0;
    }
    return out;
  };

  const handleSave = async () => {
    await onSave({
      // Spread ...config.agent so sibling agent fields (main_model, available_models,
      // session_triage_agent, …) survive — updateConfig replaces the whole `agent` key.
      agent: {
        ...config.agent,
        triage: { notify_mode: triageNotifyMode, debounce_minutes: triageDebounce ?? 4 },
      },
      session: {
        idle_timeout_minutes: idleTimeout,
        max_idle: maxIdle,
        permission_prompt: permissionPrompt,
        auto_approve_bypass: autoApproveBypass,
        enabled_modes: enabledModes,
      },
      session_limits: normalizeLimits(sessionLimits),
      session_server: {
        ...config.session_server,
        enabled: sdkEnabled,
        port: sdkPort,
      },
    });
  };

  useAutoSave({
    current: JSON.stringify({
      idleTimeout, maxIdle,
      sessionLimits: normalizeLimits(sessionLimits),
      permissionPrompt, autoApproveBypass, enabledModes, sdkEnabled, sdkPort,
      triageNotifyMode, triageDebounce: triageDebounce ?? 3,
    }),
    baseline: JSON.stringify({
      idleTimeout: config.session?.idle_timeout_minutes ?? 30,
      maxIdle: config.session?.max_idle,
      sessionLimits: normalizeLimits(config.session_limits ?? {}),
      permissionPrompt: config.session?.permission_prompt ?? true,
      autoApproveBypass: config.session?.auto_approve_bypass !== false,
      // Must match the DEFAULT_MODES used for the live state above, or the
      // auto-save baseline differs from the rendered value and every visit to
      // this section writes the config back unchanged.
      enabledModes: config.session?.enabled_modes ?? DEFAULT_MODES,
      sdkEnabled: config.session_server?.enabled ?? false,
      sdkPort: config.session_server?.port ?? 7890,
      triageNotifyMode: config.agent?.triage?.notify_mode ?? 'off',
      triageDebounce: config.agent?.triage?.debounce_minutes ?? 4,
    }),
    save: handleSave,
  });

  return (
    <SectionCard id="sessions" title="Tasks & Sessions" description="How Claude Code sessions run, and how their work is triaged back onto tasks. Changes save automatically." onSave={handleSave} showSave={false}>
      {/* Session model is a RUNTIME choice made in the session picker ("Auto" = let
          Claude Code pick its own default from its settings layers). Walnut keeps no
          config-time default model, so there's intentionally no picker here. */}
      <div className="form-row">
        <div className="form-group">
          <label htmlFor="idle-timeout">Idle Timeout</label>
          <NumberInput
            id="idle-timeout"
            value={idleTimeout}
            onChange={setIdleTimeout}
            suffix="minutes"
            placeholder="30"
            min={0}
          />
          <p className="text-sm text-muted" style={{ marginTop: 2 }}>
            0 = disable idle timeout.
          </p>
        </div>

        <div className="form-group">
          <label htmlFor="max-idle">Max Idle Sessions</label>
          <NumberInput
            id="max-idle"
            value={maxIdle}
            onChange={setMaxIdle}
            placeholder="30"
            min={0}
          />
        </div>
      </div>

      <div className="form-group">
        <ToggleSwitch
          id="permission-prompt"
          checked={permissionPrompt}
          onChange={setPermissionPrompt}
          label="Permission Prompt Interception"
        />
        <p className="text-sm text-muted" style={{ marginTop: 2 }}>
          Intercept permission prompts from Claude Code (e.g. writing to sensitive files, running destructive commands).
        </p>
      </div>

      {permissionPrompt && (
        <div className="form-group" style={{ marginLeft: 16, borderLeft: '2px solid var(--border)', paddingLeft: 12 }}>
          <ToggleSwitch
            id="auto-approve-bypass"
            checked={autoApproveBypass}
            onChange={setAutoApproveBypass}
            label="Auto-approve in Bypass Mode"
          />
          <p className="text-sm text-muted" style={{ marginTop: 2 }}>
            When a session runs in <strong>bypass</strong> mode, automatically approve all permission prompts without asking.
          </p>
          <div style={{ marginTop: 6, padding: '6px 10px', background: 'var(--bg-subtle)', borderRadius: 6, fontSize: 12, color: 'var(--text-muted)' }}>
            <strong>Examples of auto-approved actions:</strong>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18, lineHeight: 1.6 }}>
              <li>Writing to files outside the project directory</li>
              <li>Running shell commands (npm install, git push, etc.)</li>
              <li>Exiting plan mode to start execution</li>
            </ul>
            <p style={{ margin: '4px 0 0' }}>
              Turn <strong>off</strong> if you want to manually review every action, even in bypass mode.
            </p>
          </div>
        </div>
      )}

      <div className="form-group">
        <label>Enabled Session Modes</label>
        <p className="text-sm text-muted" style={{ margin: '-4px 0 6px' }}>
          Which modes appear in the session mode toggle cycle. At least one must be selected.
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {ALL_MODES.map(entry => {
            const mode = entry.id;
            const icons: Record<string, string> = {
              default: '\u2699\uFE0F', bypass: '\u26A1', plan: '\uD83D\uDCCB',
              accept: '\u2705', auto: '\uD83E\uDD16', dontAsk: '\uD83D\uDEAB',
            };
            const checked = enabledModes.includes(mode);
            return (
              <label key={mode} title={entry.description} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    if (checked && enabledModes.length <= 1) return; // keep at least one
                    setEnabledModes(prev =>
                      checked ? prev.filter(m => m !== mode) : [...prev, mode]
                    );
                  }}
                />
                {icons[mode]} {entry.label}
              </label>
            );
          })}
        </div>
      </div>

      <div className="settings-divider" />

      <div className="form-group">
        <label>Session Limits (per host)</label>
        <p className="text-sm text-muted" style={{ margin: '-4px 0 4px' }}>
          Max concurrent sessions per host. Use &quot;local&quot; for local sessions.
        </p>
        <KeyValueEditor
          entries={sessionLimits}
          onChange={setSessionLimits}
          keyPlaceholder="Host alias (e.g., local)"
          valuePlaceholder="Max sessions"
          valueType="number"
        />
      </div>

      <div className="settings-divider" />

      <div className="form-group">
        <ToggleSwitch
          id="sdk-enabled"
          checked={sdkEnabled}
          onChange={setSdkEnabled}
          label="SDK Session Server"
        />
        <p className="text-sm text-muted" style={{ marginTop: 2 }}>
          Use the Agent SDK server instead of CLI sessions.
        </p>
      </div>

      {sdkEnabled && (
        <div className="form-group">
          <label htmlFor="sdk-port">SDK Server Port</label>
          <NumberInput
            id="sdk-port"
            value={sdkPort}
            onChange={setSdkPort}
            placeholder="7890"
            min={1024}
            max={65535}
          />
        </div>
      )}

      <div className="settings-divider" />

      {/* Task Summary — a TASK concern (updates the task's note/phase and decides task
          notifications), merely triggered by a session turn. The session itself
          writes the note (side_question self-report, ~free); phase/notify is a
          deterministic PHASE_SIGNAL lookup — no summarizer agent runs. Grouped here under
          "Tasks & Sessions" rather than buried in the session-runtime knobs above. */}
      <div className="form-group">
        <label style={{ fontWeight: 600 }}>Task Summary</label>
        <p className="text-sm text-muted" style={{ margin: '2px 0 0' }}>
          After a session goes quiet, the session itself reports what it did — Walnut updates
          the task&rsquo;s summary and decides whether anything needs your attention.
        </p>
      </div>

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="triage-notify-mode">Notify Main Agent</label>
          <select
            id="triage-notify-mode"
            value={triageNotifyMode}
            onChange={(e) => setTriageNotifyMode(e.target.value as TriageNotifyMode)}
            style={{ maxWidth: 220 }}
          >
            <option value="off">Off — quiet (poll only)</option>
            <option value="buffered">Buffered — review on heartbeat</option>
            <option value="realtime">Realtime — notify immediately</option>
          </select>
          <p className="text-sm text-muted" style={{ marginTop: 2 }}>
            The task summary is <strong>always</strong> updated. This only controls whether the
            main agent is woken to tell you about it. <strong>Off</strong> stays silent — the agent
            sees it next time it checks the task. <strong>Realtime</strong> is the most expensive
            (reads the whole conversation each time).
          </p>
        </div>

        <div className="form-group">
          <label htmlFor="triage-debounce">Triage Debounce</label>
          <NumberInput
            id="triage-debounce"
            value={triageDebounce}
            onChange={setTriageDebounce}
            suffix="minutes"
            placeholder="3"
            min={0}
          />
          <p className="text-sm text-muted" style={{ marginTop: 2 }}>
            Wait this long after the last turn before triaging, so a burst of back-and-forth
            collapses into one triage. 0 = triage on every turn.
          </p>
        </div>
      </div>
    </SectionCard>
  );
}
