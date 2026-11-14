/**
 * A project's launch defaults: the engine, model and permission mode a NEW task
 * of that project starts on when its launch names none (the project's Settings;
 * `task_projects.metadata` keys default_engine / default_model / default_mode,
 * beside default_cwd / default_host).
 *
 *   value a new session runs on:   the launch's own  >  the project's  >  the global default
 *
 * Engine and model are ONE pair, because a model id belongs to one engine's
 * catalog: a launch that names an engine, a model or an effort chose its own pair
 * and takes nothing from the project; one that names none takes the project's
 * engine and, with it, the project's model. Mode is engine-neutral (a Walnut
 * permission mode every engine maps), so it falls through on its own.
 *
 * A project with none of the three keys launches exactly as before. A task that
 * already holds its conversation continues it on its own engine: none of this
 * applies to a continue, an engine switch or a transfer.
 *
 * The engine still goes through resolveDefaultEngine (default-engine.ts), the
 * same demotion the global default gets: an engine this machine does not have,
 * or an ACP engine on a remote host, starts on Claude Code instead, and the
 * project's model (which named the other engine's catalog) is dropped with it.
 * When that engine is out of usage, the fallback engine (fallback-engine.ts)
 * takes over exactly as it does for the global default: the project only says
 * which engine is the default here.
 */
import {
  resolveModelSwitchValue, SESSION_MODES, VALID_SESSION_MODE_IDS,
  type SessionEngine, type SessionMode,
} from '../types.js';
import { isKnownEngine } from '../agents/engine-registry.js';

/** The three metadata keys, in the order the settings list them. */
export const PROJECT_LAUNCH_DEFAULT_KEYS = ['default_engine', 'default_model', 'default_mode'] as const;

export interface ProjectLaunchDefaults {
  engine?: SessionEngine;
  /** A model of `engine`'s catalog (raw picker value); never present without `engine`. */
  model?: string;
  mode?: SessionMode;
}

/** Where one launch value came from. `fallback`: the default engine was out of usage. */
export type LaunchValueSource = 'task' | 'project' | 'global' | 'fallback' | 'folder';

/** Recorded on a session at its start (SessionRecord.launch_source): what decided each value. */
export interface LaunchSourceRecord {
  engine: LaunchValueSource;
  model: LaunchValueSource;
  mode: LaunchValueSource;
  /** The project whose defaults applied, when any did. */
  project?: string;
  /** What the start ran on (model: the CLI's or the adapter's id; absent = the engine's default;
   *  mode absent = the launch default): a later change in the session reads as its own pick. */
  started?: { engine: SessionEngine; model?: string; mode?: SessionMode };
}

/** A refused settings write: the route answers it as a 400. */
export class ProjectSettingsError extends Error {
  readonly statusCode = 400;
}

function modelOk(model: string): boolean {
  return resolveModelSwitchValue(model) !== null;
}

/**
 * The defaults a registry row holds. Tolerant: a value that no longer reads as
 * valid (an engine removed from the registry, a hand-edited blob) is left out,
 * so the launch falls back to the global default instead of failing.
 */
export function readProjectLaunchDefaults(meta: Record<string, unknown> | null | undefined): ProjectLaunchDefaults {
  if (!meta) return {};
  const engine = isKnownEngine(meta.default_engine) ? meta.default_engine : undefined;
  const rawModel = typeof meta.default_model === 'string' ? meta.default_model.trim() : '';
  const model = engine && rawModel && rawModel !== 'default' && modelOk(rawModel) ? rawModel : undefined;
  const mode = typeof meta.default_mode === 'string' && VALID_SESSION_MODE_IDS.has(meta.default_mode)
    ? meta.default_mode as SessionMode : undefined;
  return { ...(engine ? { engine } : {}), ...(model ? { model } : {}), ...(mode ? { mode } : {}) };
}

/**
 * The project a launch's defaults belong to: the name a task, a draft or a phone carries may be one
 * the project was renamed or merged away from, and the survivor's are its defaults. '' for Inbox
 * or a deleted project.
 */
export async function launchProjectName(project: string | null | undefined): Promise<string> {
  const trimmed = project?.trim() ?? '';
  if (!trimmed) return '';
  const tm = await import('../task-manager.js');
  return Promise.resolve().then(() => tm.resolveProjectForWrite(trimmed, 'launch-defaults'))
    .then((r) => (r?.blocked ? '' : r?.name || trimmed), () => trimmed);
}

/** The defaults of a project by name; empty for Inbox ('') or an unknown project. */
export async function projectLaunchDefaultsOf(project: string | null | undefined): Promise<ProjectLaunchDefaults> {
  const name = await launchProjectName(project);
  if (!name) return {};
  const tm = await import('../task-manager.js');
  // A read that fails (or a stub that answers nothing) is no defaults: the launch goes on as before.
  return readProjectLaunchDefaults(await Promise.resolve().then(() => tm.getProjectMetadata(name)).catch(() => null));
}

/** True when the defaults hold anything at all (none = the launch is unchanged). */
export function hasLaunchDefaults(d: ProjectLaunchDefaults): boolean {
  return d.engine !== undefined || d.mode !== undefined;
}

/**
 * A launch that named an engine or a model chose its own engine and model. An effort alone does
 * not: it tunes the model the launch runs, the project's one included.
 */
export function launchNamesOwnPair(named: { engine?: unknown; model?: unknown }): boolean {
  return named.engine !== undefined
    || (typeof named.model === 'string' && named.model !== '' && named.model !== 'default');
}

/** The engine (and model) a launch that named neither inherits, before the fallback engine. */
export interface InheritedEnginePick {
  engine: SessionEngine;
  /** The project's model, only when its engine is the one that runs. */
  model?: string;
  from: 'project' | 'global';
}

/**
 * The default engine for this launch: the project's when it set one, else the
 * global one, both through the same availability and host check
 * (resolveDefaultEngine). A project engine that check demotes is no project pick.
 */
export async function inheritedEnginePick(
  config: { defaults?: { engine?: unknown } } | null | undefined,
  defaults: ProjectLaunchDefaults,
  host: string | null | undefined,
): Promise<InheritedEnginePick> {
  const { resolveDefaultEngine, ensureEngineVerdict } = await import('../agents/default-engine.js');
  if (defaults.engine) {
    await ensureEngineVerdict(defaults.engine).catch(() => {});
    const engine = resolveDefaultEngine({ defaults: { engine: defaults.engine } }, { host });
    if (engine === defaults.engine) return { engine, ...(defaults.model ? { model: defaults.model } : {}), from: 'project' };
    return { engine, from: 'global' };
  }
  return { engine: resolveDefaultEngine(config, { host }), from: 'global' };
}

/** What a new-task launch (the web draft, the phone) runs on, and why. */
export interface LaunchDefaultsPick {
  /** Storage shape: the default engine is absent (normalizeEngine). */
  engine: Exclude<SessionEngine, 'claude'> | undefined;
  /** The project's or the fallback's model; absent when the launch named its own or none applies. */
  model?: string;
  /** The project's mode, only when the launch named none. */
  mode?: SessionMode;
  fallback: import('../agents/fallback-engine.js').FallbackDecision | null;
  source: LaunchSourceRecord;
}

/**
 * The engine, model and mode of a launch that creates or first starts a task
 * (POST /api/sessions/quick-start, the phone's POST /api/v1/sessions), from what
 * it named, its project's defaults and the global default, with the fallback
 * engine when `decidesFallback`. A launch that names a model but no engine keeps
 * the global default engine, as it always did on these routes.
 */
export async function pickLaunchDefaults(o: {
  config: { defaults?: { engine?: unknown; fallback_engine?: unknown } } | null | undefined;
  project: string | null | undefined;
  host: string | null | undefined;
  named: { engine?: unknown; model?: unknown; mode?: unknown };
  decidesFallback: boolean;
}): Promise<LaunchDefaultsPick> {
  const { normalizeEngine } = await import('../agents/engine-registry.js');
  const { resolveDefaultEngine } = await import('../agents/default-engine.js');
  const projectName = await launchProjectName(o.project);
  const defaults = await projectLaunchDefaultsOf(projectName);
  const namedMode = typeof o.named.mode === 'string' && o.named.mode !== '';
  const mode = namedMode ? undefined : defaults.mode;
  const modeFrom: LaunchValueSource = namedMode ? 'task' : mode ? 'project' : 'global';
  const done = (p: Omit<LaunchDefaultsPick, 'mode' | 'source'> & { from: Pick<LaunchSourceRecord, 'engine' | 'model'> }): LaunchDefaultsPick => {
    const source: LaunchSourceRecord = { ...p.from, mode: modeFrom };
    if (Object.values(source).includes('project') && projectName) source.project = projectName;
    return {
      engine: p.engine, ...(p.model ? { model: p.model } : {}), ...(mode ? { mode } : {}), fallback: p.fallback, source,
    };
  };
  if (launchNamesOwnPair(o.named)) {
    const named = o.named.engine !== undefined;
    // An engine named alone runs its own default model: no one picked that.
    const namedModel = !!o.named.model && o.named.model !== 'default';
    return done({
      engine: named ? normalizeEngine(o.named.engine) : normalizeEngine(resolveDefaultEngine(o.config, { host: o.host })),
      fallback: null, from: { engine: named ? 'task' : 'global', model: namedModel ? 'task' : 'global' },
    });
  }
  const pick = await inheritedEnginePick(o.config, defaults, o.host);
  if (o.decidesFallback) {
    const { resolveFallbackLaunch } = await import('../agents/fallback-engine.js');
    const fallback = await resolveFallbackLaunch(o.config, pick.engine, o.host || undefined).catch(() => null);
    if (fallback) {
      return done({ engine: normalizeEngine(fallback.engine), model: fallback.model, fallback, from: { engine: 'fallback', model: 'fallback' } });
    }
  }
  return done({
    engine: normalizeEngine(pick.engine), model: pick.model, fallback: null,
    from: { engine: pick.from, model: pick.model ? 'project' : 'global' },
  });
}

/**
 * A metadata patch, checked and completed against the row's current blob, before
 * the merge writes it. `undefined` in the patch is a clear (the merge drops the key).
 *
 * - default_engine must be a known engine; clearing or changing it clears the
 *   model unless the same patch names one (the old model named the old engine).
 * - default_model needs an engine (in the patch or already set) and a model id
 *   the launch path takes.
 * - default_mode must be a permission mode id.
 */
export function checkLaunchDefaultsPatch(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const touches = PROJECT_LAUNCH_DEFAULT_KEYS.some((k) => Object.hasOwn(patch, k));
  if (!touches) return patch;
  const out = checkLaunchDefaultsShape(patch);
  const engineAfter = Object.hasOwn(out, 'default_engine') ? out.default_engine : current.default_engine;
  const engineChanged = Object.hasOwn(out, 'default_engine') && out.default_engine !== current.default_engine;
  if (engineChanged && !Object.hasOwn(out, 'default_model')) out.default_model = undefined;
  if (out.default_model !== undefined && !isKnownEngine(engineAfter)) {
    throw new ProjectSettingsError('default_model needs default_engine: a model belongs to one engine');
  }
  return out;
}

/**
 * The values alone, before any row is read or made (a refused write leaves nothing behind): a
 * known engine, a model id, a mode. Returns the patch with the model trimmed ('default' = unset).
 */
export function checkLaunchDefaultsShape(patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...patch };
  if (Object.hasOwn(out, 'default_engine') && out.default_engine !== undefined) {
    if (!isKnownEngine(out.default_engine)) {
      throw new ProjectSettingsError(`default_engine must be a known engine, not ${JSON.stringify(out.default_engine)}`);
    }
  }
  if (Object.hasOwn(out, 'default_model') && out.default_model !== undefined) {
    const model = typeof out.default_model === 'string' ? out.default_model.trim() : '';
    if (!model || model === 'default') out.default_model = undefined;
    else if (!modelOk(model)) throw new ProjectSettingsError(`default_model is not a model id: ${JSON.stringify(out.default_model)}`);
    else out.default_model = model;
  }
  if (Object.hasOwn(out, 'isolated_workspace') && out.isolated_workspace !== undefined
    && out.isolated_workspace !== 'on' && out.isolated_workspace !== 'off') {
    throw new ProjectSettingsError(`isolated_workspace must be "on" or "off" (null follows the global setting), not ${JSON.stringify(out.isolated_workspace)}`);
  }
  if (Object.hasOwn(out, 'default_mode') && out.default_mode !== undefined) {
    if (typeof out.default_mode !== 'string' || !VALID_SESSION_MODE_IDS.has(out.default_mode)) {
      throw new ProjectSettingsError(`default_mode must be one of: ${SESSION_MODES.map((m) => m.id).join(', ')}`);
    }
  }
  return out;
}
