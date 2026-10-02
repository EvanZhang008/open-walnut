/**
 * filter-predicate: the one hit test behind the home panel's chips. The list,
 * the pin area, tier views, Recent, search (bypassDefaults), footer counts
 * (except), tab badges, the filter row count and focus-override reasons all
 * call it, so every surface reports the same number.
 *
 * Field matching is NOT reimplemented: each query dimension becomes its own
 * single-condition TaskQuery, normalized once and evaluated with the shared
 * matchesTaskQuery. Only Date (a client-side legacy filter) runs locally.
 */
import type { Task, TaskPhase } from '@open-walnut/core';
import {
  matchesTaskQuery,
  normalizeTaskPriority,
  type NormalizedTaskQuery,
  type TaskQueryContext,
} from '@open-walnut/task-query';
import {
  DEFAULT_TASK_QUERY_FILTER_STATE,
  toTaskQuery,
  type TaskQueryFilterState,
} from './view-filter-model';
import { buildTaskQueryContext, safeNormalizeTaskQuery } from './task-query-state';
import { matchesDateFilter } from './task-date-filter';
import { FILTER_DIMS, type FilterDim, type FilterLists, type FilterState } from './filter-bar-types';
import {
  dateLabel,
  dimLabel,
  isDimDefault,
  listChipLabel,
  orderStatus,
  projectLabel,
  selectedValues,
  statusChipLabel,
  timeChipText,
  valueLabel,
  withValues,
} from './filter-bar-model';

/** Dimensions evaluated through the shared query model. */
export const QUERY_DIMS: readonly FilterDim[] = [
  'status', 'project', 'source', 'priority', 'blocked', 'tags', 'sprint', 'time',
];

export interface FilterEvalContext {
  state: FilterState;
  allTasks: Task[];
  /** One normalized single-condition query per active query dimension. */
  queries: Partial<Record<FilterDim, NormalizedTaskQuery>>;
  queryCtx: TaskQueryContext;
  /** Dimensions currently at their default value. */
  defaults: ReadonlySet<FilterDim>;
}

export interface FailingOptions {
  /** Skip every dimension still at its default (search mode, 5.7). */
  bypassDefaults?: boolean;
  /** Dimensions to leave out (footer counts, facets). */
  except?: FilterDim | readonly FilterDim[];
}

/** The single-dimension slice of the query state for one FilterState dim. */
function sliceFor(state: FilterState, dim: FilterDim): TaskQueryFilterState {
  const q: TaskQueryFilterState = { ...DEFAULT_TASK_QUERY_FILTER_STATE };
  switch (dim) {
    case 'status': q.phases = orderStatus(state.status); break;
    case 'project': q.projects = [...state.projects]; break;
    case 'source': q.sources = [...state.sources]; break;
    case 'priority': q.priorities = [...state.priorities]; break;
    case 'blocked': q.blocked = state.blocked; break;
    case 'tags': q.tagsAny = [...state.tagsAny]; break;
    case 'sprint': q.sprints = [...state.sprints]; break;
    case 'time':
      q.timeBasis = state.time.basis;
      q.timePreset = state.time.preset;
      q.timeCustomValue = state.time.customValue;
      q.timeCustomUnit = state.time.customUnit;
      break;
    default: break;
  }
  return q;
}

/** Build once per state change; reuse for every task. */
export function buildFilterEvalContext(
  allTasks: readonly Task[],
  state: FilterState,
  now: Date = new Date(),
): FilterEvalContext {
  const queries: Partial<Record<FilterDim, NormalizedTaskQuery>> = {};
  const defaults = new Set<FilterDim>();
  for (const dim of FILTER_DIMS) if (isDimDefault(state, dim)) defaults.add(dim);
  for (const dim of QUERY_DIMS) {
    // Status always applies (its default is a real condition: open only).
    if (dim !== 'status' && defaults.has(dim)) continue;
    if (dim === 'status' && state.status.length === 0) continue;
    const normalized = safeNormalizeTaskQuery(toTaskQuery(sliceFor(state, dim)), now);
    if (normalized) queries[dim] = normalized;
  }
  return {
    state,
    allTasks: allTasks as Task[],
    queries,
    queryCtx: buildTaskQueryContext(allTasks, state.blocked !== undefined),
    defaults,
  };
}

/** Does `task` pass one dimension's condition? */
export function dimPasses(task: Task, dim: FilterDim, ctx: FilterEvalContext): boolean {
  if (dim === 'date') {
    const date = ctx.state.date;
    // The default `now` only hides work that has not started, which means nothing
    // for a finished task, so completed tasks skip it (the old list's rule). A Date
    // the user picked (Overdue, Starting within 7 days, No dates) is a real
    // condition and applies to every task, search included (5.7).
    if (!date || (date === 'now' && task.status === 'done')) return true;
    return matchesDateFilter(task, date, ctx.allTasks);
  }
  const query = ctx.queries[dim];
  if (!query) return true;
  return matchesTaskQuery(task, query, ctx.queryCtx);
}

function exceptList(except: FailingOptions['except']): readonly FilterDim[] {
  if (!except) return [];
  return typeof except === 'string' ? [except] : except;
}

function skipped(dim: FilterDim, ctx: FilterEvalContext, opts: FailingOptions, except: readonly FilterDim[]): boolean {
  if (except.includes(dim)) return true;
  return Boolean(opts.bypassDefaults) && ctx.defaults.has(dim);
}

/** Every dimension `task` fails, in registry order. */
export function failingDims(task: Task, ctx: FilterEvalContext, opts: FailingOptions = {}): FilterDim[] {
  const except = exceptList(opts.except);
  const out: FilterDim[] = [];
  for (const dim of FILTER_DIMS) {
    if (skipped(dim, ctx, opts, except)) continue;
    if (!dimPasses(task, dim, ctx)) out.push(dim);
  }
  return out;
}

/** True when `task` passes every applied dimension (early exit). */
export function passesChips(task: Task, ctx: FilterEvalContext, opts: FailingOptions = {}): boolean {
  const except = exceptList(opts.except);
  for (const dim of FILTER_DIMS) {
    if (skipped(dim, ctx, opts, except)) continue;
    if (!dimPasses(task, dim, ctx)) return false;
  }
  return true;
}

/** `Open`, `Garden`, `Available now`: the chip value text of one dimension. */
export function dimValueText(state: FilterState, dim: FilterDim, lists?: FilterLists): string {
  if (dim === 'status') return statusChipLabel(state.status);
  if (dim === 'date') return dateLabel(state.date);
  if (dim === 'time') return timeChipText(state.time) ?? 'Custom';
  const values = selectedValues(state, dim);
  const labels = values.map((v) => {
    if (lists) return valueLabel(dim, v, lists);
    return dim === 'project' ? projectLabel(v) : v;
  });
  if (dim === 'blocked') return labels[0] === 'true' ? 'Blocked' : labels[0] === 'false' ? 'Not blocked' : labels.join(', ');
  const plural: Partial<Record<FilterDim, string>> = {
    project: 'projects', source: 'sources', priority: 'priorities', tags: 'tags', sprint: 'sprints',
  };
  return listChipLabel(labels, plural[dim] ?? 'values');
}

export interface HiddenReason {
  dim: FilterDim;
  /** `Hidden by Project: Garden` */
  text: string;
  /** `Show tasks hidden by Project: Garden` */
  ariaLabel: string;
}

/** Why a focus-override row is outside the filters (5.12), one entry per dim. */
export function hiddenByReasons(task: Task, ctx: FilterEvalContext, lists?: FilterLists): HiddenReason[] {
  return failingDims(task, ctx).map((dim) => {
    const what = `${dimLabel(dim)}: ${dimValueText(ctx.state, dim, lists)}`;
    return { dim, text: `Hidden by ${what}`, ariaLabel: `Show tasks hidden by ${what}` };
  });
}

/** Join reasons for a title attribute: `Hidden by Status: Open, Hidden by Project: Garden`. */
export function hiddenByText(reasons: readonly HiddenReason[]): string {
  return reasons.map((r) => r.text).join(', ');
}

/**
 * The Show action of a reason: widen `dim` just enough to let `task` in.
 * Status adds its phase, Project and the other lists append its value,
 * Date goes to Any date, Blocked and Time window are removed.
 */
export function showValueFor(state: FilterState, task: Task, dim: FilterDim): FilterState {
  const append = (value: string | undefined) => {
    if (value === undefined) return withValues(state, dim, []);
    const current = selectedValues(state, dim);
    return current.includes(value) ? state : withValues(state, dim, [...current, value]);
  };
  switch (dim) {
    case 'status': return append(task.phase as TaskPhase);
    case 'project': return append(task.project || '');
    case 'date': return { ...state, date: '' };
    case 'source': return append(task.source || undefined);
    case 'priority': return append(normalizeTaskPriority(task.priority));
    case 'tags': return append(task.tags?.[0]);
    case 'sprint': return append(task.sprint || undefined);
    case 'blocked': return { ...state, blocked: undefined };
    case 'time': return { ...state, time: { ...state.time, preset: null } };
  }
}
