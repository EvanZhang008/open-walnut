/**
 * Where a new task's engine, model and permission mode come from, and the words
 * every surface uses for it (the project's settings, the draft's pills and model
 * picker, a running session's picker).
 *
 *   the task's own pick  >  its project's default  >  the global default
 *
 * Same chain as the server (src/core/sessions/project-launch-defaults.ts):
 * engine and model are one pair (a pick of either is the task's own pair), the
 * mode falls through on its own. A draft also has the folder's launch memory
 * (the last pick in that folder): it sits under the project's default, which is
 * a setting, and over the global one.
 */
import { useEffect, useState } from 'react';
import { DEFAULT_SESSION_MODE, SESSION_MODE_LABELS, type SessionEngine, type SessionMode } from '@open-walnut/core';
import { fetchConfig } from '@/api/config';
import { useEvent } from '@/hooks/useWebSocket';
import type { ProjectLaunchDefaults } from '@/hooks/useProjectRegistry';
import { engineEntry, isRemoteHost, normalizeEngine, resolveEngine, resolveEngineForHost, type EngineCatalog, type LaunchEngine } from './engines';

/** The server's sources plus the draft's folder memory, and 'engine': a model nobody set (there
 *  is no global model setting, so the engine's own default). */
export type LaunchValueSource = 'task' | 'project' | 'global' | 'fallback' | 'folder' | 'engine';

/** As the server records it on a task (Task.launch_source). */
export interface LaunchSourceRecord {
  engine: LaunchValueSource;
  model: LaunchValueSource;
  mode: LaunchValueSource;
  project?: string;
  /** What the start ran on: a value the session changed since reads as its own pick. */
  started?: { engine: SessionEngine; model?: string; mode?: SessionMode };
}

/**
 * A running session's sources: the task's record of its start, with any value the session
 * changed since (a model switch, a mode change) read as the task's own pick.
 */
export function sessionLaunchFrom(
  rec: LaunchSourceRecord,
  now: { engine: SessionEngine; model?: string; mode?: SessionMode; modeChosen?: boolean },
): { engine: LaunchValueSource; model: LaunchValueSource; mode: LaunchValueSource } {
  const s = rec.started;
  if (!s) return { engine: rec.engine, model: rec.model, mode: rec.mode };
  return {
    engine: s.engine !== now.engine ? 'task' : rec.engine,
    // `now.model` is the model Walnut runs the CLI on (absent = the CLI's own default): absent,
    // or the same model in another spelling (an alias, the CLI's id), is unchanged; one named
    // after a start on the default is a switch (or, rarely, Walnut's own guard against a CLI
    // default outside Claude, which then reads as the task's too).
    model: now.model && (!s.model || !sameModel(s.model, now.model)) ? 'task' : rec.model,
    // A start that named no mode runs in the engine's own default (Claude Code: its settings, else
    // Auto): only a mode picked since is the task's own.
    mode: (s.mode ? !!now.mode && now.mode !== s.mode : !!now.modeChosen) ? 'task' : rec.mode,
  };
}

/**
 * One model in two spellings: an alias and the CLI's id ("haiku", "claude-haiku-4-5-20251001"),
 * a provider prefix, a date suffix or a context marker. Absent is the engine's default.
 */
export function sameModel(a: string | undefined, b: string | undefined): boolean {
  const n = (m: string | undefined) => (m ?? '').toLowerCase()
    .replace(/^([a-z]{2}\.|global\.)?(anthropic\.)?claude-/, '').replace(/\[1m\]$/, '').replace(/-\d{8}(-v\d+(:\d+)?)?$/, '');
  const x = n(a); const y = n(b);
  if (!x || !y) return x === y;
  return x === y || x.startsWith(`${y}-`) || y.startsWith(`${x}-`);
}

/** "Project default (Walnut)", "Global default", ... one short phrase per source. */
export function launchSourceWords(source: LaunchValueSource, project?: string): string {
  switch (source) {
    case 'task': return 'Picked for this task';
    case 'project': return project ? `Default of project ${project}` : 'Project default';
    case 'folder': return 'Last used in this folder';
    case 'engine': return "The engine's own default model";
    case 'fallback': return 'Fallback engine (the default is out of usage)';
    default: return 'Global default';
  }
}

/** The short tag a pill or row carries: "Project", "Global", "Task", "Folder", "Fallback". */
export function launchSourceTag(source: LaunchValueSource): string {
  switch (source) {
    case 'task': return 'Task';
    case 'project': return 'Project';
    case 'folder': return 'Folder';
    case 'engine': return 'Default';
    case 'fallback': return 'Fallback';
    default: return 'Global';
  }
}

/** What a draft will launch on, and why. */
export interface DraftLaunchChoice {
  /** Storage shape: the default engine is absent. */
  engine: LaunchEngine | undefined;
  model: string | undefined;
  mode: SessionMode;
  from: { engine: LaunchValueSource; model: LaunchValueSource; mode: LaunchValueSource };
  /** The project whose defaults apply, when any do. */
  project?: string;
  /** The project's engine, which does not run where this draft launches (Claude Code does). */
  skipped?: SessionEngine;
}

/**
 * A default engine runs where the launch goes: the server's rule for an engine nobody named
 * (agents/default-engine.ts resolveDefaultEngine) gives one that is not installed, or any ACP
 * engine on a remote host (stricter than a named pick's local-only rule), way to Claude Code.
 */
export function defaultEngineRuns(engine: SessionEngine, host: string | null | undefined, catalog: EngineCatalog): boolean {
  const entry = engineEntry(catalog, engine);
  if (isRemoteHost(host) && entry.runtimeKind === 'acp') return false;
  return resolveEngineForHost(engine, host, catalog) === engine && entry.availability.installed !== false;
}

/**
 * The draft's launch values. `metaTouched`: the user picked the engine or model
 * in this draft (MainPage's latch). `defaults`: the draft's project's, empty for
 * Inbox. `globalEngine`: config.defaults.engine (absent = Claude Code). `runs`:
 * whether the project's engine runs where the draft launches (defaultEngineRuns);
 * one that does not gives way, as on the server.
 */
export function draftLaunchChoice(
  draft: { meta: { engine?: LaunchEngine; model?: string; mode?: SessionMode }; metaTouched?: boolean },
  defaults: ProjectLaunchDefaults & { project?: string },
  globalEngine?: SessionEngine,
  runs?: (engine: SessionEngine) => boolean,
): DraftLaunchChoice {
  const { meta } = draft;
  const mode: SessionMode = meta.mode ?? defaults.mode ?? DEFAULT_SESSION_MODE;
  const modeFrom: LaunchValueSource = meta.mode ? 'task' : defaults.mode ? 'project' : 'global';
  const pair = ((): Pick<DraftLaunchChoice, 'engine' | 'model'> & { from: LaunchValueSource; modelFrom: LaunchValueSource } => {
    // A pick of the engine alone leaves its model to the engine: that reads as its Default.
    if (draft.metaTouched) {
      return { engine: meta.engine, model: meta.model, from: 'task', modelFrom: meta.model && meta.model !== 'default' ? 'task' : 'global' };
    }
    const projectRuns = !!defaults.engine && (runs?.(defaults.engine) ?? true);
    if (defaults.engine && projectRuns) {
      return { engine: normalizeEngine(defaults.engine), model: defaults.model, from: 'project', modelFrom: defaults.model ? 'project' : 'global' };
    }
    if (meta.engine || (meta.model && meta.model !== 'default')) {
      return { engine: meta.engine, model: meta.model, from: meta.engine ? 'folder' : 'global', modelFrom: 'folder' };
    }
    // The project's engine does not run here: the server starts Claude Code, its model's default.
    if (defaults.engine) return { engine: undefined, model: undefined, from: 'global', modelFrom: 'global' };
    return { engine: normalizeEngine(globalEngine), model: undefined, from: 'global', modelFrom: 'global' };
  })();
  const from = { engine: pair.from, model: pair.modelFrom, mode: modeFrom };
  // The project names an engine that gives way here: the draft says so.
  const skipped = defaults.engine && !draft.metaTouched && pair.from !== 'project' ? defaults.engine : undefined;
  const usesProject = Object.values(from).includes('project') || !!skipped;
  return {
    engine: pair.engine, model: pair.model, mode, from,
    ...(usesProject && defaults.project ? { project: defaults.project } : {}),
    ...(skipped ? { skipped } : {}),
  };
}

/**
 * The values a launch sends for a draft: what comes from the project is left out, so the server
 * applies it (and records it as the project's); everything else is sent as it was. One more:
 * Claude Code picked here (absent in the storage shape) is spelled out when the silence would start
 * something else (`otherDefault`, unnamedLaunchIsNotClaude: the project's pair, its model included,
 * or a global engine that is not Claude Code), or the server would read it as "no pick".
 */
export function draftLaunchPayload(
  choice: DraftLaunchChoice,
  meta: { engine?: LaunchEngine; model?: string; mode?: SessionMode },
  otherDefault = false,
): { engine: SessionEngine | undefined; model: string | undefined; mode: SessionMode | undefined } {
  const fromProject = choice.from.engine === 'project';
  const ownClaude = choice.from.engine === 'task' && !meta.engine && otherDefault;
  return {
    engine: fromProject ? undefined : ownClaude ? 'claude' : meta.engine,
    model: fromProject ? undefined : meta.model,
    mode: choice.from.mode === 'project' ? undefined : meta.mode,
  };
}

/**
 * True when a launch that names no engine would not start plain Claude Code: the project sets an
 * engine (its pair, model included, would apply) or the global default is another engine.
 */
export function unnamedLaunchIsNotClaude(defaults: ProjectLaunchDefaults, globalEngine?: SessionEngine): boolean {
  return !!defaults.engine || (globalEngine ?? 'claude') !== 'claude';
}

/** One line of the "where these come from" note: Engine / Model / Permission mode. */
export interface LaunchSourceRow {
  key: 'engine' | 'model' | 'mode';
  label: string;
  value: string;
  source: LaunchValueSource;
  /** "Default of project Walnut", "Global default", ... */
  words: string;
}

/**
 * The note's rows. `engineName`: the engine that runs (the fallback's when it takes the launch);
 * `modelName`: the model's name, absent = that engine's own default; `showMode`: the engine has
 * Walnut's permission modes (an ACP engine sets its own).
 */
export function launchSourceRows(
  from: { engine: LaunchValueSource; model: LaunchValueSource; mode: LaunchValueSource },
  o: { engineName: string; modelName?: string; defaultModelName?: string; mode: SessionMode; modeLabel?: string; showMode: boolean; project?: string; onFallback?: boolean },
): LaunchSourceRow[] {
  const engineFrom: LaunchValueSource = o.onFallback ? 'fallback' : from.engine;
  // No global model setting exists: a model nobody set is the engine's own default.
  const modelFrom: LaunchValueSource = o.onFallback ? 'fallback' : from.model === 'global' ? 'engine' : from.model;
  const rows: LaunchSourceRow[] = [
    { key: 'engine', label: 'Engine', value: o.engineName, source: engineFrom, words: launchSourceWords(engineFrom, o.project) },
    { key: 'model', label: 'Model', value: o.modelName ?? o.defaultModelName ?? `${o.engineName} default`, source: modelFrom, words: launchSourceWords(modelFrom, o.project) },
  ];
  if (o.showMode) {
    // `modeLabel`: an engine with its own modes names the one it runs.
    rows.push({ key: 'mode', label: 'Mode', value: o.modeLabel ?? (SESSION_MODE_LABELS as Record<string, string>)[o.mode] ?? o.mode, source: from.mode, words: launchSourceWords(from.mode, o.project) });
  }
  return rows;
}

/** config.defaults.engine, live: the "Global" value the settings and the draft name. */
export function useGlobalDefaultEngine(): SessionEngine {
  const [engine, setEngine] = useState<SessionEngine>('claude');
  const [gen, setGen] = useState(0);
  useEvent('config:changed', () => setGen((g) => g + 1));
  useEffect(() => {
    let live = true;
    fetchConfig().then((c) => { if (live) setEngine(resolveEngine(c.defaults?.engine)); }, () => {});
    return () => { live = false; };
  }, [gen]);
  return engine;
}
