/**
 * QUICK ACCESS: a starting point for a user with no session history.
 *
 * A fresh install (or a host added a minute ago) opens the picker on `~/`, and the
 * home listing alone is every folder in the home, Library and Music included, with
 * nothing to say where code usually lives. Quick access leads that listing with the
 * home folder itself and the usual work folders that EXIST on that host (Desktop,
 * Documents, code, projects, ...). Existence comes from the `~/` listing the picker
 * already has, so this costs no request.
 *
 * Rows are ordinary live rows, so a click or ↑↓ + Enter opens the folder like any
 * other row. The home row IS the listed folder: opening it uses it (the picker
 * handles that, see drillOrFill in SessionPathSelector).
 *
 * Pure: no React, no IO. Unit-tested in tests/web/path-selector/quick-access.test.ts.
 */
import type { HostListingLite } from './input-model';
import type { RankedItem, Section } from './ranking';

export const QUICK_ACCESS_LABEL = '⭐ Quick access';

/** Home folder names offered when present, in display order. Exact names: a
 *  listing returns real casing, and a case-sensitive host can have both. */
export const QUICK_ACCESS_NAMES: readonly string[] = [
  'Desktop', 'Documents', 'Downloads', 'code', 'Code', 'projects', 'Projects',
  'src', 'dev', 'workplace', 'repos', 'git', 'GitHub', 'work',
];

/**
 * The home row plus every QUICK_ACCESS_NAMES folder among the direct children of
 * `parent` (the resolved home). `homeDirs` is the live listing, which also holds
 * preloaded grandchildren: those are ignored.
 */
export function quickAccessRows(
  homeDirs: readonly string[],
  parent: string,
  host: { host: string | null; hostLabel?: string } = { host: null },
): RankedItem[] {
  const home = parent.replace(/\/+$/, '') || '/';
  const prefix = home === '/' ? '/' : home + '/';
  const children = new Set<string>();
  for (const p of homeDirs) {
    if (!p.startsWith(prefix)) continue;
    const name = p.slice(prefix.length).replace(/\/+$/, '');
    if (name && !name.includes('/')) children.add(name);
  }
  const row = (cwd: string): RankedItem => ({
    cwd, host: host.host, ...(host.hostLabel ? { hostLabel: host.hostLabel } : {}),
    source: 'live',
    // depth 0: the row shows its whole path (~/code/), not a "…/code" tail.
    depth: 0, quality: 'prefix', leafHit: true, frecency: 0,
  });
  return [row(home), ...QUICK_ACCESS_NAMES.filter((n) => children.has(n)).map((n) => row(prefix + n))];
}

interface QuickAccessOpts {
  /** The dir-browse folder typed in the input ('~/', or a resolved home after the ~ rewrite). */
  dir: string;
  /** Live listing per host key ('__local__' for local). */
  byHost: ReadonlyMap<string, HostListingLite>;
  /** Host key → resolved home (learned from a `~/` listing). */
  homeByHost: ReadonlyMap<string, string>;
  /** Host key → display label. */
  hostLabels: ReadonlyMap<string, string>;
  /** All tab over several hosts: one section per host, the host named in its heading. */
  perHost: boolean;
}

/** One Quick access section per host whose listing is its home (local first).
 *  The caller decides whether Quick access applies at all (no history on the tab). */
export function buildQuickAccessSections(opts: QuickAccessOpts): Section[] {
  const { byHost, homeByHost, hostLabels, perHost } = opts;
  const typed = opts.dir.replace(/\/+$/, '') || '/';
  const keys = Array.from(byHost.keys()).sort((a, b) => Number(b === '__local__') - Number(a === '__local__'));
  const sections: Section[] = [];
  for (const hostKey of keys) {
    const state = byHost.get(hostKey)!;
    if (state.status !== 'done' || !state.exists) continue;
    // Only the home listing: '~' itself, or the path the ~ rewrite resolved it to.
    if (typed !== '~' && homeByHost.get(hostKey) !== typed) continue;
    const host = hostKey === '__local__' ? null : hostKey;
    const hostLabel = host ? (hostLabels.get(hostKey) ?? hostKey) : undefined;
    sections.push({
      id: `quick:${hostKey}`,
      label: perHost ? `${QUICK_ACCESS_LABEL} · ${hostLabel ?? 'Local'}` : QUICK_ACCESS_LABEL,
      hostKey,
      items: quickAccessRows(state.dirs, state.parent, { host, hostLabel }),
    });
  }
  return sections;
}
