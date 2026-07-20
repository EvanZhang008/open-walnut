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
 */

import { readJsonFile, writeJsonFile } from '../utils/fs.js';
import { SESSION_QUEUE_FILE } from '../constants.js';
import { log } from '../logging/index.js';

// ── Types ──

export type MessageStatus = 'pending' | 'processing';

export interface QueuedMessage {
  id: string;
  sessionId: string;
  message: string;
  status: MessageStatus;
  enqueuedAt: string;
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

async function getStore(): Promise<QueueStore> {
  if (store) return store;
  store = await readJsonFile<QueueStore>(SESSION_QUEUE_FILE, { version: 1, queues: {} });
  // Ensure valid shape
  if (!store.queues || typeof store.queues !== 'object') {
    store = { version: 1, queues: {} };
  }
  return store;
}

/**
 * Persist the current in-memory store to disk.
 * Serializes writes to avoid concurrent file corruption.
 */
async function persist(strict = false): Promise<void> {
  const s = store;
  if (!s) return;
  // Chain writes so they don't interleave
  writeLock = writeLock.catch(() => {}).then(async () => {
    try {
      await writeJsonFile(SESSION_QUEUE_FILE, s);
    } catch (err) {
      log.session.error('failed to persist session message queue', {
        error: err instanceof Error ? err.message : String(err),
      });
      if (strict) throw err;
    }
  });
  await writeLock;
}

// ── Public API ──

/**
 * Load the queue from disk into memory. Call once at startup.
 * Resets any 'processing' messages back to 'pending' (crash recovery).
 */
export async function loadQueue(): Promise<void> {
  store = null; // force re-read from disk
  const s = await getStore();
  let changed = false;
  for (const [, msgs] of Object.entries(s.queues)) {
    for (const msg of msgs) {
      if (msg.status === 'processing') {
        msg.status = 'pending';
        changed = true;
      }
    }
  }
  if (changed) {
    log.session.info('reset processing messages to pending after restart');
    await persist();
  }
}

/**
 * Enqueue a message for a session. Persists immediately.
 * Returns the queued message (with generated ID).
 */
export async function enqueueMessage(sessionId: string, message: string): Promise<QueuedMessage> {
  const s = await getStore();
  const msg: QueuedMessage = {
    id: generateId(),
    sessionId,
    message,
    status: 'pending',
    enqueuedAt: new Date().toISOString(),
  };
  if (!s.queues[sessionId]) {
    s.queues[sessionId] = [];
  }
  s.queues[sessionId].push(msg);
  await persist();
  log.session.info('message enqueued', { sessionId, messageId: msg.id, queueDepth: s.queues[sessionId].length });
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
  },
): Promise<QueuedMessage> {
  const { bus, EventNames } = await import('./event-bus.js');
  const msg = await enqueueMessage(sessionId, opts?.enqueueMessage ?? message);
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
  const s = await getStore();
  const queue = s.queues[sessionId];
  if (!queue) return [];

  const pending = queue.filter((m) => m.status === 'pending');
  if (pending.length === 0) return [];

  for (const m of pending) {
    m.status = 'processing';
  }
  await persist();
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
  const s = await getStore();
  const queue = s.queues[sessionId];
  if (!queue) return [];
  if (queue.some((message) => message.status === 'processing')) return [];

  const next = queue.find((message) => message.status === 'pending');
  if (!next) return [];

  next.status = 'processing';
  await persist();
  log.session.info('next message selected for delivery', {
    sessionId,
    messageId: next.id,
    queueDepth: queue.length,
  });
  return [next];
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
  const s = await getStore();
  const queue = s.queues[sessionId];
  if (!queue) return;

  const idSet = ids ? new Set(ids) : null;
  s.queues[sessionId] = queue.filter((m) =>
    m.status !== 'processing' || (idSet !== null && !idSet.has(m.id)));
  // Clean up empty queues
  if (s.queues[sessionId].length === 0) {
    delete s.queues[sessionId];
  }
  await persist();
  log.session.debug('message queue drained', { sessionId, scoped: !!ids });
}

/**
 * Edit a pending message's text. Returns true on success.
 * Returns false if message not found or already processing.
 */
export async function editMessage(sessionId: string, messageId: string, newText: string): Promise<boolean> {
  const s = await getStore();
  const queue = s.queues[sessionId];
  if (!queue) return false;

  const msg = queue.find((m) => m.id === messageId);
  if (!msg || msg.status !== 'pending') return false;

  msg.message = newText;
  await persist();
  return true;
}

/**
 * Delete a pending message. Returns true on success.
 * Returns false if message not found or already processing.
 */
export async function deleteMessage(sessionId: string, messageId: string): Promise<boolean> {
  const s = await getStore();
  const queue = s.queues[sessionId];
  if (!queue) return false;

  const idx = queue.findIndex((m) => m.id === messageId);
  if (idx === -1) return false;
  if (queue[idx].status !== 'pending') return false;

  queue.splice(idx, 1);
  if (queue.length === 0) {
    delete s.queues[sessionId];
  }
  await persist();
  return true;
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
  const s = await getStore();
  for (const m of messages) {
    if (m.status === 'processing') m.status = 'pending';
    const queue = s.queues[m.sessionId] ?? (s.queues[m.sessionId] = []);
    if (!queue.some((q) => q.id === m.id)) {
      log.session.warn('revertToPending: message missing from store — re-inserting (loss averted)', {
        sessionId: m.sessionId, messageId: m.id,
      });
      queue.push(m);
      // Keep queue ordered by enqueue time so redelivery preserves user order
      queue.sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt));
    }
  }
  await persist();
}

/**
 * Get all queued messages for a session.
 */
export async function getQueue(sessionId: string): Promise<QueuedMessage[]> {
  const s = await getStore();
  return s.queues[sessionId] ?? [];
}

/**
 * Get all session IDs that have pending messages (for startup recovery).
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
  const s = await getStore();
  const source = s.queues[oldSessionId] ?? [];
  if (source.length === 0) return { movedIds: [] };

  const oldSource = source;
  const oldTarget = s.queues[newSessionId];
  const target = oldTarget ?? [];
  const existingIds = new Set(target.map((message) => message.id));
  const moved = source
    .filter((message) => !existingIds.has(message.id))
    .map((message) => ({ ...message, sessionId: newSessionId }));
  const movedIds = moved.map((message) => message.id);

  s.queues[newSessionId] = [...target, ...moved]
    .sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt));
  delete s.queues[oldSessionId];
  try {
    await persist(true);
  } catch (error) {
    s.queues[oldSessionId] = oldSource;
    if (oldTarget) s.queues[newSessionId] = oldTarget;
    else delete s.queues[newSessionId];
    throw error;
  }
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
  const s = await getStore();
  const oldSource = s.queues[oldSessionId];
  const oldTarget = s.queues[newSessionId];
  const target = oldTarget ?? [];
  const movedSet = new Set(movedIds);
  const returning = target
    .filter((message) => movedSet.has(message.id))
    .map((message) => ({ ...message, sessionId: oldSessionId }));
  if (returning.length === 0) return;

  const source = oldSource ?? [];
  const sourceIds = new Set(source.map((message) => message.id));
  s.queues[oldSessionId] = [
    ...source,
    ...returning.filter((message) => !sourceIds.has(message.id)),
  ].sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt));
  const remaining = target.filter((message) => !movedSet.has(message.id));
  if (remaining.length > 0) s.queues[newSessionId] = remaining;
  else delete s.queues[newSessionId];
  try {
    await persist(true);
  } catch (error) {
    if (oldSource) s.queues[oldSessionId] = oldSource;
    else delete s.queues[oldSessionId];
    if (oldTarget) s.queues[newSessionId] = oldTarget;
    else delete s.queues[newSessionId];
    throw error;
  }
}

/**
 * Reset the in-memory cache. Useful for testing.
 */
export function resetCache(): void {
  store = null;
}
