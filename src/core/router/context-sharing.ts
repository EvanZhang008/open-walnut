import { WALNUT_HOME } from '../../constants.js';
import { readRouterAreas, type RouterAreasFile } from './areas.js';
import type { SessionRecord, Task } from '../types.js';
// Static, never `await import()`: a test's module mock of these stores did not reach a dynamic
// import here, so the check read the real store and refused every send (2026-11-07).
import { getTask } from '../task-manager.js';
import { getSessionsForTask } from '../session-tracker.js';

/** The synchronous check on the persisted mark (same-area.ts, pure so the web build can share it). */
export { sameTaskArea, sameAreaTasks } from './same-area.js';

/** A router task placed nowhere: a scope no other task ever holds. */
const NO_AREA_ROUTER = '\u0000router-without-area';

type ScopedTask = Pick<Task, 'id'> & { org_role?: string | null };

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
 * The router area a task is scoped to: a router's own assignment, a router task with none, or a
 * router session's profile. Since 2026-11-14 only a router is scoped; the work it hands items to
 * is ordinary work, whatever an older build marked on it or on one of its sessions. Any read
 * failure (a missing task included) throws, so the caller withholds the context.
 */
async function taskScopes(id: string, file: RouterAreasFile, deps: ContextSharingDeps): Promise<Set<string>> {
  const [task, sessions] = await Promise.all([deps.getTask(id), deps.sessionsForTask(id)]);
  if (!task || task.id !== id) throw new Error(`No exact task ${id}`);
  const out = new Set<string>();
  const add = (s: unknown) => { if (typeof s === 'string' && s.trim()) out.add(s.trim()); };
  for (const r of file.routers) if (r.taskId === id) add(r.areaId);
  if (out.size === 0 && task.org_role === 'router') out.add(NO_AREA_ROUTER);
  for (const record of sessions ?? []) if (record?.profile?.areaRole === 'router') add(record.profile.areaId);
  return out;
}

/**
 * May one task's words reach another task's model (or, with no target, a taskless session)?
 * A router keeps to itself (it reads outside content with only its router tools): neither side a
 * router, or both the same router. Anything that could not be read withholds it.
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
