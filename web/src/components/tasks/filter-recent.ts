/**
 * filter-recent: the Filter popover's Recent row (4.7). Entries store ids,
 * never text; they are drawn through the registry. Pure, no React.
 */
import type { TaskPhase } from '@open-walnut/core';
import type { DateFilterValue, FilterDim, FilterLists, FilterState, RecentEntry } from './filter-bar-types';
import {
  DATE_FILTER_OPTIONS,
  STATUS_FILTER_ORDER,
  dimLabel,
  isDefaultStatus,
  isValueMissing,
  orderStatus,
  pickValue,
  resetDim,
  selectedValues,
  statusChipLabel,
  valueLabel,
  withValues,
} from './filter-bar-model';

export const RECENT_LIMIT = 4;

/** Dimensions Recent remembers. */
export const RECENT_DIMS: readonly FilterDim[] = ['project', 'source', 'tags', 'sprint', 'status', 'date', 'blocked'];
const LIST_DIMS: readonly FilterDim[] = ['project', 'source', 'tags', 'sprint'];

export function recentKey(entry: RecentEntry): string {
  const v = Array.isArray(entry.value) ? orderStatus(entry.value as TaskPhase[]).join(',') : entry.value;
  return `${entry.dim}:${v}`;
}

function sameStatusSet(a: readonly string[], b: readonly string[]): boolean {
  const x = orderStatus(a as TaskPhase[]);
  const y = orderStatus(b as TaskPhase[]);
  return x.length === y.length && x.every((p, i) => p === y[i]);
}

/** The non-default conditions `next` adds over `prev`, newest last. */
export function recentEntriesFor(prev: FilterState, next: FilterState): RecentEntry[] {
  const out: RecentEntry[] = [];
  for (const dim of LIST_DIMS) {
    const before = selectedValues(prev, dim);
    for (const value of selectedValues(next, dim)) {
      if (!before.includes(value)) out.push({ dim, value });
    }
  }
  if (!isDefaultStatus(next.status) && !sameStatusSet(prev.status, next.status)) {
    out.push({ dim: 'status', value: orderStatus(next.status) });
  }
  if (next.date !== prev.date && next.date !== 'now') out.push({ dim: 'date', value: next.date });
  if (next.blocked !== undefined && next.blocked !== prev.blocked) {
    out.push({ dim: 'blocked', value: String(next.blocked) });
  }
  return out;
}

export function isRecentActive(state: FilterState, entry: RecentEntry): boolean {
  if (entry.dim === 'status') {
    return Array.isArray(entry.value) && sameStatusSet(state.status, entry.value);
  }
  const value = String(entry.value);
  return selectedValues(state, entry.dim).includes(value);
}

/**
 * Click a Recent entry. Inactive: Status replaces the whole set, Project and
 * Source replace (6.2), Tags and Sprint add, single-select dims replace.
 * Active: removes that value (single-select and Status go back to default).
 */
export function applyRecentEntry(state: FilterState, entry: RecentEntry): FilterState {
  const active = isRecentActive(state, entry);
  if (entry.dim === 'status') {
    if (active) return resetDim(state, 'status');
    const set = orderStatus((Array.isArray(entry.value) ? entry.value : [entry.value]) as TaskPhase[]);
    return set.length ? withValues(state, 'status', set) : state;
  }
  const value = String(entry.value);
  if (active) {
    if (!LIST_DIMS.includes(entry.dim)) return resetDim(state, entry.dim);
    return withValues(state, entry.dim, selectedValues(state, entry.dim).filter((v) => v !== value));
  }
  if (entry.dim === 'project' || entry.dim === 'source') return withValues(state, entry.dim, [value]);
  return pickValue(state, entry.dim, value, 'add');
}

/** `Project: Walnut`, `Status: Open, Complete`, `Date: Starting within 7 days`, `Not blocked`. */
export function recentEntryLabel(entry: RecentEntry, lists: FilterLists): string {
  if (entry.dim === 'status') {
    const set = (Array.isArray(entry.value) ? entry.value : [entry.value]) as TaskPhase[];
    return `${dimLabel('status')}: ${statusChipLabel(set)}`;
  }
  const text = valueLabel(entry.dim, String(entry.value), lists);
  if (entry.dim === 'blocked') return text;
  return `${dimLabel(entry.dim)}: ${text}`;
}

function entryValid(entry: RecentEntry, lists: FilterLists): boolean {
  if (!RECENT_DIMS.includes(entry.dim)) return false;
  if (entry.dim === 'status') {
    if (!Array.isArray(entry.value)) return false;
    const set = orderStatus(entry.value as TaskPhase[]);
    return set.length > 0 && set.length === entry.value.length
      && entry.value.every((p) => (STATUS_FILTER_ORDER as readonly string[]).includes(p));
  }
  if (typeof entry.value !== 'string') return false;
  if (entry.dim === 'date') return DATE_FILTER_OPTIONS.some((o) => o.value === (entry.value as DateFilterValue));
  if (entry.dim === 'blocked') return entry.value === 'true' || entry.value === 'false';
  return !isValueMissing(entry.dim, entry.value, lists);
}

/** Drop entries whose value no longer exists, dedupe, then keep the newest 4. */
export function validRecent(entries: readonly RecentEntry[], lists: FilterLists): RecentEntry[] {
  const seen = new Set<string>();
  const out: RecentEntry[] = [];
  for (const entry of entries) {
    if (!entry || !entryValid(entry, lists)) continue;
    const key = recentKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
    if (out.length >= RECENT_LIMIT) break;
  }
  return out;
}
