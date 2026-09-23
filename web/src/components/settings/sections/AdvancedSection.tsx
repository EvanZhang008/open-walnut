import { useCallback, useEffect, useRef, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { SettingsDisclosure, SettingsGroup, SettingsMonoBlock, SettingsRow } from '../SettingsSection';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { SettingsButton } from '../inputs/SettingsButton';
import { CopyButton } from '../inputs/CopyButton';
import { saveErrorMessage, useSettingsSaved } from '../settings-pane-context';
import { couldntSave } from '../inputs/useOptimisticSetting';
import { AUTOSAVE_DELAY_MS } from '@/hooks/useAutoSave';
import { apiGet, apiPost } from '@/api/client';
import type { OnSave } from './GeneralSection';

export interface KeepAwakeStatus {
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

interface Props { config: Config; onSave: OnSave; }

/** Keep awake disclosure summary: plain words, no symbols (pure, unit tested). */
export function keepAwakeSummary(enabled: boolean, status: KeepAwakeStatus['state'] | null | undefined): string {
  if (!enabled) return 'Off';
  if (status?.needsSudo || status?.setupDone === false) return 'Needs setup';
  if (status?.holding) return 'Active';
  return 'On';
}

/** Git disclosure summary (pure, unit tested). */
export function gitSummary(enabled: boolean, push: boolean): string {
  return `Auto commit ${enabled ? 'on' : 'off'}, push ${push ? 'on' : 'off'}`;
}

/** One status line for Keep awake, joined with commas. */
export function keepAwakeStatusLine(s: KeepAwakeStatus['state']): string {
  const parts = [
    s.holding ? 'Staying awake, safe to close the lid' : s.enabled ? `Will sleep normally (${s.reason})` : 'Disabled',
    `${s.runningLocalSessions} local session${s.runningLocalSessions === 1 ? '' : 's'} running`,
  ];
  if (s.battery) parts.push(`battery ${s.battery.pct}%${s.battery.onAc ? ' (AC)' : ''}`);
  if (s.online === false) parts.push('offline');
  return parts.join(', ');
}

const SECOND = 1_000;
const MINUTE = 60_000;

/** Intervals show in seconds or minutes, never raw milliseconds (N3-24). Pure. */
export function fromMs(ms: number | undefined, unit: number): number | undefined {
  return ms === undefined ? undefined : Math.round((ms / unit) * 100) / 100;
}

/**
 * Back to milliseconds. A field the user did not touch shows `original`
 * rounded for display; it saves `original` exactly, so an autosave of an
 * unrelated switch never rewrites 12345 as 12350.
 */
export function toMs(value: number | undefined, unit: number, original?: number): number | undefined {
  if (value === undefined || Number.isNaN(value)) return undefined;
  if (original !== undefined && fromMs(original, unit) === value) return original;
  return Math.round(value * unit);
}

/**
 * The whole section as a config patch, read from the uncontrolled form. Every
 * field of every disclosure is read, collapsed or not (collapsed rows stay
 * mounted), and a block whose fields are absent keeps the config's value
 * instead of writing false/undefined over it.
 */
export function readAdvancedForm(form: HTMLFormElement, config: Config): Partial<Config> {
  const fd = new FormData(form);
  const has = (name: string) => form.elements.namedItem(name) !== null;
  const val = (name: string) => (fd.get(name) as string) ?? '';
  const num = (name: string) => { const v = val(name); return v ? Number(v) : undefined; };
  const bool = (name: string) => fd.get(name) === 'on';
  const patch: Partial<Config> = {
    git_versioning: {
      ...config.git_versioning,
      enabled: bool('git-enabled'),
      push_enabled: bool('git-push'),
      commit_debounce_ms: toMs(num('git-debounce'), SECOND, config.git_versioning?.commit_debounce_ms),
      push_interval_ms: toMs(num('git-interval'), MINUTE, config.git_versioning?.push_interval_ms),
    },
    tools: {
      ...config.tools,
      exec: { ...config.tools?.exec, timeout: toMs(num('exec-timeout'), SECOND, config.tools?.exec?.timeout), max_output: num('exec-max') },
    },
    agent: {
      ...config.agent,
      subagent: {
        ...config.agent?.subagent,
        model: val('sub-model') || undefined,
        max_concurrent: num('sub-concurrent'),
        max_tool_rounds: num('sub-rounds'),
      },
    } as Config['agent'],
    session_server: { ...config.session_server, enabled: bool('sdk-enabled'), port: num('sdk-port') ?? 7890 },
  };
  if (has('ka-enabled')) {
    patch.keep_awake = {
      ...config.keep_awake,
      enabled: bool('ka-enabled'),
      battery_floor_pct: num('ka-battery'),
      offline_grace_minutes: num('ka-offline'),
      linger_minutes: num('ka-linger'),
    };
  }
  return patch;
}

/** A number field of the uncontrolled form (FormData reads it by `name`). */
function FormNumber({ id, defaultValue, unit, placeholder, min, max, step, readOnly }: {
  id: string; defaultValue: number | string | undefined; unit?: string; placeholder?: string;
  min?: number; max?: number; step?: number | 'any'; readOnly?: boolean;
}) {
  return (
    <span className="number-input-wrapper settings-input-with-unit">
      <input
        id={id}
        name={id}
        type="number"
        inputMode="decimal"
        className="number-input settings-input settings-input--number"
        defaultValue={defaultValue ?? ''}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
        readOnly={readOnly}
        tabIndex={readOnly ? -1 : undefined}
      />
      {/* Only with a unit: the field plus unit ends on the content edge (N03). */}
      {unit && <span className="number-input-suffix settings-input-unit">{unit}</span>}
    </span>
  );
}

export function AdvancedSection({ config, onSave }: Props) {
  const git = config.git_versioning ?? {};
  const exec = config.tools?.exec ?? {};
  const sub = config.agent?.subagent ?? {};
  const keepAwake = config.keep_awake ?? {};
  const offlineReleaseMinutes = keepAwake.offline_grace_minutes ?? 5;
  const { notifySaved } = useSettingsSaved();

  // Switches are controlled locally; their hidden mirrors feed FormData.
  const [gitEnabled, setGitEnabled] = useState(git.enabled !== false);
  const [gitPush, setGitPush] = useState(git.push_enabled === true);
  const [kaEnabled, setKaEnabled] = useState(keepAwake.enabled === true);
  const [sdkEnabled, setSdkEnabled] = useState(config.session_server?.enabled ?? false);
  // Follow a change made elsewhere; otherwise the next autosave of this form
  // would send the switch's stale state back.
  useEffect(() => { setGitEnabled(git.enabled !== false); }, [git.enabled]);
  useEffect(() => { setGitPush(git.push_enabled === true); }, [git.push_enabled]);
  useEffect(() => { setKaEnabled(keepAwake.enabled === true); }, [keepAwake.enabled]);
  useEffect(() => { setSdkEnabled(config.session_server?.enabled ?? false); }, [config.session_server?.enabled]);

  // Keep-Awake live status (macOS console feature; route 404s elsewhere -> hidden)
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
        notifySaved();
      } else if (res.detail !== 'canceled') {
        setKaSetupError(res.detail);
      }
    } catch (err) {
      setKaSetupError((err as Error).message);
    } finally {
      setKaSettingUp(false);
    }
  }, [notifySaved]);

  const configRef = useRef(config);
  configRef.current = config;
  // A failed autosave stays under the group until the next save lands.
  const [formError, setFormError] = useState<string | null>(null);
  const save = useCallback(async (patch: Partial<Config>) => {
    try {
      await onSave(patch, { rowKey: 'advanced.form' });
      setFormError(null);
    } catch (err) {
      setFormError(couldntSave(saveErrorMessage(err)));
      throw err;
    }
    // Re-evaluate immediately so the toggle takes effect without waiting a minute.
    refreshKaStatus();
  }, [onSave, refreshKaStatus]);
  const handleSave = useCallback(async () => {
    // SectionCard renders a <form id="advanced">; FormData needs the form itself.
    const f = document.getElementById('advanced') as HTMLFormElement | null;
    if (!f) return;
    await save(readAdvancedForm(f, configRef.current));
  }, [save]);

  // Auto-save: uncontrolled inputs + FormData, debounced on form edits. The
  // patch is snapshotted at edit time, so a pane switch (unmount) inside the
  // debounce window still saves what was typed instead of dropping it.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const form = document.getElementById('advanced') as HTMLFormElement | null;
    if (!form) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    let pending: Partial<Config> | null = null;
    const flush = () => {
      clearTimeout(t);
      if (!pending) return;
      const patch = pending;
      pending = null;
      saveRef.current(patch).catch(() => {});
    };
    const onEdit = () => {
      pending = readAdvancedForm(form, configRef.current);
      clearTimeout(t);
      t = setTimeout(() => {
        // Re-read at fire time: later edits in the window are in the form now.
        pending = readAdvancedForm(form, configRef.current);
        flush();
      }, AUTOSAVE_DELAY_MS);
    };
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
    form.addEventListener('input', onEdit);
    form.addEventListener('change', onEdit);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      form.removeEventListener('input', onEdit);
      form.removeEventListener('change', onEdit);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      flush();
    };
  }, []);

  const kaState = kaStatus?.state ?? null;
  const kaSupported = kaState?.supported !== false;
  const needsSetup = kaState?.setupDone === false;

  return (
    <SectionCard id="advanced" title="Advanced" onSave={handleSave} showSave={false}>
      <SettingsGroup data-testid="advanced-group">
        <SettingsDisclosure id="advanced-git" data-testid="advanced-disclosure-git" label="Git versioning" summary={gitSummary(gitEnabled, gitPush)}>
          <SettingsRow indent label="Auto commit" htmlFor="git-enabled"
            control={<ToggleSwitch id="git-enabled" name="git-enabled" checked={gitEnabled} onChange={setGitEnabled} />} />
          <SettingsRow indent label="Push to remote" htmlFor="git-push"
            control={<ToggleSwitch id="git-push" name="git-push" checked={gitPush} onChange={setGitPush} />} />
          <SettingsRow indent label="Commit debounce" htmlFor="git-debounce"
            control={<FormNumber id="git-debounce" defaultValue={fromMs(git.commit_debounce_ms ?? 30000, SECOND)} unit="seconds" min={1} step="any" />} />
          <SettingsRow indent label="Push interval" htmlFor="git-interval" disabled={!gitPush}
            control={<FormNumber id="git-interval" defaultValue={fromMs(git.push_interval_ms ?? 600000, MINUTE)} unit="minutes" min={1} step="any" readOnly={!gitPush} />} />
        </SettingsDisclosure>

        <SettingsDisclosure id="advanced-exec" data-testid="advanced-disclosure-exec" label="Command safety"
          summary={exec.timeout || exec.max_output || exec.deny?.length || exec.allow?.length ? 'Custom limits' : 'Defaults'}>
          <SettingsRow indent label="Timeout" htmlFor="exec-timeout"
            control={<FormNumber id="exec-timeout" defaultValue={fromMs(exec.timeout, SECOND)} unit="seconds" placeholder="Default" min={0} step="any" />} />
          <SettingsRow indent label="Max output" htmlFor="exec-max"
            control={<FormNumber id="exec-max" defaultValue={exec.max_output} unit="characters" placeholder="Default" min={0} />} />
          {exec.deny?.length ? (
            <SettingsRow indent label="Deny patterns" help={<code>{exec.deny.join(', ')}</code>} />
          ) : null}
          {exec.allow?.length ? (
            <SettingsRow indent label="Allow patterns" help={<code>{exec.allow.join(', ')}</code>} />
          ) : null}
        </SettingsDisclosure>

        <SettingsDisclosure id="advanced-subagent" data-testid="advanced-disclosure-subagent" label="Subagent defaults"
          summary={sub.model ? 'Own model' : 'Main model'}>
          <SettingsRow indent wide label="Subagent model" help="Leave empty to use the main model." htmlFor="sub-model"
            control={
              <input id="sub-model" name="sub-model" type="text" defaultValue={sub.model ?? ''} placeholder="Model id"
                className="settings-input settings-input--long settings-input--mono" spellCheck={false} />
            } />
          <SettingsRow indent label="Max concurrent" htmlFor="sub-concurrent"
            control={<FormNumber id="sub-concurrent" defaultValue={sub.max_concurrent} placeholder="20" min={1} />} />
          <SettingsRow indent label="Max tool rounds" htmlFor="sub-rounds"
            control={<FormNumber id="sub-rounds" defaultValue={sub.max_tool_rounds} placeholder="30" min={1} />} />
        </SettingsDisclosure>

        {/* Keep Awake: macOS console only, hidden when the route reports unsupported. */}
        {kaSupported && (
          <SettingsDisclosure
            id="advanced-keep-awake"
            data-testid="advanced-disclosure-keep-awake"
            label="Keep Mac awake during sessions"
            help="Also with the lid closed."
            summary={<span data-testid="ka-summary">{keepAwakeSummary(kaEnabled, kaState)}</span>}
          >
            <SettingsRow indent label="Keep Mac awake" htmlFor="ka-enabled"
              help="While local sessions run, Walnut prevents system sleep; closing the lid turns connected screens off while sessions keep running."
              control={<ToggleSwitch id="ka-enabled" name="ka-enabled" checked={kaEnabled} onChange={setKaEnabled} />} />
            {needsSetup && (
              <SettingsRow indent label="One-time setup" help="Needs your Mac password once." state="warning"
                data-testid="ka-setup-row"
                error={kaSetupError ? <span title={kaSetupError}>Setup didn&apos;t finish.</span> : undefined}
                control={
                  <SettingsButton variant="primary" busy={kaSettingUp} busyLabel="Setting up..." onClick={() => void runKaSetup()} data-testid="ka-setup">
                    Set up
                  </SettingsButton>
                } />
            )}
            {needsSetup && kaSetupError && kaStatus && (
              <SettingsRow indent wide label="Run in Terminal" data-testid="ka-setup-command"
                help={<code className="settings-mono-value">{kaStatus.sudoSetupCommand}</code>}
                control={<CopyButton text={kaStatus.sudoSetupCommand} data-testid="ka-setup-copy" />} />
            )}
            {kaState?.setupDone === true && (
              <SettingsRow indent label="Setup" help="Done; Walnut can keep the Mac awake." />
            )}
            <SettingsRow indent label="Battery floor" htmlFor="ka-battery" disabled={!kaEnabled}
              help="On battery at or below this charge, normal sleep returns."
              control={<FormNumber id="ka-battery" defaultValue={keepAwake.battery_floor_pct} unit="%" placeholder="30" min={5} max={95} readOnly={!kaEnabled} />} />
            <SettingsRow indent label="Offline release" htmlFor="ka-offline" disabled={!kaEnabled}
              help={`Connect an iPhone hotspot yourself; if internet stays unavailable for ${offlineReleaseMinutes} minutes, Walnut restores normal sleep.`}
              control={<FormNumber id="ka-offline" defaultValue={keepAwake.offline_grace_minutes} unit="minutes" placeholder="5" min={1} readOnly={!kaEnabled} />} />
            <SettingsRow indent label="Linger after last session" htmlFor="ka-linger" disabled={!kaEnabled}
              control={<FormNumber id="ka-linger" defaultValue={keepAwake.linger_minutes} unit="minutes" placeholder="5" min={0} readOnly={!kaEnabled} />} />
            {kaState && (
              <SettingsRow indent label="Status" help={keepAwakeStatusLine(kaState)} data-testid="ka-status" />
            )}
          </SettingsDisclosure>
        )}

        {/* SDK Session Server: a developer switch (Agent SDK server instead of CLI sessions). */}
        <SettingsDisclosure id="advanced-sdk" data-testid="advanced-disclosure-sdk" label="SDK session server" summary={sdkEnabled ? 'On' : 'Off'}>
          <SettingsRow indent label="Use the Agent SDK server" help="Runs sessions through the SDK server instead of the CLI." htmlFor="sdk-enabled"
            control={<ToggleSwitch id="sdk-enabled" name="sdk-enabled" checked={sdkEnabled} onChange={setSdkEnabled} />} />
          {/* Depends on the switch above: dimmed and read-only while it is off,
              like Push interval (N3-23). */}
          <SettingsRow indent label="Port" htmlFor="sdk-port" disabled={!sdkEnabled}
            control={<FormNumber id="sdk-port" defaultValue={config.session_server?.port ?? 7890} min={1024} max={65535} readOnly={!sdkEnabled} />} />
        </SettingsDisclosure>

        <SettingsDisclosure id="advanced-raw" data-testid="advanced-disclosure-raw" label="Raw config" summary="Read only">
          <SettingsMonoBlock label="Current config" text={JSON.stringify(config, null, 2)} data-testid="advanced-raw-config" />
        </SettingsDisclosure>
        {formError && <p className="settings-row-error" role="alert" data-testid="advanced-save-error">{formError}</p>}
      </SettingsGroup>
    </SectionCard>
  );
}
