/**
 * Where "complete and go to the next" lands: the task after the completed one in the
 * Needs you section's own order (latest activity first, status-sections.ts), read as it
 * was when the person completed it, so the queue does not reshuffle under them. Past the
 * end it wraps to the top; a task that started needing the person since then comes last.
 */
import type { Task } from '@open-walnut/core';
import { isOpenTask } from './needs-you';
import { sortSectionTasks, stateSectionOf } from './status-sections';

/** The open tasks under Needs you, in the section's order. */
export function needsYouQueue(tasks: readonly Task[]): Task[] {
  return sortSectionTasks('needs', tasks.filter((t) => isOpenTask(t) && stateSectionOf(t) === 'needs'));
}

/**
 * The next task to look at after `doneId`.
 * `before`: the queue's ids when the task was completed (it may hold `doneId`).
 * `now`: the tasks as they are now.
 * `skip`: ids not to land on (the column that is closing, a task being deleted).
 */
export function nextNeedsYou(before: readonly string[], doneId: string, now: readonly Task[], skip: ReadonlySet<string> = new Set()): Task | null {
  const queue = needsYouQueue(now).filter((t) => t.id !== doneId && !skip.has(t.id));
  if (queue.length === 0) return null;
  const byId = new Map(queue.map((t) => [t.id, t] as const));
  const at = before.indexOf(doneId);
  if (at >= 0) {
    const order = [...before.slice(at + 1), ...before.slice(0, at)];
    for (const id of order) {
      const t = byId.get(id);
      if (t) return t;
    }
  }
  const known = new Set(before);
  return queue.find((t) => !known.has(t.id)) ?? queue[0];
}
