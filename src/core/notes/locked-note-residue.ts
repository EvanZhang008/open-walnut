/**
 * After a lock, the note's old text leaves the search databases too (docs/reference/locked-notes.md,
 * "What is on disk"). Re-indexing a locked note replaces its rows with the stub, but SQLite keeps
 * what it replaced: in free pages, in deleted full-text entries until their segments merge, and in
 * the write-ahead log until it is reset. An agent that reads the files directly (`strings` over a
 * database) could find it there. So once both indexes hold the stub, each database:
 *
 *   1. merges its full-text segments (FTS5 'merge', all levels), which drops the deleted entries;
 *   2. writes zeros over every free page (a table of zero blobs that takes them all, then dropped);
 *   3. checkpoints and truncates its write-ahead log.
 *
 * better-sqlite3 is synchronous, so every step is small (about 64 pages of work), waits on no other
 * connection (busy_timeout 0 for that one call: a busy database answers at once and the step is tried
 * again after a real pause), and pauses between steps. A large index still takes a while (a merge
 * rewrites the full-text index: on a 1 GB search database about a minute of background work and
 * about as much written), which a lock, a rare step, pays once: wipes asked for while one waits run
 * as one. A wipe that did not finish (a restart, a database busy the whole time) leaves a mark in
 * the data folder, and the next start runs it again. A hidden note pays none of this: its file is
 * plain on disk by design, so only its index rows go back to the stub (no wipe).
 *
 * Both databases also open with `secure_delete = FAST` (notes-index.ts, hybrid-search db.ts), which
 * zeroes what a later delete frees inside a page at no extra I/O.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Database as DatabaseType } from '../../lib/sqlite.js'
import { WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'

/** Pages of FTS5 merge work per step, and free pages taken per zero blob. */
const MERGE_PAGES = 64
const FILL_PAGES = 256
const MAX_STEPS = 200_000
/** The real pause between two steps, so other work runs between them. */
const STEP_PAUSE_MS = 10
/** A step a busy database refused is tried again this often, this many times. */
const BUSY_PAUSE_MS = 500
const BUSY_TRIES = 240
const WIPE_TABLE = 'walnut_wipe_free_pages'

const pause = (ms = 0) => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); t.unref?.() })

export interface WipeReport { merged: number; zeroedPages: number; walTruncated: boolean }

function totalChanges(db: DatabaseType): number {
  return (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
}

const isBusy = (err: unknown) => /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(String((err as { code?: unknown })?.code ?? '') + String((err as Error)?.message ?? ''))

/**
 * Run one synchronous step without waiting on another connection inside SQLite (that wait would
 * hold the event loop): busy_timeout is 0 for this call only (nothing else runs on this thread
 * meanwhile), and a busy answer is tried again after a real pause. Undefined when it stayed busy.
 */
async function step<T>(db: DatabaseType, work: () => T): Promise<T | undefined> {
  for (let i = 0; i < BUSY_TRIES && db.open; i++) {
    const was = Number(db.pragma('busy_timeout', { simple: true }))
    db.pragma('busy_timeout = 0')
    try {
      return work()
    } catch (err) {
      if (!isBusy(err)) throw err
    } finally {
      if (db.open) db.pragma(`busy_timeout = ${was}`)
    }
    await pause(BUSY_PAUSE_MS)
  }
  return undefined
}

/** Steps 1 to 3 on one open database; `fts` names its FTS5 tables. */
export async function wipeFreedText(db: DatabaseType, fts: readonly string[]): Promise<WipeReport> {
  const report: WipeReport = { merged: 0, zeroedPages: 0, walTruncated: false }
  for (const table of fts) {
    if (!db.open) return report
    const merge = db.prepare(`INSERT INTO ${table}(${table}, rank) VALUES('merge', ?)`)
    // A step that changes fewer than two rows did no merge work: the table is one segment now.
    for (let i = 0; i < MAX_STEPS; i++) {
      if (!db.open) return report
      const moved = await step(db, () => { const before = totalChanges(db); merge.run(-MERGE_PAGES); return totalChanges(db) - before })
      if (moved === undefined) return report
      if (moved < 2) break
      report.merged++
      await pause(STEP_PAUSE_MS)
    }
  }
  if (!db.open) return report
  const pageSize = Number(db.pragma('page_size', { simple: true }))
  if ((await step(db, () => db.exec(`CREATE TABLE IF NOT EXISTS ${WIPE_TABLE} (b BLOB)`))) === undefined) return report
  try {
    for (let i = 0; i < MAX_STEPS && db.open; i++) {
      const free = Number(db.pragma('freelist_count', { simple: true }))
      if (free <= 0) break
      // A blob of n pages takes n free pages (its overflow chain) and writes them as zeros.
      const pages = Math.min(free, FILL_PAGES)
      if ((await step(db, () => db.prepare(`INSERT INTO ${WIPE_TABLE} (b) VALUES (zeroblob(?))`).run(pages * pageSize - 64))) === undefined) break
      report.zeroedPages += pages
      await pause(STEP_PAUSE_MS)
    }
  } finally {
    // Its pages go back to the free list holding only zeros (a table left by a crash goes with the next wipe).
    if (db.open) await step(db, () => db.exec(`DROP TABLE IF EXISTS ${WIPE_TABLE}`))
  }
  // A reader in the middle of a query holds the log: a busy checkpoint answers at once, tried again later.
  for (let i = 0; i < BUSY_TRIES && db.open; i++) {
    const row = (await step(db, () => db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>))?.[0]
    if (row && row.busy === 0) { report.walTruncated = true; break }
    await pause(BUSY_PAUSE_MS)
  }
  return report
}

/** The data folder's mark of a wipe asked for and not finished: the next start runs it. */
export const wipePendingPath = () => path.join(WALNUT_HOME, 'locked-notes-wipe-pending')
function markPending(on: boolean): void {
  try {
    if (on) fs.writeFileSync(wipePendingPath(), `${new Date().toISOString()}\n`, { mode: 0o600 })
    else fs.rmSync(wipePendingPath(), { force: true })
  } catch { /* a mark that cannot be written: this run still wipes */ }
}

/** Notes whose index rows go back to the stub before the next wipe, and whether that wipe runs. */
const waiting = new Map<string, string>()
let wipeAsked = false
let running: Promise<void> | null = null

async function runAll(): Promise<void> {
  while (waiting.size || wipeAsked) {
    const notes = [...waiting]
    waiting.clear()
    const wipe = wipeAsked
    wipeAsked = false
    try {
      const { reconcileNoteNow } = await import('../notes-indexer.js')
      const search = await import('../search/wiring.js')
      for (const [relPath, absPath] of notes) {
        await reconcileNoteNow(relPath)
        await search.upsertSearchV2File('note', absPath)
      }
      if (!wipe) continue
      const { getNotesIndexDb } = await import('../notes-index.js')
      let done = true
      const notesDb = getNotesIndexDb()
      if (notesDb) {
        const r = await wipeFreedText(notesDb, ['notes_fts', 'attachment_fts'])
        done &&= r.walTruncated
        log.memory.info('locked note: notes index wiped', { notes: notes.length, ...r })
      }
      if (search.isSearchV2Enabled() && search.searchV2IndexOpen()) {
        const r = await wipeFreedText(search.getSearchV2Index().db, ['doc_fts'])
        done &&= r.walTruncated
        log.memory.info('locked note: search index wiped', { notes: notes.length, ...r })
      }
      // Asked again meanwhile: the mark stays for the next round.
      if (done && !wipeAsked) markPending(false)
    } catch (err) {
      log.memory.warn('locked note: wiping the old text from the indexes failed', { notes: notes.map(([p]) => p), error: err instanceof Error ? err.message : String(err) })
    }
  }
}

function kick(): Promise<void> {
  if (!running) running = runAll().finally(() => { running = null })
  return running
}

/**
 * Bring both indexes to the stub of `relPath`, then (`wipe`, after a lock) wipe what they freed.
 * Asks that come while one runs join the next round, so many locks wipe once. A failure is logged,
 * never thrown (the lock itself is done).
 */
export function wipeLockedNoteResidue(relPath: string, absPath: string, opts: { wipe?: boolean } = {}): Promise<void> {
  waiting.set(relPath, absPath)
  if (opts.wipe !== false) { wipeAsked = true; markPending(true) }
  return kick()
}

/** At start: a wipe that did not finish before (a restart, a database busy all along) runs again, after a while. */
export function resumePendingWipe(delayMs = 120_000): void {
  if (!fs.existsSync(wipePendingPath())) return
  const t = setTimeout(() => { wipeAsked = true; void kick() }, delayMs)
  t.unref?.()
}

/** Tests: wait for the wipes started so far. */
export async function settleLockedNoteResidue(): Promise<void> {
  while (running) await running
}
