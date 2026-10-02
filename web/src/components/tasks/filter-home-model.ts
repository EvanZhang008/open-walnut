/**
 * filter-home-model: what the Filter menu's first page shows. A short list,
 * not a wall: the few filters the user picks most, then one row per property
 * (its current value at the right), the rarely used properties folded behind
 * `More filters` unless one of them is set. Pure, no React.
 */
import type { FilterChip, FilterDim, FilterLists, FilterState, RecentEntry } from './filter-bar-types';
import { FILTER_DIMS, MORE_DIMS } from './filter-bar-types';
import { isDimDefault, isDimVisible } from './filter-bar-model';

/** How many `Most used` rows the first page shows. */
export const MOST_USED_LIMIT = 4;

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
 * The `Most used` rows: the remembered picks ranked by how often they were
 * made, newest first among equals, capped. The input is already validated
 * (every value still exists) and newest first.
 */
export function mostUsed(recent: readonly RecentEntry[], limit = MOST_USED_LIMIT): RecentEntry[] {
  return recent
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => (b.entry.uses ?? 1) - (a.entry.uses ?? 1) || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.entry);
}
