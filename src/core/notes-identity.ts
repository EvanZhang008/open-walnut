/**
 * notes-identity.ts — id migration for the notes vault (IMPL-CONTRACT §2 / tech §8.3, §12).
 *
 * Two operations, both reuse the reconciler's guarded byte-preserving back-write
 * and the structural index; neither touches git-sync.ts:
 *
 *  1. stampAllIds()  — the "stamp all ids now" batched migration (§12.3). New notes
 *     get an id at create-time; legacy / git-pulled / AI-written notes get one
 *     lazily on first reconcile. This batches that back-write across the WHOLE
 *     vault in one pass so a user (or boot, for an id-less legacy vault) can reach
 *     full id coverage immediately, instead of file-by-file as each note is touched.
 *
 *  2. mergeDivergentIds() — the earliest-created-wins merge (§8.3 layer 3). When a
 *     git merge across two machines leaves the SAME logical note with TWO ids
 *     (two independent generators raced on an id-less note), the deterministic
 *     tie-break is: earliest `created` wins (then earliest id timestamp). The
 *     reconciler re-points inbound links from the losing id to the winner (an
 *     index UPDATE — links key on id) and rewrites the loser's `id:` line on disk
 *     so both histories converge. Logged + reversible (files stay source of truth).
 *
 * Identity guard (shared with the reconciler, §8.3): every disk write is under
 * `withUserFileLock(<note>.md)` + a re-read-and-hash-recheck, so a migration pass can
 * never clobber an in-flight edit. A note that changes underneath us is skipped
 * and picked up on the next reconcile.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { NOTES_DIR } from '../constants.js'
import { withFileLock } from '../utils/file-lock.js'
import { withUserFileLock } from '../utils/user-file-lock.js'
import { computeContentHash } from '../utils/file-ops.js'
import {
  parseFrontmatter,
  readId,
  generateNoteId,
  stampId,
  idTimestamp,
} from './parse-frontmatter.js'
import {
  NOTES_INDEX_PATH,
  divergentCopyGroups,
  repointLinks,
  reresolveAllEdges,
  setIndexMeta,
} from './notes-index.js'
import { reconcileNote, collectIndexableNotePaths } from './notes-indexer.js'
import { log } from '../logging/index.js'

export interface StampAllResult {
  /** Total indexable notes scanned. */
  scanned: number
  /** Notes that gained a new id (were id-less and got a guarded back-write). */
  stamped: number
  /** Notes skipped because they changed under the lock (retry next cycle). */
  skipped: number
}

/**
 * Stamp a stable frontmatter id into every id-less note in the vault (batched).
 *
 * - Idempotent: a note that already has an id is left byte-for-byte untouched.
 * - Guarded: the splice happens under `withUserFileLock` with a hash recheck, so an
 *   in-flight edit is never clobbered (the note is skipped, reconciled later).
 * - After each stamp the note is reconciled so the index row matches disk and any
 *   inbound links that named it can resolve.
 *
 * This is the admin "stamp all ids now" action AND the legacy-vault startup
 * migration. Callers should run it off the event loop (it walks the vault).
 */
export async function stampAllIds(): Promise<StampAllResult> {
  const relPaths = await collectIndexableNotePaths()
  let stamped = 0
  let skipped = 0
  for (const relPath of relPaths) {
    const abs = path.join(NOTES_DIR, relPath)
    let bytes: string
    try {
      bytes = await fsp.readFile(abs, 'utf-8')
    } catch {
      continue // gone since the walk — deletion reconcile handles it
    }
    const { data } = parseFrontmatter(bytes)
    if (readId(data)) {
      // Already identified — ensure it is in the index, then move on.
      await reconcileNote(relPath).catch(() => {})
      continue
    }
    const baseHash = computeContentHash(bytes)
    const id = generateNoteId()
    const stampedBytes = stampId(bytes, id)
    let wrote = false
    try {
      await withUserFileLock(abs, async () => {
        const current = await fsp.readFile(abs, 'utf-8')
        if (computeContentHash(current) !== baseHash) return // changed → skip
        await fsp.writeFile(abs, stampedBytes, 'utf-8')
        wrote = true
      })
    } catch (err) {
      log.memory.debug('notes-identity: stamp back-write failed', {
        path: relPath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    if (wrote) {
      stamped++
      await reconcileNote(relPath).catch(() => {})
    } else {
      skipped++
    }
  }
  setIndexMeta('last_stamp_all', new Date().toISOString())
  log.memory.info('notes-identity: stamp-all complete', {
    scanned: relPaths.length,
    stamped,
    skipped,
  })
  return { scanned: relPaths.length, stamped, skipped }
}

/**
 * Pick the winner of an earliest-created-wins tie-break among colliding notes.
 * Rule (§8.3): earliest frontmatter `created` wins; ties broken by earliest id
 * timestamp; final tie broken by lexicographic id (so the choice is total +
 * deterministic across machines). Returns the winner entry.
 */
function pickEarliest<T extends { id: string; created: string | null }>(group: T[]): T {
  return [...group].sort((a, b) => {
    const ca = a.created ? Date.parse(a.created) : NaN
    const cb = b.created ? Date.parse(b.created) : NaN
    const aHas = Number.isFinite(ca)
    const bHas = Number.isFinite(cb)
    if (aHas && bHas && ca !== cb) return ca - cb
    if (aHas !== bHas) return aHas ? -1 : 1 // a note WITH a created date is "earlier"
    const ta = idTimestamp(a.id)
    const tb = idTimestamp(b.id)
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })[0]
}

export interface MergeResult {
  /** Number of collision groups (same logical note, >1 id) that were merged. */
  groups: number
  /** Total losing ids whose inbound links were re-pointed to a winner. */
  repointedIds: number
}

/**
 * Resolve divergent ids for the same logical note (earliest-created-wins, §8.3).
 *
 * A divergence = two+ DISTINCT notes with DIFFERENT ids but byte-identical
 * title+body — the signature of one id-less note that two machines independently
 * stamped and a git merge left as two copies. (Two notes that merely share a
 * title but have different bodies are legitimately separate and are NEVER merged
 * — that case stays an `ambiguous` link.) For each divergent group:
 *   1. Pick the earliest-created winner (deterministic across machines).
 *   2. For each loser: re-point inbound link edges loser→winner, drop the loser's
 *      own index row, and rewrite the loser FILE's `id:` line to the winner id so
 *      both copies converge to one identity (file content otherwise untouched —
 *      reversible; files stay source of truth).
 *
 * Result: one id per logical note, inbound links re-pointed, 0 orphaned links.
 * Runs off the event loop (admin action / post-pull settle); never at the
 * per-save hot path.
 */
export async function mergeDivergentIds(): Promise<MergeResult> {
  const groups = divergentCopyGroups()
  let merged = 0
  let repointedIds = 0
  for (const group of groups) {
    const winner = pickEarliest(group)
    const losers = group.filter((e) => e.id !== winner.id)
    if (losers.length === 0) continue
    for (const loser of losers) {
      repointedIds += await mergeNoteIds({
        loserId: loser.id,
        winnerId: winner.id,
        loserPath: loser.path,
      })
    }
    merged++
  }
  if (merged > 0) {
    await withFileLock(NOTES_INDEX_PATH, async () => { reresolveAllEdges() })
    setIndexMeta('last_id_merge', new Date().toISOString())
    log.memory.info('notes-identity: divergent-id merge complete', {
      groups: merged,
      repointedIds,
    })
  }
  return { groups: merged, repointedIds }
}

/**
 * Re-point inbound links from `loserId` to `winnerId` and rewrite the loser note
 * file's `id:` line to the winner — the cross-machine merge primitive (§8.3
 * layer 3). Used by mergeDivergentIds and exposed for the multi-machine merge
 * test + admin tooling. The loser file content (minus the id line) is preserved.
 * Returns the count of inbound edges re-pointed.
 */
export async function mergeNoteIds(opts: {
  loserId: string
  winnerId: string
  loserPath: string
}): Promise<number> {
  const { loserId, winnerId, loserPath } = opts
  if (loserId === winnerId) return 0
  const rel = loserPath.replace(/\\/g, '/')
  const abs = path.join(NOTES_DIR, rel)
  // Re-point inbound edges first (index op — links key on id). repointLinks also
  // drops the loser's own note row + outgoing edges/tags and rewrites ambiguous
  // candidate lists that named the loser.
  const repointed = repointLinks(loserId, winnerId)
  // Converge the loser FILE's id line to the winner (guarded). We do NOT reconcile
  // the loser path afterward: the winner already owns the id at the winner path,
  // and re-indexing the loser path under the same id would MOVE the winner's row
  // onto the loser path (id is the PK). The loser file content (minus the id line)
  // stays on disk verbatim — a redundant duplicate carrying the winner id.
  try {
    const bytes = await fsp.readFile(abs, 'utf-8')
    const baseHash = computeContentHash(bytes)
    const rewritten = stampId(stripId(bytes), winnerId)
    await withUserFileLock(abs, async () => {
      const current = await fsp.readFile(abs, 'utf-8')
      if (computeContentHash(current) !== baseHash) return
      await fsp.writeFile(abs, rewritten, 'utf-8')
    })
  } catch (err) {
    log.memory.debug('notes-identity: mergeNoteIds file rewrite skipped', {
      path: rel,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  log.memory.info('notes-identity: merged note ids', { loserId, winnerId, repointed })
  return repointed
}

/**
 * Remove the `id:` line from a note's frontmatter, preserving the rest
 * byte-for-byte. Inverse of stampId for the id-line slot only — used by the merge
 * before re-stamping the winner id (so we never leave two `id:` lines).
 */
function stripId(bytes: string): string {
  const { raw, body, hasFrontmatter } = parseFrontmatter(bytes)
  if (!hasFrontmatter || !raw) return bytes
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const lines = raw.split(/\r?\n/)
  // Inner YAML = everything after the opening fence (line 0) up to the closing
  // fence. Find the closing `---` (last line that is exactly the fence).
  let closeIdx = lines.length - 1
  while (closeIdx > 0 && lines[closeIdx].trim() !== '---') closeIdx--
  const inner = lines.slice(1, closeIdx)
  const innerKept = inner.filter((line) => !/^\s*id\s*:/.test(line))
  // If removing the id emptied the frontmatter, drop the whole block so a later
  // re-stamp produces a single clean fence (never a doubled `---\n---`).
  if (innerKept.length === 0) return body
  const rebuiltRaw = `---${eol}${innerKept.join(eol)}${eol}---${eol}`
  return rebuiltRaw + body
}
