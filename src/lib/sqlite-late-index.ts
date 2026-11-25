/**
 * Indexes a database gets after it was opened, built on a worker thread.
 *
 * A covering index added to an existing table is built from every row of it: on the Mac's
 * search index that read 305 MB (22 s on a cold disk, 0.2 s warm) and on its usage ledger
 * 31 MB scattered over 2.2 GB (2.3 s cold), all inside the CREATE INDEX that holds the write
 * lock (2026-11-25). Run at open, it held the event loop and every writer for that long on
 * the first start after an upgrade. So a table that already has rows gets its index later,
 * on a worker: the worker first reads the rows the index needs with a plain read (in WAL it
 * blocks no writer), so the CREATE INDEX that follows holds the lock only for its warm build.
 * An empty table (a new database, a test) gets it at once, which costs nothing.
 *
 * A reader never depends on one being there: the planner takes an index when it exists, and a
 * query that names one (INDEXED BY) asks hasIndex first.
 */
import { Worker } from 'node:worker_threads'
import { WORKER_SQLITE, type Database } from './sqlite.js'

export interface LateIndex {
  /** The index's name, as `sql` creates it. */
  name: string
  /** The table it indexes. */
  table: string
  /** `CREATE INDEX IF NOT EXISTS <name> ON <table>(...)`. */
  sql: string
  /** A read of the columns the index holds, run before the build to bring their pages in. */
  warm: string
}

/** How long after the open the worker starts: past the start's own burst of work. */
export const LATE_INDEX_DELAY_MS = 120_000

const present = new WeakMap<Database, Set<string>>()

/** Whether `db` has the index `name` now (an index once seen is remembered). */
export function hasIndex(db: Database, name: string): boolean {
  const seen = present.get(db)
  if (seen?.has(name)) return true
  const row = db.prepare(`SELECT 1 AS one FROM sqlite_master WHERE type = 'index' AND name = ?`).get(name)
  if (!row) return false
  if (seen) seen.add(name)
  else present.set(db, new Set([name]))
  return true
}

const LATE_INDEX_WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
${WORKER_SQLITE}
const done = []
let db
try {
  // create: false: a file removed meanwhile is not made again, empty.
  db = new Database(workerData.file, { create: false })
  db.exec('PRAGMA busy_timeout = ' + workerData.busyTimeout)
  for (const ix of workerData.indexes) {
    db.query(ix.warm).all()
    db.exec(ix.sql)
    done.push(ix.name)
  }
  parentPort.postMessage({ ok: true, done })
} catch (error) {
  parentPort.postMessage({ ok: false, done, message: error && error.message ? error.message : String(error) })
} finally {
  try { db && db.close() } catch {}
}
`

/** What a build reports: the indexes it made, and why it stopped when it did not finish. */
export type LateIndexReport = (built: string[], error?: string) => void

interface Pending { file: string; indexes: LateIndex[]; timer: ReturnType<typeof setTimeout> | null; run: Promise<string[]> | null; report?: LateIndexReport }
const pending = new Map<string, Pending>()

function buildOffThread(file: string, indexes: LateIndex[], busyTimeout: number, report?: LateIndexReport): Promise<string[]> {
  return new Promise((resolve) => {
    const worker = new Worker(LATE_INDEX_WORKER, { eval: true, workerData: { file, indexes, busyTimeout } })
    let settled = false
    const settle = (done: string[], error?: string): void => {
      if (settled) return
      settled = true
      void worker.terminate()
      // What was not built, the next open asks for again.
      try { report?.(done, error) } catch { /* a report never fails the build */ }
      resolve(done)
    }
    worker.once('message', (m: { ok: boolean; done: string[]; message?: string }) => settle(m.done, m.ok ? undefined : m.message))
    worker.once('error', (err) => settle([], err instanceof Error ? err.message : String(err)))
    worker.once('exit', (code) => settle([], `the worker exited with code ${code}`))
  })
}

/**
 * Give `db` these indexes: at once on a table with no rows (or an in-memory database), else
 * on a worker LATE_INDEX_DELAY_MS after this call. Missing ones only; never throws.
 */
export function ensureLateIndexes(
  db: Database,
  indexes: readonly LateIndex[],
  opts: { delayMs?: number; busyTimeout?: number; report?: LateIndexReport } = {},
): void {
  const later: LateIndex[] = []
  for (const ix of indexes) {
    try {
      if (hasIndex(db, ix.name)) continue
      const file = db.name
      const empty = !db.prepare(`SELECT 1 AS one FROM ${ix.table} LIMIT 1`).get()
      if (empty || !file || file === ':memory:') db.exec(ix.sql)
      else later.push(ix)
    } catch { /* the next open asks again */ }
  }
  if (later.length === 0) return
  const file = db.name
  const known = pending.get(file)
  if (known) {
    for (const ix of later) if (!known.indexes.some((k) => k.name === ix.name)) known.indexes.push(ix)
    return
  }
  const entry: Pending = { file, indexes: later, timer: null, run: null, report: opts.report }
  pending.set(file, entry)
  entry.timer = setTimeout(() => { void runPending(entry, opts.busyTimeout ?? 5_000) }, opts.delayMs ?? LATE_INDEX_DELAY_MS)
  entry.timer.unref?.()
}

function runPending(entry: Pending, busyTimeout: number): Promise<string[]> {
  if (entry.timer) { clearTimeout(entry.timer); entry.timer = null }
  entry.run ??= buildOffThread(entry.file, entry.indexes, busyTimeout, entry.report).finally(() => { pending.delete(entry.file) })
  return entry.run
}

/** Tests: build every index still waiting now, and wait for it. */
export async function buildLateIndexesNow(): Promise<string[]> {
  const built = await Promise.all([...pending.values()].map((e) => runPending(e, 5_000)))
  return built.flat()
}
