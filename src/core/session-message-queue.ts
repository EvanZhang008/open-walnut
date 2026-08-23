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

import { readJsonFile, updateJsonFile } from '../utils/fs.js';
import { SESSION_QUEUE_FILE } from '../constants.js';
import { log } from '../logging/index.js';

// ── Types ──

export type MessageStatus = 'pending' | 'processing' | 'parked';

export interface QueuedMessage {
  id: string;
  sessionId: string;
  message: string;
  status: MessageStatus;
  enqueuedAt: string;
  /** When the row was parked (dead-lettered). Set only for status 'parked'. */
  parkedAt?: string;
  /** Why it was parked — shown to the human, e.g. the cwd pre-flight error. */
  parkedReason?: string;
  /**
   * Process-monotonic enqueue counter — the tiebreaker for messages that share
   * an `enqueuedAt` millisecond. Optional: rows persisted before this field
   * existed don't have it. See compareEnqueueOrder.
   */
  seq?: number;
}

interface QueueStore {
  version: 1;
  queues: Record<string, QueuedMessage[]>;
}

// ── In-memory cache (backed by disk) ──

let store: QueueStore | null = null;
let writeLock: Promise<void> = Promise.resolve();

function generateId(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `qm-${ts}-${rand}`;
}

/**
 * Monotonic tiebreaker for the enqueue order.
 *
 * `enqueuedAt` is an ISO string with MILLISECOND resolution, and enqueues are
 * fast enough to collide inside one millisecond (measured: two consecutive
 * enqueues, each with an atomic write, share a ms ~57% of the time). Every
 * `.sort((a,b) => a.enqueuedAt.localeCompare(b.enqueuedAt))` below is therefore
 * a sort on EQUAL keys for such pairs, and Array#sort being stable only
 * preserves the *input* order — which for migrateSessionQueue is
 * `[...target, ...moved]`, i.e. the target queue's messages first. So a message
 * enqueued LAST on the target could sort ahead of an older migrated one: user
 * messages redelivered out of order (the queue's whole point is FIFO).
 *
 * `seq` restores a total order: it's process-monotonic, so it breaks intra-ms
 * ties by real enqueue order. Rows written before this field existed have no
 * `seq`; those fall back to `enqueuedAt` alone (see compareEnqueueOrder).
 */
let enqueueSeq = 0;

/**
 * Total order over queued messages: timestamp first (correct across restarts,
 * where `seq` resets), then `seq` to break intra-millisecond ties.
 */
function compareEnqueueOrder(a: QueuedMessage, b: QueuedMessage): number {
  const byTime = a.enqueuedAt.localeCompare(b.enqueuedAt);
  if (byTime !== 0) return byTime;
  // Legacy rows (persisted before `seq`) keep their relative input order.
  if (a.seq === undefined || b.seq === undefined) return 0;
  return a.seq - b.seq;
}

/** Ensure a valid store shape (corrupt/legacy rows → fresh empty store). */
function normalizeShape(s: QueueStore): QueueStore {
  if (!s || !s.queues || typeof s.queues !== 'object') {
    return { version: 1, queues: {} };
  }
  return s;
}

async function getStore(): Promise<QueueStore> {
  if (store) return store;
  store = normalizeShape(await readJsonFile<QueueStore>(SESSION_QUEUE_FILE, { version: 1, queues: {} }));
  return store;
}

/**
 * Locked read-modify-write over the queue file.
 *
 * The queue has TWO writer processes (the server + the `walnut start` CLI,
 * which enqueues via sendMessageToSession), so persisting the in-memory cache
 * blindly could revert the other process's enqueue. Every mutation therefore
 * runs against a FRESH read under the cross-process file lock (updateJsonFile)
 * and the cache is refreshed to the persisted result. The in-process chain on
 * `writeLock` keeps same-process mutations FIFO (mkdir-lock polling is not).
 *
 * strict=false preserves the old best-effort contract: on a disk failure the
 * mutation is still applied to the in-memory cache (logged, not thrown).
 */
async function mutateStore<R>(fn: (s: QueueStore) => R, strict = false): Promise<R> {
  let result!: R;
  const prev = writeLock;
  let release!: () => void;
  writeLock = new Promise<void>((r) => { release = r; });
  await prev.catch(() => {});
  try {
    store = await updateJsonFile<QueueStore>(
      SESSION_QUEUE_FILE,
      { version: 1, queues: {} },
      (current) => {
        const s = normalizeShape(current);
        result = fn(s);
        return s;
      },
    );
  } catch (err) {
    log.session.error('failed to persist session message queue', {
      error: err instanceof Error ? err.message : String(err),
    });
    if (strict) throw err;
    // Disk write (or lock) failed — apply to the cache anyway so the message
    // isn't lost in-process (matches the previous mutate-cache-then-persist
    // behavior). It re-persists with the next successful mutation.
    result = fn(await getStore());
  } finally {
    release();
  }
  return result;
}

// ── Public API ──

/**
 * Load the queue from disk into memory. Call once at startup.
 * Resets any 'processing' messages back to 'pending' (crash recovery).
 */
export async function loadQueue(): Promise<void> {
  store = null; // force re-read from disk
  const changed = await mutateStore((s) => {
    let dirty = false;
    for (const [, msgs] of Object.entries(s.queues)) {
      for (const msg of msgs) {
        if (msg.status === 'processing') {
          msg.status = 'pending';
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
  opts?: { id?: string },
): Promise<QueuedMessage> {
  const msg: QueuedMessage = {
    id: opts?.id ?? generateId(),
    sessionId,
    message,
    status: 'pending',
    enqueuedAt: new Date().toISOString(),
    seq: ++enqueueSeq,
  };
  const outcome = await mutateStore((s) => {
    if (!s.queues[sessionId]) {
      s.queues[sessionId] = [];
    }
    if (opts?.id) {
      const existing = s.queues[sessionId].find((m) => m.id === opts.id);
      if (existing) return { queueDepth: s.queues[sessionId].length, existing };
    }
    s.queues[sessionId].push(msg);
    return { queueDepth: s.queues[sessionId].length, existing: null };
  });
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
  },
): Promise<QueuedMessage> {
  const { bus, EventNames } = await import('./event-bus.js');
  const msg = await enqueueMessage(sessionId, opts?.enqueueMessage ?? message, { id: opts?.messageId });
  const source = opts?.source ?? 'unknown';

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
  }, ['main-ai'], { source });

  return msg;
}

/**
 * Mark all 'pending' messages for a session as 'processing'.
 * Returns the messages that were marked (the batch to send to Claude).
 * Returns empty array if no pending messages.
 */
export async function markProcessing(sessionId: string): Promise<QueuedMessage[]> {
  const pending = await mutateStore((s) => {
    const queue = s.queues[sessionId];
    if (!queue) return [];
    const batch = queue.filter((m) => m.status === 'pending');
    for (const m of batch) {
      m.status = 'processing';
    }
    return batch;
  });
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
    s.queues[sessionId] = queue.filter((m) =>
      m.status !== 'processing' || (idSet !== null && !idSet.has(m.id)));
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
    return true;
  });
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
    log.session.warn('message parked — permanent delivery failure', {
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
export async function parkMessages(messages: QueuedMessage[], reason: string): Promise<number> {
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
  });
  logParked(parked, reason);
  return parked.length;
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
  // and the answer is almost always "nothing stale" — no file lock, no rewrite.
  const peek = normalizeShape(await readJsonFile<QueueStore>(SESSION_QUEUE_FILE, { version: 1, queues: {} }));
  if (!Object.values(peek.queues).some((msgs) => msgs.some(isStale))) return [];

  const reason = `undelivered for over ${Math.round(maxAgeMs / 86_400_000)} days`;
  const parkedAt = new Date().toISOString();
  // One atomic pass that flips IN PLACE — deliberately not parkMessages(), whose
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
 * Put a parked row back in line — EXPLICIT HUMAN ACTION ONLY (the Retry
 * affordance). Returns true when a parked row was un-parked; false when the row
 * is absent or in a status the caller shouldn't disturb.
 *
 * The caller still has to trigger a delivery attempt (processNext); this only
 * makes the row eligible again.
 */
export async function unparkMessage(sessionId: string, messageId: string): Promise<boolean> {
  const ok = await mutateStore((s) => {
    const msg = s.queues[sessionId]?.find((m) => m.id === messageId);
    if (!msg || msg.status !== 'parked') return false;
    msg.status = 'pending';
    delete msg.parkedAt;
    delete msg.parkedReason;
    return true;
  });
  if (ok) log.session.info('parked message un-parked by user action', { sessionId, messageId });
  return ok;
}

/**
 * Get all queued messages for a session.
 */
export async function getQueue(sessionId: string): Promise<QueuedMessage[]> {
  const s = await getStore();
  return s.queues[sessionId] ?? [];
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

/**
 * Reset the in-memory cache. Useful for testing.
 */
export function resetCache(): void {
  store = null;
}
