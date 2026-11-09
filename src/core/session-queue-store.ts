/**
 * The durable store behind session-message-queue.ts: the queue file's shape,
 * the in-memory cache, the enqueue order, and the one locked read-modify-write
 * every mutation goes through. Its own module so the queue's API files
 * (session-message-queue.ts, session-queue-park.ts) share one cache and one
 * write chain; nothing outside them imports it.
 */

import { readJsonFile, writeJsonFile } from '../utils/fs.js';
import { FileLockTimeoutError, withFileLock } from '../utils/file-lock.js';
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
  /**
   * A CLI took this row's line and stopped before answering it (line-answer-v1,
   * line-fate-core.ts `unanswered`), so it was sent once more under a new uuid.
   * A second time it is parked instead, and the sender told.
   */
  unansweredResent?: true;
  /**
   * Who sent it, read from the send's source (queueSentBy): `person` for words
   * someone typed (the console, the phone, the CLI, a letter), `agent` for
   * everything Walnut or another task sent. The session panel folds an agent's
   * card on arrival instead of showing it until history takes it in. Absent on
   * rows written without a source and by older versions: nothing is folded then.
   */
  sentBy?: 'person' | 'agent';
  /**
   * A person sent it (the composer, the phone, the `walnut` CLI, a plan button),
   * or a leader answering its worker's question: delivering it answers a pending
   * permission prompt with a deny, since the person moved on. A row without it (a
   * peer, a letter, a notice, a trigger) waits behind the prompt and goes out
   * once the prompt is answered.
   */
  closesPrompt?: true;
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

/** The cache as it is now, without a read (null before the first). */
export function peekStore(): QueueStore | null {
  return store;
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
 * runs against a FRESH read under the cross-process file lock and the cache is
 * refreshed to the persisted result. The in-process chain on `writeLock` keeps
 * same-process mutations FIFO (mkdir-lock polling is not).
 *
 * Three rules, from 2026-11-09 (a runaway delivery loop wrote this file 20 to 50
 * times a second for 40 minutes; every other write timed out on the lock, and the
 * user's messages stayed "QUEUED" or vanished):
 * - A mutation that changes nothing writes nothing (the loop's writes were no-ops).
 * - A lock that is busy is waited for (LOCK_ATTEMPTS rounds of the lock's own
 *   wait), never given up on after one round.
 * - strict=false keeps the best-effort contract (the cache takes the change and
 *   nothing throws), but a change that could not reach the disk is replayed onto
 *   the fresh read of the next write (`replays`, flushed soon by itself). Before,
 *   the next write read the file without it and replaced the cache: the change
 *   was lost, a queued message included.
 */
export async function mutateStore<R>(fn: (s: QueueStore) => R, strict = false, durable = false): Promise<R> {
  let result!: R;
  const prev = writeLock;
  let release!: () => void;
  writeLock = new Promise<void>((r) => { release = r; });
  await prev.catch(() => {});
  try {
    store = await persist(fn, (r) => { result = r; }, durable);
  } catch (err) {
    log.session.error('failed to persist session message queue', {
      error: err instanceof Error ? err.message : String(err),
      replaysWaiting: replays.length + (strict ? 0 : 1),
    });
    if (strict) throw err;
    // Disk write (or lock) failed: the cache takes it now, the next write puts it on disk.
    const cache = await getStore();
    const before = structuredClone(cache);
    result = fn(cache);
    replays.push(diffStore(before, cache));
    scheduleReplayFlush();
  } finally {
    release();
  }
  return result;
}

/** Rounds of the file lock's own wait (10 s each) before a write gives up. */
const LOCK_ATTEMPTS = 6;

/**
 * Changes the cache holds that did not reach the disk yet, in order (mutateStore). Each is the
 * change the mutation MADE (rows added, changed, removed), never the mutation run again: run
 * again on another read, a pick of "the next pending row" would pick another row than the one
 * its caller already sent (review of 2026-11-09).
 */
let replays: QueuePatch[] = [];

interface QueuePatch {
  /** An added row whole; a changed row only the fields it changed (undefined = removed); a removed row null. */
  rows: Array<{ sid: string; id: string; row: QueuedMessage | null; added: boolean; fields?: Record<string, unknown> }>;
  top: Array<{ path: [string] | [string, string]; value: unknown }>;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** What a mutation changed, row by row (and key by key for the store's other fields). */
export function diffStore(before: QueueStore, after: QueueStore): QueuePatch {
  const patch: QueuePatch = { rows: [], top: [] };
  for (const sid of new Set([...Object.keys(before.queues), ...Object.keys(after.queues)])) {
    const was = new Map((before.queues[sid] ?? []).map((m) => [m.id, m] as const));
    const now = new Map((after.queues[sid] ?? []).map((m) => [m.id, m] as const));
    for (const [id, row] of now) {
      const old = was.get(id);
      if (!old) patch.rows.push({ sid, id, row: structuredClone(row), added: true });
      else if (!same(old, row)) {
        // Only what changed: another writer's status, park or fence on fields this one left alone stays.
        const o = old as unknown as Record<string, unknown>;
        const r = row as unknown as Record<string, unknown>;
        const fields: Record<string, unknown> = {};
        for (const k of new Set([...Object.keys(o), ...Object.keys(r)])) {
          if (!same(o[k], r[k])) fields[k] = structuredClone(r[k]);
        }
        patch.rows.push({ sid, id, row: structuredClone(row), added: false, fields });
      }
    }
    for (const id of was.keys()) if (!now.has(id)) patch.rows.push({ sid, id, row: null, added: false });
  }
  const b = before as unknown as Record<string, unknown>;
  const a = after as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (key === 'queues' || same(b[key], a[key])) continue;
    if (isRecord(b[key]) && isRecord(a[key])) {
      const bo = b[key] as Record<string, unknown>;
      const ao = a[key] as Record<string, unknown>;
      for (const sub of new Set([...Object.keys(bo), ...Object.keys(ao)])) {
        if (!same(bo[sub], ao[sub])) patch.top.push({ path: [key, sub], value: structuredClone(ao[sub]) });
      }
    } else {
      patch.top.push({ path: [key], value: structuredClone(a[key]) });
    }
  }
  return patch;
}

/**
 * Put a held change onto a fresh read: an added row goes in at its enqueue place, a changed
 * row gets only the fields this writer changed, and only while the read still has it (a row
 * another writer removed is not brought back), an added row the read already has is left as
 * it is (its write landed), a removed row goes.
 */
export function applyPatch(s: QueueStore, patch: QueuePatch): void {
  for (const { sid, id, row, added, fields } of patch.rows) {
    const queue = s.queues[sid] ?? [];
    const at = queue.findIndex((m) => m.id === id);
    if (row === null) { if (at >= 0) queue.splice(at, 1); }
    else if (at >= 0) {
      // An added row the read already has: its write landed (and then threw), and what any
      // writer did to it since stands.
      if (added) continue;
      const target = queue[at] as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(fields ?? (row as unknown as Record<string, unknown>))) {
        if (v === undefined) delete target[k]; else target[k] = structuredClone(v);
      }
    }
    else if (added) { queue.push(structuredClone(row)); queue.sort(compareEnqueueOrder); }
    if (queue.length > 0) s.queues[sid] = queue;
    else delete s.queues[sid];
  }
  const target = s as unknown as Record<string, unknown>;
  for (const { path: [key, sub], value } of patch.top) {
    if (sub === undefined) {
      if (value === undefined) delete target[key]; else target[key] = structuredClone(value);
      continue;
    }
    const obj = isRecord(target[key]) ? target[key] as Record<string, unknown> : (target[key] = {}) as Record<string, unknown>;
    if (value === undefined) delete obj[sub]; else obj[sub] = structuredClone(value);
  }
}
let replayFlush: ReturnType<typeof setTimeout> | null = null;

function scheduleReplayFlush(): void {
  if (replayFlush) return;
  replayFlush = setTimeout(() => {
    replayFlush = null;
    if (replays.length > 0) void mutateStore(() => undefined).catch(() => {});
  }, 2_000);
  replayFlush.unref?.();
}

/** Tests only: the changes waiting to reach the disk. */
export function pendingReplayCount(): number {
  return replays.length;
}

async function persist<R>(fn: (s: QueueStore) => R, take: (r: R) => void, durable: boolean): Promise<QueueStore> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withFileLock(SESSION_QUEUE_FILE, async () => {
        const s = normalizeShape(await readJsonFile<QueueStore>(SESSION_QUEUE_FILE, { version: 1, queues: {} }));
        const before = JSON.stringify(s);
        const waiting = replays;
        for (const patch of waiting) applyPatch(s, patch);
        take(fn(s));
        if (JSON.stringify(s) !== before) await writeJsonFile(SESSION_QUEUE_FILE, s, { durable });
        // On disk now (or nothing to write): those replays are done.
        if (replays === waiting) replays = [];
        else replays = replays.slice(waiting.length);
        return s;
      });
    } catch (err) {
      if (!(err instanceof FileLockTimeoutError) || attempt >= LOCK_ATTEMPTS) throw err;
      log.session.warn('session message queue lock busy: waiting on', { attempt, of: LOCK_ATTEMPTS });
    }
  }
}

/**
 * A relayed message (the companion is waiting to tell the phone the Mac has it)
 * could not be put on disk. Its enqueue writes strictly and throws this instead
 * of keeping the row in memory only: told "taken", the companion would forget a
 * message a Mac restart then loses. DaemonConnection answers it as errorKind
 * `not_stored`, and the companion keeps the message and asks again (same id,
 * so a write that did land is found and answered once).
 */
export class QueueNotStoredError extends Error {
  readonly errorKind = 'not_stored';
  constructor(cause: unknown) {
    super(`the Mac could not store the message: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'QueueNotStoredError';
  }
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
