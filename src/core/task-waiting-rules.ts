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
 *   - the session is blocked on a human decision: that needs the human now;
 *   - someone set the status to Need Action or Complete. In Progress does NOT end
 *     it: a session turn on a waiting task is In Progress too (the one that set
 *     the wait, a session start), and an automated start must not cancel a wait;
 *   - the trigger fired or kept failing (task-waiting.ts, the side-effect half);
 *   - the backstop passed (`until`, 'timed-out'): a trigger that never fires,
 *     because its script is wrong or its host is gone, must not park a task
 *     forever, so every wait has a time after which the task comes back.
 *
 * A message (a human's or a peer's) does NOT end it (user call 2026-09-29): the
 * turn it starts runs, and its end lands on the quiet TODO like any other. The
 * web session panel tells the human the snooze still holds, with Unsnooze, and
 * the session ends or changes the wait itself when the message asks for that.
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
 * the unconditional machine would do (phase.ts).
 */
export function waitingSessionPhase(
  task: { phase: TaskPhase; waiting?: TaskWaiting | null },
  trigger: string,
  computed: TaskPhase | null,
): WaitingPhaseDecision {
  if (!isTaskWaiting(task)) return { newPhase: computed };
  if (trigger === 'session:awaiting-human') return { newPhase: computed, wake: 'needs-human' };
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

/** The backstop when the caller gives none: a week of silence is worth a look. */
export const WAIT_TTL_DEFAULT_MS = 7 * 24 * 3_600_000;
export const WAIT_TTL_MIN_MS = 60_000;
export const WAIT_TTL_MAX_MS = 30 * 24 * 3_600_000;

/**
 * A backstop duration: milliseconds, or "90m" / "12h" / "3d". Undefined when
 * absent (the caller picks the default); null when present but unreadable or
 * out of range, so a typo is an error instead of a silent week.
 */
export function parseWaitTtlMs(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  let ms: number | null = null;
  if (typeof raw === 'number' && Number.isFinite(raw)) ms = raw;
  else if (typeof raw === 'string') {
    const m = raw.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/);
    if (m) {
      const n = Number(m[1]);
      const unit = m[2][0];
      ms = unit === 'm' ? n * 60_000 : unit === 'h' ? n * 3_600_000 : n * 24 * 3_600_000;
    }
  }
  if (ms === null || ms < WAIT_TTL_MIN_MS || ms > WAIT_TTL_MAX_MS) return null;
  return Math.round(ms);
}

/** The error text for an unreadable backstop. */
export const WAIT_TTL_ERROR =
  'the backstop (ttl) must be a duration from 1 minute to 30 days, like "90m", "12h" or "3d"';

/**
 * Where a (re-)armed wait's backstop lands. A given ttl counts from now. With
 * none, a re-arm keeps the backstop it had while that is still ahead (the fire
 * was an intermediate stage, not a new wait); otherwise the default.
 */
export function waitUntilAt(now: Date, ttlMs: number | undefined, previous?: TaskWaiting | null): string {
  if (ttlMs !== undefined) return new Date(now.getTime() + ttlMs).toISOString();
  const kept = previous?.until ? Date.parse(previous.until) : NaN;
  if (Number.isFinite(kept) && kept > now.getTime()) return previous!.until!;
  return new Date(now.getTime() + WAIT_TTL_DEFAULT_MS).toISOString();
}

/** A live wait whose backstop has passed. */
export function waitTimedOut(task: { waiting?: TaskWaiting | null; phase?: string }, nowMs: number): boolean {
  if (!isTaskWaiting(task) || !task.waiting?.until) return false;
  const at = Date.parse(task.waiting.until);
  return Number.isFinite(at) && at <= nowMs;
}
