/**
 * filter-bar-dims: the dimension registry's static half (labels, titles,
 * per-dimension access to FilterState). Split out of filter-bar-model.ts to
 * keep each file under 500 lines; filter-bar-model re-exports all of it.
 * Pure, no React. Relative runtime imports on purpose.
 */
import { PHASE_LABELS } from '../../utils/session-status';
import type { TaskPhase, TaskPriority } from '@open-walnut/core';
import {
  QUERY_PRIORITY_OPTIONS,
  TIME_BASIS_OPTIONS,
  TIME_PRESET_OPTIONS,
  type TimePresetKey,
} from './view-filter-model';
import {
  DEFAULT_FILTER_STATE,
  type DateFilterValue,
  type FilterDim,
  type FilterLists,
  type FilterState,
  type FilterTime,
} from './filter-bar-types';

// ── Status (4.2, 4.2a) ──

export const OPEN_PHASES: readonly TaskPhase[] = ['TODO', 'IN_PROGRESS', 'NEED_ACTION'];
/** STATUS_OPTIONS order with Waiting moved after the open block. */
export const STATUS_FILTER_ORDER: readonly TaskPhase[] = [
  'TODO', 'IN_PROGRESS', 'NEED_ACTION', 'WAITING', 'COMPLETE',
];

export const STATUS_TITLES: Record<TaskPhase, string> = {
  TODO: 'To Do: not started yet',
  IN_PROGRESS: 'In Progress: someone is working on it now',
  NEED_ACTION: 'Need Action: an agent is waiting for your reply',
  WAITING: 'Waiting: on hold until a date or an event, hidden by default',
  COMPLETE: 'Complete: finished, hidden by default',
};

export const STATUS_LAST_VALUE_TITLE = 'At least one status stays on';
export const MISSING_VALUE_TITLE = 'No task has this value now';

/** Dedupe + registry order; drops anything that is not a known phase. */
export function orderStatus(set: readonly TaskPhase[]): TaskPhase[] {
  return STATUS_FILTER_ORDER.filter((p) => set.includes(p));
}

export function isDefaultStatus(set: readonly TaskPhase[]): boolean {
  const s = orderStatus(set);
  return s.length === OPEN_PHASES.length && OPEN_PHASES.every((p) => s.includes(p));
}

export function hasAllOpen(set: readonly TaskPhase[]): boolean {
  return OPEN_PHASES.every((p) => set.includes(p));
}

export function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// ── Labels ──

const DIM_LABELS: Record<FilterDim, string> = {
  status: 'Status',
  project: 'Project',
  date: 'Date',
  source: 'Source',
  priority: 'Priority',
  blocked: 'Blocked',
  tags: 'Tags',
  sprint: 'Sprint',
  time: 'Time window',
};

export function dimLabel(dim: FilterDim): string {
  return DIM_LABELS[dim];
}

export function statusChipLabel(set: readonly TaskPhase[]): string {
  const s = orderStatus(set);
  if (hasAllOpen(s)) {
    const extras = s.filter((p) => !OPEN_PHASES.includes(p));
    if (extras.length === 0) return 'Open';
    if (s.length === STATUS_FILTER_ORDER.length) return 'Any';
    return ['Open', ...extras.map((p) => PHASE_LABELS[p])].join(', ');
  }
  // Five statuses in all, so three names still fit a chip; four is a count.
  if (s.length <= 3) return s.map((p) => PHASE_LABELS[p]).join(', ');
  return `${s.length} statuses`;
}

/** 1 = the name, 2 = `A, B`, 3+ = `3 <plural>`. */
export function listChipLabel(names: readonly string[], plural: string): string {
  if (names.length <= 2) return names.join(', ');
  return `${names.length} ${plural}`;
}

const TIME_PRESET_WINDOWS: Record<Exclude<TimePresetKey, 'custom'>, { value: number; unit: 'hours' | 'days' }> = {
  '1h': { value: 1, unit: 'hours' },
  '6h': { value: 6, unit: 'hours' },
  '24h': { value: 24, unit: 'hours' },
  '7d': { value: 7, unit: 'days' },
  '30d': { value: 30, unit: 'days' },
};

/** Chip word for a time basis: `Either` reads as `Active` on a chip. */
export function timeBasisWord(basis: FilterTime['basis']): string {
  if (basis === 'created_or_updated') return 'Active';
  return TIME_BASIS_OPTIONS.find((o) => o.value === basis)?.label ?? String(basis);
}

/** `Updated in 24h`, `Created in 7d`, `Active in 30d`; null = no window. */
export function timeChipText(time: FilterTime): string | null {
  if (time.preset === null) return null;
  let win: { value: number; unit: 'hours' | 'days' };
  if (time.preset === 'custom') {
    const value = Math.floor(time.customValue);
    if (!Number.isFinite(value) || value <= 0) return null;
    win = { value, unit: time.customUnit };
  } else {
    win = TIME_PRESET_WINDOWS[time.preset];
  }
  return `${timeBasisWord(time.basis)} in ${win.value}${win.unit === 'hours' ? 'h' : 'd'}`;
}

export interface DateFilterOption {
  value: DateFilterValue;
  label: string;
  title: string;
  firstLayer: boolean;
}

/** 4.1 Date values, named after what matchesDateFilter really does. */
export const DATE_FILTER_OPTIONS: readonly DateFilterOption[] = [
  { value: 'now', label: 'Available now', title: 'Hide tasks that start later. Tasks with no start date stay.', firstLayer: true },
  { value: '', label: 'Any date', title: 'Show every task, including ones that start later.', firstLayer: true },
  { value: 'overdue', label: 'Overdue', title: "Only tasks whose due date, or a parent's due date, has passed.", firstLayer: false },
  { value: 'this-week', label: 'Starting within 7 days', title: 'Hide only tasks that start more than 7 days from now.', firstLayer: false },
];

export function dateLabel(value: DateFilterValue): string {
  return DATE_FILTER_OPTIONS.find((o) => o.value === value)?.label ?? String(value);
}

export const BLOCKED_OPTIONS: readonly { value: 'true' | 'false'; label: string; title: string }[] = [
  { value: 'true', label: 'Blocked', title: 'Tasks that depend on an unfinished task' },
  { value: 'false', label: 'Not blocked', title: 'Tasks with no unfinished dependency' },
];

export function projectLabel(name: string): string {
  return name === '' ? 'Inbox' : name;
}

export function sourceLabel(id: string, lists: Pick<FilterLists, 'sources'>): string {
  const hit = lists.sources.find((s) => s.id === id);
  if (hit) return hit.label;
  return id === 'local' ? 'Local' : id;
}

export function priorityLabel(p: TaskPriority): string {
  return QUERY_PRIORITY_OPTIONS.find((o) => o.value === p)?.label ?? String(p);
}

/** Text for one stored value id of one dimension. */
export function valueLabel(dim: FilterDim, value: string, lists: FilterLists): string {
  switch (dim) {
    case 'status': return PHASE_LABELS[value as TaskPhase] ?? value;
    case 'project': return projectLabel(value);
    case 'date': return dateLabel(value as DateFilterValue);
    case 'source': return sourceLabel(value, lists);
    case 'priority': return priorityLabel(value as TaskPriority);
    case 'blocked': return value === 'true' ? 'Blocked' : 'Not blocked';
    case 'tags': return lists.tagLabel(value);
    case 'sprint': return value;
    case 'time': return TIME_PRESET_OPTIONS.find((o) => o.value === value)?.label ?? value;
  }
}

export function hasName(list: readonly string[], name: string): boolean {
  return list.some((n) => sameName(n, name));
}

/** Per-value "missing" check (selected but no loaded task has it). Never while loading. */
export function isValueMissing(dim: FilterDim, value: string, lists: FilterLists): boolean {
  if (lists.loading) return false;
  if (dim === 'project') return !hasName(lists.projects, value);
  if (dim === 'source') return !lists.sources.some((s) => s.id === value);
  if (dim === 'tags') return !lists.tags.includes(value);
  if (dim === 'sprint') return !lists.sprints.includes(value);
  return false;
}

// ── Per-dimension access ──

/** The dimension's selected value ids as strings. */
export function selectedValues(state: FilterState, dim: FilterDim): string[] {
  switch (dim) {
    case 'status': return orderStatus(state.status);
    case 'project': return [...state.projects];
    case 'date': return [state.date];
    case 'source': return [...state.sources];
    case 'priority': return [...state.priorities];
    case 'blocked': return state.blocked === undefined ? [] : [String(state.blocked)];
    case 'tags': return [...state.tagsAny];
    case 'sprint': return [...state.sprints];
    case 'time': return state.time.preset === null ? [] : [state.time.preset];
  }
}

export function isDimDefault(state: FilterState, dim: FilterDim): boolean {
  switch (dim) {
    case 'status': return isDefaultStatus(state.status);
    case 'date': return state.date === 'now';
    case 'blocked': return state.blocked === undefined;
    case 'time': return state.time.preset === null;
    default: return selectedValues(state, dim).length === 0;
  }
}

/** The state with one dimension back at its default. */
export function resetDim(state: FilterState, dim: FilterDim): FilterState {
  const d = DEFAULT_FILTER_STATE;
  switch (dim) {
    case 'status': return { ...state, status: [...d.status] };
    case 'project': return { ...state, projects: [] };
    case 'date': return { ...state, date: d.date };
    case 'source': return { ...state, sources: [] };
    case 'priority': return { ...state, priorities: [] };
    case 'blocked': return { ...state, blocked: undefined };
    case 'tags': return { ...state, tagsAny: [] };
    case 'sprint': return { ...state, sprints: [] };
    case 'time': return { ...state, time: { ...state.time, preset: null } };
  }
}

/** Every dimension at default (Clear). */
export function clearedState(): FilterState {
  return { ...DEFAULT_FILTER_STATE, status: [...DEFAULT_FILTER_STATE.status], time: { ...DEFAULT_FILTER_STATE.time } };
}

/** Replace one dimension's selection with string ids. */
export function withValues(state: FilterState, dim: FilterDim, values: readonly string[]): FilterState {
  switch (dim) {
    case 'status': return { ...state, status: orderStatus(values as TaskPhase[]) };
    case 'project': return { ...state, projects: [...values] };
    case 'date': return { ...state, date: (values[0] ?? 'now') as DateFilterValue };
    case 'source': return { ...state, sources: [...values] };
    case 'priority': return { ...state, priorities: [...values] as TaskPriority[] };
    case 'blocked':
      return { ...state, blocked: values[0] === undefined ? undefined : values[0] === 'true' };
    case 'tags': return { ...state, tagsAny: [...values] };
    case 'sprint': return { ...state, sprints: [...values] };
    case 'time':
      return { ...state, time: { ...state.time, preset: (values[0] ?? null) as TimePresetKey | null } };
  }
}
