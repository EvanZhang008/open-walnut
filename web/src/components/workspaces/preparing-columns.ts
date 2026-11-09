/**
 * Columns of launches waiting for their isolated workspace: `pending:ws-<taskId>`.
 *
 * A `pending:` id on purpose: every placeholder guard (never fetched as a
 * session, free of the column budget) already covers it. Keyed by the task, so
 * several can wait at once without sharing the single in-flight quick-start
 * slot, and the strip keeps it across a reload (a setup can run for minutes).
 */
import type { Task } from '@open-walnut/core';
import { WORKSPACE_WAIT_COL_PREFIX as PREFIX } from '@/utils/column-ids';

export function workspacePendingColumnId(taskId: string): string {
  return `${PREFIX}${taskId}`;
}

/** The column of a start that waits for the task's workspace (being made, or held by its setup), if one waits. */
export function waitingStartColumnOf(task: Task): string | undefined {
  const ws = (task as { workspace?: { state?: string; pending_start?: unknown } }).workspace;
  if (!ws?.pending_start || ws.state === 'removed' || ws.state === 'removing') return undefined;
  return workspacePendingColumnId(task.id);
}

export function workspacePendingTaskId(columnId: string): string | null {
  return columnId.startsWith(PREFIX) ? columnId.slice(PREFIX.length) : null;
}

/** What the launch knew when it handed over to the column (the row may not be in the store yet). */
/** `error`: the server refused the launch's workspace request (shown with Retry and Dismiss). */
type LaunchInfo = { task?: Task | null; message?: string; error?: string };
const launches = new Map<string, LaunchInfo>();

export function rememberWorkspaceLaunch(taskId: string, info: LaunchInfo): void {
  launches.set(taskId, info);
}

export function workspaceLaunchInfo(taskId: string): LaunchInfo {
  return launches.get(taskId) ?? {};
}
