/**
 * How far a session on ANOTHER host may reach with task_merge.
 *
 * A merge deletes the victim rows (and, for synced tasks, their remote twins),
 * so it was local-only: refused to every remote session. That left a leader on
 * a dev box that found two imported copies of one ticket unable to fold them,
 * so it completed the duplicate instead (2026-10-02). The rule now: a remote
 * session may merge tasks that are ITS OWN WORK, which means each task is
 *   - its own task, or one of its descendants (the subtask tree), or
 *   - a task in its own folder (same folder id, same project).
 * Everything else stays out of reach from a remote host, and a remote caller
 * Walnut cannot place (no session, or a session with no task) reaches nothing.
 * Humans and sessions on this box are unchanged: the route does not call this
 * for them.
 */

import type { CallerPlacement } from './caller-placement.js';
import { sameProject } from './caller-placement.js';
import type { Task } from '../types.js';

/** The parent chain never runs deeper than the subtask brake allows, plus slack. */
const MAX_WALK = 16;

type ReachTask = Pick<Task, 'id' | 'title' | 'project' | 'group_id' | 'parent_task_id'>;

/**
 * The ids among `tasks` the caller may not merge, with one sentence why, or
 * `undefined` when every task is within reach. `getTask` resolves a parent id
 * (a missing one ends that walk).
 */
export async function mergeOutOfReach(
  caller: CallerPlacement,
  tasks: ReachTask[],
  getTask: (id: string) => Promise<ReachTask | undefined>,
): Promise<{ ids: string[]; message: string } | undefined> {
  if (caller.kind !== 'worker' && caller.kind !== 'ask') {
    return {
      ids: tasks.map((t) => t.id),
      message: 'task_merge from another host needs a session with a task of its own: '
        + 'it may merge its own subtasks and the tasks in its own folder.',
    };
  }
  const own = caller.task;
  const out: string[] = [];
  for (const t of tasks) {
    if (t.id === own.id) continue;
    if (own.group_id && t.group_id === own.group_id && sameProject(t.project, own.project)) continue;
    if (await isDescendantOf(t, own.id, getTask)) continue;
    out.push(t.id);
  }
  if (out.length === 0) return undefined;
  const folder = own.group_id ? ` or in its folder (${own.group_id})` : '';
  return {
    ids: out,
    message: `task_merge from another host reaches only your own work: ${out.join(', ')} `
      + `${out.length === 1 ? 'is' : 'are'} not a subtask of "${own.title}" (${own.id})${folder}. `
      + 'Ask the user to merge from the Walnut host, or complete the duplicate and say why.',
  };
}

async function isDescendantOf(
  task: ReachTask,
  ancestorId: string,
  getTask: (id: string) => Promise<ReachTask | undefined>,
): Promise<boolean> {
  const seen = new Set<string>([task.id]);
  let parentId = task.parent_task_id;
  for (let i = 0; parentId && i < MAX_WALK; i++) {
    if (parentId === ancestorId) return true;
    if (seen.has(parentId)) return false;
    seen.add(parentId);
    const parent = await getTask(parentId).catch(() => undefined);
    parentId = parent?.parent_task_id;
  }
  return false;
}
