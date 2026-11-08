/**
 * The dead-letter half of the session message queue (session-message-queue.ts
 * explains why 'parked' exists): parking rows that cannot be delivered, the
 * age backstop, the human Retry that puts one back, and the move of every row
 * to a replacement provider identity. Same store and write chain as the rest of
 * the queue (session-queue-store.ts); callers import it from
 * session-message-queue.ts.
 */

import { randomUUID } from 'node:crypto';
import { log } from '../logging/index.js';
import { compareEnqueueOrder, mutateStore, readQueueFileFresh, type QueuedMessage } from './session-queue-store.js';
import { AFTER_TURN_REASON, START_RECOVERY_HELD_REASON, STOP_PARKED_REASON } from './relay-fates.js';
import { leaveParked, parkRow } from './queue-held-spans.js';

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

/**
 * One greppable line per parked row, shared by every park path, and the askers
 * told: a parked peer ask will never be read, so its request is settled now
 * with the reason (sessions/undelivered-requests.ts), off the store's write chain.
 */
function logParked(rows: QueuedMessage[], reason: string): void {
  for (const m of rows) {
    log.session.warn('message parked: permanent delivery failure', {
      sessionId: m.sessionId, messageId: m.id, reason,
    });
  }
  if (rows.length === 0) return;
  const parked = rows.map((m) => ({ ...m, parkedReason: m.parkedReason ?? reason }));
  void import('./sessions/undelivered-requests.js')
    .then(({ notifyParkedRequests }) => notifyParkedRequests(parked))
    .catch(() => {});
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
/**
 * Why a batch parks: the words, and (a delivery verdict's `waitsFor`) the readiness kind
 * a row waits on when the agent cannot run yet, so Walnut sends it once the host can.
 * Callers holding a verdict pass the verdict itself, never only its `reason`
 * (tests/core/sessions/agent-wait-resend-guard.test.ts).
 */
export type ParkCause = string | { reason: string; waitsFor?: string };

export async function parkMessages(messages: QueuedMessage[], cause: ParkCause, strict = false): Promise<number> {
  if (messages.length === 0) return 0;
  const reason = typeof cause === 'string' ? cause : cause.reason;
  const waitsFor = typeof cause === 'string' ? undefined : cause.waitsFor;
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
      parkRow(row, reason, parkedAt);
      if (waitsFor) row.waitsFor = waitsFor;
      else delete row.waitsFor;
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
 * the rows it parked. `transcribed` (with freshLine): the CLI's transcript holds
 * the line (it took it and never answered, line-answer-v1), so even a row with
 * a pre-assigned userUuid goes out under a new uuid: under its own, Claude Code
 * would skip the Retry as a duplicate and ack it `completed`, never running it.
 */
export async function parkIfQueued(
  messages: QueuedMessage[],
  reason: string,
  opts?: { freshLine?: boolean; transcribed?: boolean; onlyPending?: boolean },
): Promise<QueuedMessage[]> {
  if (messages.length === 0) return [];
  const parkedAt = new Date().toISOString();
  const parked = await mutateStore((s) => {
    const done: QueuedMessage[] = [];
    for (const m of messages) {
      const row = s.queues[m.sessionId]?.find((q) => q.id === m.id);
      if (!row || row.status === 'parked') continue;
      // Checked under the lock: a row a delivery took meanwhile is the CLI's now.
      if (opts?.onlyPending && row.status !== 'pending') continue;
      parkRow(row, reason, parkedAt);
      if (opts?.freshLine) {
        // Plain rows derive their UUID from the unchanged id unless a fresh one is kept.
        if (!row.userUuid || opts.transcribed) {
          row.lineUuid = randomUUID();
          row.lineTries = 0;
        } else {
          delete row.lineUuid;
          delete row.lineTries;
        }
        delete row.lineTracked;
        delete row.lineInDoubt;
      }
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
        parkRow(m, reason, parkedAt);
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
    // A Retry of a line Claude Code took and never answered gets its one resend again.
    delete msg.unansweredResent;
    if (!msg.lineUuid && !msg.userUuid) {
      msg.lineUuid = randomUUID();
      msg.lineTries = 0;
    }
    leaveParked(msg);
    return true;
  });
  if (ok) log.session.info('parked message un-parked by user action', { sessionId, messageId });
  return ok;
}

/**
 * The agent can run on the session's host now: the rows parked only for that
 * (`waitsFor`) go back in line, as a Retry would put them (sessions/agent-wait-resend.ts).
 * Never a row parked for anything else, and never one a Stop came after: a row whose
 * stop fence is not the session's current one stays parked for the person (their Stop
 * wins), and a deleted row is gone. `onlyWithPending`: only when another row of the
 * session is going out now (it rides ahead of it, in its own order). Returns the ids.
 */
export async function unparkAgentWaitRows(
  sessionId: string, stopFence: string | null, opts?: { onlyWithPending?: boolean },
): Promise<string[]> {
  const ids = await mutateStore((s) => {
    const queue = s.queues[sessionId];
    if (!queue) return [] as string[];
    if (opts?.onlyWithPending && !queue.some((m) => m.status === 'pending')) return [] as string[];
    const done: string[] = [];
    for (const msg of queue) {
      if (msg.status !== 'parked' || !msg.waitsFor) continue;
      if ((msg.stopFence ?? null) !== stopFence) continue;
      msg.status = 'pending';
      delete msg.unansweredResent;
      if (!msg.lineUuid && !msg.userUuid) {
        msg.lineUuid = randomUUID();
        msg.lineTries = 0;
      }
      leaveParked(msg);
      done.push(msg.id);
    }
    return done;
  });
  if (ids.length > 0) log.session.info('parked messages sent again: the agent can run now', { sessionId, messageIds: ids });
  return ids;
}

/**
 * Start recovery (sessions/start-recovery.ts): a session's process ended before it
 * read these rows (killed while it booted, or its start never reached its host).
 * They wait here, unchanged (id, source, uuid, request), until restart recovery
 * starts the session again and releases them, or gives up and parks them for a
 * Retry. Not a delivery failure, so no asker is told. 2026-11-05: the first
 * version sent a copy of the text instead, which lost it on every path that did
 * not send and turned the user's own words into Walnut's.
 */
export { START_RECOVERY_HELD_REASON };

/** Hold `rows` for start recovery (re-inserting any a cleanup removed meanwhile). Returns the ids held. */
export async function holdForStartRecovery(rows: QueuedMessage[]): Promise<string[]> {
  if (rows.length === 0) return [];
  const parkedAt = new Date().toISOString();
  const held = await mutateStore((s) => {
    const ids: string[] = [];
    for (const m of rows) {
      const queue = s.queues[m.sessionId] ?? (s.queues[m.sessionId] = []);
      let row = queue.find((q) => q.id === m.id);
      if (!row) {
        row = { ...m };
        queue.push(row);
        queue.sort(compareEnqueueOrder);
      }
      if (row.status === 'parked' && row.parkedReason !== START_RECOVERY_HELD_REASON) continue;
      parkRow(row, START_RECOVERY_HELD_REASON, parkedAt);
      ids.push(row.id);
    }
    return ids;
  });
  if (held.length > 0) log.session.info('rows held for start recovery', { sessionId: rows[0].sessionId, messageIds: held });
  return held;
}

/** The rows of a session held for start recovery. */
export async function startRecoveryHeld(sessionId: string): Promise<QueuedMessage[]> {
  const peek = await readQueueFileFresh();
  return (peek.queues[sessionId] ?? []).filter((r) => r.status === 'parked' && r.parkedReason === START_RECOVERY_HELD_REASON);
}

/** Sessions that hold rows for start recovery (a restart's leftovers). */
export async function sessionsWithStartRecoveryHeld(): Promise<string[]> {
  const peek = await readQueueFileFresh();
  return Object.entries(peek.queues)
    .filter(([, rows]) => rows.some((r) => r.status === 'parked' && r.parkedReason === START_RECOVERY_HELD_REASON))
    .map(([sid]) => sid);
}

/**
 * End a start recovery hold: `deliver` puts the rows back to pending, as they were
 * (the caller kicks the delivery); a `park` reason dead-letters them for a Retry and
 * tells their askers. Returns the ids it moved.
 */
/**
 * Rows a start death holds that its process read after all (its init came after its
 * exit): they ran, so they leave the queue. A row already put back to pending by a
 * racing settle goes too; one being written (processing) is the delivery's.
 */
export async function removeStartRecoveryRows(sessionId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const removed = await mutateStore((s) => {
    const queue = s.queues[sessionId];
    if (!queue) return [] as string[];
    const gone = (r: QueuedMessage) => ids.includes(r.id)
      && (r.status === 'pending' || (r.status === 'parked' && r.parkedReason === START_RECOVERY_HELD_REASON));
    const out = queue.filter(gone).map((r) => r.id);
    s.queues[sessionId] = queue.filter((r) => !gone(r));
    if (s.queues[sessionId].length === 0) delete s.queues[sessionId];
    return out;
  });
  if (removed.length > 0) log.session.info('start recovery: rows its process read after all left the queue', { sessionId, messageIds: removed });
  return removed;
}

export async function settleStartRecoveryHeld(sessionId: string, how: 'deliver' | { park: string }): Promise<string[]> {
  const rows = await startRecoveryHeld(sessionId);
  if (rows.length === 0) return [];
  if (how !== 'deliver') {
    const ids = rows.map((r) => r.id);
    const parkedAt = new Date().toISOString();
    const parked = await mutateStore((s) => {
      const done: QueuedMessage[] = [];
      for (const row of s.queues[sessionId] ?? []) {
        if (!ids.includes(row.id) || row.status !== 'parked' || row.parkedReason !== START_RECOVERY_HELD_REASON) continue;
        parkRow(row, how.park, parkedAt);
        done.push(row);
      }
      return done;
    });
    logParked(parked, how.park);
    return parked.map((r) => r.id);
  }
  const moved = await mutateStore((s) => {
    const ids: string[] = [];
    for (const row of s.queues[sessionId] ?? []) {
      if (row.status !== 'parked' || row.parkedReason !== START_RECOVERY_HELD_REASON) continue;
      row.status = 'pending';
      leaveParked(row);
      ids.push(row.id);
    }
    return ids;
  });
  if (moved.length > 0) log.session.info('rows held for start recovery released', { sessionId, messageIds: moved });
  return moved;
}

/**
 * Rows lined up for after the running turn that a Stop came ahead of: parked under the
 * stop's reason, like every other row a stop sets aside. With `keepFence` given (even
 * null), only the rows queued before the latest stop are set aside.
 */
export async function setAsideHeld(sessionId: string, keepFence?: string | null): Promise<number> {
  const parkedAt = new Date().toISOString();
  const n = await mutateStore((s) => {
    let count = 0;
    for (const row of s.queues[sessionId] ?? []) {
      if (row.status !== 'parked' || row.parkedReason !== AFTER_TURN_REASON) continue;
      if (keepFence !== undefined && (row.stopFence ?? null) === keepFence) continue;
      parkRow(row, STOP_PARKED_REASON, parkedAt);
      count++;
    }
    return count;
  });
  if (n > 0) log.session.info('rows held for the turn end set aside by a stop', { sessionId, count: n });
  return n;
}

/** Sessions that still hold a row lined up for after a turn (a restart's leftovers). */
export async function sessionsWithHeld(): Promise<string[]> {
  const peek = await readQueueFileFresh();
  return Object.entries(peek.queues)
    .filter(([, rows]) => rows.some((r) => r.status === 'parked' && r.parkedReason === AFTER_TURN_REASON))
    .map(([sid]) => sid);
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

/** Sessions holding a row parked only because the agent could not run (QueuedMessage.waitsFor). */
export async function sessionsWithAgentWaitRows(): Promise<string[]> {
  const store = await readQueueFileFresh();
  return Object.entries(store.queues)
    .filter(([, rows]) => rows.some((m) => m.status === 'parked' && !!m.waitsFor))
    .map(([sid]) => sid);
}
