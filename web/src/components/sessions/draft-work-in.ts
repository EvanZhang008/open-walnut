/**
 * The draft's ONE "Work in" pill (experiment `project_first_start`), as data: where a new task
 * runs is a single question, answered by a project (a fresh workspace from its code source, or
 * its own folder) or by a folder, whose project Walnut then works out. No React, no network.
 *
 *   [Work in: Marina · fresh git worktree · Big box ●]     a project with a code source
 *   [Work in: open-walnut (Walnut) · Big box]              a folder, its project as a tag
 *   [Work in: Choose a project or folder…]                 nothing yet
 *
 * The row's shape and the Start's request stay draft-project-start.ts's (draftProjectStart);
 * this file says the pill's words, what each project row of its popover gives, which project a
 * folder belongs to (detectProjectForFolder), and the "start in a fresh workspace instead?"
 * suggestion after a folder of a project with a source.
 */
import type { StartSource } from '@/api/projects';
import type { DraftColumn } from './draft-column';
import { isHomeFolder, tildePath } from '@/utils/home-folder';
import {
  AUTO_PROVIDER, leaveForFolderPick, projectStartEligible, sourceArrayFields, type ProjectStartMode, type StartSourceRow,
} from './draft-project-start';

/** A registry row as the Work in popover reads it. */
export interface WorkInRow extends StartSourceRow {
  defaultCwd?: string;
  defaultHost?: string;
}

const LOCAL = '__local__';
const hostKey = (h: string | null | undefined): string => (!h || h === LOCAL || h === 'local' ? LOCAL : h);
const trimDir = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p);
const under = (dir: string, root: string): boolean => dir === root || dir.startsWith(`${root}/`);
/** A worktree Walnut made: `<home>/.open-walnut-worktrees/<repo>/<worktree>...` (the `<repo>` folder
 *  itself only holds them, as the phone's twin reads it). */
const WORKTREES = /^(.*\/\.open-walnut-worktrees\/([^/]+))\/[^/]/;

/** The root or a home folder (the known one, or the account-shaped guess of the one home rule,
 *  utils/home-folder.ts): a folder there holds everything, so it names no project. */
function homeAlone(dir: string, home?: string): boolean {
  return dir === '/' || isHomeFolder(dir, home) || tildePath(dir) === '~';
}

function lastName(p: string): string {
  const dir = trimDir(p);
  return dir.slice(dir.lastIndexOf('/') + 1);
}

export interface DetectedProject {
  project: string;
  /** The project has a code source: a start from it makes a fresh workspace. */
  hasSource: boolean;
}

/**
 * The project whose code lives at `cwd` on `host` (null or '' = this computer), on the same host:
 *   - a code source's anchor that is the folder or one of its parents (the longest wins);
 *   - a default folder (a project without a source's "home") only when it IS the folder: a
 *     parent folder there (`/work/u`) is where many projects start, not one project's code;
 *   - a folder inside a worktree Walnut made (`.open-walnut-worktrees/<repo>/`) belongs to the
 *     project whose code source's anchor (git, the legacy 'auto' or a plugin) is named `<repo>`.
 * Two or more DIFFERENT projects at the best length name no project (null): a guess between
 * them would file the task under the wrong one. A home folder (`~`, `/Users/x`, `/home/x`, the
 * given `home`) is never a match on either side: it would claim every folder under it.
 */
export function detectProjectForFolder(
  cwd: string, host: string | null | undefined, rows: readonly WorkInRow[], opts: { home?: string } = {},
): DetectedProject | null {
  const dir = trimDir((cwd ?? '').trim());
  if (!dir || homeAlone(dir, opts.home)) return null;
  const at = hostKey(host);
  let bestLen = -1;
  let best: WorkInRow[] = [];
  const consider = (row: WorkInRow, root: string | undefined, rootHost: string | null | undefined, how: 'ancestor' | 'exact' | number) => {
    const r = trimDir((root ?? '').trim());
    if (!r || homeAlone(r, opts.home) || hostKey(rootHost) !== at) return;
    if (how === 'ancestor' ? !under(dir, r) : how === 'exact' ? dir !== r : false) return;
    const n = typeof how === 'number' ? how : r.length;
    if (n > bestLen) { bestLen = n; best = [row]; } else if (n === bestLen && !best.includes(row)) best.push(row);
  };
  for (const row of rows) {
    if (row.startSource) consider(row, row.startSource.anchor, row.startSource.host, 'ancestor');
    if (row.defaultCwd) consider(row, row.defaultCwd, row.defaultHost, 'exact');
  }
  const wt = WORKTREES.exec(dir);
  if (wt) {
    for (const row of rows) {
      const s = row.startSource;
      if (s && lastName(s.anchor) === wt[2]) consider(row, s.anchor, s.host, wt[1].length);
    }
  }
  const names = new Set(best.map((r) => r.name.toLowerCase()));
  if (names.size !== 1) return null;
  const row = best.find((r) => r.startSource) ?? best[0];
  return { project: row.name, hasSource: !!row.startSource };
}

/**
 * The folder-owner lookup a folder pick (and the registry's re-check of a folder-set project)
 * uses: the registry's exact owner, then, while the Work in pill applies and the person did not
 * pick the project himself (nor opened the draft from a project's "+"), the project detectProjectForFolder finds.
 */
export function withDetectedOwner(
  forDir: (cwd: string) => string,
  draft: Pick<DraftColumn, 'projectSource' | 'forkOf' | 'walnut' | 'taskId' | 'intent'>,
  host: string | null | undefined,
  ctx: { on: boolean; rows: readonly WorkInRow[]; home?: string },
): (cwd: string) => string {
  if (!ctx.on || !projectStartEligible(draft) || draft.projectSource === 'user' || draft.projectSource === 'seed') return forDir;
  const known = new Set(ctx.rows.map((r) => r.name.toLowerCase()));
  // The registry's owner when it is a project that exists; a name it would make up from the
  // folder (a new project) loses to the project whose code lives there (2026-11-20, real data:
  // ~/x/anchors/open-walnut read "anchors-open-walnut" instead of Walnut).
  return (cwd) => {
    const own = forDir(cwd);
    if (own && known.has(own.toLowerCase())) return own;
    return detectProjectForFolder(cwd, host, ctx.rows, { home: ctx.home })?.project ?? own;
  };
}

/** What a start from the source makes, after "fresh": a provider whose own name already says
 *  "workspace" or "worktree" is not followed by "workspace" again. */
export function sourceMakes(source: StartSource | null | undefined): string {
  if (!source || source.provider === AUTO_PROVIDER) return 'workspace';
  if (source.provider === 'git-worktree') return 'git worktree';
  const name = (source.provider_name ?? source.provider).trim();
  return /\b(workspace|worktree)s?$/i.test(name) ? name : `${name} workspace`;
}

/** A project row's second line in the popover: what picking it gives. */
export function workInProjectLine(row: Pick<WorkInRow, 'startSource' | 'defaultCwd'>, ctx: { hostLabel: string; folderName?: string }): string {
  if (row.startSource) {
    const base = `Fresh ${sourceMakes(row.startSource)} on ${ctx.hostLabel}`;
    const favs = sourceArrayFields(row.startSource).flatMap((f) => f.favourites);
    if (!favs.length) return base;
    return `${base} · ${favs.slice(0, 3).join(', ')}${favs.length > 3 ? ` +${favs.length - 3}` : ''}`;
  }
  if (row.defaultCwd) return `Works in its folder ${ctx.folderName || row.defaultCwd} · ${ctx.hostLabel}`;
  return 'Works in a folder you pick';
}

/** The Projects tab: favourites first, then the ones with a source, then the rest, each by name. */
export function workInProjectOrder<R extends WorkInRow>(rows: readonly R[], isFavourite: (name: string) => boolean, query: string, label: (name: string) => string = (n) => n): R[] {
  const q = query.trim().toLowerCase();
  const rank = (r: R) => (isFavourite(r.name) ? 0 : r.startSource ? 1 : 2);
  return rows
    .filter((r) => !q || r.name.toLowerCase().includes(q) || label(r.name).toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export type WorkInFace =
  | { kind: 'source'; project: string; makes: string }
  /** `isolated`: Start makes an isolated copy of the folder (the isolated-workspace defaults, More's switch). */
  | { kind: 'folder'; folder: string; tag?: string; isolated?: boolean }
  | { kind: 'empty'; tag?: string };

/** What the pill shows (its host part is the component's: the live label and dot). */
export function workInFace(draft: Pick<DraftColumn, 'cwd' | 'project'>, ctx: {
  mode: ProjectStartMode;
  /** The draft's project by its current name. */
  project: string;
  source: StartSource | null;
  /** The draft folder's shown name (shownFolderName). */
  folderName: string;
  detected: DetectedProject | null;
  /** A folder start makes an isolated workspace of it (draftWorkspaceRequest will send one). */
  isolated?: boolean;
}): WorkInFace {
  if (ctx.mode === 'source') return { kind: 'source', project: ctx.project, makes: sourceMakes(ctx.source) };
  const tag = (draft.project ? ctx.project : '') || ctx.detected?.project || undefined;
  if (draft.cwd) return { kind: 'folder', folder: ctx.folderName, ...(tag ? { tag } : {}), ...(ctx.isolated ? { isolated: true } : {}) };
  return { kind: 'empty', ...(tag ? { tag } : {}) };
}

/** What a folder start that isolates says on the pill. */
export const ISOLATED_WORDS = 'isolated copy';

/** The pill's words as one line (its accessible name and the specs' text). */
export function workInWords(face: WorkInFace, hostLabel?: string): string {
  const host = hostLabel ? ` · ${hostLabel}` : '';
  if (face.kind === 'source') return `Work in: ${face.project} · fresh ${face.makes}${host}`;
  if (face.kind === 'folder') return `Work in: ${face.folder}${face.tag ? ` (${face.tag})` : ''}${face.isolated ? ` · ${ISOLATED_WORDS}` : ''}${host}`;
  return `Work in: ${face.tag ? `${face.tag} · choose a folder…` : 'Choose a project or folder…'}`;
}

/** A folder's identity, as the "Keep this folder" answer remembers it. */
export function workInFolderKey(d: Pick<DraftColumn, 'cwd' | 'host'>): string {
  return `${hostKey(d.host)}::${trimDir(d.cwd)}`;
}

export interface WorkInSuggestion {
  project: string;
  /** What a start from it makes ("git worktree"). */
  makes: string;
}

/**
 * After a folder of a project that has a code source: "This is Marina's code. Start in a fresh
 * git worktree instead?". Never on a start from a source already, nor once the person answered
 * "Keep this folder" for this folder of this draft.
 */
export function workInSuggestion(draft: Pick<DraftColumn, 'cwd' | 'host' | 'workInKept'>, ctx: {
  mode: ProjectStartMode;
  detected: DetectedProject | null;
  rows: readonly WorkInRow[];
}): WorkInSuggestion | null {
  if (ctx.mode === 'source' || !draft.cwd || !ctx.detected?.hasSource) return null;
  if (draft.workInKept === workInFolderKey(draft)) return null;
  const row = ctx.rows.find((r) => r.name === ctx.detected!.project);
  if (!row?.startSource) return null;
  return { project: row.name, makes: sourceMakes(row.startSource) };
}

/** "Keep this folder": the suggestion stays away for this folder of this draft, a reload included,
 *  and the draft stays on the folder (no seed or parse moves it onto the project's source). */
export function keepWorkInFolder(draft: DraftColumn): DraftColumn {
  return { ...leaveForFolderPick(draft, true), workInKept: workInFolderKey(draft), userTouched: true };
}
