/**
 * Settings, Sessions: "Default model" and "Default effort" of Claude Code sessions, Walnut's own
 * two settings (`launch_defaults.model`, `launch_defaults.effort`). Both start Not set: Walnut then passes no
 * --model / --effort and Claude Code's own settings decide, as before. Set, every Claude Code
 * spawn that has none of its own takes them (a new task, a restart, a resume, an engine switch;
 * core/sessions/claude-launch-defaults.ts). A pick at create, a switch in the session and a
 * project's own default win over them.
 *
 *   Default model    [Not set (Claude Code decides: Opus 5.5) v]
 *   Default effort   [Not set (Claude Code decides)           v]
 *     Claude Code's own effort, as last seen: Fable 5.2: Medium, Opus 5.5: High
 *
 * Saves on pick, like Default engine.
 */
import { useEffect, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { SettingsRow } from '../SettingsSection';
import { useOptimisticSetting } from '../inputs/useOptimisticSetting';
import { useModelOptions } from '@/components/sessions/path-selector/model-options';
import { apiGet } from '@/api/client';
import {
  currentDefaultEffort, currentDefaultModel, EFFORT_CHOICES, launchDefaultSave, NOT_SET,
  observedEffortWords, type ObservedDefaultEffort,
} from './claude-launch-defaults-select';
import type { useSerialSave } from './GeneralSection';

type SerialSave = ReturnType<typeof useSerialSave>;

const MODEL_KEY = 'sessions.default-model';
const EFFORT_KEY = 'sessions.default-effort';

/** Claude Code's own effort per model as last seen (GET /api/sessions/claude-default-efforts). */
function useObservedDefaultEfforts(): ObservedDefaultEffort[] | null {
  const [rows, setRows] = useState<ObservedDefaultEffort[] | null>(null);
  useEffect(() => {
    let live = true;
    apiGet<{ models: ObservedDefaultEffort[] }>('/api/sessions/claude-default-efforts', undefined, { priority: 'low' })
      .then((r) => { if (live) setRows(r.models ?? []); }, () => { if (live) setRows([]); });
    return () => { live = false; };
  }, []);
  return rows;
}

export function ClaudeLaunchDefaultsRow({ config, save }: { config: Config; save: SerialSave }) {
  const models = useModelOptions(null);
  const observed = useObservedDefaultEfforts();
  const model = useOptimisticSetting<string>(
    currentDefaultModel(config),
    (v) => save((c) => launchDefaultSave(c, 'model', v), { rowKey: MODEL_KEY }),
    { rowKey: MODEL_KEY },
  );
  const effort = useOptimisticSetting<string>(
    currentDefaultEffort(config),
    (v) => save((c) => launchDefaultSave(c, 'effort', v), { rowKey: EFFORT_KEY }),
    { rowKey: EFFORT_KEY },
  );
  // A saved model this machine's list no longer has stays shown, so a stray change cannot rewrite it.
  const modelRows = model.value && !models.options.some((o) => o.value === model.value)
    ? [{ value: model.value, label: model.value }, ...models.options] : models.options;
  const ccModel = models.autoResolved ? `Claude Code decides: ${models.autoResolved}` : 'Claude Code decides';
  const seen = observed && observed.length > 0 ? observedEffortWords(observed) : '';

  return (
    <>
      <SettingsRow
        label="Default model"
        htmlFor="default-claude-model"
        help="Claude Code sessions with no model of their own start on it. Not set: Claude Code's own setting decides."
        error={model.error}
        data-testid="default-claude-model-row"
        control={
          <select id="default-claude-model" data-testid="default-claude-model" className="settings-select"
            value={model.value} onChange={(e) => model.set(e.target.value)}>
            <option value={NOT_SET}>{`Not set (${ccModel})`}</option>
            {modelRows.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        }
      />
      <SettingsRow
        label="Default effort"
        htmlFor="default-claude-effort"
        help="Sessions with no effort of their own start at it; a task, session or project pick wins. Not set: Claude Code decides."
        error={effort.error}
        data-testid="default-claude-effort-row"
        control={
          <select id="default-claude-effort" data-testid="default-claude-effort" className="settings-select"
            value={effort.value} onChange={(e) => effort.set(e.target.value)}>
            <option value={NOT_SET}>Not set (Claude Code decides)</option>
            {EFFORT_CHOICES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        }
      >
        {seen && (
          <span className="settings-row-help" data-testid="default-claude-effort-observed">
            Claude Code&apos;s own effort, as last seen: {seen}
          </span>
        )}
      </SettingsRow>
    </>
  );
}
