/**
 * A session that completes its OWN task does so from inside a turn: the Bash
 * call running `task_complete` is still waiting for the answer. Stopping that
 * CLI at once cut the call, which the CLI records as "The user doesn't want to
 * proceed with this tool use", and the turn's closing words with it
 * (2026-10-05). So that one session is stopped when its turn ends, if its task
 * is still complete then; every other session of the task stops at once
 * (completeTaskSessions).
 *
 * The turn's end is the session's status leaving 'running', not session:result:
 * a background command's follow-up turn closes with a status change alone, a
 * runner detached for the rest of the turn is settled by the daemon snapshot,
 * and a failed mid-turn delivery emits session:error while the turn goes on.
 */
import { bus, EventNames } from '../event-bus.js';
import type { SessionStatusChangedEvent } from '../event-types.js';
import { log } from '../../logging/index.js';

const pending = new Set<string>();

const SUBSCRIBER = 'self-complete-stop';

export function stopWhenTurnEnds(sessionId: string): void {
  pending.add(sessionId);
  // Idempotent: the bus keys subscribers by name.
  bus.subscribe(SUBSCRIBER, (event) => {
    const status = event.data as Partial<SessionStatusChangedEvent> | undefined;
    const sid = status?.sessionId;
    if (!sid || !pending.has(sid) || !status.process_status || status.process_status === 'running') return;
    pending.delete(sid);
    void stopIfStillComplete(sid);
  }, { global: true, interest: [EventNames.SESSION_STATUS_CHANGED] });
}

/** A session waiting for its turn's end: the task's other writes leave it alone. */
export function isAwaitingTurnEnd(sessionId: string): boolean {
  return pending.has(sessionId);
}

async function stopIfStillComplete(sessionId: string): Promise<void> {
  try {
    const { completeTaskSessions, getSessionByClaudeId } = await import('../session-tracker.js');
    const { listTasksByIds } = await import('../task-manager.js');
    // The record names the session's task now (a merge moves sessions).
    const taskId = (await getSessionByClaudeId(sessionId))?.taskId;
    const task = taskId ? (await listTasksByIds([taskId]))[0] : undefined;
    // Reopened during the rest of the turn (task_update, a message): it keeps running.
    if (task?.phase !== 'COMPLETE') return;
    // Still the actor: when a new turn has started since, it waits for that one.
    const stopped = await completeTaskSessions([sessionId], { actorSid: sessionId });
    if (stopped > 0) log.session.info('self-completed session stopped at turn end', { sessionId, taskId });
  } catch (err) {
    log.session.warn('stop at turn end failed for a self-completed session', {
      sessionId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function _pendingSelfCompleteStopsForTest(): string[] {
  return [...pending];
}

export function _resetSelfCompleteStopsForTest(): void {
  pending.clear();
}
