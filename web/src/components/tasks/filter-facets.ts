/**
 * filter-facets: Linear-style facet counts for the Filter popover (4.1, G28).
 * A value's count = tasks with that value that pass every OTHER dimension.
 *
 * One pass: for each task find the set F of dimensions it fails. F empty adds
 * 1 to the task's value in every counted dimension; F = {d} adds 1 only in d;
 * |F| >= 2 is skipped. O(tasks x dims), independent of the number of values.
 */
import type { Task } from '@open-walnut/core';
import { normalizeTaskPriority } from '@open-walnut/task-query';
import { FILTER_DIMS, type FacetCounts, type FilterDim, type FilterState } from './filter-bar-types';
import { buildFilterEvalContext, dimPasses, passesChips, type FilterEvalContext } from './filter-predicate';

/**
 * Dimensions that carry facet counts by default. Date and Time window are
 * windows, not values; Blocked needs the blocked set, which the context only
 * builds while a Blocked condition is on.
 */
export const FACET_DIMS: readonly FilterDim[] = ['status', 'project', 'source', 'priority', 'tags', 'sprint'];

/** The value ids a task holds in one dimension (several for tags). */
export function taskFacetValues(task: Task, dim: FilterDim, ctx: FilterEvalContext): string[] {
  switch (dim) {
    case 'status': return [task.phase];
    case 'project': return [task.project || ''];
    case 'source': return task.source ? [task.source] : [];
    case 'priority': {
      const p = normalizeTaskPriority(task.priority);
      return p ? [p] : [];
    }
    case 'tags': return task.tags ? [...new Set(task.tags)] : [];
    case 'sprint': return task.sprint ? [task.sprint] : [];
    case 'blocked': {
      const ids = ctx.queryCtx.blockedIds;
      return ids ? [String(ids.has(task.id))] : [];
    }
    default: return [];
  }
}

function bump(out: FacetCounts, dim: FilterDim, values: readonly string[]): void {
  const bucket = (out[dim] ??= {});
  for (const v of values) bucket[v] = (bucket[v] ?? 0) + 1;
}

/** One-pass facet counts for `dims` over `tasks` under the context's state. */
export function computeFacetCounts(
  tasks: readonly Task[],
  ctx: FilterEvalContext,
  dims: readonly FilterDim[] = FACET_DIMS,
): FacetCounts {
  const out: FacetCounts = {};
  for (const dim of dims) out[dim] = {};
  const counted = new Set(dims);
  for (const task of tasks) {
    let first: FilterDim | null = null;
    let fails = 0;
    for (const dim of FILTER_DIMS) {
      if (dimPasses(task, dim, ctx)) continue;
      fails += 1;
      if (fails >= 2) break;
      first = dim;
    }
    if (fails >= 2) continue;
    if (fails === 0) {
      for (const dim of dims) bump(out, dim, taskFacetValues(task, dim, ctx));
    } else if (first && counted.has(first)) {
      bump(out, first, taskFacetValues(task, first, ctx));
    }
  }
  return out;
}

/**
 * Reference implementation for the unit test: per value, count the tasks that
 * hold it and pass every other dimension. O(values x tasks x dims).
 */
export function bruteForceFacetCounts(
  tasks: readonly Task[],
  state: FilterState,
  dims: readonly FilterDim[] = FACET_DIMS,
  now: Date = new Date(),
): FacetCounts {
  const base = buildFilterEvalContext(tasks, state, now);
  const out: FacetCounts = {};
  for (const dim of dims) {
    out[dim] = {};
    const values = new Set<string>();
    for (const t of tasks) for (const v of taskFacetValues(t, dim, base)) values.add(v);
    for (const v of values) {
      let n = 0;
      for (const t of tasks) {
        if (!taskFacetValues(t, dim, base).includes(v)) continue;
        if (passesChips(t, base, { except: dim })) n += 1;
      }
      if (n > 0) out[dim]![v] = n;
    }
  }
  return out;
}
