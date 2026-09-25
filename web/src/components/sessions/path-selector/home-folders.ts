/**
 * HOME FOLDERS: suggestions for a bare word ("work", "proj") typed into the
 * folder picker.
 *
 * A bare word used to search session history only. A fresh install (or a remote
 * host added a minute ago) has none, so typing `work` showed nothing and the user
 * concluded `~/workplace` could not be found. The picker now also lists `~/` on the
 * host(s) in view and matches the word against the home folder NAMES. History
 * matches keep the top of the list; these come after them under their own heading.
 *
 * Matching is on the folder's own name only, never on the home path: "home" or
 * the user name must not match every row through "/home/alice".
 *
 * Pure: no React, no IO. Unit-tested in tests/web/path-selector/home-folders.test.ts.
 */
import { matchQuality, qualityRank, type MatchQuality } from '@/utils/fuzzy';
import type { WorkingDirEntry } from '@/api/sessions';
import type { HostListingLite } from './input-model';
import { frecencyScore, type RankedItem, type Section } from './ranking';

export const HOME_FOLDERS_LABEL = '🏠 home folders';

interface HomeFolderOpts {
  word: string;
  /** Live `~/` listing per host key ('__local__' for local), in target order. */
  byHost: ReadonlyMap<string, HostListingLite>;
  /** Host key → display label. */
  hostLabels: ReadonlyMap<string, string>;
  /** History entries by `${hostKey}::${cwd}`: marks a home folder you have used. */
  history: ReadonlyMap<string, WorkingDirEntry>;
  /** `${hostKey}::${cwd}` rows already shown above (history matches): never twice. */
  shown: ReadonlySet<string>;
  /** All tab: one section per host, the host named in its heading. */
  perHost: boolean;
  now?: number;
}

/** Direct children of each host's home folder whose name matches `word`, as
 *  display sections (local first, then hosts in listing order). */
export function buildHomeFolderSections(opts: HomeFolderOpts): Section[] {
  const { word, byHost, hostLabels, history, shown, perHost } = opts;
  const now = opts.now ?? Date.now();
  const showHidden = word.startsWith('.');
  const keys = Array.from(byHost.keys()).sort((a, b) => Number(b === '__local__') - Number(a === '__local__'));

  const sections: Section[] = [];
  for (const hostKey of keys) {
    const state = byHost.get(hostKey)!;
    if (state.status !== 'done' || !state.exists) continue;
    const parent = state.parent.endsWith('/') ? state.parent : state.parent + '/';
    const host = hostKey === '__local__' ? null : hostKey;
    const hostLabel = host ? (hostLabels.get(hostKey) ?? hostKey) : undefined;
    const items: RankedItem[] = [];
    for (const cwd of state.dirs) {
      if (!cwd.startsWith(parent)) continue;
      const name = cwd.slice(parent.length);
      if (!name || name.includes('/')) continue; // direct children only
      if (name.startsWith('.') && !showHidden) continue;
      const key = `${hostKey}::${cwd}`;
      if (shown.has(key)) continue;
      const quality: MatchQuality = matchQuality(word, name);
      if (quality === 'none') continue;
      const hist = history.get(key);
      items.push({
        cwd, host, hostLabel, source: 'live',
        // depth 0: the row shows the whole `~/name` path, not a "…/name" tail
        // (there is no typed prefix in the input for it to continue from).
        depth: 0,
        history: hist,
        quality, leafHit: true,
        frecency: hist ? frecencyScore(hist.count, hist.lastUsed, now) : 0,
      });
    }
    if (items.length === 0) continue;
    items.sort((a, b) => {
      const qd = qualityRank(b.quality) - qualityRank(a.quality);
      if (qd !== 0) return qd;                                   // prefix > substring > subsequence
      if (a.frecency !== b.frecency) return b.frecency - a.frecency; // used before first
      return a.cwd.localeCompare(b.cwd);
    });
    sections.push({
      id: `home:${hostKey}`,
      label: perHost ? `${HOME_FOLDERS_LABEL} · ${hostKey === '__local__' ? 'Local' : hostLabel}` : HOME_FOLDERS_LABEL,
      hostKey,
      items,
    });
  }
  return sections;
}

/**
 * The per-host rows a home search shows below its results: a host still
 * connecting (the step it is on) or a host that failed (cause + Retry), exactly as
 * path mode shows them. Settled listings are dropped, so an empty or missing home
 * folder never adds a "No subdirectories on X" note under a word search.
 */
export function homeSearchHostStates<T extends HostListingLite & { pending?: unknown }>(
  byHost: ReadonlyMap<string, T>,
): Map<string, T> {
  const out = new Map<string, T>();
  for (const [key, state] of byHost) {
    if (state.status === 'error' || (state.status === 'loading' && state.pending)) out.set(key, state);
  }
  return out;
}
