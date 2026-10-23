/**
 * A task has exactly one session for its whole life, and a session belongs to at
 * most one task. Work that needs a new conversation (another engine, another
 * host, a clean context, a copy) becomes a new task.
 *
 * The rule lives on the session store, the source of truth: every write that
 * would give a task a second row is refused in code, and SQLite triggers
 * (created once the legacy data is split) refuse it too. Triggers, not a unique
 * index: the store writes with INSERT OR REPLACE, which settles a unique
 * conflict by DELETING the other row, so an index would turn any write that
 * slips past the guard (an older build after a rollback) into a silent loss of
 * the task's conversation. A trigger aborts the write instead. Task-side fields (`session_id`, the legacy
 * plan/exec slots, `session_ids`) are a cache that names that one session.
 */
import type { Database as DatabaseType } from '../../lib/sqlite.js';
import type { SessionRecord } from '../types.js';

export const ONE_SESSION_PER_TASK_TRIGGERS = ['sessions_one_per_task_insert', 'sessions_one_per_task_update'] as const;
/** The unique index an earlier build of this change created; dropped on sight. */
const RETIRED_INDEX = 'sessions_one_per_task';
/** The message SQLite raises when a write would give a task a second session. */
export const ONE_SESSION_PER_TASK_ABORT = 'one session per task';

/** ACP identity migration keeps the old row as an archived pointer to the new
 *  one for a moment (session-tracker stageAcpSessionIdMigration); it is not a
 *  second conversation. */
export const ACP_REDIRECT_PREFIX = 'acp_identity_replaced:';

/** The rows that count as a task's session. Kept as SQL so the guard and the
 *  index can never disagree. */
function taskRowSql(t: string): string {
  return `${t}task_id IS NOT NULL AND ${t}task_id <> '' AND COALESCE(substr(${t}archive_reason, 1, ${ACP_REDIRECT_PREFIX.length}), '') <> '${ACP_REDIRECT_PREFIX}'`;
}
export const TASK_SESSION_ROW_SQL = taskRowSql('');

export class TaskSessionTakenError extends Error {
  readonly status = 409;
  readonly code = 'task_has_session';
  constructor(
    readonly taskId: string,
    readonly existingSessionId: string,
    readonly attemptedSessionId: string,
  ) {
    super(
      `Task ${taskId} already has its session ${existingSessionId}; a task has exactly one session. `
      + 'Continue it with task_send, or start the new conversation as a new task (task_transfer or task_create).',
    );
    this.name = 'TaskSessionTakenError';
  }
}

/** The session id that already belongs to `taskId`, other than `sessionId`. */
export function otherTaskSessionId(handle: DatabaseType, taskId: string, sessionId: string): string | null {
  if (!taskId) return null;
  const row = handle
    .prepare(`SELECT claude_session_id FROM sessions WHERE task_id = ? AND claude_session_id <> ? AND ${TASK_SESSION_ROW_SQL} LIMIT 1`)
    .get(taskId, sessionId) as { claude_session_id: string } | undefined;
  return row?.claude_session_id ?? null;
}

export function assertTaskSessionFree(handle: DatabaseType, taskId: string, sessionId: string): void {
  const other = otherTaskSessionId(handle, taskId, sessionId);
  if (other) throw new TaskSessionTakenError(taskId, other, sessionId);
}

/** How many tasks still hold more than one session row. */
export function countTasksWithSeveralSessions(handle: DatabaseType): number {
  const row = handle
    .prepare(`SELECT COUNT(*) AS n FROM (SELECT task_id FROM sessions WHERE ${TASK_SESSION_ROW_SQL} GROUP BY task_id HAVING COUNT(*) > 1)`)
    .get() as { n: number };
  return row.n;
}

/**
 * Create the guard triggers once no task holds two rows. Returns false (and
 * creates nothing) while legacy duplicates remain: the in-code guard still
 * refuses every new duplicate, and the split migration removes the old ones.
 */
export function ensureOneSessionPerTaskGuard(handle: DatabaseType): boolean {
  handle.exec(`DROP INDEX IF EXISTS ${RETIRED_INDEX}`);
  const present = handle
    .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name IN (${ONE_SESSION_PER_TASK_TRIGGERS.map(() => '?').join(', ')})`)
    .get(...ONE_SESSION_PER_TASK_TRIGGERS) as { n: number };
  if (present.n === ONE_SESSION_PER_TASK_TRIGGERS.length) return true;
  if (countTasksWithSeveralSessions(handle) > 0) return false;
  const clash = `${taskRowSql('NEW.')} AND EXISTS (SELECT 1 FROM sessions s WHERE s.task_id = NEW.task_id
    AND s.claude_session_id <> NEW.claude_session_id AND ${taskRowSql('s.')})`;
  const abort = `BEGIN SELECT RAISE(ABORT, '${ONE_SESSION_PER_TASK_ABORT}'); END`;
  handle.exec(`CREATE TRIGGER IF NOT EXISTS ${ONE_SESSION_PER_TASK_TRIGGERS[0]} BEFORE INSERT ON sessions WHEN ${clash} ${abort}`);
  handle.exec(`CREATE TRIGGER IF NOT EXISTS ${ONE_SESSION_PER_TASK_TRIGGERS[1]} BEFORE UPDATE OF task_id, archive_reason ON sessions WHEN ${clash} ${abort}`);
  return true;
}

const LOST_CONVERSATION_REASONS = new Set(['conversation_never_persisted', 'remote_conversation_lost']);
const FAILED_START_REASONS = new Set(['awaiting_spawn', 'api_error']);

/**
 * True only when the session never held a conversation worth continuing: its
 * transcript is known lost, or its start failed before a single turn ran. Such
 * a row may be replaced by a new session on the same task (the old row is
 * deleted, so the task still has one). Anything uncertain counts as a
 * conversation: the start resumes it, and a resume that finds nothing archives
 * it as lost, after which the next start replaces it.
 */
export function sessionHasNoConversation(record: SessionRecord): boolean {
  if (record.archive_reason && LOST_CONVERSATION_REASONS.has(record.archive_reason)) return true;
  if (!record.status_reason || !FAILED_START_REASONS.has(record.status_reason)) return false;
  if (record.process_status === 'running' || record.process_status === 'idle') {
    return record.status_reason === 'awaiting_spawn' && !record.pid;
  }
  return record.contextTokens == null
    && !record.lastCompactUuid
    && !record.summary
    && (record.messageCount ?? 0) <= 1;
}
