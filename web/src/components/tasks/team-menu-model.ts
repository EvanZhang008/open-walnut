import type { Task } from '@open-walnut/core';
import { isDoneTask } from './adopt-candidates';
import { subtasksOf } from './subtask-index';

/**
 * The task kebab's collapsed Team row (TeamMenuItems.tsx) and its Release
 * picker (ReleaseWorkerFlyout.tsx), as pure functions of the task list.
 */

/**
 * What the collapsed row says after "Team": the pills' own words, so the menu
 * reads like the row it was opened on. `Leader · n` counts open workers (a
 * leader whose workers are all finished says how many are done), `Worker of “X”`
 * names its leader (`Worker` alone when the leader is not in this browser's
 * list, e.g. a finished one not loaded); '' for a task in no team.
 */
export function teamRowSummary(tasks: readonly Task[], task: Pick<Task, 'id' | 'parent_task_id'>, leaderTitle: string | null): string {
  const workers = subtasksOf(tasks, task.id);
  const open = workers.filter((t) => !isDoneTask(t)).length;
  const parts: string[] = [];
  if (open > 0) parts.push(`Leader · ${open}`);
  else if (workers.length > 0) parts.push(`Leader · ${workers.length} done`);
  if (task.parent_task_id) parts.push(leaderTitle !== null ? `Worker of “${leaderTitle}”` : 'Worker');
  return parts.join(', ');
}

/**
 * The workers a leader may release: every direct subtask, open ones first
 * (finished ones still carry the link, so they can be let go too), filtered by
 * `query` on title, project or id prefix.
 */
export function releaseCandidates(tasks: readonly Task[], leaderId: string, query = ''): Task[] {
  const q = query.trim().toLowerCase();
  return subtasksOf(tasks, leaderId).filter((t) => !q
    || t.title.toLowerCase().includes(q)
    || (t.project ?? '').toLowerCase().includes(q)
    || t.id.toLowerCase().startsWith(q));
}

/** From this many workers on, the Release picker gets a filter box. */
export const RELEASE_FILTER_FROM = 8;
