/**
 * The synchronous area check for text Walnut builds on its own (a status question, a Brief's
 * lists, a report): a task's words may reach another task's model only when both are in the same
 * incoming-item area, or neither is in one. Task.router_area_id is the persisted scope mark (an
 * area's PUT marks its tasks before it stores the config), so a task array alone is enough here.
 *
 * Pure and dependency-free: the web build imports it through brief-structure.ts. The async
 * mayShareTaskContext (context-sharing.ts) stays for paths that also read the live config.
 */
import type { Task } from '../types.js';

export type AreaScoped = Pick<Task, 'id'> & { router_area_id?: string | null };

const areaOf = (t: AreaScoped): string => (typeof t.router_area_id === 'string' ? t.router_area_id.trim() : '');

/** Both outside any area, or both in the same one. */
export function sameTaskArea(from: AreaScoped, to: AreaScoped): boolean {
  return areaOf(from) === areaOf(to);
}

/** The tasks of `tasks` that `owner` may see in automatic text. */
export function sameAreaTasks<T extends AreaScoped>(owner: AreaScoped, tasks: readonly T[]): T[] {
  return tasks.filter((t) => sameTaskArea(owner, t));
}
