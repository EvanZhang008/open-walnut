/** Who manages whom, for the reflection (managedTasks) and for the team guidance a session reads (managerOf). Pure. */
import type { Task } from '../../types.js';
import { isPluginOnlyTask, pickLead } from '../org-tree.js';
import { briefTeam } from '../../user-status.js';
import { sameAreaTasks, sameTaskArea } from '../../router/same-area.js';

/** Done this long ago, a task is no longer looked at. */
export const DONE_LOOKBACK_MS = 2 * 24 * 3600_000;

/**
 * The tasks a node manages, as its Brief counts them (user-status.ts briefTeam: a VP's projects and
 * what was put below it; the CEO's VPs and what is below it; the Inbox is no one's team), less
 * Walnut's own agent tasks and work done more than DONE_LOOKBACK_MS ago. Only tasks of the node's own
 * incoming-item area (router/same-area.ts): a lesson from one area's words never reaches another's.
 */
export function managedTasks(node: Task, all: readonly Task[], nowMs = Date.now()): Task[] {
  if (node.org_role !== 'main' && node.org_role !== 'lead') return [];
  const recent = (t: Task) => t.phase !== 'COMPLETE' || nowMs - Date.parse(t.completed_at ?? t.updated_at ?? '') < DONE_LOOKBACK_MS;
  return sameAreaTasks(node, briefTeam(node, all)).filter((t) => recent(t) && !t.walnut_agent);
}

/**
 * The node whose team guidance a task's session reads, the inverse of managedTasks for the common
 * case: a VP's for its projects' tasks, the CEO's for a VP. None for the CEO itself, a task in the
 * Inbox or a project no VP leads, a plugin's or Walnut's own agent task.
 */
export function managerOf<T extends Task>(task: Task, all: readonly T[]): T | undefined {
  if (task.org_role === 'main' || isPluginOnlyTask(task) || task.walnut_agent) return undefined;
  const manager = task.org_role === 'lead' ? all.find((t) => t.org_role === 'main' && t.phase !== 'COMPLETE')
    : (task.project ?? '').trim() ? pickLead(all, task.project ?? '') : undefined;
  // The guidance holds words of the manager's area: a task of another area reads none of it.
  return manager && sameTaskArea(manager, task) ? manager : undefined;
}
