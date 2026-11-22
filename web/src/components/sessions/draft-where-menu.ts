/**
 * The Where menu's rows as data (experiment `project_first_start`, v6; DraftWhereMenu draws them):
 *
 *   ⌕ Search folders or type a path: / or ~
 *   ✦ Auto · New worktree on devbox                       ✓
 *   Recent on devbox      open-walnut  [Walnut]   2 days ago
 *   Recent on This Mac    Downloads              3 weeks ago
 *
 * An empty search lists the recent folders by host, the draft's host first (empty when it has none); a word searches every
 * host's recent folders, grouped by host; a path (`/`, `~`) is the folder picker's typed path on
 * the draft's host (path-selector/input-model.ts: its states, its listing, its validity). No
 * React, no network.
 */
import type { WorkingDirEntry } from '@/api/sessions';
import { pathCrumbItems, tildePath, type PathCrumb } from '@/utils/home-folder';
import { classifyInput, pathValidity, type HostListingLite, type InputState } from './path-selector/input-model';
import { WORKSPACES_DIR_PART } from './draft-column';
import { detectProjectForFolder, timeOf, whereHostKey, type WorkInRow } from './draft-work-in';

export interface MenuFolderRow {
  key: string;
  cwd: string;
  /** Host key. */
  host: string;
  hostLabel?: string;
  name: string;
  /** The path as shown: the home as `~`, whole parts only. */
  path: string;
  project?: string;
  at?: string;
  lastLaunch?: WorkingDirEntry['lastLaunch'];
  current: boolean;
}

export interface MenuSection { title: string; rows: MenuFolderRow[] }

/** Recent rows per host in an empty search: enough to scroll, never the whole history. */
const PER_HOST = 8;

const trim = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p);
const nameOf = (p: string): string => { const d = trim(p); return d.slice(d.lastIndexOf('/') + 1) || d; };

/** A path's words in a row: home as `~`, its last `keep` (3) parts after `…` (never half a part). */
export function shownPath(cwd: string, home?: string, keep = 3): string {
  const t = tildePath(trim(cwd), home);
  const items = pathCrumbItems(t, keep);
  if (items.length === 1 && (items[0].label === '/' || items[0].label === '~')) return items[0].label;
  const abs = t.startsWith('/') && items[0].label !== '…';
  return `${abs ? '/' : ''}${items.map((c) => c.label).join('/')}`;
}

/** The recent folders as menu sections. `query` '' = per host "Recent on X"; a word = "N on X". */
export function folderSections(dirs: readonly WorkingDirEntry[], ctx: {
  hostKey: string;
  hostName: (key: string) => string;
  homeOf: (key: string) => string | undefined;
  rows: readonly WorkInRow[];
  current: { cwd: string; host: string } | null;
  query: string;
}): MenuSection[] {
  const q = ctx.query.trim().toLowerCase();
  const byHost = new Map<string, MenuFolderRow[]>();
  const sorted = [...dirs].sort((a, b) => timeOf(b.lastUsed) - timeOf(a.lastUsed));
  const seen = new Set<string>();
  for (const d of sorted) {
    if (!d.cwd || d.cwd.includes(WORKSPACES_DIR_PART)) continue;
    const host = whereHostKey(d.host);
    const cwd = trim(d.cwd);
    const key = `${host}::${cwd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const home = ctx.homeOf(host);
    const path = shownPath(cwd, home);
    const name = tildePath(cwd, home) === '~' ? '~' : nameOf(cwd);
    if (q && !name.toLowerCase().includes(q) && !tildePath(cwd, home).toLowerCase().includes(q)) continue;
    const detected = detectProjectForFolder(cwd, host, ctx.rows, { home });
    const project = detected?.project ?? (d.project && ctx.rows.some((r) => r.name === d.project) ? d.project : undefined);
    const list = byHost.get(host) ?? [];
    list.push({
      key, cwd, host, ...(d.hostLabel ? { hostLabel: d.hostLabel } : {}), name, path,
      ...(project ? { project } : {}), at: d.lastUsed, ...(d.lastLaunch ? { lastLaunch: d.lastLaunch } : {}),
      current: !!ctx.current && ctx.current.host === host && trim(ctx.current.cwd) === cwd,
    });
    byHost.set(host, list);
  }
  const order = [ctx.hostKey, ...[...byHost.keys()].filter((h) => h !== ctx.hostKey)];
  // The draft's host leads an empty search even with no folder of its own yet (an empty group
  // says so), so the first group never names another host as if it were this one.
  return order.filter((h) => byHost.has(h) || (!q && h === ctx.hostKey)).map((h) => {
    const rows = byHost.get(h) ?? [];
    return q
      ? { title: `${rows.length} on ${ctx.hostName(h)}`, rows }
      : { title: `Recent on ${ctx.hostName(h)}`, rows: rows.slice(0, PER_HOST) };
  });
}

export function isPathQuery(query: string): boolean {
  return query.startsWith('/') || query.startsWith('~');
}

export interface TypedPath {
  state: InputState;
  /** The typed path's folders, each clickable to that level. */
  crumbs: PathCrumb[];
  /** "Use this path": the folder the Enter would pick, and whether the host has it. */
  use: { path: string; validity: 'valid' | 'missing' | 'unknown' } | null;
  /** The listed folders under the typed level (a partial name filters them). */
  children: string[];
  loading: boolean;
}

/** A typed path on the draft's host: its breadcrumb, "Use this path" and the level's folders. */
export function typedPathView(query: string, listing: HostListingLite | undefined): TypedPath {
  const state = classifyInput(query);
  const dir = state.kind === 'dir-browse' || state.kind === 'segment' ? state.dir : state.kind === 'scoped-search' ? state.base : '';
  const crumbs = dir ? pathCrumbItems(trim(dir), 6) : [];
  const typed = trim(query.trim());
  const use = state.kind === 'browse' || state.kind === 'scoped-search' || !typed
    ? null
    : { path: typed || '/', validity: pathValidity(state, listing ? [listing] : []) };
  let children: string[] = [];
  if (listing?.status === 'done' && listing.exists) {
    const parent = listing.parent.endsWith('/') ? listing.parent : `${listing.parent}/`;
    const partial = state.kind === 'segment' ? state.partial.toLowerCase() : state.kind === 'scoped-search' ? state.keyword.toLowerCase() : '';
    children = listing.dirs
      .filter((p) => p.startsWith(parent) && !p.slice(parent.length).includes('/'))
      .filter((p) => !partial || nameOf(p).toLowerCase().includes(partial))
      .sort((a, b) => {
        const an = nameOf(a).toLowerCase(); const bn = nameOf(b).toLowerCase();
        const ap = partial && an.startsWith(partial) ? 0 : 1; const bp = partial && bn.startsWith(partial) ? 0 : 1;
        return ap - bp || an.localeCompare(bn);
      });
  }
  return { state, crumbs, use, children, loading: listing?.status === 'loading' };
}
