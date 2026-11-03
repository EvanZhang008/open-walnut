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
 *
 * The wait is turn-end-wait.ts: a status event or a poll looks, and nothing holds the stop
 * longer than SELF_COMPLETE_STOP_MAX_MS (lifecycle-waits.ts lists it).
 */
import { log } from '../../logging/index.js';
import { TurnEndWait } from './turn-end-wait.js';

interface Wait {
  /** When the wait began: the summary of the turn that ends it is newer. */
  since: number;
}

/** A turn end that another turn follows at once is not the session's end: a
 *  background command that finishes after the completing turn leaves the
 *  session idle for about 0.1s before the CLI starts its follow-up turn
 *  (2026-10-06, measured 50-100ms). The stop looks only after this long, and
 *  a session running again by then is stopped when that turn ends instead. */
const SETTLE_MS = 3_000;
let settleMs = SETTLE_MS;

/** Test-only: change (or restore, with no argument) the settle window. */
export function __setSelfCompleteSettleMs(ms?: number): void {
  settleMs = ms ?? SETTLE_MS;
}

/** The task is complete: a turn (or the background work it left) holds the stop at most this long. */
export const SELF_COMPLETE_STOP_MAX_MS = 24 * 60 * 60_000;

/** Sessions whose stop is running now (the wait is over, the stop is not yet). */
const stopping = new Set<string>();

const waiter = new TurnEndWait<Wait>({
  name: 'self-complete-stop',
  // A completed task's own background work (a deploy it started, say) may finish: it holds
  // the stop as long as a turn does, a day.
  limits: { backgroundGraceMs: SELF_COMPLETE_STOP_MAX_MS, maxMs: SELF_COMPLETE_STOP_MAX_MS },
  queue: false,
  get settleMs() { return settleMs; },
  // Reopened during the rest of the turn (task_update, a message): it keeps running.
  asked: async (sid, wait) => (await stillComplete(sid) ? { askedAt: wait.since } : null),
  act: async (sid, wait) => {
    stopping.add(sid);
    try {
      await stopIfStillComplete(sid, wait);
    } finally {
      stopping.delete(sid);
      if (!waiter.has(sid)) {
        const { forgetFinalSummary } = await import('../session-hooks/builtins.js');
        forgetFinalSummary(sid);
      }
    }
  },
});

export function stopWhenTurnEnds(sessionId: string): void {
  if (waiter.has(sessionId)) return;
  waiter.watch(sessionId, { since: Date.now() });
}

/** A session that stops at this turn's end: the task's other writes leave it
 *  alone, and its summary of the turn runs at once. Stays true until it stopped. */
export function isAwaitingTurnEnd(sessionId: string): boolean {
  return waiter.has(sessionId) || stopping.has(sessionId);
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
    if (!await stillComplete(sessionId)) return;
    const { awaitFinalSummary } = await import('../session-hooks/builtins.js');
    const summary = await awaitFinalSummary(sessionId, wait.since);
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
  }
}

export function _pendingSelfCompleteStopsForTest(): string[] {
  return [...new Set([...waiter.keys(), ...stopping])];
}

export function _resetSelfCompleteStopsForTest(): void {
  waiter.clear();
  stopping.clear();
}
