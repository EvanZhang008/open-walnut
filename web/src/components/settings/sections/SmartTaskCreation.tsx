import { useEffect, useRef, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { SettingsGroup, SettingsRow } from '../SettingsSection';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { couldntSave } from '../inputs/useOptimisticSetting';
import { saveErrorMessage } from '../settings-pane-context';
import { JevSettings } from './JevSettings';
import { useSerialSave, type OnSave } from './GeneralSection';
import { resolveMainProvider } from './main-provider';
import { fetchConfig } from '@/api/config';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { log } from '@/utils/log';

interface Props {
  config: Config;
  onSave: OnSave;
  onReload: () => Promise<void>;
}

type Runner = 'default' | 'jev';

export { API_LABELS } from './main-provider';

type Providers = Parameters<typeof resolveMainProvider>[1];

/** Name of whoever answers when Jev is not picked: Claude Code, or the API in effect. */
export function defaultRunnerName(provider: string | undefined, providers?: Providers): string {
  // A named entry resolves through its `api` (N01); an unknown id never shows raw (F14).
  return resolveMainProvider(provider, providers).label;
}

/** Help under `Uses` (pure, unit tested). */
export function usesHelp(runner: Runner, provider: string | undefined, providers?: Providers): string {
  if (runner === 'jev') return 'Under a second, fractions of a cent.';
  const name = defaultRunnerName(provider, providers);
  if (name === 'Claude Code') return 'Slow: each guess starts Claude Code once.';
  return name === 'Your API' ? 'Slow: each guess calls your API once.' : `Slow: each guess calls ${name} once.`;
}

/**
 * Jev answers when the section exists and at least one of its decisions is
 * not switched off. `getJevClient` treats the section itself as the opt-in, so
 * "Default engine" is written as both decisions off rather than as a deleted
 * section: the endpoint and model a user typed survive a round trip.
 */
function runnerOf(config: Config): Runner {
  const d = config.jev?.decisions;
  if (!config.jev) return 'default';
  return d?.quick_parse === false && d?.session_organize === false ? 'default' : 'jev';
}

type Want = { fillDetails: boolean; fileSessions: boolean; runner: Runner };

function wantOf(config: Config): Want {
  return {
    fillDetails: config.agent?.quick_parse === true,
    fileSessions: config.agent?.session_organize !== false,
    runner: runnerOf(config),
  };
}

/**
 * Settings, Tasks, Smart task creation: the two things Walnut guesses for
 * you when a task is born, and who answers.
 *
 * Every write (both switches and the radio) goes through ONE queue, one PUT at
 * a time, each carrying the newest local choice spread over a FRESH server
 * read. updateConfig replaces a whole top-level key, so a write spreading this
 * page's copy would undo a change made elsewhere (the composer's + menu writes
 * `agent` too), and two concurrent PUTs can land in either order (caught by
 * settings-smart-task-creation.spec.ts: the second switch undid the first).
 */
export function SmartTaskCreation({ config, onSave, onReload }: Props) {
  const [want, setWant] = useState<Want>(() => wantOf(config));
  const latest = useRef(want);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);
  // Keys the user changed that the queue has not finished saving. A write
  // carries ONLY these, and a refresh overrides every other key: this page
  // does not hear other windows, so its copy of an untouched switch may be stale.
  const touched = useRef(new Set<keyof Want>());
  const [busy, setBusy] = useState<Partial<Record<keyof Want, boolean>>>({});
  // Row errors stay until that row is edited again or saves (never timed).
  const [errors, setErrors] = useState<Partial<Record<keyof Want, string>>>({});
  const { health } = useSystemHealth();
  // Shared with every other row write (Jev's endpoint and model save `jev` too).
  const save = useSerialSave(config, onSave);

  const adopt = (next: Want) => { latest.current = next; setWant(next); };

  useEffect(() => {
    const server = wantOf(config);
    const mine = latest.current;
    const t = touched.current;
    adopt({
      fillDetails: t.has('fillDetails') ? mine.fillDetails : server.fillDetails,
      fileSessions: t.has('fileSessions') ? mine.fileSessions : server.fileSessions,
      runner: t.has('runner') ? mine.runner : server.runner,
    });
  }, [config]);

  const enqueue = (keys: (keyof Want)[], write: () => Promise<void>) => {
    pending.current += 1;
    setBusy((b) => ({ ...b, ...Object.fromEntries(keys.map((k) => [k, true])) }));
    setErrors((e) => {
      const next = { ...e };
      for (const k of keys) delete next[k];
      return next;
    });
    chain.current = chain.current.then(async () => {
      try {
        await write();
      } catch (err) {
        const message = saveErrorMessage(err);
        log.error('settings', 'smart task creation save failed', { error: message });
        setErrors((e) => ({ ...e, ...Object.fromEntries(keys.map((k) => [k, couldntSave(message)])) }));
        // Nothing newer queued: show what the server really holds, or the
        // control keeps claiming a change that was never saved.
        if (pending.current === 1) {
          touched.current.clear();
          try { adopt(wantOf(await fetchConfig())); } catch { /* keep the local view */ }
        }
      } finally {
        pending.current -= 1;
        if (pending.current === 0) {
          touched.current.clear();
          setBusy({});
        }
      }
    });
  };

  const setSwitch = (key: 'fillDetails' | 'fileSessions', v: boolean) => {
    touched.current.add(key);
    adopt({ ...latest.current, [key]: v });
    // Built when the job runs, from the config the page rendered: saveSection
    // diffs against that same render and lays the change over a fresh read.
    enqueue([key], () => save((c) => {
      const w = latest.current;
      const t = touched.current;
      return {
        agent: {
          ...c.agent,
          ...(t.has('fillDetails') ? { quick_parse: w.fillDetails } : {}),
          ...(t.has('fileSessions') ? { session_organize: w.fileSessions } : {}),
        } as Config['agent'],
      };
    }, { rowKey: `tasks.smart.${key}` }));
  };

  const pickRunner = (next: Runner) => {
    if (next === latest.current.runner) return;
    touched.current.add('runner');
    adopt({ ...latest.current, runner: next });
    enqueue(['runner'], () => save((c) => {
      // The last pick wins: read when the job runs, not when it was queued.
      const on = latest.current.runner === 'jev';
      // Only `decisions` differs from the render, so the rest of `jev` (endpoint,
      // model, the api_key file ref) rides along from the server's fresh copy.
      return { jev: { ...c.jev, decisions: { quick_parse: on, session_organize: on } } };
    }, { rowKey: 'tasks.smart.runner' }));
  };

  // Explicit choice, else the server's resolved default (Claude Code when it is
  // installed, an API otherwise). Unknown until health loads: say Claude Code.
  const provider = config.agent?.main_provider ?? health.mainProvider;
  const { fillDetails, fileSessions, runner } = want;

  return (
    <SettingsGroup heading="Smart task creation" data-testid="smart-task-creation">
      <SettingsRow
        label="Fill in details as you type"
        help="Guesses the tier, priority, due date and project; same switch as the composer's + menu."
        htmlFor="smart-fill-details"
        error={errors.fillDetails}
        control={
          <ToggleSwitch id="smart-fill-details" checked={fillDetails} busy={busy.fillDetails} onChange={(v) => setSwitch('fillDetails', v)} />
        }
      />
      <SettingsRow
        label="File new sessions into a project"
        help="A session started without a project lands in its best match instead of the Inbox."
        htmlFor="smart-file-sessions"
        error={errors.fileSessions}
        control={
          <ToggleSwitch id="smart-file-sessions" checked={fileSessions} busy={busy.fileSessions} onChange={(v) => setSwitch('fileSessions', v)} />
        }
      />
      <SettingsRow
        label="Uses"
        help={usesHelp(runner, provider, config.providers)}
        error={errors.runner}
        data-testid="smart-runner-row"
        control={
          <SegmentedControl<Runner>
            aria-label="Smart task creation uses"
            name="smart-task-runner"
            value={runner}
            onChange={pickRunner}
            options={[
              { value: 'default', label: defaultRunnerName(provider, config.providers), testId: 'smart-runner-default' },
              { value: 'jev', label: 'Jev', testId: 'smart-runner-jev' },
            ]}
          />
        }
      />
      {runner === 'jev' && <JevSettings config={config} onSave={onSave} onReload={onReload} />}
    </SettingsGroup>
  );
}
