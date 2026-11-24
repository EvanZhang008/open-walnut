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
 *
 * The wait is also on the record (`taskCompleteStop: 'turn_end'`, task-complete-stop.ts), so
 * a restart watches it again with its own deadline instead of losing it (2026-11-18: a deploy
 * dropped the in-memory wait, and the boot migration then wrote the live session stopped).
 *
 * On a host that runs and judges its sessions, the same wait serves the host's own rows: the
 * leader decided the completion and asked the host (host-judged-complete.ts takeCompletionStop),
 * the marker on the host's row is that decision, and the host stops its own session at the turn's
 * end (stopOwnCompleted), its task copy only vetoing a task reopened since.
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

// One shared import (turn-end-wait.ts: two first imports at once can leave one pending under vitest).
let taskCompleteStopMod: Promise<typeof import('./task-complete-stop.js')> | null = null;
const taskCompleteStop = () => (taskCompleteStopMod ??= import('./task-complete-stop.js'));

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
  asked: async (sid, wait) => {
    if (await stillComplete(sid)) return { askedAt: wait.since };
    await (await taskCompleteStop()).clearTaskCompleteStop(sid, 'turn_end');
    return null;
  },
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

/** `since`: when the stop was decided (a restart passes the time on the record, keeping the deadline). */
export function stopWhenTurnEnds(sessionId: string, since: number = Date.now()): void {
  if (waiter.has(sessionId)) return;
  waiter.watch(sessionId, { since });
}

/** A session that stops at this turn's end: the task's other writes leave it
 *  alone, and its summary of the turn runs at once. Stays true until it stopped. */
export function isAwaitingTurnEnd(sessionId: string): boolean {
  return waiter.has(sessionId) || stopping.has(sessionId);
}

/** The session's task id when that task (as its record names it now) is complete. */
export async function stillComplete(sessionId: string): Promise<string | undefined> {
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const { listTasksByIds } = await import('../task-manager.js');
  const rec = await getSessionByClaudeId(sessionId);
  // One of this host's own rows: the leader's decision on its row, not the task copy here.
  const host = await import('./host-judged-complete.js');
  if (rec && await host.ownRowHere(rec)) return await host.hostCompletionStillWanted(rec) ? (rec.taskId || sessionId) : undefined;
  // The record names the session's task now (a merge moves sessions).
  const taskId = rec?.taskId;
  const task = taskId ? (await listTasksByIds([taskId]))[0] : undefined;
  return task?.phase === 'COMPLETE' ? taskId : undefined;
}

async function stopIfStillComplete(sessionId: string, wait: Wait): Promise<void> {
  try {
    if (!await stillComplete(sessionId)) {
      await (await taskCompleteStop()).clearTaskCompleteStop(sessionId, 'turn_end');
      return;
    }
    const { awaitFinalSummary } = await import('../session-hooks/builtins.js');
    const summary = await awaitFinalSummary(sessionId, wait.since);
    const taskId = await stillComplete(sessionId);
    if (!taskId) {
      await (await taskCompleteStop()).clearTaskCompleteStop(sessionId, 'turn_end');
      return;
    }
    const { completeTaskSessions, getSessionByClaudeId } = await import('../session-tracker.js');
    const host = await import('./host-judged-complete.js');
    if (await host.ownRowHere(await getSessionByClaudeId(sessionId))) {
      await host.stopOwnCompleted(sessionId);
      return;
    }
    // Still the actor: when a new turn has started since, it waits for that one.
    const stopped = await completeTaskSessions([sessionId], { actorSid: sessionId });
    if (stopped > 0) log.session.info('self-completed session stopped at turn end', { sessionId, taskId, summary });
  } catch (err) {
    log.session.warn('stop at turn end failed for a self-completed session', {
      sessionId, error: err instanceof Error ? err.message : String(err),
    });
    // The wait is over: its marker must not keep the task's next completion pass away from it.
    await (await taskCompleteStop()).clearTaskCompleteStop(sessionId, 'turn_end');
  }
}

export function _pendingSelfCompleteStopsForTest(): string[] {
  return [...new Set([...waiter.keys(), ...stopping])];
}

export function _resetSelfCompleteStopsForTest(): void {
  waiter.clear();
  stopping.clear();
}
