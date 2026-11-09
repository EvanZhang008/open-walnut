import { WALNUT_HOME } from '../../constants.js';
import { readRouterAreas, taskArea, type RouterAreasFile } from './areas.js';
import type { SessionRecord, Task } from '../types.js';
// Static, never `await import()`: a test's module mock of these stores did not reach a dynamic
// import here, so the check read the real store and refused every send (2026-11-07).
import { getTask } from '../task-manager.js';
import { getSessionsForTask } from '../session-tracker.js';

/** The synchronous check on the persisted mark (same-area.ts, pure so the web build can share it). */
export { sameTaskArea, sameAreaTasks } from './same-area.js';

/** A router task placed nowhere: a scope no other task ever holds. */
const NO_AREA_ROUTER = '\u0000router-without-area';

type ScopedTask = Pick<Task, 'id'> & { router_area_id?: string | null; org_role?: string | null };

/** Every read the check makes; tests pass their own, production uses the real stores. */
export interface ContextSharingDeps {
  readAreas(home: string): Promise<RouterAreasFile>;
  // Undefined or a throw both mean the task cannot be read: the check fails closed.
  getTask(id: string): Promise<ScopedTask | undefined>;
  sessionsForTask(taskId: string): Promise<Array<Pick<SessionRecord, 'profile'>>>;
}

const defaultDeps: ContextSharingDeps = {
  readAreas: (home) => readRouterAreas(home),
  getTask: (id) => getTask(id),
  sessionsForTask: (taskId) => getSessionsForTask(taskId),
};

/**
 * Every area a task is in, by the same authority as source-reader.ts: its persisted mark, the
 * registry's task list, a router assignment, and every session profile of the task. Any read
 * failure (a missing task included) throws, so the caller withholds the context.
 */
async function taskScopes(id: string, file: RouterAreasFile, deps: ContextSharingDeps): Promise<Set<string>> {
  const [task, sessions] = await Promise.all([deps.getTask(id), deps.sessionsForTask(id)]);
  if (!task || task.id !== id) throw new Error(`No exact task ${id}`);
  const out = new Set<string>();
  const add = (s: unknown) => { if (typeof s === 'string' && s.trim()) out.add(s.trim()); };
  add(task.router_area_id);
  add(taskArea(file, id)?.id);
  for (const r of file.routers) if (r.taskId === id) add(r.areaId);
  if (out.size === 0 && task.org_role === 'router') out.add(NO_AREA_ROUTER);
  for (const record of sessions ?? []) add(record?.profile?.areaId);
  return out;
}

/**
 * May one task's words reach another task's model (or, with no target, a taskless session)?
 * Both outside every area, or both in exactly one and the same area. Two areas on one task, an
 * unassigned router, or anything that could not be read withholds it.
 */
export async function mayShareTaskContext(
  fromTaskId: string,
  toTaskId: string | undefined,
  deps: ContextSharingDeps = defaultDeps,
): Promise<boolean> {
  try {
    const file = await deps.readAreas(WALNUT_HOME);
    const [from, to] = await Promise.all([
      taskScopes(fromTaskId, file, deps),
      toTaskId ? taskScopes(toTaskId, file, deps) : Promise.resolve(new Set<string>()),
    ]);
    if (from.size === 0) return to.size === 0;
    if (from.size !== 1 || to.size !== 1) return false;
    const [f] = from;
    const [t] = to;
    return f === t && f !== NO_AREA_ROUTER;
  } catch {
    return false;
  }
}
