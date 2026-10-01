import type { Task } from '@open-walnut/core';
import { ParentRefMatcher } from './task-tree-index';

/**
 * Who leads whom, read off the task list once per list.
 *
 * A subtask points at its parent with `parent_task_id`, which may be a short
 * prefix of the parent's id (legacy data): the store's rule everywhere is
 * `parent.id.startsWith(child.parent_task_id)`. Resolving that per row would be
 * O(rows × tasks) on every render of the board, so the index is built once per
 * task ARRAY (the context hands out a new array on every change) and cached on
 * it. Subtasks in other projects count too: the board only nests inside one
 * project, but the Leader pill lists everything the task leads.
 */
const INDEX = new WeakMap<readonly Task[], Map<string, Task[]>>();

function isDone(t: Task): boolean {
  return t.phase === 'COMPLETE' || t.status === 'done';
}

function buildIndex(tasks: readonly Task[]): Map<string, Task[]> {
  const byPrefix = new Map<string, Task[]>();
  for (const t of tasks) {
    if (!t.parent_task_id) continue;
    const list = byPrefix.get(t.parent_task_id);
    if (list) list.push(t); else byPrefix.set(t.parent_task_id, [t]);
  }
  const index = new Map<string, Task[]>();
  if (byPrefix.size === 0) return index;
  const matcher = new ParentRefMatcher(byPrefix.keys());
  for (const parent of tasks) {
    let children: Task[] | undefined;
    for (const prefix of matcher.refsOf(parent.id)) {
      const list = byPrefix.get(prefix)!;
      children = children ? children.concat(list) : list.slice();
    }
    if (!children) continue;
    // Open work first, finished work last; otherwise the list order stands.
    children.sort((a, b) => Number(isDone(a)) - Number(isDone(b)));
    index.set(parent.id, children);
  }
  return index;
}

/** The subtasks of `parentId`, in any project, open ones first. */
export function subtasksOf(tasks: readonly Task[], parentId: string): Task[] {
  let index = INDEX.get(tasks);
  if (!index) {
    index = buildIndex(tasks);
    INDEX.set(tasks, index);
  }
  return index.get(parentId) ?? [];
}

/**
 * The subtasks of `parentId` still open (not COMPLETE), in any project. The
 * Leader pill counts and lists these only: a leader that ran eight subtasks and
 * has two left reads `Leader · 2`, not a history of everything it ever filed
 * (2026-10-01 user report). Finished ones stay reachable through the board.
 */
export function openSubtasksOf(tasks: readonly Task[], parentId: string): Task[] {
  return subtasksOf(tasks, parentId).filter((t) => !isDone(t));
}

/** How many of `parentId`'s subtasks are finished (the pill's hover says so). */
export function doneSubtaskCount(tasks: readonly Task[], parentId: string): number {
  return subtasksOf(tasks, parentId).filter(isDone).length;
}

/** Hover text of the Leader pill: the open subtasks, and how many are done. */
export function leaderPillTitle(open: readonly Task[], done = 0): string {
  const n = open.length;
  const noun = n === 1 ? 'open subtask' : 'open subtasks';
  const doneNote = done > 0 ? ` (${done} done)` : '';
  return `Leads ${n} ${noun}${doneNote}. Click to list them.`;
}

/**
 * Where a subtask lives, when that is not beside its leader: the project name,
 * 'Inbox' for the project-less inbox, '' for the leader's own project.
 */
export function subtaskPlaceLabel(sub: Pick<Task, 'project'>, leaderProject: string | undefined): string {
  const here = (leaderProject ?? '').trim().toLowerCase();
  const there = (sub.project ?? '').trim();
  if (there.toLowerCase() === here) return '';
  return there === '' ? 'Inbox' : there;
}
