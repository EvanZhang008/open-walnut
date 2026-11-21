/**
 * Inspect a database file read-only on a worker thread: PRAGMA integrity_check, its
 * tables and rows, and optionally one row of a query. An integrity check of a large
 * database is one long synchronous call; on the server's thread it would hold every
 * route (CLAUDE.md, "No sync blocking on the event loop"). Like the VACUUM INTO worker
 * in sqlite.ts, the worker opens its own connection with bun:sqlite, the same SQLite
 * this process already loaded. Used by the restore drill (core/backup/restore-drill-checks.ts).
 */
import { Worker } from 'node:worker_threads'

const INSPECT_WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
let db
try {
  const { Database } = require('bun:sqlite')
  db = new Database(workerData.file, { readonly: true })
  const integrity = db.query('PRAGMA integrity_check').all().map((r) => Object.values(r)[0])
  const ok = integrity.length === 1 && integrity[0] === 'ok'
  const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name)
  let rows = 0
  for (const t of tables) {
    try { rows += db.query('SELECT COUNT(*) AS n FROM "' + t.replace(/"/g, '""') + '"').get().n } catch { /* a virtual table without its module */ }
  }
  // The caller's own read: its failure is reported beside the check, never as the check's.
  let row = null
  let rowError
  if (workerData.query) {
    try { row = db.query(workerData.query).get() || null } catch (e) { rowError = e && e.message ? e.message : String(e) }
  }
  parentPort.postMessage({ ok, detail: ok ? undefined : integrity.slice(0, 3).join('; '), tables: tables.length, rows, row, rowError })
} catch (error) {
  parentPort.postMessage({ ok: false, detail: error && error.message ? error.message : String(error) })
} finally {
  try { db && db.close() } catch {}
}
`

export interface InspectResult {
  /** integrity_check said exactly "ok". */
  ok: boolean
  /** integrity_check's first lines, or why the file did not open. */
  detail?: string
  tables?: number
  rows?: number
  /** The first row of `query`, or null. */
  row?: Record<string, unknown> | null
  /** `query` failed (the check itself may still be ok). */
  rowError?: string
}

const INSPECT_TIMEOUT_MS = 10 * 60_000

export function inspectSqliteOffThread(file: string, opts: { query?: string; timeoutMs?: number } = {}): Promise<InspectResult> {
  return new Promise((resolve) => {
    const worker = new Worker(INSPECT_WORKER, { eval: true, workerData: { file, query: opts.query } })
    let settled = false
    const timeoutMs = opts.timeoutMs ?? INSPECT_TIMEOUT_MS
    const settle = (r: InspectResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      resolve(r)
    }
    const timer = setTimeout(() => settle({ ok: false, detail: `the check took over ${Math.round(timeoutMs / 1000)} s` }), timeoutMs)
    timer.unref?.()
    worker.once('message', (m: InspectResult) => settle(m))
    worker.once('error', (err) => settle({ ok: false, detail: err instanceof Error ? err.message : String(err) }))
    worker.once('exit', (code) => settle({ ok: false, detail: `the check's worker exited with code ${code}` }))
  })
}
