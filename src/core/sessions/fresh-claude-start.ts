/**
 * How this Mac would start a FRESH Claude Code session of a new task in folder `cwd` on host
 * `host`, for a run a host starts itself while this Mac is away. One place, for every run that
 * starts from the routine (plain-session) template there:
 *
 *   - a claude-code routine's run on its host (clock-host-start-v1, routines/clock-routine-start.ts);
 *   - a task-targeted routine's away run (routines/offline-run.ts: its engine and effort);
 *   - a new task of a project (`defaults`: its session defaults), made on that host while this
 *     Mac is away.
 *
 * The engine: the project's when it set one, through the same availability and host check
 * every launch takes (inheritedEnginePick); else the inherited default as a host start takes
 * it, deterministic (default-engine.ts hostStartDefaultEngine). Anything but Claude Code is no
 * start (null). The model only with the project's own engine.
 * The mode: the project's when it names one (`modeNamed`), else what the engine's own settings
 * on that host choose (resolveClaudeLaunchMode). The model and effort: the launch defaults every
 * spawn takes (claude-launch-defaults.ts: the project's effort, Walnut's default model and effort).
 * The context: the session context this Mac appends, built for a task whose id is
 * START_TASK_TOKEN (the host mints it) and whose title the caller gives (a routine's literal
 * title, or a title token for a project's new task that the host fills in at the create:
 * host-start-core.ts planTask `titleToken`).
 *
 * Walnut sets no engine default of its own here: no model unless someone chose one.
 */

import { START_TASK_TOKEN } from '../../providers/trigger-clock-core.js';
import type { SessionEffort, SessionMode, Task } from '../types.js';
import type { ProjectLaunchDefaults } from './project-launch-defaults.js';

export interface FreshClaudeStart {
  mode: SessionMode;
  /** True: the project named the mode; false: the engine's own setting on that host chose it. */
  modeNamed: boolean;
  model?: string;
  effort?: SessionEffort;
  context: string;
}

type EngineConfig = { defaults?: { engine?: unknown }; launch_defaults?: { model?: unknown; effort?: unknown } | null; agent?: { session_effort?: unknown } } | null | undefined;

/** A fresh session of these defaults on `host` runs on Claude Code (with the project's model, when its engine is the one): else null. */
export async function freshClaudeEngine(config: EngineConfig, host: string, defaults: ProjectLaunchDefaults = {}): Promise<{ model?: string } | null> {
  const { normalizeEngine } = await import('../agents/engine-registry.js');
  if (!defaults.engine) {
    const { hostStartDefaultEngine } = await import('../agents/default-engine.js');
    return normalizeEngine(hostStartDefaultEngine(config, host)) === undefined ? {} : null;
  }
  const pick = await (await import('./project-launch-defaults.js')).inheritedEnginePick(config, defaults, host);
  if (normalizeEngine(pick.engine) !== undefined) return null;
  return pick.model ? { model: pick.model } : {};
}

/**
 * The session context for a task of this title and project, its id START_TASK_TOKEN. Throws
 * when it cannot be built (a run without it would differ from this Mac's own start).
 */
export async function freshStartContext(task: Partial<Task> & { title: string }, cwd: string, host: string): Promise<string> {
  const { buildSessionContext } = await import('./session-context.js');
  const asTask = { ...task, id: START_TASK_TOKEN } as unknown as Task;
  // This machine's own sessions name no host (fleet-prompt.ts reads none as "here").
  return (await buildSessionContext(START_TASK_TOKEN, cwd, host === '__local__' ? undefined : host, { task: asTask })).systemPrompt;
}

/** The whole start (see the header), or null when it would not run on Claude Code. Throws when its context cannot be built. */
export async function freshClaudeStart(o: {
  config: EngineConfig;
  host: string;
  cwd: string;
  task: Partial<Task> & { title: string };
  defaults?: ProjectLaunchDefaults;
}): Promise<FreshClaudeStart | null> {
  const engine = await freshClaudeEngine(o.config, o.host, o.defaults);
  if (!engine) return null;
  const context = await freshStartContext(o.task, o.cwd, o.host);
  const named = o.defaults?.mode;
  const mode = named ?? (await (await import('../../providers/claude-launch-mode.js')).resolveClaudeLaunchMode(o.host, o.cwd)).mode;
  // The same rule as every spawn on this Mac (claude-launch-defaults.ts).
  const { model, effort } = (await import('./claude-launch-defaults.js')).pickClaudeSpawnDefaults({
    config: o.config, projectEffort: o.defaults?.effort, model: engine.model,
  });
  return { mode, modeNamed: named !== undefined, ...(model ? { model } : {}), ...(effort ? { effort } : {}), context };
}
