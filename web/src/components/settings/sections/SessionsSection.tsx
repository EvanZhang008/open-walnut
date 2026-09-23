import { SESSION_MODES, DEFAULT_SESSION_OUTPUT_MODE } from '@open-walnut/core';
import type { Config, SessionMode, SessionOutputMode } from '@open-walnut/core';
import { SettingsGroup, SettingsRow, SettingsSection } from '../SettingsSection';
import { NumberInput } from '../inputs/NumberInput';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { SettingsCheckbox } from '../inputs/SettingsCheckbox';
import { useOptimisticSetting } from '../inputs/useOptimisticSetting';
import { useCommitField } from '../inputs/useCommitField';
import { useSerialSave, type OnSave } from './GeneralSection';

interface Props {
  config: Config;
  onSave: OnSave;
}

type SessionBlock = NonNullable<Config['session']>;

/**
 * The DEFAULT ticks are narrowed to the three real intents (look / vetted run /
 * full trust). Must stay identical to DEFAULT_MODES in
 * web/src/hooks/useEnabledModes.ts.
 */
export const DEFAULT_MODES: SessionMode[] = ['plan', 'auto', 'bypass'];

/** The checklist offers every registry mode; only the default ticks narrow. */
const ALL_MODES = SESSION_MODES;

/** Settings copy per mode (the registry's labels serve the composer pill). */
export const MODE_COPY: Record<SessionMode, { label: string; help: string }> = {
  plan: { label: 'Plan', help: 'Reads and plans, never edits.' },
  default: { label: 'Default', help: 'Asks before each risky action.' },
  dontAsk: { label: "Don't ask", help: 'Denies anything not already allowed.' },
  accept: { label: 'Accept edits', help: 'Applies file edits without asking.' },
  auto: { label: 'Auto', help: 'A classifier decides what needs asking.' },
  bypass: { label: 'Bypass', help: 'Never asks.' },
};

/** Toggle one mode, never leaving the list empty. Keeps registry order. */
export function toggleMode(enabled: readonly SessionMode[], mode: SessionMode, on: boolean): SessionMode[] {
  const set = new Set(enabled);
  if (on) set.add(mode);
  else if (set.size > 1) set.delete(mode);
  return ALL_MODES.map((m) => m.id).filter((id) => set.has(id));
}

const OUTPUT_OPTIONS: { value: SessionOutputMode; label: string; testId: string }[] = [
  { value: 'rich', label: 'Rich HTML', testId: 'session-output-rich' },
  { value: 'markdown', label: 'Plain markdown', testId: 'session-output-markdown' },
];

/**
 * How a Claude Code session runs: idle reaping, permission interception, the
 * mode cycle, the reply style. Numbers are empty when unset: the server's own
 * per-host defaults apply, and saving another row never writes a guess back.
 */
export function SessionsSection({ config, onSave }: Props) {
  const save = useSerialSave(config, onSave);
  const saveSession = (patch: Partial<SessionBlock>, rowKey: string) =>
    // Spread config.session: updateConfig replaces the whole `session` key.
    save((c) => ({ session: { ...(c.session ?? {}), ...patch } as SessionBlock }), { rowKey });

  const idle = useCommitField<number | undefined>(
    config.session?.idle_timeout_minutes,
    (v) => saveSession({ idle_timeout_minutes: v }, 'sessions.idle-timeout'),
    { rowKey: 'sessions.idle-timeout', kind: 'number' },
  );
  const maxIdle = useCommitField<number | undefined>(
    config.session?.max_idle,
    (v) => saveSession({ max_idle: v }, 'sessions.max-idle'),
    { rowKey: 'sessions.max-idle', kind: 'number' },
  );
  const permission = useOptimisticSetting<boolean>(
    config.session?.permission_prompt ?? true,
    (v) => saveSession({ permission_prompt: v }, 'sessions.permission-prompt'),
    { rowKey: 'sessions.permission-prompt' },
  );
  const bypass = useOptimisticSetting<boolean>(
    config.session?.auto_approve_bypass !== false,
    (v) => saveSession({ auto_approve_bypass: v }, 'sessions.auto-approve-bypass'),
    { rowKey: 'sessions.auto-approve-bypass' },
  );
  const modes = useOptimisticSetting<SessionMode[]>(
    config.session?.enabled_modes ?? DEFAULT_MODES,
    (v) => saveSession({ enabled_modes: v }, 'sessions.modes'),
    { rowKey: 'sessions.modes' },
  );
  const output = useOptimisticSetting<SessionOutputMode>(
    config.session?.output_mode ?? DEFAULT_SESSION_OUTPUT_MODE,
    (v) => saveSession({ output_mode: v }, 'sessions.output-mode'),
    { rowKey: 'sessions.output-mode' },
  );

  return (
    <SettingsSection id="sessions" title="Sessions">
      {/* Session model is a RUNTIME choice made in the session picker; Walnut
          keeps no config-time default model, so there is no picker here. */}
      <SettingsGroup>
        <SettingsRow
          anchor="idle-timeout-row"
          label="Idle timeout"
          help="Minutes a quiet session keeps running before Walnut stops it; empty uses 60 here and 120 on remote hosts, 0 never stops."
          htmlFor="idle-timeout"
          error={idle.error}
          control={<NumberInput id="idle-timeout" field={idle.inputProps} unit="minutes" placeholder="60" min={0} />}
        />
        <SettingsRow
          anchor="max-idle-row"
          label="Max idle sessions"
          help="Idle sessions kept alive at once; empty uses 30 here and 40 on remote hosts."
          htmlFor="max-idle"
          error={maxIdle.error}
          control={<NumberInput id="max-idle" field={maxIdle.inputProps} placeholder="30" min={0} unit="sessions" />}
        />
      </SettingsGroup>

      <SettingsGroup heading="Permissions">
        <SettingsRow
          label="Intercept permission prompts"
          help="Ask in Walnut before Claude Code writes sensitive files or runs destructive commands."
          htmlFor="permission-prompt"
          error={permission.error}
          control={
            <ToggleSwitch id="permission-prompt" checked={permission.value} busy={permission.busy} onChange={permission.set} />
          }
        />
        <SettingsRow
          indent
          disabled={!permission.value}
          label="Auto approve in bypass mode"
          help="Sessions in bypass mode never ask; turn off to review every action."
          htmlFor="auto-approve-bypass"
          error={bypass.error}
          control={
            <ToggleSwitch
              id="auto-approve-bypass"
              checked={bypass.value}
              busy={bypass.busy}
              disabled={!permission.value}
              onChange={bypass.set}
            />
          }
        />
      </SettingsGroup>

      {/* Turn-error auto-retry is a DAEMON POLICY, so it lives in Hooks with the
          other automatic behaviors; two editors for one key would race. */}
      <SettingsGroup heading="Session modes" className="settings-checklist" footer="Modes the composer's mode button cycles through." data-testid="session-modes">
        {ALL_MODES.map((entry) => {
          const mode = entry.id;
          const checked = modes.value.includes(mode);
          const last = checked && modes.value.length <= 1;
          return (
            <SettingsCheckbox
              key={mode}
              id={`session-mode-${mode}`}
              data-testid={`session-mode-${mode}`}
              checked={checked}
              disabled={last}
              title={last ? 'Keep at least one mode.' : undefined}
              label={
                <span className="settings-checkbox-copy">
                  <span className="settings-row-label">{MODE_COPY[mode].label}</span>
                  <span className="settings-row-help">{MODE_COPY[mode].help}</span>
                </span>
              }
              onChange={(on) => modes.set(toggleMode(modes.value, mode, on))}
            />
          );
        })}
        {modes.error && <p className="settings-row-error" role="alert">{modes.error}</p>}
      </SettingsGroup>

      <SettingsGroup heading="Replies">
        <SettingsRow
          label="Output mode"
          help="The output mode pill in a session overrides this."
          error={output.error}
          control={
            <SegmentedControl<SessionOutputMode>
              id="session-output-mode"
              aria-label="Output mode"
              value={output.value}
              options={OUTPUT_OPTIONS}
              onChange={output.set}
            />
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
