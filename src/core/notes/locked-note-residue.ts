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
 * Every step is small and yields between steps (better-sqlite3 is synchronous: one long call would
 * hold every route), so a large index takes a while in the background, never a stall. Both
 * databases also open with `secure_delete = FAST` (notes-index.ts, hybrid-search db.ts), which
 * zeroes what a later delete frees inside a page at no extra I/O.
 */
import type { Database as DatabaseType } from '../../lib/sqlite.js'
import { log } from '../../logging/index.js'

/** Pages of FTS5 merge work per step, and free pages taken per zero blob. */
const MERGE_PAGES = 256
const FILL_PAGES = 256
const MAX_STEPS = 200_000
const WIPE_TABLE = 'walnut_wipe_free_pages'

const pause = (ms = 0) => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); t.unref?.() })

export interface WipeReport { merged: number; zeroedPages: number; walTruncated: boolean }

function totalChanges(db: DatabaseType): number {
  return (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
}

/** Steps 1 to 3 on one open database; `fts` names its FTS5 tables. */
export async function wipeFreedText(db: DatabaseType, fts: readonly string[]): Promise<WipeReport> {
  const report: WipeReport = { merged: 0, zeroedPages: 0, walTruncated: false }
  for (const table of fts) {
    // A step that changes fewer than two rows did no merge work: the table is one segment now.
    for (let i = 0; i < MAX_STEPS; i++) {
      if (!db.open) return report
      const before = totalChanges(db)
      db.prepare(`INSERT INTO ${table}(${table}, rank) VALUES('merge', ?)`).run(-MERGE_PAGES)
      if (totalChanges(db) - before < 2) break
      report.merged++
      await pause()
    }
  }
  if (!db.open) return report
  const pageSize = Number(db.pragma('page_size', { simple: true }))
  db.exec(`CREATE TABLE IF NOT EXISTS ${WIPE_TABLE} (b BLOB)`)
  try {
    for (let i = 0; i < MAX_STEPS && db.open; i++) {
      const free = Number(db.pragma('freelist_count', { simple: true }))
      if (free <= 0) break
      // A blob of n pages takes n free pages (its overflow chain) and writes them as zeros.
      const pages = Math.min(free, FILL_PAGES)
      db.prepare(`INSERT INTO ${WIPE_TABLE} (b) VALUES (zeroblob(?))`).run(pages * pageSize - 64)
      report.zeroedPages += pages
      await pause()
    }
  } finally {
    // Its pages go back to the free list holding only zeros.
    if (db.open) db.exec(`DROP TABLE IF EXISTS ${WIPE_TABLE}`)
  }
  // A reader in the middle of a query holds the log: try again a few times.
  for (let i = 0; i < 10 && db.open; i++) {
    const row = (db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>)[0]
    if (!row || row.busy === 0) { report.walTruncated = true; break }
    await pause(500)
  }
  return report
}

let chain: Promise<void> = Promise.resolve()

/**
 * Bring both indexes to the stub of the note just locked, then wipe what they freed. One at a time
 * for the whole process; a failure is logged, never thrown (the lock itself is done).
 */
export function wipeLockedNoteResidue(relPath: string, absPath: string): Promise<void> {
  const run = async () => {
    const { reconcileNoteNow } = await import('../notes-indexer.js')
    const { getNotesIndexDb } = await import('../notes-index.js')
    const search = await import('../search/wiring.js')
    await reconcileNoteNow(relPath)
    await search.upsertSearchV2File('note', absPath)
    const notesDb = getNotesIndexDb()
    if (notesDb) log.memory.info('locked note: notes index wiped', { path: relPath, ...(await wipeFreedText(notesDb, ['notes_fts', 'attachment_fts'])) })
    if (search.isSearchV2Enabled() && search.searchV2IndexOpen()) {
      log.memory.info('locked note: search index wiped', { path: relPath, ...(await wipeFreedText(search.getSearchV2Index().db, ['doc_fts'])) })
    }
  }
  const next = chain.then(run).catch((err: unknown) => {
    log.memory.warn('locked note: wiping the old text from the indexes failed', { path: relPath, error: err instanceof Error ? err.message : String(err) })
  })
  chain = next
  return next
}

/** Tests: wait for the wipes started so far. */
export function settleLockedNoteResidue(): Promise<void> {
  return chain
}
