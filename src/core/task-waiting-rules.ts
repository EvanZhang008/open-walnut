/**
 * "Wait until": the pure half. What the phase machine does with a task that is
 * waiting on a trigger (TaskWaiting in types.ts), kept free of I/O so phase.ts
 * can import it without a cycle and the rules can be tested without a store.
 *
 * The whole feature is one exception to the hand-back rule: a finished turn on a
 * waiting task lands on TODO instead of NEED_ACTION, so the row keeps no red dot
 * while nothing needs the human. Everything else here is about when the wait
 * ENDS, because a wait that never ends is the parked-state bug the WAIT phase
 * was removed for:
 *
 *   - someone sent the task a message (a human or a peer): they took it back;
 *   - the session is blocked on a human decision: that needs the human now;
 *   - someone set the status to Need Action or Complete. In Progress does NOT end
 *     it: a session turn on a waiting task is In Progress too (the one that set
 *     the wait, a session start), and an automated start must not cancel a wait;
 *   - the trigger fired or kept failing (task-waiting.ts, the side-effect half).
 */
import { cutEnd } from './text-cut.js';
import { isTaskWaiting, type TaskPhase, type TaskWaiting, type TaskWakeReason } from './types.js';

export interface WaitingPhaseDecision {
  /** The phase to write, or null for no phase change. */
  newPhase: TaskPhase | null;
  /** Set when this transition ends the wait. */
  wake?: TaskWakeReason;
  /** A hand-back (NEED_ACTION) the wait turned into a quiet TODO: the turn ended. */
  absorbed?: boolean;
}

/**
 * A session-driven transition on a task that may be waiting. `computed` is what
 * the unconditional machine would do (phase.ts); `humanSend` marks a
 * `session:input` whose send came from a human or a peer (the same allowlist that
 * may reopen a completed task).
 */
export function waitingSessionPhase(
  task: { phase: TaskPhase; waiting?: TaskWaiting | null },
  trigger: string,
  computed: TaskPhase | null,
  opts: { humanSend?: boolean } = {},
): WaitingPhaseDecision {
  if (!isTaskWaiting(task)) return { newPhase: computed };
  if (trigger === 'session:awaiting-human') return { newPhase: computed, wake: 'needs-human' };
  if (trigger === 'session:input' && opts.humanSend) return { newPhase: computed, wake: 'message' };
  // A turn that ended (result, error, a dead session's hand-back): the task keeps
  // waiting, so it goes quiet instead of red.
  if (computed === 'NEED_ACTION') return { newPhase: task.phase === 'TODO' ? null : 'TODO', absorbed: true };
  return { newPhase: computed };
}

/** An explicit status write (applyPhase): Need Action or Complete ends the wait. */
export function waitEndsOnStatusChange(
  task: { phase: TaskPhase; waiting?: TaskWaiting | null },
  next: TaskPhase,
): boolean {
  return isTaskWaiting(task) && next !== task.phase && (next === 'NEED_ACTION' || next === 'COMPLETE');
}

/** The same wait record (a re-arm or a new wait replaces `since`). */
export function sameWait(a: TaskWaiting | null | undefined, b: TaskWaiting | null | undefined): boolean {
  return !!a && !!b && a.routine_id === b.routine_id && a.since === b.since;
}

/**
 * A first wait on a trigger that already fired this recently was set too late:
 * the event it waits for was delivered as an ordinary fire (a new trigger's first
 * check runs seconds after trigger_create, before task_wait), and the trigger's
 * dedup will never fire it again.
 */
export const EARLY_FIRE_WINDOW_MS = 60 * 60_000;

/** The record after the wait ended: the routine link stays so a re-arm can reuse it. */
export function endedWait(waiting: TaskWaiting, reason: TaskWakeReason, now = new Date()): TaskWaiting {
  return { ...waiting, woke_at: now.toISOString(), woke_reason: reason };
}

/** The longest condition text kept; it is one line on a card, not a brief. */
export const WAIT_CONDITION_MAX = 300;

/** Normalize the user's condition: one line, trimmed, bounded. Empty = invalid. */
export function normalizeWaitCondition(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const flat = raw.replace(/\s+/g, ' ').trim();
  // cutEnd: never split a surrogate pair (a lone one breaks the phone's decoder).
  return flat.length > WAIT_CONDITION_MAX ? `${flat.slice(0, cutEnd(flat, WAIT_CONDITION_MAX - 1))}…` : flat;
}
