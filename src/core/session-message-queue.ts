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
async function persist(): Promise<void> {
  const s = store;
  if (!s) return;
  // Chain writes so they don't interleave
  writeLock = writeLock.then(async () => {
    try {
      await writeJsonFile(SESSION_QUEUE_FILE, s);
    } catch (err) {
      log.session.error('failed to persist session message queue', {
        error: err instanceof Error ? err.message : String(err),
      });
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
 * Remove all 'processing' messages for a session (they are now in JSONL history).
 */
export async function removeProcessed(sessionId: string): Promise<void> {
  const s = await getStore();
  const queue = s.queues[sessionId];
  if (!queue) return;

  s.queues[sessionId] = queue.filter((m) => m.status !== 'processing');
  // Clean up empty queues
  if (s.queues[sessionId].length === 0) {
    delete s.queues[sessionId];
  }
  await persist();
  log.session.debug('message queue drained', { sessionId });
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
 * Used when mid-turn FIFO injection fails after markProcessing().
 * Messages must be references returned by markProcessing (same objects in the store).
 */
export async function revertToPending(messages: QueuedMessage[]): Promise<void> {
  for (const m of messages) {
    if (m.status === 'processing') m.status = 'pending'
  }
  await persist()
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

/**
 * Reset the in-memory cache. Useful for testing.
 */
export function resetCache(): void {
  store = null;
}
