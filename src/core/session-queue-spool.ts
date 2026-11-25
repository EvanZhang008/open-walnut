/**
 * The enqueue's side path (2026-11-23, the user: a message is never lost, and an error keeps being
 * retried). An enqueue whose queue write keeps failing (a lock another process holds past its
 * waits, a write error) puts its row in a file of its own next to the queue file, synced, without
 * the queue's lock, and the send is stored: its sender hears "queued" only for a row on disk. The
 * spool is merged into the queue by the next write that works (drainQueueSpool: at startup, after
 * an enqueue, and on its own clock until it is empty), each row once, by id.
 *
 * A relayed or once-only row never goes here: its fate is written in the same write as the row
 * (relay-fates.ts), so its enqueue throws and its sender sends again.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { SESSION_QUEUE_FILE } from '../constants.js';
import { log } from '../logging/index.js';
import { writeJsonFile } from '../utils/fs.js';
import { mutateStore, readQueueFileFresh, type QueuedMessage, type QueueStore } from './session-queue-store.js';
import { homeWritesStopped } from '../lib/leader-clocks.js';

export function spoolDir(): string {
  return `${SESSION_QUEUE_FILE}.spool`;
}

const fileOf = (id: string) => path.join(spoolDir(), `${encodeURIComponent(id)}.json`);

/** Put `row` in the spool, synced. Throws when even that cannot be written. */
export async function spoolRow(row: QueuedMessage): Promise<void> {
  // A new spool directory is synced into its parent, so a crash cannot drop the directory with its rows.
  if (await fsp.mkdir(spoolDir(), { recursive: true })) await syncDir(path.dirname(spoolDir()));
  await writeJsonFile(fileOf(row.id), row, { durable: true });
  log.session.warn('session message queue: the row waits in the spool for the queue to take it', { sessionId: row.sessionId, messageId: row.id });
  scheduleDrain();
}

/** The spooled row of this id, if one waits (a resend of the same id is that row). */
export async function spooledRow(id: string): Promise<QueuedMessage | null> {
  try {
    return JSON.parse(await fsp.readFile(fileOf(id), 'utf-8')) as QueuedMessage;
  } catch {
    return null;
  }
}

/** Rows waiting in the spool, oldest first (by time alone: their `seq` came from several processes). */
export async function spooledRows(): Promise<QueuedMessage[]> {
  let names: string[];
  try { names = await fsp.readdir(spoolDir()); } catch { return []; }
  const rows: QueuedMessage[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const row = JSON.parse(await fsp.readFile(path.join(spoolDir(), name), 'utf-8')) as QueuedMessage;
      if (row && typeof row.id === 'string' && typeof row.sessionId === 'string') rows.push(row);
    } catch { /* a half file: its writer threw, and its sender was told */ }
  }
  return rows.sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt));
}

/** Cheap: whether anything may wait (no read of the rows). */
export function spoolMayHoldRows(): boolean {
  return fs.existsSync(spoolDir());
}

async function syncDir(dir: string): Promise<void> {
  const fh = await fsp.open(dir, 'r');
  try { await fh.sync(); } finally { await fh.close(); }
}

/** Every row id the store holds anywhere: a queue or a transit. */
function heldIds(s: QueueStore): Set<string> {
  const ids = new Set<string>();
  for (const q of Object.values(s.queues)) for (const r of q) ids.add(r.id);
  for (const t of Object.values(s.transit ?? {})) for (const r of t.rows) ids.add(r.id);
  return ids;
}

/**
 * Put `row` in `queue` at its enqueue time, rows already in line staying where they are: only
 * the timestamps compare (a spooled row's `seq` came from another process's counter).
 */
function insertByTime(queue: QueuedMessage[], row: QueuedMessage): void {
  const at = queue.findIndex((m) => m.status === 'pending' && m.enqueuedAt > row.enqueuedAt);
  queue.splice(at < 0 ? queue.length : at, 0, row);
}

let draining: Promise<number> | null = null;

/**
 * Merge the spool into the queue, in one strict write, then remove the merged files. A row the
 * store already holds anywhere (any session's queue, a transit: a resend may have reached another
 * session), or one that already left (`settled`), is not put again. How many went in.
 */
export function drainQueueSpool(): Promise<number> {
  draining ??= drainOnce().finally(() => { draining = null; });
  return draining;
}

async function drainOnce(): Promise<number> {
  const rows = await spooledRows();
  if (rows.length === 0) return 0;
  let added: QueuedMessage[];
  try {
    added = await mutateStore((s) => {
      const out: QueuedMessage[] = [];
      const held = heldIds(s);
      for (const row of rows) {
        if (held.has(row.id) || s.settled?.[row.id]) continue;
        const queue = s.queues[row.sessionId] ?? [];
        insertByTime(queue, structuredClone(row));
        s.queues[row.sessionId] = queue;
        held.add(row.id);
        out.push(row);
      }
      return out;
    }, true, true);
  } catch (err) {
    log.session.warn('session message queue: the spool could not be merged yet; trying again', { rows: rows.length, error: err instanceof Error ? err.message : String(err) });
    // A merge that landed and then threw: the rows the file holds now leave the spool, so one
    // removed from the queue before the next merge is never brought back.
    const back = await readQueueFileFresh({ readErrors: 'throw' }).then(heldIds, () => null);
    if (back) for (const row of rows) if (back.has(row.id)) await fsp.rm(fileOf(row.id), { force: true }).catch(() => {});
    scheduleDrain();
    return 0;
  }
  for (const row of rows) await fsp.rm(fileOf(row.id), { force: true }).catch(() => {});
  if (added.length > 0) {
    log.session.info('session message queue: spooled rows are queued', { rows: added.length });
    const { bus, EventNames } = await import('./event-bus.js');
    for (const sid of new Set(added.map((r) => r.sessionId))) {
      bus.emit(EventNames.SESSION_SEND, { sessionId: sid, message: '' }, ['session-runner'], { source: 'queue-spool' });
    }
  }
  return added.length;
}

const DRAIN_MS = [1_000, 5_000, 30_000];
let drainTimer: ReturnType<typeof setTimeout> | null = null;
let drainTry = 0;

function scheduleDrain(): void {
  if (drainTimer) return;
  drainTimer = setTimeout(() => {
    drainTimer = null;
    if (homeWritesStopped()) return;
    void drainQueueSpool().then(async () => {
      if ((await spooledRows()).length > 0) { drainTry++; scheduleDrain(); } else drainTry = 0;
    }, () => scheduleDrain());
  }, DRAIN_MS[Math.min(drainTry, DRAIN_MS.length - 1)]);
  drainTimer.unref?.();
}

/** The server's own look at the spool, every 30 s: a spool another process left (the CLI) is merged too. */
const WATCH_MS = 30_000;
let watchTimer: ReturnType<typeof setInterval> | null = null;

export function watchQueueSpool(): void {
  if (watchTimer) return;
  watchTimer = setInterval(() => {
    if (homeWritesStopped()) return;
    if (spoolMayHoldRows()) void drainQueueSpool().catch(() => 0);
  }, WATCH_MS);
  watchTimer.unref?.();
}

/** Tests only: forget the drain clock and the watch. */
export function resetSpoolState(): void {
  if (drainTimer) clearTimeout(drainTimer);
  drainTimer = null;
  drainTry = 0;
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
}
