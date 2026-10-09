/**
 * Persistent message queue for Claude Code session chat.
 *
 * Messages are persisted to disk so they survive server restarts.
 * Uses atomic writes (temp file + rename) via writeJsonFile.
 *
 * Message lifecycle:
 *   enqueue()        → status: 'pending'     (on disk, editable)
 *   markProcessing() → status: 'processing'  (on disk, locked)
 *   removeProcessed()→ removed from disk      (now in JSONL history)
 *   parkMessages()   → status: 'parked'      (on disk, NEVER auto-redelivered)
 *
 * ## Why 'parked' exists (the dead-letter state)
 *
 * A pending row is retried forever: on every server boot (startup recovery) and
 * on every daemon reconnect. That is right for a transient failure (host asleep,
 * ssh down) and catastrophic for a permanent one. Observed: user messages sat
 * pending for 12 DAYS targeting sessions whose cwd had been deleted, so each
 * boot/reconnect ran the same doomed cycle — redeliver → cwd pre-flight aborts
 * the spawn → revert to pending — and published two error notifications per
 * session per cycle. Every deploy lit up the Errors rail with the same 12-day-old
 * failure.
 *
 * Parking ends that loop AT THE SOURCE: the row stays on disk and visible, but no
 * automatic trigger will ever pick it up again. Only an explicit human action
 * (unparkMessage, from Retry) puts it back in line, or deleteMessage discards it.
 */

import fs from 'node:fs/promises';
import { withFileLock } from '../utils/file-lock.js';
import { SESSION_QUEUE_FILE } from '../constants.js';
import { log } from '../logging/index.js';
import { lineUuidFor, splitBatchAtUuid } from '../providers/batch-uuid.js';
import {
  fateOf, isPhoneMessageId, noteDelivered, setFate, withdrawIn, STOP_PARKED_REASON,
  type RelayFate, type WithdrawState,
} from './relay-fates.js';
import {
  compareEnqueueOrder, generateId, getStore, mutateStore, nextEnqueueSeq, resetCache,
  type QueuedMessage, type QueueStore,
} from './session-queue-store.js';
import { noteSettledLine, settledLineUuid } from './session-queue-lines.js';

// ── Types and store (session-queue-store.ts) ──

export type { MessageStatus, QueuedMessage } from './session-queue-store.js';
export { resetCache } from './session-queue-store.js';
// The dead-letter API and the identity move (session-queue-park.ts), re-exported: callers know one module.
export {
  MAX_PENDING_AGE_MS, parkIfQueued, parkMessages, parkStalePending, unparkMessage,
  migrateSessionQueue, rollbackSessionQueueMigration, type SessionQueueMigration,
} from './session-queue-park.js';
// The lines that went out (session-queue-lines.ts): rows the CLI took, rows put back unconfirmed.
export { removeTaken, revertIfQueued, settledLineUuid } from './session-queue-lines.js';

// ── Public API ──

/**
 * Load the queue from disk into memory. Call once at startup.
 * Resets any 'processing' messages back to 'pending' (crash recovery). A row
 * keeps its `lineUuid` and `lineTries`, so its next delivery goes out alone
 * under the same uuid and asks the daemon first: a line a live CLI already holds
 * is not written to it again.
 */
export async function loadQueue(): Promise<void> {
  resetCache(); // force re-read from disk
  const changed = await mutateStore((s) => {
    let dirty = false;
    for (const [, msgs] of Object.entries(s.queues)) {
      for (const msg of msgs) {
        if (msg.status === 'processing') {
          msg.status = 'pending';
          // The server died mid-delivery: the line may be in a CLI (QueuedMessage.lineInDoubt).
          if (msg.lineUuid) msg.lineInDoubt = true;
          dirty = true;
        }
      }
    }
    return dirty;
  });
  if (changed) {
    log.session.info('reset processing messages to pending after restart');
  }
}

/**
 * Enqueue a message for a session. Persists immediately.
 * Returns the queued message (with generated ID).
 *
 * `opts.id` — caller-supplied stable message id (e.g. the cloud relay's
 * `qm-mobile-*`). IDEMPOTENT: if a row with this id is already queued for the
 * session, that row is returned unchanged instead of enqueuing a duplicate.
 * This is the exactly-once anchor for phone sends: a bridge-relay replay (the
 * daemon died after the primary enqueued but before the ack reached the
 * phone, so the phone retried) collapses onto the original row, and queue
 * redelivery after a daemon respawn delivers it once.
 */
export async function enqueueMessage(
  sessionId: string,
  message: string,
  opts?: { id?: string; userUuid?: string; stopFence?: string | null; relayTaken?: boolean; lineUuid?: string },
): Promise<QueuedMessage> {
  const { sessionStops, SessionStopSupersededError } = await import('./sessions/session-stop.js');
  const stopFence = await sessionStops.fence(sessionId);
  if (opts?.stopFence !== undefined && opts.stopFence !== stopFence) {
    throw new SessionStopSupersededError('Message predates the latest stop; send a new message to continue');
  }
  // A resend of a message that already went out (a Retry, the phone's same-id
  // resend) keeps that line's uuid: the CLI then skips it if it already ran it.
  const inherited = opts?.lineUuid ?? (opts?.id ? await settledLineUuid(opts.id) : undefined);
  const msg: QueuedMessage = {
    id: opts?.id ?? generateId(),
    ...(stopFence ? { stopFence } : {}),
    sessionId,
    message,
    status: 'pending',
    enqueuedAt: new Date().toISOString(),
    seq: nextEnqueueSeq(),
    // Additive: absent ⇒ the key never lands on the row, so an old-shaped row and
    // a new-shaped one are byte-identical on disk.
    ...(opts?.userUuid ? { userUuid: opts.userUuid } : {}),
    ...(inherited ? { lineUuid: inherited, lineTries: 1 } : {}),
  };
  const outcome = await mutateStore((s) => {
    if (!s.queues[sessionId]) {
      s.queues[sessionId] = [];
    }
    // A phone message the companion relayed: its fate is written with its row.
    if (opts?.relayTaken && opts.id) setFate(s, opts.id, 'taken');
    if (opts?.id) {
      const existing = s.queues[sessionId].find((m) => m.id === opts.id);
      if (existing) return { queueDepth: s.queues[sessionId].length, existing };
    }
    s.queues[sessionId].push(msg);
    return { queueDepth: s.queues[sessionId].length, existing: null };
  }, false, opts?.relayTaken === true);
  if (outcome.existing) {
    log.session.info('message enqueue deduped by id (already queued)', {
      sessionId, messageId: outcome.existing.id, queueDepth: outcome.queueDepth,
    });
    return outcome.existing;
  }
  log.session.info('message enqueued', { sessionId, messageId: msg.id, queueDepth: outcome.queueDepth });
  return msg;
}

/**
 * Enqueue a message AND notify session-runner + UI in one call.
 * This is the preferred entry point for sending messages to sessions.
 * Callers should use this instead of manually emitting SESSION_SEND + SESSION_MESSAGE_QUEUED.
 *
 * @param opts.source - identifies who sent the message (e.g. 'ui', 'agent', 'phase-hook')
 * @param opts.taskId - optional task ID associated with the session
 * @param opts.mode - optional permission mode override for the session
 * @param opts.interrupt - if true, interrupt the current turn before sending
 * @param opts.enqueueMessage - if provided, enqueue this text (may include image refs);
 *   the original `message` is used for bus events (UI display). Defaults to `message`.
 * @param opts.messageId - caller-supplied stable id (cloud relay `qm-mobile-*`).
 *   Idempotent: a duplicate id collapses onto the already-queued row (see
 *   enqueueMessage) so bridge replays / phone retries can't double-deliver.
 * @param opts.userUuid - pre-assigned v4 uuid for the CLI's user line (see
 *   QueuedMessage.userUuid). Optional; absent changes nothing.
 */
export async function sendMessageToSession(
  sessionId: string,
  message: string,
  opts?: {
    source?: string;
    taskId?: string;
    mode?: string;
    interrupt?: boolean;
    enqueueMessage?: string;
    messageId?: string;
    userUuid?: string;
    stopFence?: string | null;
    /** A phone message relayed by the companion (DaemonConnection): its fate goes with its row. */
    relayTaken?: boolean;
    /** A resend of a line that already went out keeps its uuid (see QueuedMessage.lineUuid). */
    lineUuid?: string;
  },
): Promise<QueuedMessage> {
  const { bus, EventNames } = await import('./event-bus.js');
  const msg = await enqueueMessage(sessionId, opts?.enqueueMessage ?? message, {
    id: opts?.messageId,
    ...(opts?.stopFence !== undefined ? { stopFence: opts.stopFence } : {}),
    ...(opts?.userUuid ? { userUuid: opts.userUuid } : {}),
    ...(opts?.relayTaken ? { relayTaken: true } : {}),
    ...(opts?.lineUuid ? { lineUuid: opts.lineUuid } : {}),
  });
  const source = opts?.source ?? 'unknown';

  // Ask Walnut drift repair — AWAITED before SESSION_SEND is emitted, because
  // the record profile is consumed exactly when this send triggers a cold
  // --resume (resolveResumeArgs); a fire-and-forget would lose that race and
  // ship the stale persona one more spawn. Cheap by construction: an ordinary
  // session pays one indexed record read and early-returns; only a real
  // Ask-Walnut session rebuilds, at most once per TTL. Never fails a send —
  // the helper catches everything internally.
  try {
    const { refreshWalnutSessionProfile } = await import('./sessions/personal-ai-lane.js');
    await refreshWalnutSessionProfile(sessionId);
  } catch { /* stale persona until next attempt */ }

  // Tell session-runner to process the queued message
  bus.emit(EventNames.SESSION_SEND, {
    sessionId,
    taskId: opts?.taskId,
    message,
    mode: opts?.mode,
    interrupt: opts?.interrupt || undefined,
  }, ['session-runner'], { source });

  // Tell UI so the message appears immediately in the session panel
  bus.emit(EventNames.SESSION_MESSAGE_QUEUED, {
    sessionId,
    messageId: msg.id,
    message,
    source,
    enqueuedAt: msg.enqueuedAt,
  }, ['main-ai'], { source });

  return msg;
}

/**
 * Mark the next deliverable run of 'pending' messages for a session as 'processing'.
 * Returns the messages that were marked (the batch to send to Claude).
 * Returns empty array if no pending messages.
 *
 * A row carrying a pre-assigned `userUuid` (a question's head row) is never
 * batched: at the head it goes alone, otherwise the run stops before it
 * (splitBatchAtUuid), so every turn carries at most one uuid row. `midTurn`
 * marks NOTHING while any pending row carries a uuid: a question must start its
 * own turn, never ride inside the answer to another one; processNext picks it
 * up when the current turn ends.
 *
 * The batch is one stdin line. Rows that already went out in a line (they carry
 * its `lineUuid`) go out again alone and together, under that uuid; fresh rows
 * never join them. Fresh rows get their line's uuid here, in the same write
 * that marks them, so a crash right after can never send them under another.
 * `tracked`: the CLI they go to reports its queue (QueuedMessage.lineTracked).
 */
export async function markProcessing(
  sessionId: string,
  stopFence?: string | null,
  opts?: { midTurn?: boolean; tracked?: boolean },
): Promise<QueuedMessage[]> {
  let deferredForQuestion = false;
  const pending = await mutateStore((s) => {
    const queue = s.queues[sessionId];
    if (!queue) return [];
    if (stopFence !== undefined) {
      for (const message of queue) {
        if (message.status !== 'pending' || (message.stopFence ?? null) === stopFence) continue;
        message.status = 'parked';
        message.parkedAt = new Date().toISOString();
        message.parkedReason = STOP_PARKED_REASON;
      }
    }
    const pendingRows = queue.filter((m) => m.status === 'pending');
    if (opts?.midTurn && pendingRows.some((m) => m.userUuid)) {
      deferredForQuestion = true;
      return [];
    }
    const head = pendingRows[0];
    if (!head) return [];
    const run: QueuedMessage[] = [];
    for (const m of pendingRows) {
      if (m.lineUuid !== head.lineUuid) break;
      run.push(m);
    }
    const batch = head.lineUuid ? run : splitBatchAtUuid(run);
    const lineUuid = head.lineUuid ?? lineUuidFor(batch);
    for (const m of batch) {
      m.status = 'processing';
      m.lineUuid = lineUuid;
      m.lineTries = (m.lineTries ?? 0) + 1;
      if (opts?.tracked) m.lineTracked = true;
    }
    return batch;
  }, stopFence !== undefined);
  if (deferredForQuestion) {
    log.session.info('mid-turn injection deferred: a question row starts its own turn', { sessionId });
  }
  if (pending.length === 0) return [];
  log.session.info('messages batched for delivery', { sessionId, count: pending.length });
  return pending;
}

/**
 * Mark only the oldest pending message for a session as processing.
 *
 * ACP providers accept one prompt per turn, so their runner uses this instead
 * of the native Claude batching contract above. Returning an array keeps the
 * scoped remove/revert APIs identical while guaranteeing a cardinality of 0–1.
 */
export async function markNextProcessing(sessionId: string): Promise<QueuedMessage[]> {
  const picked = await mutateStore((s) => {
    const queue = s.queues[sessionId];
    if (!queue) return null;
    if (queue.some((message) => message.status === 'processing')) return null;

    const next = queue.find((message) => message.status === 'pending');
    if (!next) return null;

    next.status = 'processing';
    return { next, queueDepth: queue.length };
  });
  if (!picked) return [];
  log.session.info('next message selected for delivery', {
    sessionId,
    messageId: picked.next.id,
    queueDepth: picked.queueDepth,
  });
  return [picked.next];
}

/**
 * Remove 'processing' messages for a session (they are now in JSONL history).
 *
 * @param ids - when provided, remove ONLY these message IDs. Delivery points
 *   (FIFO write / mid-turn inject / confirmed --resume spawn) pass the exact
 *   batch they delivered, so a concurrent in-flight batch for the same session
 *   can never be swept away by a stale SESSION_RESULT cleanup (that race
 *   silently lost messages: cleanup removed the in-flight batch, the write
 *   then failed, and revertToPending mutated orphaned objects).
 *   This scoping is also what makes revertToPending's blind re-insert safe —
 *   reverting to un-scoped removal would make that re-insert resurrect
 *   already-delivered messages as duplicates. (See revertToPending.)
 */
export async function removeProcessed(sessionId: string, ids?: string[]): Promise<void> {
  const found = await mutateStore((s) => {
    const queue = s.queues[sessionId];
    if (!queue) return false;

    const idSet = ids ? new Set(ids) : null;
    const gone = (m: QueuedMessage) => m.status === 'processing' && (idSet === null || idSet.has(m.id));
    // A phone message among them ran here: recorded in the same write (relay-fates.ts).
    const removed = queue.filter(gone);
    noteDelivered(s, removed);
    for (const m of removed) noteSettledLine(s, m);
    s.queues[sessionId] = queue.filter((m) => !gone(m));
    // Clean up empty queues
    if (s.queues[sessionId].length === 0) {
      delete s.queues[sessionId];
    }
    return true;
  });
  if (found) log.session.debug('message queue drained', { sessionId, scoped: !!ids });
}

/**
 * Edit a pending message's text. Returns true on success.
 * Returns false if message not found or already processing.
 */
export async function editMessage(sessionId: string, messageId: string, newText: string): Promise<boolean> {
  return mutateStore((s) => {
    const queue = s.queues[sessionId];
    if (!queue) return false;

    const msg = queue.find((m) => m.id === messageId);
    if (!msg || msg.status !== 'pending') return false;

    msg.message = newText;
    return true;
  });
}

/**
 * Delete a pending or parked message ("Discard"). Returns true on success.
 * Returns false if the message is missing or already processing (in flight —
 * deleting it would race the delivery points' own scoped removal).
 */
export async function deleteMessage(sessionId: string, messageId: string): Promise<boolean> {
  return mutateStore((s) => {
    const queue = s.queues[sessionId];
    if (!queue) return false;

    const idx = queue.findIndex((m) => m.id === messageId);
    if (idx === -1) return false;
    if (queue[idx].status === 'processing') return false;

    queue.splice(idx, 1);
    if (queue.length === 0) {
      delete s.queues[sessionId];
    }
    // A relayed phone message a person removed: the companion is told so, never
    // "delivered", and never "not received" either (gate r3, M6: a row an older
    // Mac took carries no fate, and "not received" let the companion run it).
    if (fateOf(s, messageId) || isPhoneMessageId(messageId)) setFate(s, messageId, 'removed');
    return true;
  }, false, true);
}

/**
 * The companion's question for one phone message it relayed here: answered,
 * and the row removed when it may go another way, in ONE durable write
 * (relay-fates.ts withdrawIn). Throws when the write fails, so the companion
 * hears no answer and keeps waiting rather than acting on one never recorded.
 */
export async function withdrawRelayedMessage(sessionId: string, messageId: string): Promise<WithdrawState> {
  return mutateStore((s) => withdrawIn(s, sessionId, messageId), true, true);
}

/** What became of a relayed phone message here (undefined: never seen, or past the horizon). */
export async function relayFateOf(messageId: string): Promise<RelayFate | undefined> {
  return fateOf(await getStore(), messageId);
}

/**
 * Revert specific messages from 'processing' back to 'pending'.
 * Used when delivery fails after markProcessing().
 *
 * NO-LOSS GUARANTEE: if a message is no longer in the store (e.g. a concurrent
 * un-scoped cleanup removed it while this batch was in flight), it is
 * RE-INSERTED, not just mutated. Mutating an orphaned object and persisting
 * would silently drop the message — that was a real loss path.
 *
 * SAFE ONLY BECAUSE removeProcessed is scoped to batch ids: the blind
 * re-insert below trusts that a missing message means delivery genuinely
 * failed. If removeProcessed were reverted to un-scoped (sweeping ALL
 * 'processing'), this re-insert would resurrect messages the CLI already
 * received — duplicates. The two invariants are paired; keep both. (See
 * removeProcessed's @param ids doc for the other direction.)
 */
export async function revertToPending(messages: QueuedMessage[]): Promise<void> {
  if (messages.length === 0) return;
  await mutateStore((s) => {
    for (const m of messages) {
      if (m.status === 'processing') m.status = 'pending';
      const queue = s.queues[m.sessionId] ?? (s.queues[m.sessionId] = []);
      const existing = queue.find((q) => q.id === m.id);
      if (existing) {
        // The fresh on-disk row is authoritative for identity; make sure ITS
        // status flips too (the caller's object may be a detached copy).
        if (existing.status === 'processing') existing.status = 'pending';
      } else {
        log.session.warn('revertToPending: message missing from store — re-inserting (loss averted)', {
          sessionId: m.sessionId, messageId: m.id,
        });
        queue.push(m);
        // Keep queue ordered by enqueue time so redelivery preserves user order
        queue.sort(compareEnqueueOrder);
      }
    }
  });
}

/**
 * Get all queued messages for a session.
 */
export async function getQueue(sessionId: string): Promise<QueuedMessage[]> {
  const s = await getStore();
  return s.queues[sessionId] ?? [];
}

export async function withUndeliveredMessageGuard<T>(
  check: (hasUndelivered: (sessionId: string) => boolean) => Promise<T>,
): Promise<T> {
  return withFileLock(SESSION_QUEUE_FILE, async () => {
    let current: QueueStore;
    try {
      current = JSON.parse(await fs.readFile(SESSION_QUEUE_FILE, 'utf8')) as QueueStore;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      current = { version: 1, queues: {} };
    }
    return check(sessionId => (current.queues[sessionId] ?? []).some(message => message.status !== 'parked'));
  });
}

/**
 * Is this message id STILL IN THE QUEUE for the session (any status)?
 *
 * Retry-after-delivery-failure guard (inc-1786774073558). A failed --resume spawn
 * calls revertToPending(), so the message stays in the queue as 'pending' AND the
 * UI is told the batch failed. The user's Retry then enqueued a SECOND copy of the
 * same text, and the next batch combined both into one payload joined by '\n\n' —
 * the CLI literally received the user's words twice (canonical enqueue line held
 * two identical halves). A retry must re-DRAIN the surviving row, never add one.
 *
 * 'processing' counts as queued too: delivery is in flight and hasn't settled
 * (every delivery point removes the row EAGERLY, so a surviving 'processing' row
 * means no delivery happened yet). Enqueueing beside it would re-open the same
 * doubling window one step later — if that in-flight batch also fails,
 * revertToPending restores the original next to the copy. Only a row that is
 * fully GONE justifies a fresh enqueue.
 */
export async function isMessageQueued(sessionId: string, messageId: string): Promise<boolean> {
  const s = await getStore();
  const queue = s.queues[sessionId];
  if (!queue) return false;
  return queue.some((m) => m.id === messageId);
}

/** The queued row with this id in any session's queue (a migration moves rows between ids), or null. */
export async function findQueuedMessage(messageId: string): Promise<QueuedMessage | null> {
  const s = await getStore();
  for (const queue of Object.values(s.queues)) {
    const row = queue.find((m) => m.id === messageId);
    if (row) return row;
  }
  return null;
}

/**
 * Get all session IDs that have pending messages (for startup recovery and
 * daemon-reconnect redelivery). 'parked' rows are deliberately invisible here —
 * this is the single gate both automatic triggers pass through, so excluding
 * them is what makes "never auto-redelivered" true.
 */
export async function getAllSessionsWithPending(): Promise<string[]> {
  const s = await getStore();
  const result: string[] = [];
  for (const [sessionId, msgs] of Object.entries(s.queues)) {
    if (msgs.some((m) => m.status === 'pending')) {
      result.push(sessionId);
    }
  }
  return result;
}
