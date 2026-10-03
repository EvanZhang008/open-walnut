/**
 * Columns of launches waiting for their isolated workspace: `pending:ws-<taskId>`.
 *
 * A `pending:` id on purpose: every placeholder guard (not persisted, never
 * fetched as a session) already covers it. Keyed by the task, so several can
 * wait at once without sharing the single in-flight quick-start slot.
 */
import type { Task } from '@open-walnut/core';
import { PENDING_COL_PREFIX } from '@/utils/column-ids';

const PREFIX = `${PENDING_COL_PREFIX}ws-`;

export function workspacePendingColumnId(taskId: string): string {
  return `${PREFIX}${taskId}`;
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
