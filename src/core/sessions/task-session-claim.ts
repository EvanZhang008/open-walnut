/**
 * The start paths' side of one-session-per-task (one-session-per-task.ts):
 * before a new session is made for a task, the task's existing session is
 * either continued (it holds a conversation) or retired (its start failed
 * before a single turn ran, or its transcript is known lost).
 */
import type { SessionRecord } from '../types.js';
import { ACP_REDIRECT_PREFIX, sessionHasNoConversation, TaskSessionTakenError } from './one-session-per-task.js';
import { log } from '../../logging/index.js';

/** A start Walnut is still spawning: its row has no turn yet, but it is not dead. */
const SPAWN_WINDOW_MS = 5 * 60_000;

function stillSpawning(r: SessionRecord, now: number): boolean {
  if (r.status_reason !== 'awaiting_spawn') return false;
  const at = Date.parse(r.startedAt ?? '');
  return Number.isFinite(at) && now - at < SPAWN_WINDOW_MS;
}

/**
 * The task's one conversation (a start still spawning counts), or undefined
 * when the task is free for a new session.
 *
 * Rows that never held a conversation are skipped. With `retire` (start paths
 * only, about to make the task's new session) they are also detached: unlinked
 * and kept in the task's `legacy_session_ids`, never deleted, because "no
 * conversation" is sometimes only a path mismatch on the host.
 */
export async function taskConversation(taskId: string, opts: { retire?: boolean } = {}): Promise<SessionRecord | undefined> {
  const { getSessionsForTask } = await import('../session-tracker.js');
  const now = Date.now();
  const rows = (await getSessionsForTask(taskId))
    .filter((r) => !r.archive_reason?.startsWith(ACP_REDIRECT_PREFIX));
  const empty = rows.filter((r) => sessionHasNoConversation(r) && !stillSpawning(r, now));
  if (opts.retire) {
    for (const r of empty) await detachTaskSession(taskId, r.claudeSessionId, 'no conversation, replaced by a new start');
  }
  return rows
    .filter((r) => !empty.includes(r))
    .sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''))[0];
}

/**
 * Unlink a session from its task and keep it as the task's history. The row
 * stays (with `legacyTaskId`), so nothing it held is lost.
 */
export async function detachTaskSession(taskId: string, sessionId: string, why: string): Promise<void> {
  const { updateSessionRecord } = await import('../session-tracker.js');
  await updateSessionRecord(sessionId, { taskId: '', legacyTaskId: taskId });
  const { updateTaskRaw } = await import('../task-manager.js');
  await updateTaskRaw(taskId, (cur) => ({
    session_ids: (cur.session_ids ?? []).filter((sid) => sid !== sessionId),
    legacy_session_ids: [...new Set([...(cur.legacy_session_ids ?? []), sessionId])],
    ...(cur.session_id === sessionId ? { session_id: undefined } : {}),
    ...(cur.plan_session_id === sessionId ? { plan_session_id: undefined } : {}),
    ...(cur.exec_session_id === sessionId ? { exec_session_id: undefined } : {}),
  }), { source: 'one-session-per-task', push: false }).catch(() => { /* task gone */ });
  log.session.info('task session detached', { taskId, sessionId, why });
}

/** Throws TaskSessionTakenError unless the task can take a new session. */
export async function claimTaskForNewSession(taskId: string, attemptedSessionId = 'new'): Promise<void> {
  const existing = await taskConversation(taskId, { retire: true });
  if (existing) throw new TaskSessionTakenError(taskId, existing.claudeSessionId, attemptedSessionId);
}

/**
 * Continue the task's existing conversation with `text`: the one-session answer
 * to "start this task again". Unarchives it first (an archived session is a
 * closed tab, not a deleted conversation).
 */
export async function continueTaskConversation(
  record: SessionRecord,
  opts: { text: string; callerSid?: string; expectReply?: boolean; replyTimeoutSecs?: number },
): Promise<{ sessionId: string; requestId?: string; delivery: 'queued' | 'deferred' }> {
  const { updateSessionRecord } = await import('../session-tracker.js');
  if (record.archived) {
    await updateSessionRecord(record.claudeSessionId, { archived: false, archive_reason: undefined });
  }
  const { performSessionSend } = await import('./session-send-core.js');
  const sent = await performSessionSend({
    to: record.claudeSessionId,
    text: opts.text,
    callerSid: opts.callerSid,
    expectReply: opts.expectReply,
    replyTimeoutSecs: opts.replyTimeoutSecs,
    force: true,
    reason: 'The task was started again; its one conversation continues here.',
  });
  return { sessionId: record.claudeSessionId, requestId: sent.requestId, delivery: sent.delivery };
}

/** Another session that already belongs to `taskId` (null = none). */
export async function otherTaskSessionIdFor(taskId: string, sessionId: string): Promise<string | null> {
  const { getDb } = await import('../session-db.js');
  const db = getDb();
  if (!db) return null;
  const { otherTaskSessionId } = await import('./one-session-per-task.js');
  return otherTaskSessionId(db, taskId, sessionId);
}
