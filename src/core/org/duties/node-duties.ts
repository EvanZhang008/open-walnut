/**
 * A node's duty switches (types.ts): read, turn on or off, and the nodes that have one on.
 * Stored on the node's own task (Task.org_duties, a payload field like org_instructions),
 * so the switch goes with the node through a rename, a handover or a restart. Off unless a row
 * says on: an older Walnut ignores the field, and a node it never saw has every duty off.
 */
import type { Task } from '../../types.js';
import { bus, EventNames } from '../../event-bus.js';
import { OrgError, orgTasks, withOrgLock } from '../org-store.js';
import { orgDuty } from './registry.js';
import type { DutyRole, NodeDutyState } from './types.js';

export interface DutyWriter {
  by: 'human' | 'agent' | `task:${string}`;
  byName?: string;
}

const roleOf = (task: Pick<Task, 'org_role'>): DutyRole | null =>
  (task.org_role === 'main' || task.org_role === 'lead' ? task.org_role : null);

/** Whether `task` has duty `id` on. */
export function dutyOn(task: Pick<Task, 'org_role' | 'org_duties'>, id: string): boolean {
  const cap = orgDuty(id);
  const role = roleOf(task);
  if (!cap || !role || !cap.roles.includes(role)) return false;
  return task.org_duties?.[id]?.on === true;
}

/** The open org nodes that have duty `id` on. */
export async function nodesWithDuty(id: string): Promise<Task[]> {
  return (await orgTasks()).filter((t) => t.phase !== 'COMPLETE' && dutyOn(t, id));
}

/** Turn duty `id` on or off for the node `taskId`. Returns the node as written. */
export async function setNodeDuty(taskId: string, id: string, on: unknown, writer: DutyWriter = { by: 'human' }): Promise<Task> {
  const cap = orgDuty(id);
  if (!cap) throw new OrgError('unknown_duty', 404, `No duty "${id}".`);
  if (typeof on !== 'boolean') throw new OrgError('bad_request', 400, '`on` must be true or false.');
  return withOrgLock(async () => {
    const tm = await import('../../task-manager.js');
    const task = await tm.getTask(taskId).catch(() => null);
    const role = task ? roleOf(task) : null;
    if (!task || !role) throw new OrgError('not_org_node', 404, `No CEO or VP with id "${taskId}".`);
    if (!cap.roles.includes(role)) throw new OrgError('duty_not_for_role', 409, `"${cap.name}" is not for ${role === 'main' ? 'the CEO' : 'a VP'}.`);
    const row: NodeDutyState = {
      on, at: new Date().toISOString(), by: writer.by,
      ...(writer.by !== 'human' && writer.byName ? { by_name: writer.byName } : {}),
    };
    const { task: written } = await tm.updateTaskRaw(task.id, (cur) => {
      if (cur.org_duties?.[id]?.on === on) return null;
      return { org_duties: { ...(cur.org_duties ?? {}), [id]: row } };
    }, { source: 'api' });
    const out = written ?? await tm.getTask(task.id);
    // Written raw (updated_at stays): open pages learn the switch from this.
    if (written) bus.emit(EventNames.TASK_UPDATED, { task: written }, ['web-ui'], { source: 'org-duty' });
    return out;
  });
}
