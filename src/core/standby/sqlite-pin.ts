/**
 * Every SQLite database of a batch, taken at one moment, all or nothing.
 *
 * The backup takes one database at a time with VACUUM INTO and skips one that fails
 * (src/core/backup/sqlite-snapshot.ts): right for a backup, wrong for a standby, whose
 * databases must all be of the same moment. Here a worker thread opens each database
 * read-only and starts a read transaction on it (a "pin": in WAL mode the reader keeps
 * seeing that commit, whatever writers do after). Pinning every database takes a few ms;
 * a commit that lands between the first pin and the last (seen as a -wal that grew) means
 * the pins are not of one moment, so they are dropped and taken again. Then each database
 * is copied with sqlite3_serialize inside its pinned transaction: the copy is exactly the
 * pinned state, page for page (so the next batch's copy shares most chunks with this one).
 * VACUUM INTO cannot run inside a transaction, which is why it is not used here.
 *
 * Any database that cannot be opened, pinned or copied fails the whole batch.
 *
 * Cost: a database is held in the worker's memory while it is written out (its size).
 */
import { Worker } from 'node:worker_threads'
import Database from '../../lib/sqlite.js'

const PIN_WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const { Database } = require('bun:sqlite')
const fs = require('node:fs')
const path = require('node:path')
const open = []
const walSize = (file) => { try { return fs.statSync(file + '-wal').size } catch { return -1 } }
const ensureWal = (file) => {
  // A read-only connection to a WAL database needs its -wal to exist (src/lib/sqlite.ts).
  try {
    if (fs.existsSync(file + '-wal')) return
    const h = Buffer.alloc(20); const fd = fs.openSync(file, 'r')
    try { if (fs.readSync(fd, h, 0, 20, 0) < 20 || h[18] !== 2 || h[19] !== 2) return } finally { fs.closeSync(fd) }
    fs.writeFileSync(file + '-wal', '', { flag: 'wx', mode: fs.statSync(file).mode & 0o777 })
  } catch {}
}
const endAll = () => { for (const o of open) { try { o.db.exec('COMMIT') } catch {} } }
const closeAll = () => {
  endAll()
  for (const o of open.splice(0)) { try { o.db.close() } catch {} }
}
parentPort.on('message', (m) => {
  try {
    if (m.cmd === 'open') {
      // Before the hold: opening a connection costs more than pinning one.
      closeAll()
      for (const file of m.files) {
        ensureWal(file)
        const db = new Database(file, { readonly: true })
        db.exec('PRAGMA busy_timeout = 5000')
        open.push({ file, db, wal: -1 })
      }
      parentPort.postMessage({ ok: true })
    } else if (m.cmd === 'pin') {
      for (let attempt = 1; attempt <= m.attempts; attempt++) {
        endAll()
        const pinnedAt = Date.now()
        for (const o of open) {
          o.db.exec('BEGIN')
          o.db.query('SELECT count(*) FROM sqlite_master').get()
          o.wal = walSize(o.file)
        }
        // A commit after a database's pin grows its -wal (a pinned reader keeps it from
        // being reset): any growth before the last pin means the pins are not one moment.
        if (open.every((o) => walSize(o.file) === o.wal)) {
          parentPort.postMessage({ ok: true, pinnedAt, pinnedEnd: Date.now(), attempts: attempt })
          return
        }
      }
      endAll()
      parentPort.postMessage({ ok: false, message: 'databases kept changing while they were pinned' })
    } else if (m.cmd === 'copy') {
      const o = open[m.index]
      const bytes = o.db.serialize()
      fs.mkdirSync(path.dirname(m.dest), { recursive: true })
      fs.writeFileSync(m.dest, bytes)
      parentPort.postMessage({ ok: true, size: bytes.length })
    } else if (m.cmd === 'close') {
      closeAll()
      parentPort.postMessage({ ok: true })
    }
  } catch (error) {
    parentPort.postMessage({ ok: false, message: error && error.message ? error.message : String(error) })
  }
})
`

export interface Pin {
  /** Wall clock just before the first pin: the moment of the batch. */
  pinnedAt: number
  /** Wall clock just after the last pin: the databases are as at any instant between the two. */
  pinnedEnd: number
  attempts: number
}

export interface PinWorker {
  /** Pin every database opened, at one moment. Throws when that is not possible. */
  pin(opts?: { attempts?: number }): Promise<Pin>
  /** Write database `index` (in the order given to openPinWorker) as it was pinned to `dest`. */
  copy(index: number, dest: string): Promise<number>
  /** End the read transactions and the worker. Safe to call twice. */
  close(): Promise<void>
}

/** A worker with a read-only connection to each database in `files` (absolute paths), not yet pinned. */
export async function openPinWorker(files: string[]): Promise<PinWorker> {
  // Load SQLite in this process first (on macOS that picks Walnut's own build), so the worker's is the same.
  new Database(':memory:').close()
  const worker = new Worker(PIN_WORKER, { eval: true })
  let pending: { resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void } | null = null
  let dead: Error | null = null
  const fail = (err: Error): void => { dead = err; pending?.reject(err); pending = null }
  worker.on('message', (m: Record<string, unknown>) => { const p = pending; pending = null; p?.resolve(m) })
  worker.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))))
  worker.on('exit', (code) => fail(new Error(`the database pin worker exited (${code})`)))
  const ask = (msg: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (dead) return Promise.reject(dead)
    return new Promise((resolve, reject) => {
      pending = { resolve, reject }
      worker.postMessage(msg)
    }).then((m) => {
      const r = m as Record<string, unknown>
      if (!r.ok) throw new Error(String(r.message ?? 'database pin failed'))
      return r
    })
  }
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await ask({ cmd: 'close' }).catch(() => {})
    worker.removeAllListeners('exit')
    await worker.terminate()
  }
  try {
    await ask({ cmd: 'open', files })
  } catch (err) {
    await close()
    throw err
  }
  return {
    pin: async (opts = {}) => {
      const r = await ask({ cmd: 'pin', attempts: opts.attempts ?? 5 })
      return { pinnedAt: Number(r.pinnedAt), pinnedEnd: Number(r.pinnedEnd), attempts: Number(r.attempts) }
    },
    copy: async (index, dest) => Number((await ask({ cmd: 'copy', index, dest })).size),
    close,
  }
}
