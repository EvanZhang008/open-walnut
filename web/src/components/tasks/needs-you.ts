/**
 * "Needs you" roll-up for a collapsed parent row (spec 4.7 Home, C68).
 *
 * `taskNeedsAction` answers for ONE task. A collapsed leader hides its
 * workers, so a worker handed back to the human (NEED_ACTION) or blocked on a
 * prompt was invisible on the phone's home list. This walks the subtree and
 * lists the open descendants that wait on the user, in tree order, so the row
 * can say `N need you` and the tap can scroll to the first one.
 *
 * Completed descendants never count, but the walk goes through them: an open
 * grandchild under a finished child still waits on the user.
 */
import type { Task } from '@open-walnut/core';
import { resolveParentRef } from './task-tree-index';
import { taskNeedsAction } from '@/utils/session-status';

export interface NeedsYouOptions {
  /** A live "blocked on a prompt" reading (the session-status store). */
  isWaiting?: (task: Task) => boolean;
}

export function isOpenTask(task: Task): boolean {
  return task.status !== 'done' && task.phase !== 'COMPLETE';
}

export function taskNeedsYou(task: Task, opts?: NeedsYouOptions): boolean {
  if (!isOpenTask(task)) return false;
  return taskNeedsAction(task) || !!opts?.isWaiting?.(task);
}

type TaskMap = ReadonlyMap<string, Task>;

// One children index per task map (the map is rebuilt when the list changes).
const CHILDREN = new WeakMap<TaskMap, Map<string, Task[]>>();

function childrenIndex(tasksById: TaskMap): Map<string, Task[]> {
  const cached = CHILDREN.get(tasksById);
  if (cached) return cached;
  const list = [...tasksById.values()];
  const index = new Map<string, Task[]>();
  for (const t of list) {
    if (!t.parent_task_id) continue;
    // Parent refs may be id prefixes (task-tree-index's rule).
    const parent = tasksById.get(t.parent_task_id) ?? resolveParentRef(list, t.parent_task_id);
    if (!parent || parent.id === t.id) continue;
    const arr = index.get(parent.id);
    if (arr) arr.push(t); else index.set(parent.id, [t]);
  }
  CHILDREN.set(tasksById, index);
  return index;
}

/** Open descendants of `task` that need the user, in pre-order. */
export function descendantsNeedingYou(task: Task, tasksById: TaskMap, opts?: NeedsYouOptions): Task[] {
  const index = childrenIndex(tasksById);
  const out: Task[] = [];
  const seen = new Set<string>([task.id]);
  const walk = (id: string) => {
    for (const child of index.get(id) ?? []) {
      if (seen.has(child.id)) continue; // cycle guard
      seen.add(child.id);
      if (taskNeedsYou(child, opts)) out.push(child);
      walk(child.id);
    }
  };
  walk(task.id);
  return out;
}

/** The parent pill's words: what it counts is in the text (spec: one count, one meaning). */
export function needYouLabel(n: number): string {
  return `${n} need you`;
}

/** A map over a task list, for callers that hold an array. */
export function tasksByIdOf(tasks: readonly Task[]): Map<string, Task> {
  return new Map(tasks.map((t) => [t.id, t]));
}
