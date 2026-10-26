/**
 * Remote items a local task owned BEFORE the remote-identity ledger existed.
 *
 * The ledger (task-remote-links.ts) records every remote id a local task gives
 * up, so a pull never mints a second task for it. It arrived after the
 * 2026-08-05 source repair, which had already moved tasks off a provider (to
 * another provider, or to local) and dropped their remote ids without a record.
 * The remote copies stayed in the provider. A full pull then saw each of them
 * as a brand new item, and when its grouping named a project the item could
 * not land in (another provider's, a retired name) it was refused on every
 * cycle and reported as an error asking the user to rename lists, for items
 * that were Walnut's own old copies of tasks the user still has, or deleted
 * (2026-10-15 to 10-25: three cards, twelve items, all twelve found here).
 *
 * The evidence is Walnut's own: the copy of the task database the v5 migration
 * wrote before it ran (TASK_DB_PRE_V5_BACKUP_PATH). An install that never ran
 * that migration has no pre-ledger history, so no file and nothing to find.
 * Read once, read-only, in a worker (a cold read of the 28 MB file took 0.5 s,
 * too long for the event loop), and only when a pull meets an item it cannot
 * import.
 */
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { TASK_DB_PRE_V5_BACKUP_PATH } from './task-db.js';
import { sqliteModuleFile } from '../lib/sqlite.js';
import { log } from '../logging/index.js';

/** source → remote id → the local task id that owned it in the snapshot. */
export type OwnerIndex = Map<string, Map<string, string>>;

/** Every id an ext entry names for its remote item: current id, display id, aliases. */
function idsOf(entry: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ['id', 'short_id']) {
    const v = entry[key];
    if (typeof v === 'string' && v) out.push(v);
  }
  const prev = entry.previous_ids;
  if (Array.isArray(prev)) for (const v of prev) if (typeof v === 'string' && v) out.push(v);
  return out;
}

/**
 * An id two different tasks named (a display id may repeat) is ambiguous and
 * dropped: a wrong match would release, for good, an item that is not a copy.
 */
export function buildOwnerIndex(rows: Iterable<{ id: string; ext: string | null }>): OwnerIndex {
  const out: OwnerIndex = new Map();
  const ambiguous = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.ext) continue;
    let ext: unknown;
    try { ext = JSON.parse(row.ext); } catch { continue; }
    if (!ext || typeof ext !== 'object') continue;
    for (const [source, entry] of Object.entries(ext as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue;
      for (const remoteId of idsOf(entry as Record<string, unknown>)) {
        let bySource = out.get(source);
        if (!bySource) out.set(source, (bySource = new Map()));
        const owner = bySource.get(remoteId);
        if (owner === undefined) bySource.set(remoteId, row.id);
        else if (owner !== row.id) {
          let set = ambiguous.get(source);
          if (!set) ambiguous.set(source, (set = new Set()));
          set.add(remoteId);
        }
      }
    }
  }
  for (const [source, ids] of ambiguous) for (const id of ids) out.get(source)?.delete(id);
  return out;
}

const READ_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const driver = require(workerData.driver)
const Database = typeof driver === 'function' ? driver : driver.default
let db
try {
  db = new Database(workerData.file, { readonly: true, fileMustExist: true })
  const rows = db.prepare("SELECT id, ext FROM tasks WHERE ext IS NOT NULL AND ext != '{}'").all()
  parentPort.postMessage({ ok: true, rows })
} catch (err) {
  parentPort.postMessage({ ok: false, error: String(err && err.message || err) })
} finally {
  try { db && db.close() } catch {}
}
`;

const READ_TIMEOUT_MS = 30_000;
// The worker shares no module with this thread, so it loads src/lib/sqlite.ts
// itself (dist/lib/sqlite.js in a build): the same bun:sqlite as the server.
const SQLITE_DRIVER_PATH = sqliteModuleFile();

function readRows(file: string): Promise<Array<{ id: string; ext: string | null }>> {
  return new Promise((resolve, reject) => {
    const driver = SQLITE_DRIVER_PATH;
    if (!driver) { reject(new Error('SQLite driver not found (dist/lib/sqlite.js is missing from this build)')); return; }
    const worker = new Worker(READ_WORKER_SOURCE, { eval: true, workerData: { file, driver } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`reading ${file} took over ${READ_TIMEOUT_MS} ms`));
    }, READ_TIMEOUT_MS);
    worker.once('message', (msg: { ok: boolean; rows?: Array<{ id: string; ext: string | null }>; error?: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (msg.ok) resolve(msg.rows ?? []);
      else reject(new Error(msg.error ?? 'read failed'));
    });
    worker.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

async function load(file: string): Promise<OwnerIndex> {
  if (!fs.existsSync(file)) return new Map();
  try {
    const rows = await readRows(file);
    const built = buildOwnerIndex(rows);
    log.task.info('pre-ledger owners loaded', { file, tasks: rows.length, sources: [...built.keys()] });
    return built;
  } catch (err) {
    log.task.warn('pre-ledger owners unreadable; treating as none', {
      file, error: err instanceof Error ? err.message : String(err),
    });
    return new Map();
  }
}

let loading: { file: string; index: Promise<OwnerIndex> } | null = null;

/**
 * The local task that owned one of `remoteIds` for `source` before the ledger,
 * or null. `remoteIds` are every id the pull knows the item by.
 */
export async function preLedgerOwnerOf(
  source: string,
  remoteIds: readonly string[],
  file: string = TASK_DB_PRE_V5_BACKUP_PATH,
): Promise<string | null> {
  if (!loading || loading.file !== file) loading = { file, index: load(file) };
  const bySource = (await loading.index).get(source);
  if (!bySource) return null;
  for (const id of remoteIds) {
    const owner = bySource.get(id);
    if (owner) return owner;
  }
  return null;
}

/** Tests: forget the loaded snapshot. */
export function resetPreLedgerOwnersForTest(): void {
  loading = null;
}
