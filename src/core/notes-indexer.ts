/**
 * notes-indexer.ts — the reconciler that keeps notes-index.sqlite + the QMD
 * semantic store in sync with the markdown vault.
 *
 * Design (IMPL-CONTRACT §8, reuses in-repo patterns):
 * - Per-path COALESCING QUEUE + one better-sqlite3 transaction per drain
 *   (not a single global timer): a 500-file git pull becomes one transaction +
 *   one debounced QMD pass, never 500 interleaved reconciles.
 * - HASH-SKIP: skip a note whose file bytes are unchanged (qmd-task-sync shape).
 * - SEMANTIC store driven PER-FILE via insertContent/insertDocument/updateDocument/
 *   deactivateDocument — NEVER store.update() on the save path (that synchronously
 *   re-globs + readFileSync's the whole vault → event-loop starvation).
 * - IDENTITY: id stamped at create-time by the route; this reconciler is the
 *   FALLBACK authority for files that arrive without one (git pull / AI write),
 *   with a guarded byte-preserving back-write (never clobbers an in-flight edit).
 * - withFileLock on every sidecar write + every id back-write.
 *
 * Files stay the source of truth; the index is rebuildable (rebuildIndex()).
 */
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { NOTES_DIR, CLOUD_MODE } from '../constants.js'
import { withFileLock } from '../utils/file-lock.js'
import { getNotesStore, DEFAULT_QMD_MODEL } from './qmd-store.js'
import {
  NOTES_INDEX_PATH,
  upsertNote,
  deleteNoteByPath,
  getNoteHash,
  findNoteIdsByName,
  findNoteIdByPathForm,
  reresolveAllEdges,
  setIndexMeta,
  clearAll,
  type NoteRow,
  type LinkEdge,
  type TagEdge,
} from './notes-index.js'
import {
  parseFrontmatter,
  generateNoteId,
  readId,
  stampId,
} from './parse-frontmatter.js'
import { computeContentHash } from '../utils/file-ops.js'
import { bus, EventNames } from './event-bus.js'
import { log } from '../logging/index.js'

const QMD_COLLECTION = 'vault'

// Wiki-link: [[target]] or [[target|label]]. We resolve on `target` (the part
// before a real `|alias`), matching the on-disk Obsidian-native form (§2.2).
const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g

// Inline #hashtag: `#` at start-of-string or after whitespace, immediately
// followed by a letter, then tag chars. Excludes `C#` (letter before `#`),
// `#123` (digit after `#`), `#frag` in a URL (a `/` or non-space before `#`).
// Matches the FE TagNode trigger contract (§3.2). The capturing group is the slug.
const INLINE_TAG_RE = /(^|[\s(])#([A-Za-z][A-Za-z0-9/_-]*)/g

// ── Tag + title helpers ─────────────────────────────────────────────────────

/** Normalize a tag slug: lowercase, strip leading '#', spaces→'-' (BE+FE must match). */
export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
}

/** Tag sources = frontmatter.tags[] ∪ inline #hashtags. */
function extractTags(data: Record<string, unknown>, body: string): TagEdge[] {
  const set = new Set<string>()
  const fmTags = data.tags
  if (Array.isArray(fmTags)) {
    for (const t of fmTags) {
      if (typeof t === 'string') {
        const slug = normalizeTag(t)
        if (slug) set.add(slug)
      }
    }
  } else if (typeof fmTags === 'string') {
    for (const t of fmTags.split(/[,\s]+/)) {
      const slug = normalizeTag(t)
      if (slug) set.add(slug)
    }
  }
  // Strip fenced code blocks so a `#comment` inside code isn't a tag.
  const noCode = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '')
  let m: RegExpExecArray | null
  INLINE_TAG_RE.lastIndex = 0
  while ((m = INLINE_TAG_RE.exec(noCode)) !== null) {
    const slug = normalizeTag(m[2])
    if (slug) set.add(slug)
  }
  return [...set].map((tag) => ({ tag }))
}

function firstH1(body: string): string | null {
  const m = body.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : null
}

/** Extract + resolve outgoing wiki-link edges to target ids (Obsidian-native §2.2/§4.3). */
function extractLinks(srcId: string, body: string): LinkEdge[] {
  const edges: LinkEdge[] = []
  let m: RegExpExecArray | null
  WIKI_LINK_RE.lastIndex = 0
  while ((m = WIKI_LINK_RE.exec(body)) !== null) {
    const target = m[1].trim()
    if (!target) continue
    const start = Math.max(0, m.index - 30)
    const end = Math.min(body.length, m.index + m[0].length + 30)
    const context = body.slice(start, end)

    let dstId: string | null = null
    let status: LinkEdge['status'] = 'unresolved'
    let candidates: string[] | undefined

    if (target.includes('/')) {
      // Path form `[[folder/Title]]` → resolve by path (collision-free).
      const byPath = findNoteIdByPathForm(target)
      if (byPath) { dstId = byPath; status = 'resolved' }
    } else {
      // Name form `[[Title]]` → resolve by title/basename.
      const matches = findNoteIdsByName(target).filter((r) => r.id !== srcId)
      if (matches.length === 1) {
        dstId = matches[0].id
        status = 'resolved'
      } else if (matches.length > 1) {
        status = 'ambiguous'
        candidates = matches.map((r) => r.id)
      }
    }
    edges.push({ dstId, dstName: target, status, context, candidates })
  }
  return edges
}

// ── Per-note reconcile ──────────────────────────────────────────────────────

/**
 * Skip hidden dirs. global-notes.md (vault root) is a first-class note: it
 * shows in the tree, indexes, and searches like any other file. The Global
 * Notes widget remains a second editing surface for the same bytes — the two
 * converge via NOTES_UPDATED events + contentHash optimistic locking.
 */
function isIndexableRelPath(relPath: string): boolean {
  if (!relPath.endsWith('.md')) return false
  const parts = relPath.split('/')
  if (parts.some((p) => p.startsWith('.'))) return false
  return true
}

function virtualPathFor(relPath: string): string {
  // QMD virtual path within the 'vault' collection — basename-independent key.
  return relPath.replace(/\\/g, '/')
}

function qmdBodyHash(body: string): string {
  return createHash('sha256').update(body).digest('hex')
}

/**
 * Drive the QMD semantic store for ONE changed note (the qmd-task-sync two-call
 * shape). insertContent is content-addressable by hash; insertDocument/updateDocument
 * maps collection↔path↔hash; hash-skip is the caller's job via findActiveDocument.
 * embed() is already incremental. NEVER calls store.update() here.
 */
async function reconcileSemantic(relPath: string, title: string, body: string): Promise<void> {
  // Cloud companion: no semantic index (same gate as server.ts initQmdStores).
  // Without this, a full rebuild embeds every note and pins the 2-vCPU box.
  if (CLOUD_MODE) return
  try {
    const store = await getNotesStore()
    const docPath = virtualPathFor(relPath)
    const hash = qmdBodyHash(body)
    const existing = store.internal.findActiveDocument(QMD_COLLECTION, docPath)
    if (existing && existing.hash === hash) return // up to date
    const now = new Date().toISOString()
    store.internal.insertContent(hash, body, now)
    if (existing) {
      store.internal.updateDocument(existing.id, title, hash, now)
    } else {
      store.internal.insertDocument(QMD_COLLECTION, docPath, title, hash, now, now)
    }
    const model = process.env.QMD_EMBED_MODEL || DEFAULT_QMD_MODEL
    await store.embed({ model })
  } catch (err) {
    // Semantic is best-effort; structural index is authoritative for exact search.
    log.memory.debug('notes-indexer: semantic reconcile failed', {
      path: relPath,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function removeSemantic(relPath: string): Promise<void> {
  if (CLOUD_MODE) return
  try {
    const store = await getNotesStore()
    store.internal.deactivateDocument(QMD_COLLECTION, virtualPathFor(relPath))
  } catch { /* best-effort */ }
}

/**
 * Reconcile a single note path: structural index (always) + semantic store (best-effort).
 * Returns the note id, or null on deletion / skip.
 */
export async function reconcileNote(relPath: string): Promise<string | null> {
  if (!isIndexableRelPath(relPath)) return null
  const abs = path.join(NOTES_DIR, relPath)

  let bytes: string
  let stat: fs.Stats
  try {
    bytes = await fsp.readFile(abs, 'utf-8')
    stat = await fsp.stat(abs)
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      // Deletion.
      await withFileLock(NOTES_INDEX_PATH, async () => { deleteNoteByPath(relPath) })
      await removeSemantic(relPath)
      return null
    }
    throw err
  }

  const fileHash = computeContentHash(bytes)
  if (getNoteHash(relPath) === fileHash) return null // hash-skip (unchanged)

  let { data, body, raw } = parseFrontmatter(bytes)
  let id = readId(data)

  // FALLBACK id assignment for id-less files (git pull / external/AI write).
  // Guarded back-write: only when the file's current hash still equals what we
  // read under lock — never clobber an in-flight edit (§8.3).
  if (!id) {
    id = generateNoteId()
    const stamped = stampId(bytes, id)
    try {
      let wrote = false
      await withFileLock(abs, async () => {
        const current = await fsp.readFile(abs, 'utf-8')
        if (computeContentHash(current) !== fileHash) return // changed → skip, retry next cycle
        await fsp.writeFile(abs, stamped, 'utf-8')
        wrote = true
      })
      // Re-read the stamped bytes so the index row matches what's on disk.
      bytes = stamped
      const reparsed = parseFrontmatter(stamped)
      data = reparsed.data
      body = reparsed.body
      raw = reparsed.raw
      // The back-write changed the on-disk bytes (and hash) outside any editor
      // save path. Without an event, open editors keep a stale contentHash and
      // their NEXT save 409s for no visible reason — emit the same contract as
      // the write routes so they re-sync. (The reconcile subscriber sees this
      // too, but the follow-up reconcile hash-skips: no loop.)
      if (wrote) {
        bus.emit(
          EventNames.NOTES_UPDATED,
          { source: `notes/${relPath.replace(/\.md$/, '')}`, contentHash: computeContentHash(stamped) },
          ['web-ui'],
        )
      }
    } catch (err) {
      log.memory.debug('notes-indexer: id back-write skipped', {
        path: relPath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const finalHash = computeContentHash(bytes)
  const title =
    (typeof data.title === 'string' && data.title.trim()) ||
    firstH1(body) ||
    path.basename(relPath, '.md')
  // js-yaml auto-parses an ISO date (`created: 2026-01-01T…`) into a Date object,
  // so accept both a string and a Date and normalize to an ISO string.
  const created =
    typeof data.created === 'string'
      ? data.created
      : data.created instanceof Date && !isNaN(data.created.getTime())
        ? data.created.toISOString()
        : null
  const tags = extractTags(data, body)
  const links = extractLinks(id, body)

  const row: NoteRow = {
    id,
    path: relPath.replace(/\\/g, '/'),
    title,
    content_hash: finalHash,
    body,
    frontmatter: raw || null,
    created,
    modified: stat.mtime.toISOString(),
    size: stat.size,
  }

  await withFileLock(NOTES_INDEX_PATH, async () => {
    upsertNote(row, links, tags)
  })
  await reconcileSemantic(relPath, title, body)
  return id
}

// ── Coalescing queue (per-path, single drain) ───────────────────────────────

const dirtyPaths = new Set<string>()
let drainTimer: ReturnType<typeof setTimeout> | null = null
let draining = false
let stopped = false
let rebuilding = false
const DEBOUNCE_MS = 300

/**
 * Schedule a reconcile of one changed path. Coalesces bursts into a single drain.
 * Safe to call from both the in-process bus handler and the fs.watch catch-all.
 */
export function scheduleNotesIndexUpdate(relPath: string): void {
  if (stopped) return
  const norm = relPath.replace(/\\/g, '/')
  if (!isIndexableRelPath(norm)) return
  dirtyPaths.add(norm)
  if (drainTimer) clearTimeout(drainTimer)
  drainTimer = setTimeout(() => { void drainQueue() }, DEBOUNCE_MS)
}

async function drainQueue(): Promise<void> {
  if (stopped) return
  if (draining) {
    // Re-arm so we don't lose the latest burst while a drain is in flight.
    if (drainTimer) clearTimeout(drainTimer)
    drainTimer = setTimeout(() => { void drainQueue() }, DEBOUNCE_MS)
    return
  }
  draining = true
  drainTimer = null
  const batch = [...dirtyPaths]
  dirtyPaths.clear()
  try {
    for (const relPath of batch) {
      if (stopped) break
      try {
        await reconcileNote(relPath)
      } catch (err) {
        log.memory.debug('notes-indexer: reconcile failed', {
          path: relPath,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  } finally {
    draining = false
  }
}

/**
 * Stop the reconciler: cancel the pending debounce timer and drop queued paths.
 * Mirrors startQmdWatcher().stop(). Lets the ephemeral server (temp OPEN_WALNUT_HOME)
 * and tests tear down without a stray debounced reconcile re-creating the sidecar
 * in a directory being removed. Call resetNotesIndexer() to re-arm.
 */
export function stopNotesIndexer(): void {
  stopped = true
  if (drainTimer) { clearTimeout(drainTimer); drainTimer = null }
  dirtyPaths.clear()
}

/** Re-arm the reconciler after a stop (used by tests between cases). */
export function resetNotesIndexer(): void {
  stopped = false
  rebuilding = false
}

/** Reconcile a path immediately (and await it) — used by routes that need the
 * index fresh before responding (e.g. after a PUT that stamped an id). */
export async function reconcileNoteNow(relPath: string): Promise<string | null> {
  return reconcileNote(relPath.replace(/\\/g, '/'))
}

// ── Cold rebuild (off-loop, chunked) ─────────────────────────────────────────

export function isRebuilding(): boolean {
  return rebuilding
}

/** Recursively collect indexable .md relpaths under NOTES_DIR. Exported for the
 * id migration (notes-identity.ts) so it walks the exact same set as a rebuild. */
export async function collectIndexableNotePaths(): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.name.endsWith('.md')) {
        const rel = path.relative(NOTES_DIR, full).replace(/\\/g, '/')
        if (isIndexableRelPath(rel)) out.push(rel)
      }
    }
  }
  await walk(NOTES_DIR)
  return out
}

/**
 * Full structural rebuild: clear + re-walk the vault, yielding to the event loop
 * every CHUNK files so a large vault never blocks. The only O(n) structural pass
 * (startup / explicit rebuild only — never per query).
 *
 * Two-pass: first index every note (so identity exists), then a second pass
 * re-resolves links now that all targets are present (the upsert's re-resolve
 * step handles most, but a clean rebuild benefits from a settle pass).
 */
export async function rebuildIndex(): Promise<void> {
  if (rebuilding || stopped) return
  rebuilding = true
  const startedAt = Date.now()
  try {
    if (stopped) return
    await withFileLock(NOTES_INDEX_PATH, async () => { clearAll() })
    const relPaths = await collectIndexableNotePaths()
    const CHUNK = 50
    for (let i = 0; i < relPaths.length; i++) {
      if (stopped) return // shutdown mid-rebuild — don't write to a torn-down dir
      try {
        await reconcileNote(relPaths[i])
      } catch (err) {
        log.memory.debug('notes-indexer: rebuild reconcile failed', {
          path: relPaths[i],
          error: err instanceof Error ? err.message : String(err),
        })
      }
      if (i % CHUNK === CHUNK - 1) {
        await new Promise((r) => setImmediate(r)) // yield to event loop
      }
    }
    if (stopped) return
    // Settle pass: now that every note has identity, re-resolve all link edges
    // (resolved / ambiguous / unresolved) against the complete notes table.
    await withFileLock(NOTES_INDEX_PATH, async () => { reresolveAllEdges() })
    setIndexMeta('last_full_rebuild', new Date().toISOString())
    log.memory.info('notes-index: full rebuild complete', {
      notes: relPaths.length,
      ms: Date.now() - startedAt,
    })
  } finally {
    rebuilding = false
  }
}

/**
 * Initialize the structural sidecar at server boot. If the DB is empty (fresh /
 * schema bump), kick off a chunked off-loop rebuild WITHOUT blocking boot.
 */
export async function initNotesIndex(): Promise<void> {
  const { getNotesIndexDb, readSchemaVersion, NOTES_INDEX_SCHEMA_VERSION, docCount } =
    await import('./notes-index.js')
  const persisted = readSchemaVersion()
  // Open (creates tables + records current schema_version).
  getNotesIndexDb()
  const stale = persisted !== null && persisted < NOTES_INDEX_SCHEMA_VERSION
  if (stale || docCount() === 0) {
    // Off-loop: don't await — boot proceeds, string search builds in background.
    void rebuildIndex().catch((err) => {
      log.memory.warn('notes-index: initial rebuild failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }
}
