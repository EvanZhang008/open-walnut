/**
 * The one way to name a task as a URL: `/tasks/<id>`.
 *
 * There is no task page behind it any more (2026-11-02, the user: "why I click task
 * it open this page ... it should always, anywhere, go to home page ... don't have
 * this stupid page, for ever"). The route is a redirect shim (App.tsx `TaskRedirect`)
 * that opens the task on Home: selected and scrolled to in the task panel, its
 * session open, as a click on its row does. The URL stays so an old link, a
 * notification, the phone or an outside deep link still lands on the task.
 *
 * Code never builds the path by hand: a link's `href` uses `taskPath`, and a click
 * calls `openTaskOnHome` (utils/open-session.ts). tests/web/task-page-guard.test.ts
 * fails on a new `/tasks/<id>` literal anywhere else in web/src.
 */
export const TASK_PATH_PREFIX = '/tasks/';

export function taskPath(taskId: string): string {
  return `${TASK_PATH_PREFIX}${encodeURIComponent(taskId)}`;
}

/** The task id a `/tasks/<id>` path (with an optional query or hash) names, else null. */
export function taskIdOfPath(to: string): string | null {
  const m = /^\/tasks\/([^/?#]+)\/?(?:[?#].*)?$/.exec(to);
  if (!m) return null;
  try { return decodeURIComponent(m[1]!); } catch { return m[1]!; }
}
