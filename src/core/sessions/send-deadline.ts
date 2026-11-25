/**
 * The deadline of a send into a session's queue, which never calls a row it stored undelivered.
 *
 * A plain race of the send against a timer answered "delivery timed out, retry" while the send
 * went on and stored its row all the same (2026-11-25: right after a restart, on a slow CI
 * machine, the durable enqueue outlasted the 8 s deadline; POST /api/v1/messages answered 503 and
 * the message was queued and answered anyway, so a retry would have sent it twice).
 *
 * `run` gets `inTime`, the send's gate: pass it as the send's `stillWanted` (sendMessageToSession
 * asks it right before the row is stored). A raw enqueueMessage starts its store at once, so it
 * takes no deadline at all. Until the gate is passed the deadline holds: when the deadline comes
 * first, the gate stays shut, the send stores nothing, and this resolves null, so the caller's
 * "timed out, retry" is true. Once
 * the gate is passed the row is on its way to the disk: the deadline no longer ends the wait, and
 * the send's own outcome (its row, or its error) is the answer. The store bounds itself (the queue
 * lock's own rounds, then the spool: session-queue-store.ts, session-queue-spool.ts).
 *
 * Ratchet: tests/core/sessions/send-deadline.test.ts (no plain timer race around a queue store in src/).
 */
export async function sendWithin<T>(ms: number, run: (inTime: () => boolean) => Promise<T>): Promise<T | null> {
  let state: 'open' | 'committed' | 'expired' = 'open';
  const inTime = (): boolean => {
    if (state === 'expired') return false;
    state = 'committed';
    return true;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      // Committed: the send's own outcome answers; this race never settles.
      if (state === 'committed') return;
      state = 'expired';
      resolve(null);
    }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([run(inTime), expired]);
  } finally {
    clearTimeout(timer);
  }
}
