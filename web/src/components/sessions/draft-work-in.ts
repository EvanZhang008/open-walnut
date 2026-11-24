/**
 * The new task draft's Project + Where row (experiment `project_first_start`, v6), as data:
 *
 *   [PROJECT  Marina ▾]  [WHERE  ● devbox › ✦Auto New worktree            ⌕]
 *   Last used for Marina: Auto on devbox, 12 min ago.
 *
 * Where is ONE path whose first part is the host. Its value is Auto (what the project makes: a
 * fresh workspace from its code source, its own folder, or the home folder) or a folder. This
 * file says which project a folder belongs to (detectProjectForFolder), what Auto makes and
 * whether a host can make it (autoOn: the same rule as the phone), what a project pick restores
 * (derivedPlace: from the folders Walnut already records), the one line under the row
 * (whereLine), and the Recent chips. No React, no network.
 *
 * The row's shape and the Start's request stay draft-project-start.ts's (draftProjectStart), so
 * what the row shows is what Start sends.
 */
import type { StartSource } from '@/api/projects';
import type { WorkingDirEntry } from '@/api/sessions';
import { WORKSPACES_DIR_PART, type DraftColumn } from './draft-column';
import { isHomeFolder, tildePath } from '@/utils/home-folder';
import {
  AUTO_PROVIDER, leaveForFolderPick, projectStartEligible, sourceArrayFields, workInFolderKey, type StartSourceRow,
} from './draft-project-start';

/** A registry row as the row reads it. */
export interface WorkInRow extends StartSourceRow {
  defaultCwd?: string;
  defaultHost?: string;
}

const LOCAL = '__local__';
/** One key per host: this computer is `__local__` whatever the caller wrote (null, '', 'local'). */
export const whereHostKey = (h: string | null | undefined): string => (!h || h === LOCAL || h === 'local' ? LOCAL : h);
/** The draft's host for a key: null is this computer. */
export const draftHostFor = (key: string): string | null => (whereHostKey(key) === LOCAL ? null : key);
const trimDir = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p);
const under = (dir: string, root: string): boolean => dir === root || dir.startsWith(`${root}/`);
/** A worktree Walnut made: `<home>/.open-walnut-worktrees/<repo>/<worktree>...`. */
const WORKTREES = /^(.*\/\.open-walnut-worktrees\/([^/]+))\/[^/]/;

/** The root or a home folder: a folder there holds everything, so it names no project. */
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
 *   - a default folder (a project without a source's "home") only when it IS the folder;
 *   - a folder inside a worktree Walnut made (`.open-walnut-worktrees/<repo>/`) belongs to the
 *     project whose code source's anchor is named `<repo>`.
 * Two or more DIFFERENT projects at the best length name no project (null). A home folder is
 * never a match on either side: it would claim every folder under it.
 */
export function detectProjectForFolder(
  cwd: string, host: string | null | undefined, rows: readonly WorkInRow[], opts: { home?: string } = {},
): DetectedProject | null {
  const dir = trimDir((cwd ?? '').trim());
  if (!dir || homeAlone(dir, opts.home)) return null;
  const at = whereHostKey(host);
  let bestLen = -1;
  let best: WorkInRow[] = [];
  const consider = (row: WorkInRow, root: string | undefined, rootHost: string | null | undefined, how: 'ancestor' | 'exact' | number) => {
    const r = trimDir((root ?? '').trim());
    if (!r || homeAlone(r, opts.home) || whereHostKey(rootHost) !== at) return;
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
 * The folder-owner lookup a folder pick uses: the registry's exact owner, then, while the row
 * applies and the person did not pick the project himself (nor opened the draft from a
 * project's "+"), the project detectProjectForFolder finds.
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
  // folder (a new project) loses to the project whose code lives there (2026-11-20, real data).
  return (cwd) => {
    const own = forDir(cwd);
    if (own && known.has(own.toLowerCase())) return own;
    return detectProjectForFolder(cwd, host, ctx.rows, { home: ctx.home })?.project ?? own;
  };
}

/**
 * Records on the draft whether its folder-set project is the project whose code is in its folder
 * (`detectedProject`), at the folder pick and when the registry re-decides it: the one place the
 * detection is read for a Start. The same row back when nothing changed.
 */
export function stampFolderDetection<T extends Pick<DraftColumn, 'project' | 'projectSource' | 'cwd' | 'host' | 'detectedProject'>>(
  draft: T, ctx: { on: boolean; rows: readonly WorkInRow[]; home?: string },
): T {
  const name = draft.project ?? '';
  const found = ctx.on && name && draft.projectSource === 'folder' && draft.cwd
    ? detectProjectForFolder(draft.cwd, draft.host, ctx.rows, { home: ctx.home })?.project : undefined;
  const hit = found && found.toLowerCase() === name.toLowerCase() ? name : undefined;
  if (draft.detectedProject === hit) return draft;
  const { detectedProject: _old, ...rest } = draft;
  return (hit ? { ...rest, detectedProject: hit } : rest) as T;
}

/**
 * Whether a folder start hands its project to the server's folder rule (`projectFromFolder`):
 * only a name the draft took from the folder. A project whose code is in this folder (the Where
 * row's "detected", recorded on the draft by stampFolderDetection) goes as it is: the folder rule
 * would file the task under a new project named after the folder (2026-11-21: "app" instead of
 * the project whose checkout it is). Reads the draft only, never the registry, so a Start right
 * after a reload (the list not loaded yet) sends what the row showed. `on`: the experiment.
 */
export function sendsFolderProject(draft: Pick<DraftColumn, 'project' | 'projectSource' | 'detectedProject'>, on: boolean): boolean {
  if (!draft.project || draft.projectSource !== 'folder') return false;
  // The experiment off: today's rule exactly, whatever an earlier session recorded on the draft.
  if (!on) return true;
  return (draft.detectedProject ?? '').toLowerCase() !== draft.project.toLowerCase();
}

/** What a start from the source makes, after "fresh": a provider whose own name already says
 *  "workspace" or "worktree" is not followed by "workspace" again. */
export function sourceMakes(source: StartSource | null | undefined): string {
  if (!source || source.provider === AUTO_PROVIDER) return 'workspace';
  if (source.provider === 'git-worktree') return 'git worktree';
  const name = (source.provider_name ?? source.provider).trim();
  return /\b(workspace|worktree)s?$/i.test(name) ? name : `${name} workspace`;
}

/** The Project menu's order: favourites first, then the ones with a source, then the rest, each by name. */
export function projectMenuOrder<R extends WorkInRow>(rows: readonly R[], isFavourite: (name: string) => boolean, query: string, label: (name: string) => string = (n) => n): R[] {
  const q = query.trim().toLowerCase();
  const rank = (r: R) => (isFavourite(r.name) ? 0 : r.startSource ? 1 : 2);
  return rows
    .filter((r) => !q || r.name.toLowerCase().includes(q) || label(r.name).toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export { workInFolderKey };

export interface WorkInSuggestion {
  project: string;
  /** What a start from it makes ("git worktree"). */
  makes: string;
}

/**
 * After a folder of a project that has a code source: "This folder is Marina’s code. Use a fresh
 * workspace instead?". Never on a start from a source, never once the person answered "Keep"
 * for this folder of this draft, and never on a folder a project pick restored (that write
 * marks it kept).
 */
export function workInSuggestion(draft: Pick<DraftColumn, 'cwd' | 'host' | 'workInKept'>, ctx: {
  mode: 'off' | 'pick' | 'source';
  detected: DetectedProject | null;
  rows: readonly WorkInRow[];
}): WorkInSuggestion | null {
  if (ctx.mode === 'source' || !draft.cwd || !ctx.detected?.hasSource) return null;
  if (draft.workInKept === workInFolderKey(draft)) return null;
  const row = ctx.rows.find((r) => r.name === ctx.detected!.project);
  if (!row?.startSource) return null;
  return { project: row.name, makes: sourceMakes(row.startSource) };
}

/** "Keep": the suggestion stays away for this folder of this draft, a reload included, and the
 *  draft stays on the folder (no seed or parse moves it onto the project's source). */
export function keepWorkInFolder(draft: DraftColumn): DraftColumn {
  return { ...leaveForFolderPick(draft, true), workInKept: workInFolderKey(draft), userTouched: true };
}

// ── Auto: what it makes, and whether a host can make it ──

export type AutoKind = 'git' | 'box' | 'folder' | 'home';

/** What Auto makes for a project, in two or three words ("New worktree", "Its folder notes"). */
export function autoWhat(row: WorkInRow | undefined, folderName?: string): { kind: AutoKind; words: string } {
  const s = row?.startSource;
  if (s) {
    if (s.provider === 'git-worktree') return { kind: 'git', words: 'New worktree' };
    return { kind: 'box', words: `New ${sourceMakes(s)}` };
  }
  if (row?.defaultCwd) return { kind: 'folder', words: `Its folder ${folderName || lastName(row.defaultCwd) || row.defaultCwd}` };
  return { kind: 'home', words: 'Home folder' };
}

/** The host a project's Auto runs on by default: its source's, else its default folder's. */
export function ownHostOf(row: WorkInRow | undefined): string {
  return whereHostKey(row?.startSource ? row.startSource.host : row?.defaultHost);
}

export type AutoVerdict =
  | { ok: true; moved: boolean }
  | { ok: false; reason: string; noProject?: true };

/** A folder Walnut knows on a host (the working-dirs list). */
export type KnownDir = Pick<WorkingDirEntry, 'cwd' | 'host'>;

export const NO_PROJECT_REASON = 'Pick a project first: Auto follows the project';

/**
 * Can `host` run this project's Auto? (The phone has the same rule.) No project: no. Its own host:
 * yes. A code source on another host: only when Walnut knows a folder there that is the anchor or
 * inside it (a start there reuses the anchor's path); otherwise "{host} has no {project} checkout."
 * (git) or "{host} cannot make a {makes}." (a plugin). A project folder on another host: no, it is
 * on its own. No source and no folder: the home folder exists everywhere.
 */
export function autoOn(row: WorkInRow | undefined, host: string | null | undefined, ctx: {
  hostName: (key: string) => string;
  knownDirs: readonly KnownDir[];
  projectName?: (name: string) => string;
  folderName?: string;
}): AutoVerdict {
  if (!row) return { ok: false, reason: NO_PROJECT_REASON, noProject: true };
  const at = whereHostKey(host);
  const own = ownHostOf(row);
  if (at === own) return { ok: true, moved: false };
  const s = row.startSource;
  const name = ctx.projectName ? ctx.projectName(row.name) : row.name;
  if (s) {
    const anchor = trimDir(s.anchor);
    const there = ctx.knownDirs.some((d) => whereHostKey(d.host) === at && under(trimDir(d.cwd), anchor));
    if (there) return { ok: true, moved: true };
    const isGit = s.provider === 'git-worktree' || s.provider === AUTO_PROVIDER;
    return { ok: false, reason: isGit ? `${ctx.hostName(at)} has no ${name} checkout.` : `${ctx.hostName(at)} cannot make a ${sourceMakes(s)}.` };
  }
  if (row.defaultCwd) {
    return { ok: false, reason: `${ctx.folderName || lastName(row.defaultCwd)} is on ${ctx.hostName(own)}, not on ${ctx.hostName(at)}.` };
  }
  return { ok: true, moved: false };
}

/** The Auto row's second line: what a pick gives. */
export function autoNote(row: WorkInRow | undefined, verdict: AutoVerdict, ctx: { anchorShown?: string; folderShown?: string; picked?: Record<string, string[]> } = {}): string {
  if (!row) return NO_PROJECT_REASON;
  if (!verdict.ok) return verdict.reason;
  const s = row.startSource;
  if (s) {
    if (s.provider === 'git-worktree' || s.provider === AUTO_PROVIDER) {
      return verdict.moved && ctx.anchorShown ? `From ${ctx.anchorShown}, removed when merged` : 'Fresh copy of the default branch, removed when merged';
    }
    const counts = sourceArrayFields(s, ctx.picked).map((f) => `${f.values.length} ${f.values.length === 1 ? f.title.toLowerCase().replace(/s$/, '') : f.title.toLowerCase()}`);
    return [...counts, `A fresh ${sourceMakes(s)}, removed when merged`].join(' · ');
  }
  if (row.defaultCwd) return `Works in ${ctx.folderShown ?? row.defaultCwd}`;
  return 'Works in your home folder';
}

// ── Per-project memory: derived from the folders Walnut already records ──

export interface WherePlace {
  /** Auto (a fresh workspace, or the project's own folder) rather than a folder of the person's. */
  auto: boolean;
  /** Host key ('__local__' or a hosts key). */
  host: string;
  /** The folder (auto false). */
  cwd?: string;
  hostLabel?: string;
  /** When it was last used (ISO); absent for a first time. */
  at?: string;
  /** The project was never used: Auto on its usual host. */
  first?: true;
}

/** A workspace Walnut keeps for a task (the tasks store's `task.workspace`), with its task's
 *  project and when the task was made (a start from a source is a place before its session runs). */
export interface WorkspaceRoot { root: string; host: string; project?: string; at?: string }

/**
 * Every task workspace's root, one `host\troot` line each, sorted (a string, so a store change
 * that moves none re-renders nothing). A REMOVED workspace counts too: a folder a session ran in
 * stays a Walnut-made one after its cleanup, so a project whose last place it was restores Auto,
 * never a pinned folder that no longer exists (a plugin's workspace, or one under a custom root,
 * has no telling path part).
 */
export function workspaceRootsKey(tasks: readonly { project?: string; created_at?: string; workspace?: { root?: string; host?: string | null } | null }[]): string {
  return tasks.flatMap((t) => (t.workspace?.root
    ? [`${whereHostKey(t.workspace.host)}\t${t.workspace.root}\t${t.project ?? ''}\t${t.created_at ?? ''}`]
    : [])).sort().join('\n');
}

/** workspaceRootsKey back into its rows. */
export function parseWorkspaceRoots(key: string): WorkspaceRoot[] {
  return key ? key.split('\n').map((l) => {
    const [host, root, project, at] = l.split('\t');
    return { host, root, ...(project ? { project } : {}), ...(at ? { at } : {}) };
  }) : [];
}

/** An ISO time as a number to compare, a missing or bad one as the oldest (never NaN). */
export const timeOf = (iso: string | undefined): number => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? t : 0; };

/**
 * Where `project` last ran, from the working-dirs list (every folder a session used, its project
 * vote and when): the newest folder of the project. A folder inside a worktree Walnut made or
 * inside a task's workspace was a fresh workspace, so it reads as Auto on that host.
 */
export function derivedPlace(project: string, dirs: readonly WorkingDirEntry[], roots: readonly WorkspaceRoot[]): WherePlace | null {
  const p = project.trim().toLowerCase();
  if (!p) return null;
  let best: WorkingDirEntry | null = null;
  for (const d of dirs) {
    if ((d.project ?? '').toLowerCase() !== p || !d.cwd) continue;
    if (!best || timeOf(d.lastUsed) > timeOf(best.lastUsed)) best = d;
  }
  // A task of the project with a workspace Walnut made is a place too, from the moment it is
  // made: its session records its folder only once the workspace is ready.
  let newest: WorkspaceRoot | null = null;
  for (const r of roots) {
    if ((r.project ?? '').toLowerCase() !== p || !r.at) continue;
    if (!newest || timeOf(r.at) > timeOf(newest.at)) newest = r;
  }
  if (newest && (!best || timeOf(newest.at) > timeOf(best.lastUsed))) return { auto: true, host: whereHostKey(newest.host), at: newest.at };
  if (!best) return null;
  const host = whereHostKey(best.host);
  const cwd = trimDir(best.cwd);
  const made = cwd.includes(WORKSPACES_DIR_PART) || roots.some((r) => whereHostKey(r.host) === host && under(cwd, trimDir(r.root)));
  return made
    ? { auto: true, host, at: best.lastUsed }
    : { auto: false, host, cwd, ...(best.hostLabel ? { hostLabel: best.hostLabel } : {}), at: best.lastUsed };
}

/** What a project pick restores: a change made in this draft, else where it last ran, else Auto on its usual host. */
export function placeFor(row: WorkInRow | undefined, local: WherePlace | undefined, derived: WherePlace | null): WherePlace {
  return local ?? derived ?? { auto: true, host: ownHostOf(row), first: true };
}

/** One place's identity: the Last used line stays until the place changes. */
export function placeKey(p: Pick<WherePlace, 'auto' | 'host' | 'cwd'>): string {
  return p.auto ? `auto::${p.host}` : `${p.host}::${trimDir(p.cwd ?? '')}`;
}

/** A folder known on another host only: the host it is on, else null. `~` exists everywhere. */
export function folderElsewhere(cwd: string, host: string | null | undefined, dirs: readonly KnownDir[], home?: string): string | null {
  const dir = trimDir(cwd);
  if (!dir || homeAlone(dir, home)) return null;
  const at = whereHostKey(host);
  if (dirs.some((d) => whereHostKey(d.host) === at && trimDir(d.cwd) === dir)) return null;
  const other = dirs.find((d) => whereHostKey(d.host) !== at && trimDir(d.cwd) === dir);
  return other ? whereHostKey(other.host) : null;
}

// ── The line under the row: one slot, first match wins ──

export type WhereLine =
  | { kind: 'off-host'; other: string }
  | { kind: 'gone'; cwd: string }
  | { kind: 'cannot'; reason: string; projectHost: string }
  | { kind: 'no-source'; reason: string }
  | { kind: 'last-used'; project: string; place: WherePlace }
  | { kind: 'suggest'; project: string; makes: string }
  | { kind: 'moved'; projectHost: string };

export function whereLine(s: {
  /** The folder is known on another host only (folderElsewhere). */
  offHost: string | null;
  /** The draft's folder is not there on its host (useFolderGone). */
  gone?: string | null;
  /** Auto is the current choice and this host cannot make it. */
  cannot: string | null;
  /** A start from the project's source, and this tab sees the project with no source (removed meanwhile). */
  noSource?: string | null;
  projectHost: string;
  /** The Last used note, while the place a project pick restored stands. */
  restored: { project: string; place: WherePlace } | null;
  suggestion: WorkInSuggestion | null;
  /** Auto runs on another host than the project's own. */
  moved: boolean;
}): WhereLine | null {
  if (s.offHost) return { kind: 'off-host', other: s.offHost };
  if (s.gone) return { kind: 'gone', cwd: s.gone };
  if (s.cannot) return { kind: 'cannot', reason: s.cannot, projectHost: s.projectHost };
  if (s.noSource) return { kind: 'no-source', reason: s.noSource };
  if (s.restored) return { kind: 'last-used', ...s.restored };
  if (s.suggestion) return { kind: 'suggest', ...s.suggestion };
  if (s.moved) return { kind: 'moved', projectHost: s.projectHost };
  return null;
}

/** A run of the line's words: plain, bold, or a folder name in the code face. */
export interface LinePart { text: string; style?: 'b' | 'code' }

/** The Last used note's words. `narrow`: the project is in the field right above, so it is dropped. */
export function lastUsedParts(r: { project: string; place: WherePlace }, ctx: {
  narrow?: boolean; hostName: (key: string) => string; folderName: (cwd: string, host: string) => string; ago: (iso: string) => string;
}): LinePart[] {
  const host = ctx.hostName(r.place.host);
  if (r.place.first) return [{ text: ctx.narrow ? 'First time:' : `First time with ${r.project}:`, style: 'b' }, { text: ` Auto on ${host}, its usual host.` }];
  const lead: LinePart = { text: ctx.narrow ? 'Last used:' : `Last used for ${r.project}:`, style: 'b' };
  const when = r.place.at ? `, ${ctx.ago(r.place.at)}` : '';
  if (r.place.auto) return [lead, { text: ` Auto on ${host}${when}.` }];
  return [lead, { text: ' ' }, { text: ctx.folderName(r.place.cwd ?? '', r.place.host), style: 'code' }, { text: ` on ${host}${when}.` }];
}

// ── Recent: the lower row's chips ──

export type RecentPlace =
  | { kind: 'project'; project: string; at: string }
  | { kind: 'folder'; cwd: string; host: string; hostLabel?: string; at: string };

/** The places used last, newest first: a folder of a known project is that project (its pick
 *  restores the folder), any other folder itself. A task's own workspace is never a chip. */
export function recentPlaces(dirs: readonly WorkingDirEntry[], projectOf: (name: string) => string | null): RecentPlace[] {
  const sorted = [...dirs].sort((a, b) => timeOf(b.lastUsed) - timeOf(a.lastUsed));
  const seen = new Set<string>();
  const out: RecentPlace[] = [];
  for (const d of sorted) {
    const project = d.project ? projectOf(d.project) : null;
    if (project) {
      const key = `p:${project.toLowerCase()}`;
      if (!seen.has(key)) { seen.add(key); out.push({ kind: 'project', project, at: d.lastUsed }); }
      continue;
    }
    if (d.cwd.includes(WORKSPACES_DIR_PART)) continue;
    const key = `f:${workInFolderKey(d)}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ kind: 'folder', cwd: d.cwd, host: whereHostKey(d.host), ...(d.hostLabel ? { hostLabel: d.hostLabel } : {}), at: d.lastUsed });
    }
  }
  return out;
}

/** The Host menu's second line: never the name again. */
export function hostLine(local: boolean, connected: boolean): string {
  return `${local ? 'This computer' : 'Remote host'} · ${connected ? 'online' : 'offline'}`;
}
