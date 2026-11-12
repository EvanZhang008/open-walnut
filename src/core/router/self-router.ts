/**
 * A task that routes or watches by itself, listed among the Org page's routers (2026-11-11, the
 * user asked for a pipeline watch lead and a Slack channel monitor with its own agent loop to
 * show as routers). Such a task already runs its own loop (its triggers, a
 * Slack loop, its tracker) on its own host, so it is no area router (org_role 'router', which
 * reads assigned mail under a router profile and starts paused): converting it would replace its
 * session. The mark only lists it beside the routers with the VPs it works with. Walnut starts,
 * stops, pauses and changes nothing of its session, triggers or work, and it stays work of its
 * project (never an org node).
 */
import { withOrgLock, OrgError } from '../org/org-store.js';
import { openLeadLinks, routerName } from './nodes.js';
import type { Task } from '../types.js';

export interface SelfRouterInput {
  links: string[];
  /** Its name on the Org page; absent keeps the task's title. */
  name?: string;
  /** Who listed it: 'human' or 'task:<id>'. */
  by: string;
}

async function announce(task: Task): Promise<void> {
  const { bus, EventNames } = await import('../event-bus.js');
  bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'self-router' });
}

function checkTask(task: Task | null, taskId: string): Task {
  if (!task || task.id !== taskId) throw new OrgError('router_task_missing', 404, 'No task has this exact id.');
  if (task.org_role) {
    throw new OrgError(task.org_role === 'router' ? 'router_exists' : 'not_router', 409,
      task.org_role === 'router' ? 'This task is already a router.' : 'The CEO or a VP is never listed as a router.');
  }
  if (task.phase === 'COMPLETE') throw new OrgError('router_complete', 409, 'This task is complete. Reopen it before listing it as a router.');
  if (task.plugin_only) throw new OrgError('not_router', 409, 'A plugin\'s own task is not listed on the Org page.');
  return task;
}

/** List a task among the routers (or change its links or name). Writes only `self_router`. */
export async function setSelfRouter(taskId: string, input: SelfRouterInput): Promise<Task> {
  const name = input.name === undefined ? undefined : routerName(input.name);
  return withOrgLock(async () => {
    const { getTask, updateTaskRaw } = await import('../task-manager.js');
    const task = checkTask(await getTask(taskId).catch(() => null), taskId);
    const links = await openLeadLinks(input.links);
    const next = { links, at: new Date().toISOString(), by: input.by, ...(name && name !== task.title ? { name } : {}) };
    const prior = task.self_router;
    if (prior && JSON.stringify([...prior.links].sort()) === JSON.stringify([...links].sort()) && (prior.name ?? undefined) === next.name) return task;
    await updateTaskRaw(taskId, { self_router: next }, {
      source: 'self-router', emitEvent: false,
      shouldUpdate: (current) => !current.org_role && current.phase !== 'COMPLETE',
    });
    const updated = await getTask(taskId);
    if (!updated.self_router) throw new OrgError('router_task_changed', 409, 'The task changed meanwhile. Read it and retry.');
    await announce(updated);
    return updated;
  });
}

/** Take a task off the routers list. Its work is untouched. */
export async function clearSelfRouter(taskId: string): Promise<Task> {
  return withOrgLock(async () => {
    const { getTask, updateTaskRaw } = await import('../task-manager.js');
    const task = await getTask(taskId).catch(() => null);
    if (!task || task.id !== taskId) throw new OrgError('router_task_missing', 404, 'No task has this exact id.');
    if (!task.self_router) return task;
    await updateTaskRaw(taskId, { self_router: null }, { source: 'self-router', emitEvent: false });
    const updated = await getTask(taskId);
    await announce(updated);
    return updated;
  });
}

/** Whether a task is listed among the routers by this mark (open, no org role). */
export function isSelfRouter(task: Pick<Task, 'self_router' | 'org_role' | 'phase'>): boolean {
  return !!task.self_router && !task.org_role && task.phase !== 'COMPLETE';
}
