/**
 * The Where picker's data rules (experiment `project_first_start`, design A of 2026-11-24): the
 * folders the person used (Recent: the last 10; Most used: the 10 with the most starts, on every
 * machine), a search over them and the folders listed on the browsed machine, and the levels of a
 * path. No React, no network: DraftWhereMenu draws it.
 *
 * Search order (the board's search classes): the query in the folder's own name, then anywhere in
 * its path, then its letters in order inside the name; a query with `/` matches piece by piece
 * (`code/wlnut`: the last piece the name, each earlier piece a level above, in order). A folder the
 * person used ranks above every folder they never used, by its starts, then how recent.
 */
import type { WorkingDirEntry } from '@/api/sessions';
import { tildePath } from '@/utils/home-folder';
import { isMadeFolder, timeOf, whereHostKey } from './draft-work-in';

/** A folder the person started tasks in, once per machine and path. */
export interface UsedFolder {
  /** Host key (`__local__` for this machine). */
  host: string;
  /** The absolute path, no trailing slash. */
  cwd: string;
  count: number;
  /** ISO time of the last start there. */
  last: string;
  hostLabel?: string;
  lastLaunch?: WorkingDirEntry['lastLaunch'];
}

export const LIST_SIZE = 10;
const SEARCH_SIZE = 40;
const RECENT_DAYS = 14;

/** A folder path without its trailing slashes (`/` stays). */
export const trimFolder = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p);
const trim = trimFolder;
export const nameOfPath = (p: string): string => { const d = trim(p); return d.slice(d.lastIndexOf('/') + 1) || d; };

/** The working-dirs list as one row per machine and folder (starts added, the newest time kept). */
export function usedFolders(dirs: readonly WorkingDirEntry[]): UsedFolder[] {
  const byKey = new Map<string, UsedFolder>();
  for (const d of dirs) {
    if (!d.cwd || isMadeFolder(d.cwd)) continue;
    const host = whereHostKey(d.host);
    const cwd = trim(d.cwd);
    const key = `${host}\t${cwd}`;
    const had = byKey.get(key);
    if (!had) {
      byKey.set(key, { host, cwd, count: d.count || 0, last: d.lastUsed, ...(d.hostLabel ? { hostLabel: d.hostLabel } : {}), ...(d.lastLaunch ? { lastLaunch: d.lastLaunch } : {}) });
      continue;
    }
    had.count += d.count || 0;
    if (timeOf(d.lastUsed) > timeOf(had.last)) {
      had.last = d.lastUsed;
      if (d.lastLaunch) had.lastLaunch = d.lastLaunch;
    }
  }
  return [...byKey.values()];
}

export function recentFolders(used: readonly UsedFolder[]): UsedFolder[] {
  return [...used].sort((a, b) => timeOf(b.last) - timeOf(a.last)).slice(0, LIST_SIZE);
}

export function mostUsedFolders(used: readonly UsedFolder[]): UsedFolder[] {
  return [...used].sort((a, b) => b.count - a.count || timeOf(b.last) - timeOf(a.last)).slice(0, LIST_SIZE);
}

export interface FolderMatch { tier: number; score: number; hits: number[] }

const range = (a: number, n: number): number[] => Array.from({ length: n }, (_, i) => a + i);

/** The letters of `q` in order inside `t[from..to)`, close together; their places, or null. */
function inOrder(q: string, t: string, from: number, to = t.length): number[] | null {
  let i = 0;
  const hits: number[] = [];
  for (let j = from; j < to && i < q.length; j++) if (t[j] === q[i]) { hits.push(j); i++; }
  return i === q.length && hits[hits.length - 1] - hits[0] < q.length * 2 + 2 ? hits : null;
}

/** `a/b`: the last piece in the folder's name, each earlier piece in a level above it, in order. */
function byPieces(q: string, t: string): FolderMatch | null {
  const pieces = q.split('/').filter(Boolean);
  if (!pieces.length) return null;
  const levels: Array<[number, number]> = [];
  for (let j = 0, k = 0; j <= t.length; j++) {
    if (j === t.length || t[j] === '/') { if (j > k) levels.push([k, j]); k = j + 1; }
  }
  if (!levels.length) return null;
  const hits: number[] = [];
  let li = levels.length - 1;
  for (let qi = pieces.length - 1; qi >= 0; qi--) {
    let found: number[] | null = null;
    for (; li >= 0; li--) {
      const [a, b] = levels[li];
      const at = t.slice(a, b).indexOf(pieces[qi]);
      found = at >= 0 ? range(a + at, pieces[qi].length) : inOrder(pieces[qi], t, a, b);
      if (found) { li--; break; }
      // The last piece is the folder's own name: it never matches a level above.
      if (qi === pieces.length - 1) return null;
    }
    if (!found) return null;
    hits.push(...found);
  }
  return { tier: 2, score: 0, hits: hits.sort((x, y) => x - y) };
}

/** How `shown` (a path as shown, home as `~`) matches `query`, with the matched letters; null when it does not. */
export function matchFolder(query: string, shown: string): FolderMatch | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const t = shown.toLowerCase();
  if (q.includes('/')) return byPieces(q, t);
  const name0 = t.lastIndexOf('/') + 1;
  const at = t.indexOf(q, name0);
  if (at >= 0) return { tier: 3, score: -(at - name0), hits: range(at, q.length) };
  const any = t.indexOf(q);
  if (any >= 0) return { tier: 2, score: 0, hits: range(any, q.length) };
  const letters = inOrder(q, t, name0);
  return letters ? { tier: 1, score: 0, hits: letters } : null;
}

export interface FolderHit { host: string; cwd: string; shown: string; match: FolderMatch; used?: UsedFolder }

/**
 * The folders matching `query`: every used folder on every machine, then `listed` (folders seen on
 * the browsed machine); used ones first by starts, then how recent, then the match class.
 */
export function searchFolders(query: string, used: readonly UsedFolder[], listed: ReadonlyArray<{ host: string; cwd: string }>,
  homeOf: (host: string) => string | undefined, now = Date.now()): FolderHit[] {
  const seen = new Set<string>();
  const usedByKey = new Map(used.map((u) => [`${u.host}\t${u.cwd}`, u]));
  const out: Array<FolderHit & { rank: number }> = [];
  const add = (host: string, cwd: string) => {
    const key = `${host}\t${trim(cwd)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const shown = tildePath(trim(cwd), homeOf(host));
    const match = matchFolder(query, shown);
    if (!match) return;
    const u = usedByKey.get(key);
    const fresh = u ? Math.max(0, 1 - (now - timeOf(u.last)) / (RECENT_DAYS * 864e5)) : 0;
    const rank = u ? 1e7 + u.count * 10 + fresh + match.tier * 0.01 : match.tier * 1000 + match.score;
    out.push({ host, cwd: trim(cwd), shown, match, ...(u ? { used: u } : {}), rank });
  };
  for (const u of used) add(u.host, u.cwd);
  for (const l of listed) if (!isMadeFolder(l.cwd)) add(l.host, l.cwd);
  return out.sort((a, b) => b.rank - a.rank).slice(0, SEARCH_SIZE).map(({ rank: _rank, ...hit }) => hit);
}

/** One level of a path as shown (`~`, `/`, or a folder name) and the folder it stands for. */
export interface PathLevel { label: string; dir: string }

/** `~/a/b` -> `~`, `~/a`, `~/a/b`; `/x/y` -> `/`, `/x`, `/x/y`. */
export function pathLevels(shown: string): PathLevel[] {
  const p = trim(shown);
  const home = p === '~' || p.startsWith('~/');
  const parts = (home ? p.slice(1) : p).split('/').filter(Boolean);
  const out: PathLevel[] = [{ label: home ? '~' : '/', dir: home ? '~' : '/' }];
  let cur = home ? '~' : '';
  for (const part of parts) { cur = `${cur}/${part}`; out.push({ label: part, dir: cur }); }
  return out;
}

/** Levels as shown in a row: more than 6 fold to the first, `…` (its folders in a menu), the last 3. */
export function foldLevels(levels: readonly PathLevel[]): { shown: Array<PathLevel | 'fold'>; folded: PathLevel[] } {
  if (levels.length <= 6) return { shown: [...levels], folded: [] };
  return { shown: [levels[0], 'fold', ...levels.slice(-3)], folded: levels.slice(1, -3) };
}

/** The folder above `shown` (`~` and `/` have none: they stay). */
export function parentLevel(shown: string): string {
  const levels = pathLevels(shown);
  return levels.length > 1 ? levels[levels.length - 2].dir : levels[0].dir;
}

/** A folder's child as shown (`~` + `a` -> `~/a`, `/` + `a` -> `/a`). */
export const childOf = (dir: string, name: string): string => `${dir === '/' ? '' : trim(dir)}/${name}`;

/**
 * A typed path split for browsing: the folder whose children show (`~/a/` and `~/a/b` both browse
 * `~/a`), and the piece after its last `/` that filters them ('' for none).
 */
export function typedBrowse(typed: string): { dir: string; filter: string } | null {
  if (!typed.startsWith('/') && !typed.startsWith('~')) return null;
  if (typed === '~') return { dir: '~', filter: '' };
  const cut = typed.lastIndexOf('/');
  const dir = cut <= 0 ? (typed.startsWith('~') ? '~' : '/') : typed.slice(0, cut);
  return { dir: dir || '/', filter: typed.slice(cut + 1) };
}

/** The folders under the home or the root worth a click on `host`: the top two levels of its used folders outside the home. */
export function placesOn(host: string, used: readonly UsedFolder[], home: string | undefined): string[] {
  const counts = new Map<string, number>();
  for (const u of used) {
    if (u.host !== host) continue;
    const shown = tildePath(u.cwd, home);
    if (shown.startsWith('~')) continue;
    const parts = shown.split('/').filter(Boolean);
    if (parts.length < 2) continue;
    const top = `/${parts[0]}/${parts[1]}`;
    counts.set(top, (counts.get(top) ?? 0) + u.count);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([p]) => p);
}
