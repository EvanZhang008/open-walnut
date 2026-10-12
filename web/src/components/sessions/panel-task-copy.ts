import type { Task } from '@open-walnut/core';

/**
 * The task a session panel shows. The shared task store is the truth inside
 * this browser (a rename or phase flip anywhere lands there in the same frame).
 * The panel's own REST copy stands in only for the task the session still names
 * (`linkedTaskId`): for a task the list does not carry, and as the donor of
 * `ext`, which the list's minimal payload drops. Once that task is deleted, or
 * the session re-pointed by a merge, the copy is stale: a click in the panel
 * marked the deleted task read through it (PATCH, 500, an error card) every
 * time, 2026-10-11.
 */
export function panelTaskCopy(
  storeTask: Task | null,
  fetchedTask: Task | null,
  linkedTaskId: string | undefined,
): Task | null {
  const fetched = fetchedTask && fetchedTask.id === linkedTaskId ? fetchedTask : null;
  if (!storeTask) return fetched;
  if (!fetched || storeTask.ext !== undefined) return storeTask;
  return { ...storeTask, ext: fetched.ext };
}
