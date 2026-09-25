import type { Task } from '@open-walnut/core';

/**
 * Recent feed sort mode: 'updated' ranks by the latest activity of any kind (the
 * historical behavior), 'created' by pure creation time. Sorting only; nothing is
 * rewritten.
 */
export type RecentSortMode = 'updated' | 'created';

export type RecentActivityKind = 'created' | 'updated' | 'session' | 'completed';

export interface RecentActivity {
  /** ISO timestamp the feed ranks the task by. */
  at: string;
  /** Which task field supplied it; the row tooltip names it. */
  kind: RecentActivityKind;
}

/**
 * The ONE clock behind a Recent row: the feed sorts by it and the row's "3w ago"
 * shows it. They used to differ (the sort took the latest of update / session /
 * completion while the row fell back to created_at for a task with no session), so
 * a task edited yesterday sat at the top of the feed labelled "5mo ago".
 *
 * Strict `>` keeps the earlier-declared kind on a tie, so a never-edited task whose
 * updated_at equals its created_at still reads "Created".
 *
 * completed_at counts only while the task IS done: real data carries it on open
 * tasks too (a reopened task, a sync echo with a date-only completion), and those
 * must not read "Completed" nor rank by a completion that no longer holds.
 */
export type RecentActivityTask = Pick<Task, 'created_at' | 'updated_at' | 'last_session_update' | 'completed_at' | 'status' | 'phase'>;

export function recentActivityTime(task: RecentActivityTask, mode: RecentSortMode): RecentActivity {
  let best: RecentActivity = { at: task.created_at ?? '', kind: 'created' };
  if (mode === 'created') return best;
  const consider = (at: string | undefined, kind: RecentActivityKind) => {
    if (at && at > best.at) best = { at, kind };
  };
  consider(task.updated_at, 'updated');
  consider(task.last_session_update, 'session');
  if (task.status === 'done' || task.phase === 'COMPLETE') consider(task.completed_at, 'completed');
  return best;
}

const KIND_LABEL: Record<RecentActivityKind, string> = {
  created: 'Created',
  updated: 'Updated',
  session: 'Session activity',
  completed: 'Completed',
};

/** Tooltip for the row's relative time: which clock it is, then the full local date. */
export function recentActivityTitle(activity: RecentActivity): string {
  const t = new Date(activity.at);
  if (isNaN(t.getTime())) return '';
  return `${KIND_LABEL[activity.kind]} ${t.toLocaleString()}`;
}
