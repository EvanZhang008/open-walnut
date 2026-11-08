/**
 * The time a queued row was held where no delivery could take it, kept on the
 * row so its delivery wait leaves it out (providers/delivery-latency.ts).
 *
 * 2026-11-12, the send.resume health alarm at 6,926 s: a message to a task that
 * was moving to clouddev waited, parked under MOVE_HELD_REASON, from 15:12 to
 * 17:07 while four deploys cut the move short and it then failed; the resume
 * that delivered it took one second. A parked row is never delivered by itself
 * (a move, the end of a running turn, start recovery, a Stop, a dead letter
 * waiting for Retry), and a row a move takes out of the queue is in no queue at
 * all: neither wait is the delivery path's.
 *
 * Not left out: a start-recovery hold (START_RECOVERY_HELD_REASON). Its rows wait
 * for Walnut to start the session again after a start died, which is the resume
 * path's own retry.
 *
 * Every park goes through parkRow (a row parked again keeps its earlier hold),
 * every way a row leaves `parked` goes through leaveParked/leftParked, and a row
 * a move takes out of the queue is stamped `takenAt` and closed by closeTaken
 * when it is put back (tests/core/queue-held-spans-guard.test.ts holds both).
 * The spans ride the queue file, so a hold across a restart is kept. Older
 * Walnut versions ignore the field.
 */

import type { QueuedMessage } from './session-queue-store.js';
import { START_RECOVERY_HELD_REASON } from './relay-fates.js';

export interface HeldSpan { start: number; end: number }

/** The most spans a row keeps (newest last): a row is held a handful of times at most. */
export const HELD_SPANS_MAX = 16;

type Holdable = Pick<QueuedMessage, 'heldSpans'>;

function withSpan(spans: HeldSpan[] | undefined, start: number, end: number): HeldSpan[] | undefined {
  if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) return spans;
  const out = [...(spans ?? []), { start, end }];
  return out.length > HELD_SPANS_MAX ? out.slice(-HELD_SPANS_MAX) : out;
}

/** Record that `row` was held from `start` to `end` (ms), in place. */
export function addHeldSpan(row: Holdable, start: number, end: number): void {
  const next = withSpan(row.heldSpans, start, end);
  if (next) row.heldSpans = next;
}

/** Record the time `row` has been parked so far, unless its hold is the resume path's own. */
function recordParked(row: QueuedMessage, now: number): void {
  if (!row.parkedAt || row.parkedReason === START_RECOVERY_HELD_REASON) return;
  addHeldSpan(row, Date.parse(row.parkedAt), now);
}

/** Park `row` under `reason` at `at`, in place. A row parked already keeps its earlier hold. */
export function parkRow(row: QueuedMessage, reason: string, at: string = new Date().toISOString()): void {
  if (row.status === 'parked') recordParked(row, Date.parse(at));
  row.status = 'parked';
  row.parkedAt = at;
  row.parkedReason = reason;
}

/** A parked row becomes deliverable: its parked time is recorded and the park fields go, in place. */
export function leaveParked(row: QueuedMessage, now: number = Date.now()): void {
  recordParked(row, now);
  delete row.parkedAt;
  delete row.parkedReason;
  // What an agent-wait park waited on (QueuedMessage.waitsFor) goes with the park.
  delete row.waitsFor;
}

/** The same as leaveParked, on a copy. */
export function leftParked<T extends QueuedMessage>(row: T, now: number = Date.now()): T {
  const copy = { ...row };
  leaveParked(copy, now);
  return copy;
}

/** A row a move takes out of its queue: from now it waits outside any queue. */
export function stampTaken(row: QueuedMessage, now: number = Date.now()): void {
  if (row.takenAt === undefined) row.takenAt = now;
}

/** A taken row goes back into a queue: the time out of it is recorded (on a copy). */
export function closeTaken<T extends QueuedMessage>(row: T, now: number = Date.now()): T {
  if (row.takenAt === undefined) return row;
  const { takenAt, ...rest } = row;
  const copy = rest as T;
  addHeldSpan(copy, takenAt, now);
  return copy;
}
