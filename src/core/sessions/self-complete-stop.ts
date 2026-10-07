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
 *
 * Before the stop, the session writes its summary of that last turn into the
 * task note (awaitFinalSummary): once the CLI is gone nothing can answer, and
 * a completed task has no next turn to catch up in.
 */
import { bus, EventNames } from '../event-bus.js';
import type { SessionStatusChangedEvent } from '../event-types.js';
import { log } from '../../logging/index.js';

interface Wait {
  /** When the wait began: the summary of the turn that ends it is newer. */
  since: number;
  /** The turn ended and the stop is running. */
  stopping: boolean;
  /** When the status left 'running'. */
  endedAt?: number;
}

const pending = new Map<string, Wait>();

/** A turn end that another turn follows at once is not the session's end: a
 *  background command that finishes after the completing turn leaves the
 *  session idle for about 0.1s before the CLI starts its follow-up turn
 *  (2026-10-06, measured 50-100ms). The stop decides only after this long, and
 *  a session running again by then is stopped when that turn ends instead. */
const SETTLE_MS = 3_000;
let settleMs = SETTLE_MS;

/** Test-only: change (or restore, with no argument) the settle window. */
export function __setSelfCompleteSettleMs(ms?: number): void {
  settleMs = ms ?? SETTLE_MS;
}

const SUBSCRIBER = 'self-complete-stop';

export function stopWhenTurnEnds(sessionId: string): void {
  pending.set(sessionId, { since: Date.now(), stopping: false });
  // Idempotent: the bus keys subscribers by name.
  bus.subscribe(SUBSCRIBER, (event) => {
    const status = event.data as Partial<SessionStatusChangedEvent> | undefined;
    const sid = status?.sessionId;
    const wait = sid ? pending.get(sid) : undefined;
    if (!sid || !wait || wait.stopping || !status.process_status || status.process_status === 'running') return;
    wait.stopping = true;
    wait.endedAt = Date.now();
    void stopIfStillComplete(sid, wait);
  }, { global: true, interest: [EventNames.SESSION_STATUS_CHANGED] });
}

/** A session that stops at this turn's end: the task's other writes leave it
 *  alone, and its summary of the turn runs at once. Stays true until it stopped. */
export function isAwaitingTurnEnd(sessionId: string): boolean {
  return pending.has(sessionId);
}

async function stillComplete(sessionId: string): Promise<string | undefined> {
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const { listTasksByIds } = await import('../task-manager.js');
  // The record names the session's task now (a merge moves sessions).
  const taskId = (await getSessionByClaudeId(sessionId))?.taskId;
  const task = taskId ? (await listTasksByIds([taskId]))[0] : undefined;
  return task?.phase === 'COMPLETE' ? taskId : undefined;
}

async function stopIfStillComplete(sessionId: string, wait: Wait): Promise<void> {
  try {
    // Reopened during the rest of the turn (task_update, a message): it keeps running.
    if (!await stillComplete(sessionId)) return;
    const { awaitFinalSummary } = await import('../session-hooks/builtins.js');
    const summary = await awaitFinalSummary(sessionId, wait.since);
    const settleLeft = (wait.endedAt ?? Date.now()) + settleMs - Date.now();
    if (settleLeft > 0) await new Promise((resolve) => setTimeout(resolve, settleLeft).unref?.());
    const taskId = await stillComplete(sessionId);
    if (!taskId) return;
    const { completeTaskSessions } = await import('../session-tracker.js');
    // Still the actor: when a new turn has started since, it waits for that one.
    const stopped = await completeTaskSessions([sessionId], { actorSid: sessionId });
    if (stopped > 0) log.session.info('self-completed session stopped at turn end', { sessionId, taskId, summary });
  } catch (err) {
    log.session.warn('stop at turn end failed for a self-completed session', {
      sessionId, error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    // A new wait registered meanwhile (a turn began again) is kept.
    if (pending.get(sessionId) === wait) {
      pending.delete(sessionId);
      const { forgetFinalSummary } = await import('../session-hooks/builtins.js');
      forgetFinalSummary(sessionId);
    }
  }
}

export function _pendingSelfCompleteStopsForTest(): string[] {
  return [...pending.keys()];
}

export function _resetSelfCompleteStopsForTest(): void {
  pending.clear();
}
