/**
 * Settings, Sessions: "Default model" and "Default effort" of Claude Code sessions
 * (`launch_defaults.model`, `launch_defaults.effort`; the server's rule is
 * core/sessions/claude-launch-defaults.ts).
 *
 * Pure: what the rows read and what a pick writes.
 */
import type { Config, SessionEffort } from '@open-walnut/core';
import { SESSION_EFFORTS, VALID_SESSION_EFFORT_IDS } from '@open-walnut/core';
import { formatModelName } from '@/utils/model-name';

/** The select's value for "Not set": Claude Code decides. */
export const NOT_SET = '';

export function currentDefaultModel(config: Pick<Config, 'launch_defaults'> | undefined): string {
  const m = config?.launch_defaults?.model;
  return typeof m === 'string' && m.trim() && m.trim() !== 'default' ? m.trim() : NOT_SET;
}

export function currentDefaultEffort(config: Pick<Config, 'launch_defaults' | 'agent'> | undefined): SessionEffort | typeof NOT_SET {
  const e = config?.launch_defaults?.effort ?? config?.agent?.session_effort;
  return typeof e === 'string' && VALID_SESSION_EFFORT_IDS.has(e) ? e as SessionEffort : NOT_SET;
}

/**
 * The config patch for a pick of one of the two (`NOT_SET` clears it). The Settings page saves a
 * section whole (saveSection rebases it: a key left undefined is removed, one left out of the
 * section is removed too), so the sibling is spread back, as defaultEngineSave does. Effort also
 * clears the older hand-edited `agent.session_effort` the row reads as its fallback, keeping
 * every other agent setting, so the row reads afterwards what was picked.
 */
export function launchDefaultSave(
  config: Pick<Config, 'launch_defaults' | 'agent'>, key: 'model' | 'effort', value: string,
): Partial<Config> {
  const launch = { ...config.launch_defaults, [key]: value === NOT_SET ? undefined : value } as Config['launch_defaults'];
  const patch: Partial<Config> = { launch_defaults: launch };
  if (key === 'effort' && config.agent?.session_effort !== undefined) {
    patch.agent = { ...config.agent, session_effort: undefined } as Config['agent'];
  }
  return patch;
}

/** Effort choices, in order, with their names ("X-High"). */
export const EFFORT_CHOICES: ReadonlyArray<{ value: SessionEffort; label: string }> =
  SESSION_EFFORTS.map((e) => ({ value: e.id, label: e.label }));

export function effortName(e: string): string {
  return EFFORT_CHOICES.find((c) => c.value === e)?.label ?? e;
}

export interface ObservedDefaultEffort { model: string; effort: string; at: string; sessionId: string }

/** "Fable 5.2: Medium, Opus 5.5: High": Claude Code's own effort per model as last seen. */
export function observedEffortWords(rows: readonly ObservedDefaultEffort[], max = 4): string {
  return rows.slice(0, max).map((r) => `${formatModelName(r.model) || r.model}: ${effortName(r.effort)}`).join(', ');
}
