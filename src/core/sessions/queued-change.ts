/**
 * The answer to a person's Edit or Delete on a queued message (the web's
 * `session:edit-queued` / `session:delete-queued`).
 *
 * 2026-11-09, the user: he pressed Delete on a bubble that still read Queued and
 * got a red toast, `RPC handler error for "session:delete-queued": Message not
 * deletable (already processing or not found)`. The row had already gone to the
 * session (or left the queue): that is a state, not an error, so the answer says
 * which one and the bubble says it in place. Only a queue that could not be read
 * or written at all is `unavailable`, and that is logged as a warning, never as
 * the error that a toast shows.
 *
 *   taken        the row is still in the queue but on its way to the CLI (or read
 *                by it): too late to change.
 *   held         the row is marked processing but was never written: it waits
 *                behind an earlier line still being confirmed (line-consumption.ts
 *                heldRows). Not sent; it can be changed once the hold lifts.
 *   gone         the queue no longer has the row (answered and cleared, or removed
 *                elsewhere).
 *   unavailable  the queue did not answer (its file lock timed out, a read failed).
 */
export type QueuedChangeOutcome =
  | { ok: true }
  | { ok: false; outcome: 'taken' | 'held' | 'gone' | 'unavailable'; error?: string };

export interface QueuedChangeDeps {
  /** The queue's own change (deleteMessage / editMessage): false when it refused. */
  change: () => Promise<boolean>;
  /** The session's rows, to say why a refused change was refused. */
  readQueue: () => Promise<ReadonlyArray<{ id: string; status?: string }>>;
  /** Whether the runner holds this row back unwritten (heldRows). */
  isHeld?: (messageId: string) => boolean;
}

/** The reader the queue routes hand queuedChange: a session's own rows, only to tell taken from gone. */
export function queueOf(sessionId: string): () => Promise<ReadonlyArray<{ id: string; status?: string }>> {
  return async () => {
    const { getQueue } = await import('../session-message-queue.js');
    return getQueue(sessionId);
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run the change; on a refusal, read the queue once to say whether the row is taken or gone. */
export async function queuedChange(messageId: string, deps: QueuedChangeDeps): Promise<QueuedChangeOutcome> {
  let changed: boolean;
  try {
    changed = await deps.change();
  } catch (err) {
    return { ok: false, outcome: 'unavailable', error: messageOf(err) };
  }
  if (changed) return { ok: true };
  try {
    const rows = await deps.readQueue();
    if (!rows.some((r) => r.id === messageId)) return { ok: false, outcome: 'gone' };
    return deps.isHeld?.(messageId) ? { ok: false, outcome: 'held' } : { ok: false, outcome: 'taken' };
  } catch (err) {
    return { ok: false, outcome: 'unavailable', error: messageOf(err) };
  }
}
