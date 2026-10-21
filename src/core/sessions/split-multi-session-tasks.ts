/**
 * One-time move to one-session-per-task (sessions/one-session-per-task.ts).
 *
 * Before 2026-10-21 a task could collect several sessions (plan then execute,
 * retries, rewinds into a copy, restarts after a lost conversation). Each such
 * task keeps ONE session: the one its `session_id` names when that row exists,
 * else its most recently active one. The others are detached: their row loses
 * the task link and records `legacyTaskId`, and the task lists them in
 * `legacy_session_ids` (history only). No task is created, so no sync plugin
 * sees a new item. Once no task holds two rows the guard triggers are created, and
 * from then on SQLite refuses a second session as well.
 *
 * Idempotent: a second run finds nothing to split and only re-checks the guard.
 */
import { getDb } from '../session-db.js';
import { log } from '../../logging/index.js';
import { ensureOneSessionPerTaskGuard, TASK_SESSION_ROW_SQL } from './one-session-per-task.js';

interface Row { claude_session_id: string; task_id: string; last_active_at: string | null; archived: number | null; message_count: number | null }

export interface SplitResult { tasks: number; detached: number; guardReady: boolean }

function pickKeeper(rows: Row[], taskSessionId: string | undefined): Row {
  // A row with no messages (a warm session that took the link, a start that
  // never got a turn) never wins over one that holds the conversation.
  const talked = rows.filter((r) => (r.message_count ?? 0) > 0);
  const pool = talked.length > 0 ? talked : rows;
  const named = taskSessionId ? pool.find((r) => r.claude_session_id === taskSessionId) : undefined;
  if (named) return named;
  return [...pool].sort((a, b) => {
    const live = Number(!a.archived) - Number(!b.archived);
    if (live !== 0) return -live;
    return (b.last_active_at ?? '').localeCompare(a.last_active_at ?? '');
  })[0];
}

export async function splitMultiSessionTasks(): Promise<SplitResult> {
  const db = getDb();
  if (!db) return { tasks: 0, detached: 0, guardReady: false };
  const rows = db.prepare(
    `SELECT claude_session_id, task_id, last_active_at, archived, message_count FROM sessions WHERE ${TASK_SESSION_ROW_SQL}
       AND task_id IN (SELECT task_id FROM sessions WHERE ${TASK_SESSION_ROW_SQL} GROUP BY task_id HAVING COUNT(*) > 1)`,
  ).all() as Row[];
  const byTask = new Map<string, Row[]>();
  for (const row of rows) byTask.set(row.task_id, [...(byTask.get(row.task_id) ?? []), row]);

  const { updateSessionRecord } = await import('../session-tracker.js');
  const { getTask, updateTaskRaw } = await import('../task-manager.js');
  let detached = 0;
  for (const [taskId, group] of byTask) {
    const task = await getTask(taskId).catch(() => undefined);
    const keeper = pickKeeper(group, task?.session_id);
    const others = group.filter((r) => r !== keeper).map((r) => r.claude_session_id);
    for (const sid of others) {
      await updateSessionRecord(sid, { taskId: '', legacyTaskId: taskId });
      detached++;
    }
    if (task) {
      const keep = keeper.claude_session_id;
      await updateTaskRaw(task.id, (current) => {
        const legacy = new Set([...(current.legacy_session_ids ?? []), ...others,
          ...(current.session_ids ?? []).filter((id) => id !== keep)]);
        return {
          session_ids: [keep],
          legacy_session_ids: [...legacy],
          ...(current.session_id && current.session_id !== keep ? { session_id: keep } : {}),
          ...(current.plan_session_id && current.plan_session_id !== keep ? { plan_session_id: undefined } : {}),
          ...(current.exec_session_id && current.exec_session_id !== keep ? { exec_session_id: undefined } : {}),
        };
      }, { source: 'one-session-per-task', emitEvent: false, push: false });
    }
  }
  // A task's own list can still name sessions no row links to it any more (a row
  // moved to another task, or left with none): those are history too.
  const { listTasks } = await import('../task-manager.js');
  const ownerOf = db.prepare(`SELECT claude_session_id FROM sessions WHERE task_id = ? AND ${TASK_SESSION_ROW_SQL} ORDER BY last_active_at DESC LIMIT 1`).pluck();
  let listsTrimmed = 0;
  for (const task of await listTasks()) {
    if ((task.session_ids?.length ?? 0) <= 1 || byTask.has(task.id)) continue;
    const owned = ownerOf.get(task.id) as string | undefined;
    const keep = owned ?? task.session_id ?? task.session_ids![task.session_ids!.length - 1];
    await updateTaskRaw(task.id, (current) => ({
      session_ids: [keep],
      legacy_session_ids: [...new Set([...(current.legacy_session_ids ?? []), ...(current.session_ids ?? []).filter((id) => id !== keep)])],
      ...(owned && current.session_id !== owned ? { session_id: owned } : {}),
      ...(current.plan_session_id && current.plan_session_id !== keep ? { plan_session_id: undefined } : {}),
      ...(current.exec_session_id && current.exec_session_id !== keep ? { exec_session_id: undefined } : {}),
    }), { source: 'one-session-per-task', emitEvent: false, push: false });
    listsTrimmed++;
  }
  const guardReady = ensureOneSessionPerTaskGuard(db);
  if (byTask.size > 0 || listsTrimmed > 0 || !guardReady) {
    log.session.info('one session per task: legacy tasks split', { tasks: byTask.size, detached, listsTrimmed, guardReady });
  }
  return { tasks: byTask.size + listsTrimmed, detached, guardReady };
}
