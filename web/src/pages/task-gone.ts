/**
 * What the task page does when the task it shows goes away under it (deleted,
 * or merged into another task, from another window, the board or a session).
 *
 * The fork r6 gate (MED-1): the page navigated home on a merge too, and a
 * pop-out window ("Open in new tab") that navigates to an app path rendered the
 * whole app there and crashed. Now:
 *  - merged into a task that still exists: a notice naming it, with a link;
 *  - deleted, in a pop-out: a notice (a pop-out has no home to go to);
 *  - deleted, in the app: home, as before.
 * Links on the page stay in the pop-out when it is one (taskHref).
 */
import { deletedTaskId, mergedIntoOf } from '../../../src/core/task-deleted-id';
import { popoutPath } from '@/popout/openPopout';

/** The task the page showed is gone. `forId` is the page id it applies to. */
export interface TaskGone {
  forId: string;
  mergedInto?: { id: string; title: string };
}

export type TaskGoneAction =
  | { kind: 'ignore' }
  | { kind: 'notice'; gone: TaskGone }
  | { kind: 'navigate'; to: string };

/**
 * The page's answer to a `task:deleted`. `taskId` is the resolved id events
 * match on; `pageId` the id the page was opened with (it may be a prefix).
 */
export function taskGoneAction(data: unknown, taskId: string | undefined, pageId: string | undefined, isPopout: boolean): TaskGoneAction {
  const gone = deletedTaskId(data);
  if (!gone || !taskId || !pageId || gone !== taskId) return { kind: 'ignore' };
  const mergedInto = mergedIntoOf(data);
  if (mergedInto && mergedInto.id !== taskId) return { kind: 'notice', gone: { forId: pageId, mergedInto } };
  if (isPopout) return { kind: 'notice', gone: { forId: pageId } };
  return { kind: 'navigate', to: '/' };
}

/**
 * The id the page's events match on: the loaded detail's (the page id may be a
 * prefix), but only while the detail is this page's task. After a link to
 * another task in the same window the last task's detail stays until the next
 * one loads, and an event about it must not land on the new page.
 */
export function pageTaskId(detailId: string | undefined, pageId: string | undefined): string | undefined {
  return detailId && pageId && detailId.startsWith(pageId) ? detailId : pageId;
}

/** Where a link to a task goes from the task page: the same pop-out, or the app's task page. */
export function taskHref(id: string, isPopout: boolean): string {
  return isPopout ? popoutPath('task', { id }) : `/tasks/${id}`;
}
