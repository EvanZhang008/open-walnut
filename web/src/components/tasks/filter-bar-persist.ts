/**
 * filter-bar-persist: localStorage for the home Filter bar (4.7, 4.8, 5.10).
 *
 * Every key carries the `walnut-todo-` prefix on purpose: ui-prefs-sync mirrors
 * it to the user's other devices (wanted, same as the old date key), and
 * crash-recovery clears it. Tests must call isolateUiPrefs first.
 * Reads are synchronous so the first render already shows the filtered list.
 */
import type { TaskPhase, TaskPriority } from '@open-walnut/core';
import { log } from '@/utils/log';
import { INBOX_TAB, LS_TAB_KEY } from './task-tabs';
import {
  DEFAULT_FILTER_STATE,
  FILTER_DIMS,
  type DateFilterValue,
  type FilterDim,
  type FilterState,
  type FilterTime,
  type RecentEntry,
} from './filter-bar-types';
import { orderStatus } from './filter-bar-model';
import { recentKey } from './filter-recent';

export const LS_FILTERS_KEY = 'walnut-todo-filters';
export const LS_FILTER_RECENT_KEY = 'walnut-todo-filter-recent';
export const LS_FILTER_MORE_OPEN_KEY = 'walnut-todo-filter-more-open';
export const LS_TIER_USED_KEY = 'walnut-todo-tier-used';
/** The old date key: folded once into LS_FILTERS_KEY, read-only afterwards. */
export const LS_LEGACY_DATE_KEY = 'walnut-todo-dateFilter';

export const FILTERS_VERSION = 1;
/** Stored history is longer than the 4 shown, so dropped values do not shrink the row. */
export const RECENT_STORE_LIMIT = 12;

const DATE_VALUES: readonly DateFilterValue[] = ['', 'now', 'overdue', 'this-week', 'no-date'];
const PRIORITIES: readonly TaskPriority[] = ['immediate', 'important', 'backlog', 'none'];
const BASES: readonly FilterTime['basis'][] = ['created', 'updated', 'created_or_updated'];
const PRESETS: readonly NonNullable<FilterTime['preset']>[] = ['1h', '6h', '24h', '7d', '30d', 'custom'];

function getItem(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function setItem(key: string, value: string): void {
  // Quota or private mode: silently ignored, same as persistDateFilter.
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

function strings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

function parseTime(raw: unknown): FilterTime {
  const d = DEFAULT_FILTER_STATE.time;
  if (!raw || typeof raw !== 'object') return { ...d };
  const r = raw as Record<string, unknown>;
  return {
    basis: BASES.includes(r.basis as FilterTime['basis']) ? (r.basis as FilterTime['basis']) : d.basis,
    preset: PRESETS.includes(r.preset as NonNullable<FilterTime['preset']>) ? (r.preset as FilterTime['preset']) : null,
    customValue: typeof r.customValue === 'number' && Number.isFinite(r.customValue) ? r.customValue : d.customValue,
    customUnit: r.customUnit === 'days' ? 'days' : 'hours',
  };
}

/** Field-by-field sanitize of a stored v1 record; unknown pieces fall back to default. */
export function parseFilterRecord(r: Record<string, unknown>): FilterState {
  const status = orderStatus(strings(r.status) as TaskPhase[]);
  return {
    status: status.length ? status : [...DEFAULT_FILTER_STATE.status],
    projects: strings(r.projects),
    date: DATE_VALUES.includes(r.date as DateFilterValue) ? (r.date as DateFilterValue) : DEFAULT_FILTER_STATE.date,
    sources: strings(r.sources),
    priorities: strings(r.priorities).filter((p): p is TaskPriority => PRIORITIES.includes(p as TaskPriority)),
    blocked: typeof r.blocked === 'boolean' ? r.blocked : undefined,
    tagsAny: strings(r.tagsAny),
    sprints: strings(r.sprints),
    time: parseTime(r.time),
  };
}

export function serializeFilters(state: FilterState): string {
  return JSON.stringify({
    v: FILTERS_VERSION,
    status: orderStatus(state.status),
    projects: state.projects,
    date: state.date,
    sources: state.sources,
    priorities: state.priorities,
    ...(state.blocked === undefined ? {} : { blocked: state.blocked }),
    tagsAny: state.tagsAny,
    sprints: state.sprints,
    time: state.time,
  });
}

export function writePersistedFilters(state: FilterState): void {
  setItem(LS_FILTERS_KEY, serializeFilters(state));
}

/** First read with no new key: fold the old date key and the tab bookmark. */
function foldLegacyKeys(): FilterState | null {
  const date = getItem(LS_LEGACY_DATE_KEY);
  const tab = getItem(LS_TAB_KEY);
  const hasDate = date !== null && DATE_VALUES.includes(date as DateFilterValue);
  if (!hasDate && !tab) return null;
  const state: FilterState = {
    ...DEFAULT_FILTER_STATE,
    status: [...DEFAULT_FILTER_STATE.status],
    time: { ...DEFAULT_FILTER_STATE.time },
    date: hasDate ? (date as DateFilterValue) : DEFAULT_FILTER_STATE.date,
    projects: tab ? [tab === INBOX_TAB ? '' : tab] : [],
  };
  writePersistedFilters(state);
  return state;
}

/**
 * Synchronous read for a useState initializer. null = use the defaults.
 * Bad JSON or an unknown version is dropped with a warning.
 */
export function readPersistedFilters(): FilterState | null {
  const raw = getItem(LS_FILTERS_KEY);
  if (raw === null) return foldLegacyKeys();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn('filter-bar', 'stored filters are not valid JSON, using defaults', { error: (err as Error).message });
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as { v?: unknown }).v !== FILTERS_VERSION) {
    log.warn('filter-bar', 'stored filters have an unknown version, using defaults', {
      v: parsed && typeof parsed === 'object' ? String((parsed as { v?: unknown }).v) : typeof parsed,
    });
    return null;
  }
  return parseFilterRecord(parsed as Record<string, unknown>);
}

// ── Recent (4.7) ──

function parseRecentEntry(raw: unknown): RecentEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { dim?: unknown; value?: unknown; uses?: unknown };
  if (!FILTER_DIMS.includes(r.dim as FilterDim)) return null;
  const uses = typeof r.uses === 'number' && Number.isFinite(r.uses) && r.uses > 1 ? Math.floor(r.uses) : undefined;
  const entry = (value: string | string[]): RecentEntry => (uses ? { dim: r.dim as FilterDim, value, uses } : { dim: r.dim as FilterDim, value });
  if (typeof r.value === 'string') return entry(r.value);
  if (Array.isArray(r.value) && r.value.every((v) => typeof v === 'string')) return entry([...r.value]);
  return null;
}

/** Stored Recent entries, newest first (shape-checked only; see validRecent). */
export function readRecent(): RecentEntry[] {
  const raw = getItem(LS_FILTER_RECENT_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseRecentEntry).filter((e): e is RecentEntry => e !== null);
  } catch {
    return [];
  }
}

/**
 * Record new picks (given oldest first): newest first, deduped, capped. A pick
 * made before keeps its place at the top and counts one more use, which is
 * what ranks the menu's search hits.
 */
export function pushRecent(entries: readonly RecentEntry[]): RecentEntry[] {
  const current = readRecent();
  if (!entries.length) return current;
  const uses = new Map(current.map((e) => [recentKey(e), e.uses ?? 1]));
  const seen = new Set<string>();
  const next: RecentEntry[] = [];
  for (const entry of [...entries].reverse().concat(current)) {
    const key = recentKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    const fresh = entries.some((e) => recentKey(e) === key);
    const n = fresh ? (uses.get(key) ?? 0) + 1 : (entry.uses ?? 1);
    next.push(n > 1 ? { dim: entry.dim, value: entry.value, uses: n } : { dim: entry.dim, value: entry.value });
    if (next.length >= RECENT_STORE_LIMIT) break;
  }
  setItem(LS_FILTER_RECENT_KEY, JSON.stringify(next));
  return next;
}

// ── Small flags ──

export function readMoreOpen(): boolean {
  return getItem(LS_FILTER_MORE_OPEN_KEY) === '1';
}

export function writeMoreOpen(open: boolean): void {
  setItem(LS_FILTER_MORE_OPEN_KEY, open ? '1' : '0');
}

/** 5.10: the user has picked a tier at least once (set once, never cleared). */
export function readTierUsed(): boolean {
  return getItem(LS_TIER_USED_KEY) === '1';
}

export function markTierUsed(): void {
  if (!readTierUsed()) setItem(LS_TIER_USED_KEY, '1');
}

/** The id of the "Task created" toast for a task, so a later toast about the same create can replace it (F33). */
export function createdToastId(taskId: string): string {
  return `task-created-${taskId}`;
}
