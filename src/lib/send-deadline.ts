/**
 * The deadline of a send into a session's queue, which never calls a row it stored undelivered.
 *
 * A plain race of the send against a timer answered "delivery timed out, retry" while the send
 * went on and stored its row all the same (2026-11-25: right after a restart, on a slow CI
 * machine, the durable enqueue outlasted the 8 s deadline; POST /api/v1/messages answered 503 and
 * the message was queued and answered anyway, so a retry would have sent it twice).
 *
 * Only a caller that sends again on a timeout takes a deadline (an API client told "retry", a
 * letter answer recorded failed, a trigger fire replayed). A notice nobody sends again takes none:
 * a deadline would drop it where, without one, it is stored late and still delivered.
 *
 * `run` gets the send's gate. `inTime` is the send's `stillWanted` (sendMessageToSession asks it
 * right before the row is stored); `stored` is its `onStored`. Until the gate is passed the
 * deadline holds: when the deadline comes first, the gate stays shut, the send stores nothing,
 * and the outcome is `timed_out`, so a retry is safe. Once the gate is passed the row is on its
 * way to the disk and the deadline no longer ends the send:
 * - the send finishes: `sent`, with its value;
 * - past the deadline, its row is stored while the rest of the send still runs: `stored` at once
 *   (the notes, hints and emits after the store never hold the answer);
 * - past the deadline, the store itself has not ended within `storeBoundMs`: `unconfirmed`. The
 *   row may still land, so its sender must not send it again. `storeBoundMs: null` waits for the
 *   store's own end instead (a caller whose own wait is bounded elsewhere and tracks the attempt).
 * A raw enqueueMessage starts its store at once, so it takes no deadline at all.
 *
 * Ratchet: tests/lib/send-deadline.test.ts.
 */

export type SendOutcome<T> =
  | { status: 'sent'; value: T }
  | { status: 'stored' }
  | { status: 'timed_out' }
  | { status: 'unconfirmed' };

export interface SendGate {
  /** The send's stillWanted: true commits the send (its row goes to the disk), false once the deadline passed. */
  inTime: () => boolean;
  /** The send's onStored: its row is on the disk (it commits the send, if inTime was not asked). */
  stored: () => void;
}

/**
 * How long, past the deadline, a store under way may take before its send is `unconfirmed`:
 * beyond the queue lock's own rounds (session-queue-store.ts LOCK_ATTEMPTS, 6 of 10 s each).
 */
export const STORE_BOUND_MS = 90_000;

export function sendWithin<T>(
  ms: number,
  run: (gate: SendGate) => Promise<T>,
  opts: { storeBoundMs?: number | null; onLateError?: (err: unknown) => void } = {},
): Promise<SendOutcome<T>> {
  return new Promise<SendOutcome<T>>((resolve, reject) => {
    let phase: 'open' | 'committed' | 'expired' = 'open';
    let rowStored = false;
    let late = false;
    let settled = false;
    let bound: ReturnType<typeof setTimeout> | undefined;
    const finish = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(bound);
      return true;
    };
    const settle = (outcome: SendOutcome<T>): void => { if (finish()) resolve(outcome); };
    const gate: SendGate = {
      inTime: () => {
        if (phase === 'expired') return false;
        phase = 'committed';
        return true;
      },
      stored: () => {
        // On the disk is past the gate too (a send whose work went out without asking it).
        if (phase === 'open') phase = 'committed';
        rowStored = true;
        if (late) settle({ status: 'stored' });
      },
    };
    const deadline = setTimeout(() => {
      if (phase === 'open') {
        phase = 'expired';
        settle({ status: 'timed_out' });
        return;
      }
      late = true;
      if (rowStored) { settle({ status: 'stored' }); return; }
      if (opts.storeBoundMs === null) return;
      bound = setTimeout(() => settle({ status: 'unconfirmed' }), opts.storeBoundMs ?? STORE_BOUND_MS);
      bound.unref?.();
    }, ms);
    deadline.unref?.();
    let sending: Promise<T>;
    try { sending = run(gate); } catch (err) { sending = Promise.reject(err); }
    sending.then(
      (value) => settle({ status: 'sent', value }),
      (err) => {
        if (finish()) reject(err);
        else opts.onLateError?.(err);
      },
    );
  });
}
