import type { Task } from '@open-walnut/core';
import { subtasksOf } from './subtask-index';

/**
 * Which tasks a leader may adopt as a worker (AdoptWorkerFlyout.tsx).
 *
 * Never the leader itself, never one of its ancestors (that would make a
 * cycle), never one of its descendants (already in its team), never finished
 * work. `parent_task_id` may be a short prefix (legacy data), so both walks use
 * the store's prefix rule. Recently updated work first: the task the user just
 * filed or touched is the one they want to hand over.
 */
export function isDoneTask(t: Pick<Task, 'phase' | 'status'>): boolean {
  return t.phase === 'COMPLETE' || t.status === 'done';
}

/** The task a `parent_task_id` names (exact id first, then the prefix rule). */
export function resolveParent(tasks: readonly Task[], byId: ReadonlyMap<string, Task>, ref: string | undefined): Task | null {
  if (!ref) return null;
  return byId.get(ref) ?? tasks.find((t) => t.id.startsWith(ref)) ?? null;
}

/** Ids a leader may not adopt: itself, its ancestors and its descendants. */
export function adoptExclusions(tasks: readonly Task[], leaderId: string): Set<string> {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const out = new Set<string>([leaderId]);
  // Up: the chain of leaders above (a seen set ends a corrupt cycle).
  let up = resolveParent(tasks, byId, byId.get(leaderId)?.parent_task_id);
  while (up && !out.has(up.id)) {
    out.add(up.id);
    up = resolveParent(tasks, byId, up.parent_task_id);
  }
  // Down: the whole team below.
  const queue = [leaderId];
  const walked = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (walked.has(id)) continue;
    walked.add(id);
    for (const child of subtasksOf(tasks, id)) {
      out.add(child.id);
      queue.push(child.id);
    }
  }
  return out;
}

function stamp(t: Task): number {
  const ms = Date.parse(t.updated_at || t.created_at || '');
  return Number.isNaN(ms) ? 0 : ms;
}

/** Candidates for `leaderId`, filtered by `query` (title, project, id prefix), newest first. */
export function adoptCandidates(tasks: readonly Task[], leaderId: string, query = ''): Task[] {
  const excluded = adoptExclusions(tasks, leaderId);
  const q = query.trim().toLowerCase();
  return tasks
    .filter((t) => !excluded.has(t.id) && !isDoneTask(t))
    .filter((t) => !q
      || t.title.toLowerCase().includes(q)
      || (t.project ?? '').toLowerCase().includes(q)
      || t.id.toLowerCase().startsWith(q))
    .sort((a, b) => stamp(b) - stamp(a));
}
