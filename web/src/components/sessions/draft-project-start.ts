/**
 * "Start new tasks from a project" (experiment `project_first_start`) as plain data: which
 * shape the draft's launch row takes, what a project pick writes on the draft, the value chips
 * of the source's array inputs, and what the Start sends. No React, no network.
 *
 *   off     the experiment is off, the draft cannot start from a project (bound, fork, Ask
 *           Walnut, a repair, a host without a folder picker), or the person chose a folder
 *           instead: today's row, exactly.
 *   pick    no project with a code source is picked yet: the draft runs in a folder (a project
 *           without a source keeps the folder flow).
 *   source  a project with a code source is picked: a fresh workspace, its value chips.
 *
 * While the draft may start from a project (`canPick`, also in 'off' after a folder pick), the
 * draft shows its Project + Where row for both (DraftWhereRow, its words in draft-work-in.ts).
 *
 * The server reads the source (src/core/workspaces/project-source.ts) and resolves the start
 * itself (`fromProject` on quick-start); this file only mirrors what the row shows.
 */
import type { StartSource } from '@/api/projects';
import type { DraftColumn } from './draft-column';
import { clearAiFields, withDirLaunchMemory } from './draft-column';
import { homeDraftFolder } from './draft-home-default';
import { isInboxProject } from '../../../../src/core/inbox-project';

export type ProjectStartMode = 'off' | 'pick' | 'source';

/** The provider id of a legacy project (default folder + isolated workspace on). */
export const AUTO_PROVIDER = 'auto';

type ModeDraft = Pick<DraftColumn, 'fromProject' | 'project' | 'projectSource'>;

/**
 * The row's shape. A hand pick (`fromProject`) stays a start from its project even when this tab
 * no longer sees the source (removed meanwhile): its Start still sends `fromProject`, and the
 * server says why it cannot, so the draft never falls back to running in the source's folder. A
 * project "+" seed and a project the background parse picked start from a source they have.
 */
export function projectStartMode(draft: ModeDraft, ctx: {
  flagOn: boolean;
  /** A plain new draft (not bound, fork, Ask Walnut, a repair, or one with no folder picker). */
  eligible: boolean;
  /** The picked project's start source, when it has one. */
  source: StartSource | null | undefined;
}): ProjectStartMode {
  if (!ctx.flagOn || !ctx.eligible || draft.fromProject === false) return 'off';
  if (!draft.project) return 'pick';
  if (draft.fromProject === true) return 'source';
  if (ctx.source && (draft.projectSource === 'seed' || draft.projectSource === 'ai')) return 'source';
  return 'pick';
}

/** A registry row as this file reads it. */
export interface StartSourceRow { name: string; startSource?: StartSource }

/** A project's current name (following a rename this tab knows of) and its start source; the Inbox has none. */
export function startSourceOf(
  rows: readonly StartSourceRow[], name: string | undefined, resolve: (name: string) => string = (n) => n,
): { project: string; source: StartSource | null } {
  const current = resolve((name ?? '').trim()).trim();
  // The Inbox (a draft's '' or its name) is the draft's no-project pick: no source of its own here.
  if (isInboxProject(current)) return { project: '', source: null };
  const lower = current.toLowerCase();
  const row = rows.find((r) => r.name.toLowerCase() === lower);
  return { project: row?.name ?? current, source: row?.startSource ?? null };
}

export interface DraftProjectStartState {
  mode: ProjectStartMode;
  /** The source of a draft in 'source' mode; null when this tab does not see one (the server decides). */
  source: StartSource | null;
  /** The draft's project by its current name (a rename followed). */
  project: string;
  /** The Project + Where row applies: a project pick goes through pickProjectForStart (also after a folder pick). */
  canPick: boolean;
}

/**
 * THE decision "does this draft start from its project, and from which source": the row
 * (useDraftProjectStart) and the Start and its Retry (MainPage) read only this, so what the row
 * shows is what Start sends.
 */
export function draftProjectStart(draft: ModeDraft, ctx: {
  flagOn: boolean;
  eligible: boolean;
  rows: readonly StartSourceRow[];
  resolve?: (name: string) => string;
}): DraftProjectStartState {
  const found = startSourceOf(ctx.rows, draft.project, ctx.resolve);
  const mode = projectStartMode(draft, { flagOn: ctx.flagOn, eligible: ctx.eligible, source: found.source });
  return { mode, source: mode === 'source' ? found.source : null, project: found.project, canPick: ctx.flagOn && ctx.eligible };
}

/**
 * Whether the draft's own Isolated workspace choice (draftWorkspaceRequest) is part of the start:
 * every start but one from a project's code source, which makes its own workspace. The row that
 * shows and defaults the choice is mounted on exactly this, and Start reads the choice on exactly
 * this, so a choice the row no longer shows can never reach a start (a folder's isolation default
 * carried into a project's Auto home folder asked for a worktree of ~).
 */
export function startReadsDraftWorkspace(state: Pick<DraftProjectStartState, 'mode'>): boolean {
  return state.mode !== 'source';
}

/** The draft's host for a source's host: `null` is this machine. */
export function draftHostOf(source: Pick<StartSource, 'host'>): string | null {
  return !source.host || source.host === '__local__' || source.host === 'local' ? null : source.host;
}

/** A project's default folder and host (the registry's projectDefaults). */
export type ProjectHome = { cwd: string; host: string | null } | undefined;

type FolderKept = NonNullable<DraftColumn['fromProjectPrev']>;

function folderOf(d: DraftColumn): FolderKept {
  return {
    cwd: d.cwd, host: d.host,
    ...(d.hostLabel ? { hostLabel: d.hostLabel } : {}),
    ...(d.cwdPinned ? { cwdPinned: true } : {}),
    ...(d.createCwd ? { createCwd: true } : {}),
  };
}

const sameProject = (a: string | undefined, b: string | undefined) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

/**
 * Enter or leave source mode after a write on the draft (a pick, a parse). Entering keeps the
 * folder the draft stood on (`fromProjectPrev`) and puts the source's folder and host on it, so
 * the host chooser, the engine checks and the slash commands read the host the start runs on. Leaving gives the folder back: the new project's own default folder
 * when the project changed and it has one (as its "+" does), else the one kept on entering.
 * Returns the SAME object when nothing changes.
 */
export function settleProjectStart(before: DraftColumn, after: DraftColumn, ctx: {
  /** The experiment is on and the draft may start from a project. */
  active: boolean;
  /** The source of `after.project`, when it has one. */
  source: StartSource | null;
  /** `after.project`'s default folder and host. */
  home?: ProjectHome;
}): DraftColumn {
  const mode = projectStartMode(after, { flagOn: ctx.active, eligible: true, source: ctx.source });
  const moved = !sameProject(before.project, after.project);
  if (mode === 'source') {
    // A hand pick whose source this tab lost: the Start asks the server, which names the problem.
    if (!ctx.source) return after;
    const keepHost = !!after.fromProjectHostPicked && !moved;
    const host = keepHost ? after.host : draftHostOf(ctx.source);
    const hostLabel = keepHost ? after.hostLabel : host ? ctx.source.host_label : undefined;
    if (after.fromProjectPrev && after.cwd === ctx.source.anchor && after.host === host && after.hostLabel === hostLabel
      && after.cwdPinned && !after.createCwd && (keepHost || !after.fromProjectHostPicked)) return after;
    const { fromProjectHostPicked: _picked, ...rest } = after;
    return {
      ...rest,
      fromProjectPrev: after.fromProjectPrev ?? folderOf(after),
      cwd: ctx.source.anchor,
      host,
      hostLabel,
      cwdPinned: true,
      createCwd: false,
      ...(keepHost ? { fromProjectHostPicked: true } : {}),
    };
  }
  if (!after.fromProjectPrev && !after.fromProjectHostPicked) return after;
  const { fromProjectPrev: prev, fromProjectHostPicked: _picked, ...rest } = after;
  const back: FolderKept = moved && ctx.home?.cwd ? { cwd: ctx.home.cwd, host: ctx.home.host } : prev ?? folderOf(after);
  return { ...rest, cwd: back.cwd, host: back.host, hostLabel: back.hostLabel, cwdPinned: !!back.cwdPinned, createCwd: !!back.createCwd };
}

/**
 * A project pick in the Project field (or a Recent chip). A project with a
 * source starts from it, its chips back on the favourites and its own host; one without a source
 * (or the Inbox) is today's project pick, and a draft that stood on a source gets its folder back
 * (settleProjectStart). `toHome` (Auto: "Its folder notes"): one without a source also puts the
 * draft on its own default folder and host.
 */
export function pickProjectForStart(
  draft: DraftColumn, project: string, source: StartSource | null | undefined, home?: ProjectHome, opts: { toHome?: boolean } = {},
): DraftColumn {
  const base = clearAiFields(draft, source ? ['project', 'cwd'] : ['project']);
  const { fromProjectInputs: _inputs, fromProjectHostPicked: _host, fromProject, ...rest } = base;
  const after: DraftColumn = {
    ...rest,
    project,
    projectSource: 'user',
    userTouched: true,
    // A project with a source re-enters project-first, also after a folder pick; one without
    // keeps the folder picked instead.
    ...(source ? { fromProject: true } : fromProject === false ? { fromProject: false } : {}),
  };
  const settled = settleProjectStart(draft, after, { active: true, source: source ?? null, home });
  if (source || !opts.toHome || !home?.cwd || (settled.cwd === home.cwd && (settled.host ?? null) === home.host)) return settled;
  return { ...settled, cwd: home.cwd, host: home.host, hostLabel: undefined, cwdPinned: false, createCwd: false };
}

/**
 * A folder picked by hand: the draft no longer starts from a project's code source, and keeps the
 * picked folder. While the Where row applies (`workIn`) the pick is final against every way a
 * draft enters source mode (a hand pick, a project "+" seed, the background parse): it writes
 * `fromProject: false`, so only a later project pick brings a source back.
 */
export function leaveForFolderPick(d: DraftColumn, workIn = false): DraftColumn {
  const left = workIn && d.fromProject !== false;
  if (!left && !d.fromProject && !d.fromProjectPrev && !d.fromProjectHostPicked && !d.fromProjectInputs) return d;
  const { fromProjectInputs: _inputs, fromProjectPrev: _prev, fromProjectHostPicked: _host, ...rest } = d;
  return left || d.fromProject ? { ...rest, fromProject: false } : rest;
}

/** The Where field's host on a start from a source: another host for this start only. */
export function pickStartHost(draft: DraftColumn, host: string | null, hostLabel?: string): DraftColumn {
  return { ...draft, host, hostLabel: host ? hostLabel : undefined, fromProjectHostPicked: true, userTouched: true };
}

/** The home folder of a host as a draft stores it: this machine's absolute home, `~` elsewhere. */
export function homeFolderOn(host: string | null): string {
  return host ? '~' : homeDraftFolder();
}

/**
 * Another host for a draft that runs in a folder (not a start from a source). The home folder
 * follows the host (every host has one); any other folder stays as it is, and the row says when
 * that host does not have it.
 */
export function moveDraftHost(draft: DraftColumn, host: string | null, hostLabel: string | undefined, opts: { home: boolean }): DraftColumn {
  return {
    ...draft,
    host,
    hostLabel: host ? hostLabel : undefined,
    ...(opts.home ? { cwd: homeFolderOn(host), cwdPinned: false, createCwd: false } : {}),
    userTouched: true,
  };
}

/**
 * A project pick that restores the folder the project last ran in: the folder, pinned, with its
 * launch memory, and marked kept, so a restored folder never asks "use a fresh workspace instead?".
 */
export function restoreFolderPlace(draft: DraftColumn, cwd: string, host: string | null, hostLabel?: string): DraftColumn {
  const left = leaveForFolderPick(draft, true);
  const next: DraftColumn = {
    ...left, cwd, host, hostLabel: host ? hostLabel : undefined, cwdPinned: true, createCwd: false, userTouched: true,
    meta: draft.metaTouched ? draft.meta : withDirLaunchMemory(draft.meta, cwd, host),
  };
  return { ...next, workInKept: workInFolderKey(next) };
}

/** A folder's identity on its host, as the "Keep" answer (`workInKept`) remembers it. */
export function workInFolderKey(d: Pick<DraftColumn, 'cwd' | 'host'>): string {
  const h = d.host;
  return `${!h || h === '__local__' || h === 'local' ? '__local__' : h}::${d.cwd.length > 1 ? d.cwd.replace(/\/+$/, '') : d.cwd}`;
}

const strings = (v: unknown): string[] => (Array.isArray(v)
  ? [...new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))]
  : []);

export interface SourceArrayField {
  key: string;
  title: string;
  required: boolean;
  /** What this start uses: the draft's own list, else the favourites. */
  values: string[];
  /** The project's favourites (★). */
  favourites: string[];
  /** Favourites first, then values used before by count (the server's order). */
  suggestions: string[];
  placeholder?: string;
}

/** The source's array-of-string inputs: from the provider's schema, else what the source holds. */
export function sourceArrayFields(source: StartSource, picked?: Record<string, string[]>): SourceArrayField[] {
  const props = source.input_schema?.properties;
  const keys = props
    ? Object.entries(props).filter(([, f]) => f.type === 'array').map(([k]) => k)
    : [...new Set([...Object.keys(source.inputs ?? {}).filter((k) => Array.isArray(source.inputs[k])), ...Object.keys(source.suggestions ?? {})])];
  const required = new Set(source.input_schema?.required ?? []);
  return keys.map((key) => {
    const favourites = strings(source.inputs?.[key]);
    const own = picked?.[key];
    return {
      key,
      title: props?.[key]?.title ?? key,
      required: required.has(key),
      values: own ? strings(own) : favourites,
      favourites,
      suggestions: strings(source.suggestions?.[key]),
      ...(props?.[key]?.placeholder ? { placeholder: props[key].placeholder } : {}),
    };
  });
}

/** The "+ Add" flyout's rows: suggestions not chosen yet that match what is typed, then the typed text itself. */
export function addOptions(field: Pick<SourceArrayField, 'values' | 'suggestions'>, typed: string): { suggestions: string[]; freeText: string | null } {
  const q = typed.trim();
  const chosen = new Set(field.values.map((v) => v.toLowerCase()));
  const suggestions = field.suggestions.filter((s) => !chosen.has(s.toLowerCase()) && (!q || s.toLowerCase().includes(q.toLowerCase())));
  const known = q && (chosen.has(q.toLowerCase()) || suggestions.some((s) => s.toLowerCase() === q.toLowerCase()));
  return { suggestions, freeText: q && !known ? q : null };
}

/** The draft after a chip's × or an Add: that field's list is now this start's own. */
export function setSourceValues(draft: DraftColumn, key: string, values: string[]): DraftColumn {
  return { ...draft, fromProjectInputs: { ...draft.fromProjectInputs, [key]: strings(values) }, userTouched: true };
}

export interface ProjectStartRequest {
  project: string;
  /** Only a host the person picked for this start ('__local__' or a hosts key); absent: the project's own. */
  host?: string;
  workspaceInputs?: Record<string, string[]>;
}

/** What Start sends for a draft in `source` mode; `{ error }` when a required list is empty (the Start waits). */
export function projectStartRequest(
  draft: DraftColumn, start: Pick<DraftProjectStartState, 'source' | 'project'>,
): ProjectStartRequest | { error: string } {
  let workspaceInputs: Record<string, string[]> | undefined = draft.fromProjectInputs;
  if (start.source) {
    workspaceInputs = {};
    for (const f of sourceArrayFields(start.source, draft.fromProjectInputs)) {
      if (f.required && !f.values.length) return { error: `Add at least one of ${f.title} to start` };
      workspaceInputs[f.key] = f.values;
    }
  }
  return {
    project: start.project,
    ...(draft.fromProjectHostPicked ? { host: draft.host ?? '__local__' } : {}),
    ...(workspaceInputs ? { workspaceInputs } : {}),
  };
}

/** A draft that may start from a project at all: not bound to a task, a fork, Ask Walnut or a repair. */
export function projectStartEligible(d: Pick<DraftColumn, 'forkOf' | 'walnut' | 'taskId' | 'intent'>): boolean {
  return !d.forkOf && !d.walnut && !d.taskId && d.intent !== 'fix-walnut';
}

/**
 * The words a refused start from a project puts on the line: the server's, except a project
 * with no code source, which says it short (it takes the line's one row with its action).
 */
export function projectStartRefusalWords(err: { message: string; body?: unknown }): string {
  const code = err.body && typeof err.body === 'object' ? (err.body as { code?: unknown }).code : undefined;
  return code === 'no-project-source' ? 'No code source: set one in the project\'s settings.' : err.message;
}
