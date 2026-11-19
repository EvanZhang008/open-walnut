/**
 * The sessions a node manages: a VP's are the tasks of the projects it leads (its own and the ones
 * put under it); the CEO's are the VPs themselves and the tasks of projects no VP leads. Org nodes,
 * plugin tasks and Walnut's own agent tasks are no one's team here. Pure.
 */
import type { Task } from '../../types.js';
import { isHiddenOrgNode, isPluginOnlyTask, pickLead } from '../org-tree.js';

/** Done this long ago, a task is no longer looked at. */
export const DONE_LOOKBACK_MS = 2 * 24 * 3600_000;

export function managedTasks(node: Task, all: readonly Task[], nowMs = Date.now()): Task[] {
  const recent = (t: Task) => t.phase !== 'COMPLETE' || nowMs - Date.parse(t.completed_at ?? t.updated_at ?? '') < DONE_LOOKBACK_MS;
  if (node.org_role === 'main') {
    return all.filter((t) => t.id !== node.id && recent(t) && !isPluginOnlyTask(t) && !t.walnut_agent
      && (t.org_role === 'lead' || (!isHiddenOrgNode(t) && !t.org_role && !pickLead(all, t.project ?? ''))));
  }
  if (node.org_role !== 'lead') return [];
  return all.filter((t) => t.id !== node.id && recent(t) && !t.org_role && !isPluginOnlyTask(t) && !t.walnut_agent
    && pickLead(all, t.project ?? '')?.id === node.id);
}
