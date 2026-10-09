/**
 * The dead-letter half of the session message queue (session-message-queue.ts
 * explains why 'parked' exists): parking rows that cannot be delivered, the
 * age backstop, the human Retry that puts one back, and the move of every row
 * to a replacement provider identity. Same store and write chain as the rest of
 * the queue (session-queue-store.ts); callers import it from
 * session-message-queue.ts.
 */

import { log } from '../logging/index.js';
import { compareEnqueueOrder, mutateStore, readQueueFileFresh, type QueuedMessage } from './session-queue-store.js';

/**
 * Age backstop for the parking policy: a pending row this old is parked instead
 * of redelivered, whatever the failure that stranded it looked like.
 *
 * The classifier (providers/delivery-failure.ts) only recognizes the permanent
 * failures we've SEEN. This catches the ones we haven't: a week is far longer
 * than any real outage (the worst measured was ~7 minutes) and far shorter than
 * the 12 days a doomed row actually survived.
 */
export const MAX_PENDING_AGE_MS = 7 * 24 * 60 * 60_000;

/** One greppable line per parked row, shared by both park paths. */
function logParked(rows: QueuedMessage[], reason: string): void {
  for (const m of rows) {
    log.session.warn('message parked: permanent delivery failure', {
      sessionId: m.sessionId, messageId: m.id, reason,
    });
  }
}

/**
 * Dead-letter a batch: 'processing' | 'pending' → 'parked'.
 *
 * Called INSTEAD of revertToPending when delivery failed for a reason that
 * retrying cannot fix (deleted working directory, deleted session record). One
 * structured line per row so the park is greppable.
 *
 * Same NO-LOSS re-insert as revertToPending: a row a concurrent cleanup removed
 * while the batch was in flight is re-inserted (parked), never silently dropped.
 * Note revertToPending only un-sticks rows whose stored status is 'processing',
 * so a later transient revert can never resurrect a parked row.
 */
export async function parkMessages(messages: QueuedMessage[], reason: string, strict = false): Promise<number> {
  if (messages.length === 0) return 0;
  const parkedAt = new Date().toISOString();
  const parked = await mutateStore((s) => {
    const done: QueuedMessage[] = [];
    for (const m of messages) {
      const queue = s.queues[m.sessionId] ?? (s.queues[m.sessionId] = []);
      const existing = queue.find((q) => q.id === m.id);
      const row = existing ?? { ...m };
      if (!existing) {
        queue.push(row);
        queue.sort(compareEnqueueOrder);
      }
      if (row.status === 'parked') continue;
      row.status = 'parked';
      row.parkedAt = parkedAt;
      row.parkedReason = reason;
      done.push(row);
    }
    return done;
  }, strict);
  logParked(parked, reason);
  return parked.length;
}

/**
 * Park the rows still in the queue (never re-inserting a missing one: the CLI
 * took it). `freshLine`: the CLI dropped the line for good, so a Retry must go
 * out as a new line (the old uuid would be skipped as already seen). Returns
 * the rows it parked.
 */
export async function parkIfQueued(
  messages: QueuedMessage[],
  reason: string,
  opts?: { freshLine?: boolean },
): Promise<QueuedMessage[]> {
  if (messages.length === 0) return [];
  const parkedAt = new Date().toISOString();
  const parked = await mutateStore((s) => {
    const done: QueuedMessage[] = [];
    for (const m of messages) {
      const row = s.queues[m.sessionId]?.find((q) => q.id === m.id);
      if (!row || row.status === 'parked') continue;
      row.status = 'parked';
      row.parkedAt = parkedAt;
      row.parkedReason = reason;
      if (opts?.freshLine) { delete row.lineUuid; delete row.lineTries; delete row.lineTracked; delete row.lineInDoubt; }
      done.push({ ...row });
    }
    return done;
  });
  logParked(parked, reason);
  return parked;
}

/**
 * Park every pending row older than maxAgeMs. Run before the two automatic
 * redelivery triggers (startup recovery, daemon reconnect) so a stale row is
 * retired rather than retried; returns the rows it parked.
 *
 * A row whose `enqueuedAt` won't parse is left alone: its age is unknowable, and
 * guessing "ancient" could retire a message that was written seconds ago.
 */
export async function parkStalePending(maxAgeMs = MAX_PENDING_AGE_MS): Promise<QueuedMessage[]> {
  const cutoff = Date.now() - maxAgeMs;
  const isStale = (m: QueuedMessage): boolean => {
    if (m.status !== 'pending') return false;
    const at = Date.parse(m.enqueuedAt);
    return !Number.isNaN(at) && at <= cutoff;
  };
  // Cheap fresh read first. This runs on every boot AND every daemon reconnect,
  // and the answer is almost always "nothing stale": no file lock, no rewrite.
  const peek = await readQueueFileFresh();
  if (!Object.values(peek.queues).some((msgs) => msgs.some(isStale))) return [];

  const reason = `undelivered for over ${Math.round(maxAgeMs / 86_400_000)} days`;
  const parkedAt = new Date().toISOString();
  // One atomic pass that flips IN PLACE, deliberately not parkMessages(), whose
  // no-loss re-insert would resurrect a row that got delivered since the peek.
  const parked = await mutateStore((s) => {
    const done: QueuedMessage[] = [];
    for (const msgs of Object.values(s.queues)) {
      for (const m of msgs) {
        if (!isStale(m)) continue;
        m.status = 'parked';
        m.parkedAt = parkedAt;
        m.parkedReason = reason;
        done.push(m);
      }
    }
    return done;
  });
  logParked(parked, reason);
  return parked;
}

/**
 * Put a parked row back in line. EXPLICIT HUMAN ACTION ONLY (the Retry
 * affordance). Returns true when a parked row was un-parked; false when the row
 * is absent or in a status the caller shouldn't disturb.
 *
 * The caller still has to trigger a delivery attempt (processNext); this only
 * makes the row eligible again.
 */
export async function unparkMessage(sessionId: string, messageId: string): Promise<boolean> {
  const { sessionStops } = await import('./sessions/session-stop.js');
  const stopFence = await sessionStops.fence(sessionId);
  const ok = await mutateStore((s) => {
    const msg = s.queues[sessionId]?.find((m) => m.id === messageId);
    if (!msg || msg.status !== 'parked') return false;
    if (stopFence) msg.stopFence = stopFence;
    else delete msg.stopFence;
    msg.status = 'pending';
    delete msg.parkedAt;
    delete msg.parkedReason;
    return true;
  });
  if (ok) log.session.info('parked message un-parked by user action', { sessionId, messageId });
  return ok;
}

export interface SessionQueueMigration {
  movedIds: string[];
}

/**
 * Move every durable queue row to a replacement provider identity.
 *
 * The queue write must commit before an ACP identity redirect is deleted.
 * Stable message IDs survive the move, so worker command-id dedup still gives
 * exactly-once provider submission after a crash resets `processing` rows.
 */
export async function migrateSessionQueue(
  oldSessionId: string,
  newSessionId: string,
): Promise<SessionQueueMigration> {
  if (oldSessionId === newSessionId) return { movedIds: [] };
  // strict mutateStore: a failed persist throws WITHOUT committing the fresh
  // copy or the cache, so no in-memory compensation is needed on error.
  const movedIds = await mutateStore((s) => {
    const source = s.queues[oldSessionId] ?? [];
    if (source.length === 0) return [];

    const target = s.queues[newSessionId] ?? [];
    const existingIds = new Set(target.map((message) => message.id));
    const moved = source
      .filter((message) => !existingIds.has(message.id))
      .map((message) => ({ ...message, sessionId: newSessionId }));

    s.queues[newSessionId] = [...target, ...moved]
      .sort(compareEnqueueOrder);
    delete s.queues[oldSessionId];
    return moved.map((message) => message.id);
  }, true);
  if (movedIds.length === 0) return { movedIds: [] };
  log.session.info('session message queue identity migrated', {
    oldSessionId,
    newSessionId,
    movedCount: movedIds.length,
  });
  return { movedIds };
}

/**
 * Compensate a staged identity migration that failed after its queue move.
 * Target messages that predated the migration are left untouched.
 */
export async function rollbackSessionQueueMigration(
  oldSessionId: string,
  newSessionId: string,
  movedIds: string[],
): Promise<void> {
  if (oldSessionId === newSessionId || movedIds.length === 0) return;
  // strict mutateStore: a failed persist throws without committing anywhere,
  // so the old hand-rolled in-memory compensation is no longer needed.
  await mutateStore((s) => {
    const target = s.queues[newSessionId] ?? [];
    const movedSet = new Set(movedIds);
    const returning = target
      .filter((message) => movedSet.has(message.id))
      .map((message) => ({ ...message, sessionId: oldSessionId }));
    if (returning.length === 0) return;

    const source = s.queues[oldSessionId] ?? [];
    const sourceIds = new Set(source.map((message) => message.id));
    s.queues[oldSessionId] = [
      ...source,
      ...returning.filter((message) => !sourceIds.has(message.id)),
    ].sort(compareEnqueueOrder);
    const remaining = target.filter((message) => !movedSet.has(message.id));
    if (remaining.length > 0) s.queues[newSessionId] = remaining;
    else delete s.queues[newSessionId];
  }, true);
}
