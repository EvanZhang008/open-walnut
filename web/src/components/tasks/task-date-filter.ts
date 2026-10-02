/**
 * task-date-filter: the home panel's client-side Date filter, moved verbatim
 * out of TodoPanel.tsx so the shared filter predicate can reuse it. Child tasks
 * inherit their parent's due_date/start_date for filtering when they have none.
 */
import type { Task } from '@open-walnut/core';
import { resolveParentRef } from './task-tree-index';
import { parseDateLocal } from '../common/DatePicker';
import type { DateFilterValue } from './filter-bar-types';

type DateFilter = DateFilterValue;

/**
 * Resolve an effective date field for a task: if the task has no value,
 * walk up the parent chain and inherit the first ancestor's value.
 */
export function getEffectiveDateField(task: Task, allTasks: Task[], field: 'due_date' | 'start_date'): string | undefined {
  if (task[field]) return task[field];
  if (!task.parent_task_id) return undefined;
  // Walk up parent chain (max 10 depth to avoid infinite loops)
  let current: Task | undefined = task;
  for (let i = 0; i < 10 && current?.parent_task_id; i++) {
    const parent: Task | undefined = resolveParentRef(allTasks, current.parent_task_id);
    if (!parent) break;
    if (parent[field]) return parent[field];
    current = parent;
  }
  return undefined;
}

export function getEffectiveDueDate(task: Task, allTasks: Task[]): string | undefined {
  return getEffectiveDateField(task, allTasks, 'due_date');
}

export function getEffectiveStartDate(task: Task, allTasks: Task[]): string | undefined {
  return getEffectiveDateField(task, allTasks, 'start_date');
}

/** True when the task's (inherited) start_date is still in the future:
 *  i.e. the task is deferred and not yet actionable. Day-level start dates
 *  activate at local midnight of that day. */
export function isDeferredByStart(task: Task, allTasks: Task[], now = Date.now()): boolean {
  const effectiveStart = getEffectiveStartDate(task, allTasks);
  if (!effectiveStart) return false;
  const startMs = parseDateLocal(effectiveStart).getTime();
  return Number.isFinite(startMs) && startMs > now;
}

/** Match task against dateFilter. Uses time-level precision for "now".
 *  Child tasks inherit parent's due_date/start_date for filtering if they
 *  have none.
 *
 *  "Now" is START-time driven: it answers "what should I look at now", so a
 *  task is shown unless its start_date says the work begins later. Due dates
 *  are deadlines: they mark Overdue but never hide a task from Now. */
export function matchesDateFilter(task: Task, filter: DateFilter, allTasks: Task[]): boolean {
  if (!filter) return true; // "All"
  const now = Date.now();
  switch (filter) {
    case 'now':
      // Everything actionable now: no start date, or start time has arrived.
      return !isDeferredByStart(task, allTasks, now);
    case 'overdue': {
      const effectiveDue = getEffectiveDueDate(task, allTasks);
      const dueMs = effectiveDue ? parseDateLocal(effectiveDue).getTime() : null;
      if (!dueMs) return false;
      // Time-level dates: overdue if past now; Day-level: overdue if before start of today
      if (effectiveDue!.includes('T')) return dueMs < now;
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      return dueMs < todayStart.getTime();
    }
    case 'this-week': {
      // Same start-driven semantics with a 7-day horizon: hide only tasks
      // whose start is beyond this week.
      const effectiveStart = getEffectiveStartDate(task, allTasks);
      const startMs = effectiveStart ? parseDateLocal(effectiveStart).getTime() : null;
      return !startMs || startMs <= now + 7 * 86_400_000;
    }
    case 'no-date':
      // no-date means the task itself is unscheduled (not inherited)
      return !task.due_date && !task.start_date;
    default:
      return true;
  }
}
