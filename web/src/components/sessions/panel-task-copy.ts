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

/**
 * The task each open panel shows, by session id. The keys that act on a column (mod+shift+D,
 * MainPage) read the board's list, which a slow load brings after the columns are up: until it
 * has come, the column's own copy stands in, as it does for the header's Complete
 * (TaskQuickActions). 2026-11-10: a Cmd+Shift+D in that window said "This column has no task
 * to complete" under a column showing its task.
 */
const shownTasks = new Map<string, Task>();

/** Note the task a panel of `sessionId` shows; the returned cleanup forgets it (only that copy). */
export function noteShownTask(sessionId: string, task: Task | null): () => void {
  if (!task) return () => {};
  shownTasks.set(sessionId, task);
  return () => { if (shownTasks.get(sessionId) === task) shownTasks.delete(sessionId); };
}

/** The task an open panel of `sessionId` shows, if one is open and knows it. */
export function shownTaskOf(sessionId: string): Task | undefined {
  return shownTasks.get(sessionId);
}
