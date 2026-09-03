import { useState, useEffect } from 'react';
import { SESSION_MODES, DEFAULT_SESSION_OUTPUT_MODE } from '@open-walnut/core';
import type { Config, SessionMode, SessionOutputMode } from '@open-walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { NumberInput } from '../inputs/NumberInput';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { useAutoSave } from '@/hooks/useAutoSave';

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

/**
 * How a Claude Code session runs: idle reaping, permission interception, the
 * mode cycle, the reply style. Task Summary moved to Tasks, per-host limits to
 * Remote Hosts, the SDK server toggle to Advanced, and the suggestion-accuracy
 * table to Usage & Costs — this card is the session runtime and nothing else.
 */
export function SessionsSection({ config, onSave }: Props) {
  const [idleTimeout, setIdleTimeout] = useState<number | undefined>(config.session?.idle_timeout_minutes ?? 30);
  const [maxIdle, setMaxIdle] = useState<number | undefined>(config.session?.max_idle);
  const [permissionPrompt, setPermissionPrompt] = useState(config.session?.permission_prompt ?? true);
  const [autoApproveBypass, setAutoApproveBypass] = useState(config.session?.auto_approve_bypass !== false);
  // The checkbox list offers EVERY registry mode (core/types.ts, safest →
  // loosest). Only the DEFAULT ticks are narrowed to the three that cover the
  // three real intents — look / vetted-run / full-trust — so the pill cycle
  // isn't a six-item ring. Must stay identical to DEFAULT_MODES in
  // web/src/hooks/useEnabledModes.ts, otherwise the auto-save baseline differs
  // from the rendered value and merely opening Settings rewrites the config.
  const ALL_MODES = SESSION_MODES;
  const DEFAULT_MODES: SessionMode[] = ['plan', 'auto', 'bypass'];
  const [enabledModes, setEnabledModes] = useState<SessionMode[]>(config.session?.enabled_modes ?? DEFAULT_MODES);
  // Reply style every session starts on. A session's own pill overrides it; one
  // that never did follows this value live (core/sessions/output-mode.ts).
  const [outputMode, setOutputMode] = useState<SessionOutputMode>(config.session?.output_mode ?? DEFAULT_SESSION_OUTPUT_MODE);

  useEffect(() => {
    setIdleTimeout(config.session?.idle_timeout_minutes ?? 30);
    setMaxIdle(config.session?.max_idle);
    setPermissionPrompt(config.session?.permission_prompt ?? true);
    setAutoApproveBypass(config.session?.auto_approve_bypass !== false);
    setEnabledModes(config.session?.enabled_modes ?? DEFAULT_MODES);
    setOutputMode(config.session?.output_mode ?? DEFAULT_SESSION_OUTPUT_MODE);
  }, [config]);

  const handleSave = async () => {
    await onSave({
      // Spread ...config.session so sibling session fields this section does NOT
      // render (cron_policy, acp_walnut_mcp, …) survive — updateConfig replaces
      // the whole `session` key.
      session: {
        ...config.session,
        idle_timeout_minutes: idleTimeout,
        max_idle: maxIdle,
        permission_prompt: permissionPrompt,
        auto_approve_bypass: autoApproveBypass,
        enabled_modes: enabledModes,
        output_mode: outputMode,
      },
    });
  };

  useAutoSave({
    current: JSON.stringify({
      idleTimeout, maxIdle, permissionPrompt, autoApproveBypass, enabledModes, outputMode,
    }),
    baseline: JSON.stringify({
      idleTimeout: config.session?.idle_timeout_minutes ?? 30,
      maxIdle: config.session?.max_idle,
      permissionPrompt: config.session?.permission_prompt ?? true,
      autoApproveBypass: config.session?.auto_approve_bypass !== false,
      // Must match the DEFAULT_MODES used for the live state above, or the
      // auto-save baseline differs from the rendered value and every visit to
      // this section writes the config back unchanged.
      enabledModes: config.session?.enabled_modes ?? DEFAULT_MODES,
      // Same defaulting as the live state above (DEFAULT_SESSION_OUTPUT_MODE), or
      // merely opening this section would write the config back.
      outputMode: config.session?.output_mode ?? DEFAULT_SESSION_OUTPUT_MODE,
    }),
    save: handleSave,
  });

  return (
    <SectionCard id="sessions" title="Sessions" description="How Claude Code sessions run. Changes save automatically." onSave={handleSave} showSave={false}>
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

      {/* Turn-error auto-retry is a DAEMON POLICY, so it lives in Settings →
          Hooks with the rest of the automatic behaviors (and its knobs are
          declared there as hook settings). Deliberately not duplicated here:
          two editors for one config key means whichever page saved last wins. */}

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

      <div className="form-group">
        <label htmlFor="session-output-mode">Output Mode</label>
        <select
          id="session-output-mode"
          value={outputMode}
          onChange={(e) => setOutputMode(e.target.value as SessionOutputMode)}
          style={{ maxWidth: 220 }}
        >
          <option value="rich">Rich HTML</option>
          <option value="markdown">Plain markdown</option>
        </select>
        <p className="text-sm text-muted" style={{ marginTop: 2 }}>
          <strong>Rich HTML</strong>: the model may reply in HTML that the console renders
          (diagrams, steppers, colored layout). <strong>Plain markdown</strong>: markdown only.
          The output-mode pill in a session&rsquo;s composer overrides this for that session.
        </p>
      </div>
    </SectionCard>
  );
}
