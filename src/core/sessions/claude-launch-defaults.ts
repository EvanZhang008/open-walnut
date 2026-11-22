/**
 * The model and reasoning effort a Claude Code session spawns with when nobody picked them for
 * this spawn: the ONE place every spawn resolves them. A fresh start, a cold `--resume` (a
 * restart, a compaction's respawn, a recovered session), an engine switch's new session and a
 * start a host makes while the Mac is away all call `resolveClaudeSpawnDefaults` (ratchet:
 * tests/core/sessions/claude-launch-defaults-ratchet.test.ts). Only the user's own sessions take
 * the defaults (`takesLaunchDefaults`): Walnut's lanes run on what their starter chose.
 *
 *   effort:  the spawn's own (the launch's pick, or the session's recorded effort, which a
 *            switch in the session writes)  >  its project's `default_effort`  >  Walnut's
 *            `launch_defaults.effort` (Settings > Sessions)  >  none
 *   model:   the spawn's own  >  Walnut's `launch_defaults.model`  >  none
 *            (a project's `default_model` rides its `default_engine` upstream:
 *            project-launch-defaults.ts; a conversation that already has a model keeps it)
 *
 * "None" means no `--effort` / `--model` flag: Claude Code's own settings decide, exactly as
 * before. Both Walnut settings are unset until the user sets them, so Walnut picks nothing for
 * anyone who has not asked it to (CLAUDE.md: Walnut never sets an engine's own defaults; these
 * are the user's own picks, kept in Walnut, never written into Claude Code's settings files).
 *
 * Why the effort default matters (Claude Code 2.1.322, read from its own code): the top-level
 * `effortLevel` in the user's `~/.claude/settings.json` is a legacy value once the file also has
 * `modelSettings` (which `/effort` writes, per model); it then applies only to older models, so a
 * newer model with no `modelSettings` entry runs at its own default (Fable 5.2: medium) even
 * though the file says `effortLevel: "high"`. A `--effort` flag wins over every settings layer.
 */
import { isClaudeModelName, VALID_SESSION_EFFORT_IDS, type SessionEffort } from '../types.js';

/** The config keys this module reads (a structural slice of Config). */
export interface ClaudeLaunchDefaultsConfig {
  launch_defaults?: { model?: unknown; effort?: unknown } | null;
  /** `agent.session_effort`: the older, hand-edited name of the default effort. */
  agent?: { session_effort?: unknown } | null;
}

function effortOf(v: unknown): SessionEffort | undefined {
  return typeof v === 'string' && VALID_SESSION_EFFORT_IDS.has(v) ? v as SessionEffort : undefined;
}

/** True for a model id a Claude Code launch takes (an alias or a catalog value). */
export function isClaudeLaunchModel(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '' && v.trim() !== 'default' && isClaudeModelName(v);
}

/** Walnut's default effort (Settings > Sessions), else the older `agent.session_effort`; unset = none. */
export function walnutDefaultEffort(config: ClaudeLaunchDefaultsConfig | null | undefined): SessionEffort | undefined {
  return effortOf(config?.launch_defaults?.effort) ?? effortOf(config?.agent?.session_effort);
}

/** Walnut's default Claude Code model (Settings > Sessions); unset = none. */
export function walnutDefaultModel(config: ClaudeLaunchDefaultsConfig | null | undefined): string | undefined {
  const m = config?.launch_defaults?.model;
  return isClaudeLaunchModel(m) ? m.trim() : undefined;
}

/**
 * Whether a spawn takes the user's launch defaults at all: the user's own sessions do (a task's,
 * a bare one from the phone or the draft). Walnut's own lanes never do: Ask Walnut, a plugin's
 * `ai.run`, `subagent_run`, the cloud chat, a side thread (a fork that must keep its parent's
 * cache key), and a session with a profile (an area's router) run on what their starter chose.
 */
export function takesLaunchDefaults(s: { lane?: string | null; profile?: unknown } | null | undefined): boolean {
  return !!s && !s.lane && !s.profile;
}

/** Where a spawn's value came from: its own, its project's, Walnut's setting, or nowhere (Claude Code decides). */
export type SpawnDefaultSource = 'own' | 'project' | 'walnut' | 'claude-code';

export interface ClaudeSpawnDefaults {
  model?: string;
  effort?: SessionEffort;
  from: { model: SpawnDefaultSource; effort: SpawnDefaultSource };
}

/**
 * The pure rule (see the header). `keepsModel`: the spawn continues a conversation that already
 * ran on a model (a resume or a fork), so no default model is put under it.
 */
export function pickClaudeSpawnDefaults(o: {
  config: ClaudeLaunchDefaultsConfig | null | undefined;
  projectEffort?: SessionEffort;
  model?: string;
  effort?: SessionEffort;
  keepsModel?: boolean;
}): ClaudeSpawnDefaults {
  const ownModel = o.model && o.model !== 'default' ? o.model : undefined;
  const globalModel = ownModel || o.keepsModel ? undefined : walnutDefaultModel(o.config);
  const model = ownModel ?? globalModel;
  const modelFrom: SpawnDefaultSource = ownModel ? 'own' : globalModel ? 'walnut' : 'claude-code';
  const ownEffort = effortOf(o.effort);
  const globalEffort = walnutDefaultEffort(o.config);
  const defaultEffort = o.projectEffort ?? globalEffort;
  // Not stepped down per model: every Claude family takes every level (types.ts
  // MODEL_EFFORT_FAMILY_DEFAULTS), and for an id Walnut cannot place the CLI decides.
  const effort = ownEffort ?? defaultEffort;
  const effortFrom: SpawnDefaultSource = ownEffort ? 'own' : !effort ? 'claude-code' : o.projectEffort ? 'project' : 'walnut';
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}), from: { model: modelFrom, effort: effortFrom } };
}

/**
 * The model and effort a Claude Code spawn runs on, with its project's default effort read from
 * the registry (`default_effort`; a read that fails is no project default: the spawn goes on).
 */
export async function resolveClaudeSpawnDefaults(o: {
  config: ClaudeLaunchDefaultsConfig | null | undefined;
  project: string | null | undefined;
  model?: string;
  effort?: SessionEffort;
  keepsModel?: boolean;
}): Promise<ClaudeSpawnDefaults> {
  let projectEffort: SessionEffort | undefined;
  if (!effortOf(o.effort) && o.project !== undefined && o.project !== null) {
    const { projectLaunchDefaultsOf } = await import('./project-launch-defaults.js');
    projectEffort = (await projectLaunchDefaultsOf(o.project).catch(() => ({ effort: undefined }))).effort;
  }
  return pickClaudeSpawnDefaults({ ...o, projectEffort });
}

/** One model's effort as Claude Code itself chose it: a session Walnut gave no --effort reported it. */
export interface ObservedClaudeDefaultEffort {
  /** The model the CLI reported (its own id, e.g. "claude-fable-5-2"). */
  model: string;
  effort: SessionEffort;
  /** When that session was last active (ISO). */
  at: string;
  sessionId: string;
}

/**
 * What Claude Code's own default effort is per model, as last seen: for each model, the most recent
 * Claude Code session that ran with no effort from Walnut (no pick, no default) and whose CLI
 * reported the effort it applied (get_settings, `effectiveEffort`). The Settings page shows it under
 * "Default effort" so "Not set" says what it means today. Newest first, one row per model.
 */
export function observedClaudeDefaultEfforts(
  records: ReadonlyArray<{ claudeSessionId: string; engine?: string; model?: string; effort?: string; effectiveEffort?: string; lastActiveAt?: string }>,
): ObservedClaudeDefaultEffort[] {
  const byModel = new Map<string, ObservedClaudeDefaultEffort>();
  for (const r of records) {
    if (r.engine && r.engine !== 'claude') continue;
    if (r.effort !== undefined && r.effort !== null) continue;
    const effort = effortOf(r.effectiveEffort);
    const model = typeof r.model === 'string' ? r.model.trim() : '';
    if (!effort || !model) continue;
    const key = model.toLowerCase().replace(/\[1m\]$/, '');
    const at = r.lastActiveAt ?? '';
    const prev = byModel.get(key);
    if (!prev || at > prev.at) byModel.set(key, { model, effort, at, sessionId: r.claudeSessionId });
  }
  return [...byModel.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
