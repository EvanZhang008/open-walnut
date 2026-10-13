/**
 * Who a `task:deleted` event names, for the readers that key on an id.
 *
 * Every emitter addressed to the web UI sends `{ id, task }`
 * (tests/core/task-deleted-id.test.ts holds them to it); the plugin sync and the
 * reconciler, which reach only server subscribers, send `{ task }`. A merge sent
 * `{ task }` alone to the web UI until the r5 gate (L-27): the board removes rows
 * by id, so every other open window, the Mac app included, kept the merged task
 * until a reload. The board and the task page read the task's own id when `id`
 * is missing, as the phone feed (routes/events-v1.ts) and the board store
 * (boards/board-store.ts) already do.
 *
 * No imports: the web bundle uses this file too.
 */

/** The `source` a merge's events carry (task-manager mergeTaskInto). */
export const MERGE_EVENT_SOURCE = 'merge';

/**
 * The task a merged task went into, when a `task:deleted` comes from a merge
 * whose survivor still exists, else undefined (a plain delete, or a merge whose
 * survivor was deleted while it ran). A page open on the merged task says so
 * and links to it instead of leaving (fork r6 gate, MED-1).
 */
export function mergedIntoOf(data: unknown): { id: string; title: string } | undefined {
  const into = (data as { mergedInto?: { id?: unknown; title?: unknown } | null } | null | undefined)?.mergedInto;
  if (!into || typeof into.id !== 'string' || !into.id) return undefined;
  return { id: into.id, title: typeof into.title === 'string' ? into.title : '' };
}

/** The id a `task:deleted` event names: its `id`, else its task's id. */
export function deletedTaskId(data: unknown): string | undefined {
  const d = (data ?? {}) as { id?: unknown; task?: { id?: unknown } | null };
  if (typeof d.id === 'string' && d.id) return d.id;
  const own = d.task?.id;
  return typeof own === 'string' && own ? own : undefined;
}

/**
 * The task a `task:deleted` on the companion deletes on the primary, or
 * undefined. Only an event that names its `id`, as before. A merge's victim is
 * never sent: on the primary a plain delete clears the victim's session links,
 * which are what a merge exists to keep, so the primary keeps the victim, as it
 * did while the merge's event carried no id.
 */
export function companionDeleteId(event: { source?: string; data?: unknown }): string | undefined {
  const id = (event.data as { id?: unknown } | undefined)?.id;
  if (typeof id !== 'string' || !id) return undefined;
  return event.source === MERGE_EVENT_SOURCE ? undefined : id;
}
