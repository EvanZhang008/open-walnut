/**
 * The durable store behind session-message-queue.ts: the queue file's shape,
 * the in-memory cache, the enqueue order, and the one locked read-modify-write
 * every mutation goes through. Its own module so the queue's API files
 * (session-message-queue.ts, session-queue-park.ts) share one cache and one
 * write chain; nothing outside them imports it.
 */

import { readJsonFile, updateJsonFile } from '../utils/fs.js';
import { SESSION_QUEUE_FILE } from '../constants.js';
import { log } from '../logging/index.js';
import type { RelayFates } from './relay-fates.js';

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
  /** Why it was parked, shown to the human, e.g. the cwd pre-flight error. */
  parkedReason?: string;
  /**
   * Process-monotonic enqueue counter: the tiebreaker for messages that share
   * an `enqueuedAt` millisecond. Optional: rows persisted before this field
   * existed don't have it. See compareEnqueueOrder.
   */
  seq?: number;
  /**
   * Pre-assigned v4 uuid for the CLI's own user line. The harness contract: a
   * stream-json user message may carry `uuid` and the CLI persists the user line
   * under exactly that uuid, so a client can key metadata (a thread anchor) to a
   * transcript line BEFORE the line exists, with no text matching.
   *
   * Optional everywhere. Absent ⇒ the envelope carries no `uuid` key at all and
   * the CLI mints its own, i.e. byte-identical to the pre-feature behaviour. The
   * drain sends ONE uuid per batch (the LAST row's, mirroring the CLI's own
   * `batch.findLast(c => c.uuid)`); see providers/batch-uuid.ts.
   */
  userUuid?: string;
  stopFence?: string;
  /**
   * The uuid of the stdin line that carries this row, fixed the first time the
   * row is picked for delivery and never changed after. Every later attempt
   * (a redelivery after a crash, a restart, an unanswered send, a Retry) sends
   * the same line under the same uuid, so the CLI and the daemon can both
   * recognise it. Rows of one line share it and are never merged with others.
   */
  lineUuid?: string;
  /** How many deliveries took this row. Above one, its line may already be in a CLI. */
  lineTries?: number;
  /**
   * Its line went to a CLI that reports its command queue (command_lifecycle).
   * Kept across a restart, so the server that resends the line also waits for
   * the CLI's word on it, as the one that first wrote it did.
   */
  lineTracked?: true;
  /**
   * The row went back to pending while its line may be in a CLI (an unanswered
   * send, a server restart mid-delivery). Kept until the row leaves the queue:
   * only this Mac, resending under `lineUuid`, may deliver it. A companion that
   * asks for it back hears "delivering" (relay-fates.ts withdrawIn), because a
   * copy it sent by the host's direct path would carry another uuid and run twice.
   */
  lineInDoubt?: true;
}

export interface QueueStore {
  version: 1;
  queues: Record<string, QueuedMessage[]>;
  /** What became of each phone message the companion relayed here (relay-fates.ts). */
  relay?: RelayFates;
  /** Row id → uuid of the line it went out in, for rows that left the queue (session-queue-lines.ts). */
  settled?: Record<string, string>;
}

// ── In-memory cache (backed by disk) ──

let store: QueueStore | null = null;
let writeLock: Promise<void> = Promise.resolve();

export function generateId(): string {
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
 * preserves the *input* order, which for migrateSessionQueue is
 * `[...target, ...moved]`, i.e. the target queue's messages first. So a message
 * enqueued LAST on the target could sort ahead of an older migrated one: user
 * messages redelivered out of order (the queue's whole point is FIFO).
 *
 * `seq` restores a total order: it's process-monotonic, so it breaks intra-ms
 * ties by real enqueue order. Rows written before this field existed have no
 * `seq`; those fall back to `enqueuedAt` alone (see compareEnqueueOrder).
 */
let enqueueSeq = 0;

/** The next enqueue counter value (see above). */
export function nextEnqueueSeq(): number {
  return ++enqueueSeq;
}

/**
 * Total order over queued messages: timestamp first (correct across restarts,
 * where `seq` resets), then `seq` to break intra-millisecond ties.
 */
export function compareEnqueueOrder(a: QueuedMessage, b: QueuedMessage): number {
  const byTime = a.enqueuedAt.localeCompare(b.enqueuedAt);
  if (byTime !== 0) return byTime;
  // Legacy rows (persisted before `seq`) keep their relative input order.
  if (a.seq === undefined || b.seq === undefined) return 0;
  return a.seq - b.seq;
}

/** Ensure a valid store shape (corrupt/legacy rows → fresh empty store). */
export function normalizeShape(s: QueueStore): QueueStore {
  if (!s || !s.queues || typeof s.queues !== 'object') {
    return { version: 1, queues: {} };
  }
  if (s.settled !== undefined && (typeof s.settled !== 'object' || s.settled === null)) delete s.settled;
  return s;
}

export async function getStore(): Promise<QueueStore> {
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
export async function mutateStore<R>(fn: (s: QueueStore) => R, strict = false, durable = false): Promise<R> {
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
      { durable },
    );
  } catch (err) {
    log.session.error('failed to persist session message queue', {
      error: err instanceof Error ? err.message : String(err),
    });
    if (strict) throw err;
    // Disk write (or lock) failed: apply to the cache anyway so the message
    // isn't lost in-process (matches the previous mutate-cache-then-persist
    // behavior). It re-persists with the next successful mutation.
    result = fn(await getStore());
  } finally {
    release();
  }
  return result;
}

/** A fresh read of the queue file, bypassing the cache (no lock, no write). */
export async function readQueueFileFresh(): Promise<QueueStore> {
  return normalizeShape(await readJsonFile<QueueStore>(SESSION_QUEUE_FILE, { version: 1, queues: {} }));
}

/**
 * Reset the in-memory cache. Useful for testing.
 */
export function resetCache(): void {
  store = null;
}
