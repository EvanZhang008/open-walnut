/**
 * Where a task stands against the outside service its project syncs to (the server side is
 * src/core/private-tasks/): the task menus' Sync row, the details' Source fact and the create
 * surfaces' Local / <service> choice read it from here, so they say the same thing.
 */
import type { SyncHold, Task } from '@open-walnut/core';

export type SyncStanding =
  /** Synced to `service`. */
  | { kind: 'synced'; service: string }
  /** Local in a project that syncs to `service`; `hold` says why when Walnut knows. */
  | { kind: 'kept'; service: string; hold?: SyncHold }
  /** Being checked before its first push to `service`. */
  | { kind: 'checking'; service: string; hold: SyncHold }
  /** Local in a project that does not sync (or the Inbox): nothing to choose. */
  | { kind: 'local' };

type TaskLike = Pick<Task, 'source' | 'project'> & { sync_hold?: SyncHold };

/** `projectSource` is the project's registry source ('local' or a plugin id). */
export function syncStanding(task: TaskLike, projectSource: string | undefined): SyncStanding {
  const hold = task.sync_hold;
  if (task.source && task.source !== 'local') return { kind: 'synced', service: task.source };
  if (hold?.state === 'checking') return { kind: 'checking', service: hold.target, hold };
  const service = hold?.target && hold.target !== 'local' ? hold.target
    : projectSource && projectSource !== 'local' && (task.project ?? '').trim() ? projectSource : '';
  return service ? { kind: 'kept', service, ...(hold ? { hold } : {}) } : { kind: 'local' };
}

/** The one line a task kept local shows (the details' Source fact, the menu's Sync row). */
export function keptLine(standing: SyncStanding, name: (source: string) => string): string {
  if (standing.kind === 'checking') return `Checking whether it is private before it goes to ${name(standing.service)}`;
  if (standing.kind !== 'kept') return '';
  const reason = standing.hold?.reason;
  return reason ? `Kept out of ${name(standing.service)}: ${reason}` : `Local, not synced to ${name(standing.service)}`;
}

/** The project's outside service a new task there would go to, or '' (a local project, the Inbox). */
export function projectService(project: string | undefined, sourceByName: ReadonlyMap<string, string>): string {
  const name = (project ?? '').trim().toLowerCase();
  if (!name) return '';
  const source = sourceByName.get(name);
  return source && source !== 'local' ? source : '';
}
