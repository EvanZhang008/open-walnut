/**
 * filter-home-model: what the panel menu's first page shows for filters. A
 * short list, not a wall: one row per property (its current value at the
 * right), the rarely used properties folded behind `More filters` unless one
 * of them is set. Also the use-based ranking of search hits. Pure, no React.
 */
import type { FilterChip, FilterDim, FilterLists, FilterState, RecentEntry } from './filter-bar-types';
import { FILTER_DIMS, MORE_DIMS } from './filter-bar-types';
import { isDimDefault, isDimVisible } from './filter-bar-model';
import { recentKey } from './filter-recent';

/** The right-hand words of a property row when nothing is set on it. */
const DEFAULT_SUMMARY: Record<FilterDim, string> = {
  status: 'Open',
  project: 'Any',
  date: 'Available now',
  source: 'Any',
  priority: 'Any',
  blocked: 'Any',
  tags: 'Any',
  sprint: 'Any',
  time: 'Any time',
};

export interface DimSummary {
  text: string;
  /** Nothing set: the words are the default, drawn muted. */
  isDefault: boolean;
}

/** `Open`, `Home, Garden`, `Available now`: the row's value in the chip's own words. */
export function dimSummary(dim: FilterDim, state: FilterState, chips: readonly FilterChip[]): DimSummary {
  const chip = chips.find((c) => c.dim === dim);
  if (chip && !isDimDefault(state, dim)) return { text: chip.value, isDefault: false };
  return { text: DEFAULT_SUMMARY[dim], isDefault: true };
}

export interface HomeRows {
  /** The property rows always shown: the first-layer properties plus any folded one that is set. */
  shown: FilterDim[];
  /** The folded properties (behind `More filters`), none of them set. */
  folded: FilterDim[];
}

/** Which property rows the first page draws, in registry order. */
export function homeRows(state: FilterState, lists: FilterLists): HomeRows {
  const shown: FilterDim[] = [];
  const folded: FilterDim[] = [];
  for (const dim of FILTER_DIMS) {
    if (!isDimVisible(dim, state, lists)) continue;
    if (MORE_DIMS.includes(dim) && isDimDefault(state, dim)) folded.push(dim);
    else shown.push(dim);
  }
  return { shown, folded };
}

/**
 * How often the user picked `value` on `dim` (0 = never remembered). The
 * remembered picks (`RecentEntry`, `uses` counted in pushRecent) rank the
 * search hits: the picks made most come first among what the text matches.
 */
export function useCount(recent: readonly RecentEntry[], dim: FilterDim, value: string): number {
  const key = `${dim}:${value}`;
  const hit = recent.find((e) => !Array.isArray(e.value) && recentKey(e) === key);
  return hit ? hit.uses ?? 1 : 0;
}

/** Stable sort: the items used most first, ties keep their order. */
export function rankByUse<T>(items: readonly T[], uses: (item: T) => number): T[] {
  return items
    .map((item, i) => ({ item, i, n: uses(item) }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map((x) => x.item);
}

/**
 * How well a label answers the typed text: 2 = the whole label, 1 = its start,
 * 0 = somewhere inside (or through a keyword). `recent` names the Recent view
 * before the time windows a keyword matched; `wait` puts Waiting first.
 */
export function matchScore(label: string, query: string): number {
  const l = label.trim().toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  if (l === q) return 2;
  if (l.startsWith(q)) return 1;
  return 0;
}

/** Stable sort by matchScore, highest first; ties keep their order. */
export function rankByMatch<T>(items: readonly T[], label: (item: T) => string, query: string): T[] {
  return items
    .map((item, i) => ({ item, i, n: matchScore(label(item), query) }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map((x) => x.item);
}

export function badgeText(n: number): string {
  return n > 9 ? '9+' : String(n);
}
