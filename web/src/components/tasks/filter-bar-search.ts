/**
 * filter-bar-search: the Filter popover's search box (6.3). Flat hits over
 * every dimension (More dims and values truncated behind `N more` included),
 * with keyword aliases. Pure, no React.
 */
import type { FilterDim, FilterLists, FilterState } from './filter-bar-types';
import { FILTER_DIMS } from './filter-bar-types';
import { dimLabel, dimValues, isDimVisible, timeChipText } from './filter-bar-model';

export interface FilterSearchHit {
  dim: FilterDim;
  value: string;
  dimLabel: string;
  valueLabel: string;
  selected: boolean;
}

export interface FilterSearchResult {
  hits: FilterSearchHit[];
  /** The text asked for Pinned, which is a view: show the "open Display" line. */
  pinHint: boolean;
  /** The view the text asked for (Pinned, a tier, Recent): `<view> is a view: open Display` (F27). */
  viewHint: string | null;
}

/** Extra words that find a whole dimension. */
const DIM_ALIASES: Partial<Record<FilterDim, readonly string[]>> = {
  status: ['phase', 'state'],
  time: ['updated', 'created', 'time', 'recent'],
  blocked: ['flag', 'blocked', 'dependency'],
  tags: ['tag', 'label'],
};

/** Extra words that find one value. */
const VALUE_ALIASES: Partial<Record<FilterDim, Record<string, readonly string[]>>> = {
  status: {
    IN_PROGRESS: ['doing'],
    COMPLETE: ['done', 'complete', 'completed', 'finished'],
    TODO: ['todo'],
  },
  // The old quick filter called it "This week" (F27).
  date: {
    'this-week': ['week', 'thisweek', 'soon'],
    'no-date': ['nodate', 'undated'],
  },
};

/** Views a user may look for in the Filter search; they live in Display (F27). */
const VIEW_WORDS: readonly { label: string; words: readonly string[] }[] = [
  { label: 'Pinned', words: ['pinned', 'pin'] },
  { label: 'Focus', words: ['focus'] },
  { label: 'Satellite', words: ['satellite'] },
  { label: 'Parked', words: ['parked'] },
  { label: 'Focus', words: ['tier', 'tiers'] },
  { label: 'Recent', words: ['recent'] },
];

function squash(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '');
}

/** Case-insensitive substring match that also ignores spaces (`todo` finds `To Do`). */
function hit(query: string, hay: string): boolean {
  const h = hay.toLowerCase();
  return h.includes(query) || squash(h).includes(squash(query));
}

function aliasHit(query: string, words: readonly string[] | undefined): boolean {
  if (!words) return false;
  const q = squash(query);
  return words.some((w) => w.startsWith(q) || q === w);
}

/** The view a query asks for, if any (three letters at least). */
export function viewHintFor(query: string): string | null {
  const q = squash(query);
  if (q.length < 3) return null;
  for (const v of VIEW_WORDS) {
    if (v.words.some((w) => w.startsWith(q) || q.startsWith(w))) return v.label;
  }
  return null;
}

/**
 * Search every dimension's values. Order (G15): every unselected hit first,
 * in registry order, then the selected ones in the same order. `Custom` time
 * windows never appear (one click cannot supply the number).
 */
export function searchFilterDims(text: string, state: FilterState, lists: FilterLists): FilterSearchResult {
  const query = text.trim().toLowerCase();
  if (!query) return { hits: [], pinHint: false, viewHint: null };
  const unselected: FilterSearchHit[] = [];
  const selected: FilterSearchHit[] = [];
  for (const dim of FILTER_DIMS) {
    if (!isDimVisible(dim, state, lists)) continue;
    const name = dimLabel(dim);
    const wholeDim = hit(query, name) || aliasHit(query, DIM_ALIASES[dim]);
    for (const opt of dimValues(dim, state, lists)) {
      if (dim === 'time' && opt.value === 'custom') continue;
      const label = dim === 'time'
        ? timeChipText({ ...state.time, preset: opt.value as FilterState['time']['preset'] }) ?? opt.label
        : opt.label;
      const matched = wholeDim || hit(query, label) || aliasHit(query, VALUE_ALIASES[dim]?.[opt.value]);
      if (!matched) continue;
      const entry: FilterSearchHit = {
        dim, value: opt.value, dimLabel: name, valueLabel: label, selected: opt.selected,
      };
      (opt.selected ? selected : unselected).push(entry);
    }
  }
  // `recent` also names the Time window dimension; a hint only when nothing else matched.
  const hits = [...unselected, ...selected];
  const view = viewHintFor(query);
  const viewHint = view === 'Recent' && hits.length > 0 ? null : view;
  return { hits, pinHint: viewHint === 'Pinned', viewHint };
}
