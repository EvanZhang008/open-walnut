import { useEffect, useRef, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { SettingsSubCard } from '../SettingsSection';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { JevSettings } from './JevSettings';
import { fetchConfig } from '@/api/config';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { log } from '@/utils/log';

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
  onReload: () => Promise<void>;
}

type Runner = 'default' | 'jev';

/** A radio option is a sentence, not a field caption: `.form-group label`
 *  uppercases and letter-spaces every label, and inline style is what beats that
 *  (0,1,1) rule without a new stylesheet. */
const OPTION_LABEL = {
  display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4,
  fontSize: 14, fontWeight: 400, textTransform: 'none', letterSpacing: 'normal', color: 'var(--fg)',
} as const;

/** Display names for an API `agent.main_provider` (Advanced › Use an API). */
const API_LABELS: Record<string, string> = {
  bedrock: 'AWS Bedrock',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  gemini: 'Google Gemini',
  ollama: 'Ollama',
};

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
 * Settings › Tasks › Smart task creation: the two things Walnut guesses for
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
  const { health } = useSystemHealth();

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

  const enqueue = (write: () => Promise<void>) => {
    pending.current += 1;
    chain.current = chain.current.then(async () => {
      try {
        await write();
      } catch (err) {
        log.error('settings', 'smart task creation save failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        // Nothing newer queued: show what the server really holds, or the
        // control keeps claiming a change that was never saved.
        if (pending.current === 1) {
          try { adopt(wantOf(await fetchConfig())); } catch { /* keep the local view */ }
        }
      } finally {
        pending.current -= 1;
        if (pending.current === 0) touched.current.clear();
      }
    });
  };

  const setSwitch = (patch: Partial<Pick<Want, 'fillDetails' | 'fileSessions'>>) => {
    for (const key of Object.keys(patch) as (keyof Want)[]) touched.current.add(key);
    adopt({ ...latest.current, ...patch });
    enqueue(async () => {
      const w = latest.current;
      const t = touched.current;
      const fresh = await fetchConfig();
      await onSave({
        agent: {
          ...fresh.agent,
          ...(t.has('fillDetails') ? { quick_parse: w.fillDetails } : {}),
          ...(t.has('fileSessions') ? { session_organize: w.fileSessions } : {}),
        },
      });
    });
  };

  const pickRunner = (next: Runner) => {
    if (next === latest.current.runner) return;
    touched.current.add('runner');
    adopt({ ...latest.current, runner: next });
    enqueue(async () => {
      const w = latest.current.runner;
      const fresh = await fetchConfig();
      if (runnerOf(fresh) === w) return;
      const on = w === 'jev';
      // The rest of `jev` rides along from the server's copy: the endpoint and
      // model form autosaves the same key, and api_key is a ${file:} ref.
      await onSave({ jev: { ...fresh.jev, decisions: { quick_parse: on, session_organize: on } } });
    });
  };

  // Explicit choice, else the server's resolved default (Claude Code when it is
  // installed, an API otherwise). Unknown until health loads: say Claude Code's
  // generic name rather than guess an API.
  const provider = config.agent?.main_provider ?? health.mainProvider;
  const apiProvider = provider && provider !== 'claude_cli' ? provider : undefined;
  const defaultLabel = apiProvider
    ? `Default (${API_LABELS[apiProvider] ?? apiProvider}, set under Advanced)`
    : 'Default engine (Claude Code)';
  const { fillDetails, fileSessions, runner } = want;

  return (
    <SettingsSubCard title="Smart task creation">
      <div data-testid="smart-task-creation">
        <div className="form-group">
          <ToggleSwitch
            id="smart-fill-details"
            checked={fillDetails}
            onChange={(v) => setSwitch({ fillDetails: v })}
            label="Fill in the details when you type a task"
          />
          <p className="text-sm text-muted" style={{ marginTop: 2 }}>
            Guesses the tier, priority, due date and project from what you type. Same switch as the
            one in the composer&rsquo;s + menu.
          </p>
        </div>

        <div className="form-group">
          <ToggleSwitch
            id="smart-file-sessions"
            checked={fileSessions}
            onChange={(v) => setSwitch({ fileSessions: v })}
            label="File new sessions into the right project"
          />
          <p className="text-sm text-muted" style={{ marginTop: 2 }}>
            A session started without a project lands in its best-matching project instead of the Inbox.
          </p>
        </div>

        <div className="form-group" role="radiogroup" aria-label="Smart task creation uses">
          <label>Uses</label>
          <label style={OPTION_LABEL}>
            <input
              type="radio"
              name="smart-task-runner"
              value="default"
              checked={runner === 'default'}
              onChange={() => pickRunner('default')}
              data-testid="smart-runner-default"
            />
            <span>
              {defaultLabel}
              <span className="text-sm text-muted"> · slow: each guess starts it once</span>
            </span>
          </label>
          <label style={OPTION_LABEL}>
            <input
              type="radio"
              name="smart-task-runner"
              value="jev"
              checked={runner === 'jev'}
              onChange={() => pickRunner('jev')}
              data-testid="smart-runner-jev"
            />
            <span>
              Jev
              <span className="text-sm text-muted"> · under a second, fractions of a cent</span>
            </span>
          </label>
        </div>

        {runner === 'jev' && (
          <div style={{ paddingLeft: 24 }}>
            <JevSettings config={config} onSave={onSave} onReload={onReload} />
          </div>
        )}
      </div>
    </SettingsSubCard>
  );
}
