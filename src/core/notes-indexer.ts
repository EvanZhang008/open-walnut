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
import { NOTES_DIR, CLOUD_MODE } from '../constants.js'
import { withFileLock } from '../utils/file-lock.js'
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
  listNoteSyncMeta,
  touchNoteStat,
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
import {
  dispatchQmdIncrementalIndex,
  usesQmdIndexWorker,
} from './qmd-dispatcher.js'

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

/**
 * All section headings (## and deeper — the H1 is already the title), newline-
 * joined for the heading search leg. Author-written section labels are the only
 * findable handle for grab-bag notes ("Gov document" holding an `## SIN` section)
 * whose title/body would otherwise never surface them. Fenced code is stripped
 * so a `# comment` inside a code block isn't a heading.
 */
function sectionHeadings(body: string): string {
  const noCode = body.replace(/```[\s\S]*?```/g, '')
  const out: string[] = []
  // Each line = the heading's ancestor path, " > "-joined ("Eye > prescription"
  // for an `### prescription` under `## Eye`): a query naming the section the
  // way a human remembers it ("eye prescription") spans levels, and the leaf
  // alone is often a one-word label that matches nothing.
  const stack: Array<{ level: number; text: string }> = []
  for (const m of noCode.matchAll(/^(#{2,6})\s+(.+)$/gm)) {
    const level = m[1].length
    const h = m[2].replace(/[*_`~]+/g, '').trim()
    if (!h) continue
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
    stack.push({ level, text: h })
    out.push(stack.map((s) => s.text).join(' > '))
  }
  return out.join('\n')
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

/**
 * Queue one semantic note update. Production returns after enqueue so a note
 * save never waits for native SQLite/vector work; tests use the inline mode and
 * retain deterministic completion.
 */
async function reconcileSemantic(relPath: string): Promise<void> {
  if (CLOUD_MODE) return
  const pending = dispatchQmdIncrementalIndex({ notePaths: [relPath] })
  if (usesQmdIndexWorker()) {
    void pending.catch((err) => {
      log.memory.debug('notes-indexer: semantic reconcile failed', {
        path: relPath,
        error: err instanceof Error ? err.message : String(err),
      })
    })
    return
  }
  try {
    await pending
  } catch (err) {
    log.memory.debug('notes-indexer: semantic reconcile failed', {
      path: relPath,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function removeSemantic(relPath: string): Promise<void> {
  await reconcileSemantic(relPath)
}

interface ReconcileNoteOptions {
  deferSemantic?: boolean
}

/**
 * Reconcile a single note path: structural index (always) + semantic store (best-effort).
 * Returns the note id, or null on deletion / skip.
 */
async function reconcileNoteInternal(
  relPath: string,
  options?: ReconcileNoteOptions,
): Promise<string | null> {
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
      if (!options?.deferSemantic) await removeSemantic(relPath)
      return null
    }
    throw err
  }

  const fileHash = computeContentHash(bytes)
  if (getNoteHash(relPath) === fileHash) {
    // Unchanged content — but refresh the stat columns so an mtime-only touch
    // doesn't keep re-flagging this note in every boot's drift scan.
    await withFileLock(NOTES_INDEX_PATH, async () => {
      touchNoteStat(relPath, stat.mtime.toISOString(), stat.size)
    })
    return null
  }

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
      // Re-stat: the back-write changed mtime+size; storing the PRE-stamp stat
      // would make the boot drift scan flag this note forever.
      try { stat = await fsp.stat(abs) } catch { /* keep the pre-stamp stat */ }
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
    headings: sectionHeadings(body),
  }

  await withFileLock(NOTES_INDEX_PATH, async () => {
    upsertNote(row, links, tags)
  })
  if (!options?.deferSemantic) await reconcileSemantic(relPath)
  return id
}

export async function reconcileNote(relPath: string): Promise<string | null> {
  return reconcileNoteInternal(relPath)
}

// ── Coalescing queue (per-path, single drain) ───────────────────────────────

const dirtyPaths = new Set<string>()
let drainTimer: ReturnType<typeof setTimeout> | null = null
let draining = false
let stopped = false
let rebuilding = false
let rebuildPromise: Promise<void> | null = null
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

export interface RebuildIndexOptions {
  /** Recompute every note vector even when its content hash is unchanged. */
  forceSemantic?: boolean
  /** Surface semantic failures to callers such as the QMD recovery endpoint. */
  strictSemantic?: boolean
  onProgress?: (progress: {
    chunksEmbedded: number
    totalChunks: number
    bytesProcessed: number
    totalBytes: number
  }) => void
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
async function rebuildSemanticIndex(
  options: RebuildIndexOptions,
): Promise<void> {
  if (CLOUD_MODE || stopped) return

  await dispatchQmdIncrementalIndex({
    notesFull: true,
    forceNotes: options.forceSemantic,
  }, {
    onProgress: options.onProgress
      ? (_store, progress) => options.onProgress!(progress)
      : undefined,
  })
  log.memory.info('notes-index: semantic rebuild complete')
}

async function performRebuild(options: RebuildIndexOptions): Promise<void> {
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
        await reconcileNoteInternal(relPaths[i], { deferSemantic: true })
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
    try {
      await rebuildSemanticIndex(options)
    } catch (err) {
      log.memory.warn('notes-index: semantic rebuild failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      if (options.strictSemantic) throw err
    }
    log.memory.info('notes-index: full rebuild complete', {
      notes: relPaths.length,
      ms: Date.now() - startedAt,
    })
  } finally {
    rebuilding = false
  }
}

export function rebuildIndex(options: RebuildIndexOptions = {}): Promise<void> {
  if (rebuildPromise) {
    const requiresOwnSemanticPass =
      options.forceSemantic || options.strictSemantic || options.onProgress
    return requiresOwnSemanticPass
      ? rebuildPromise.then(() => rebuildIndex(options))
      : rebuildPromise
  }
  if (stopped) return Promise.resolve()

  rebuildPromise = performRebuild(options).finally(() => {
    rebuildPromise = null
  })
  return rebuildPromise
}

/**
 * Drift scan: reconcile changes made while the server was NOT running.
 *
 * The fs.watch pipeline only sees changes while the process is alive — notes
 * edited by Obsidian/agents/git during downtime silently diverged from the
 * index until the next full rebuild. This scan closes that gap at boot:
 * stat-compare every vault file against the index's (mtime, size) columns and
 * reconcile only new/changed/deleted paths through the NORMAL per-note path
 * (hash-skip still guards against mtime-only touches). Cost is one stat per
 * note (~tens of ms per thousand files) — no file contents are read for
 * unchanged notes.
 */
/**
 * Max continuous event-loop occupancy per slice. The scan yields a full
 * macrotask whenever it has held the loop this long, so HTTP handlers, timers
 * and IO callbacks always run first — REGARDLESS of vault size or how busy the
 * process is when the scan happens to run. This bounds impact structurally
 * instead of hoping a start-delay lands in a quiet moment.
 */
const DRIFT_SLICE_MS = 5

export async function scanForDrift(): Promise<{ changed: number; deleted: number }> {
  const startedAt = Date.now()
  const indexed = new Map(listNoteSyncMeta().map((r) => [r.path, r]))
  const onDisk = await collectIndexableNotePaths()
  const onDiskSet = new Set(onDisk)

  let changed = 0
  let deleted = 0
  let sliceStart = Date.now()
  const yieldIfSliceSpent = async () => {
    if (Date.now() - sliceStart < DRIFT_SLICE_MS) return
    await new Promise((r) => setImmediate(r))
    sliceStart = Date.now()
  }
  for (const relPath of onDisk) {
    if (stopped || rebuilding) return { changed, deleted } // a rebuild supersedes the scan
    await yieldIfSliceSpent()
    const row = indexed.get(relPath)
    if (row) {
      try {
        const stat = await fsp.stat(path.join(NOTES_DIR, relPath))
        if (stat.mtime.toISOString() === row.modified && stat.size === row.size) continue
      } catch {
        continue // vanished mid-scan — the deletion branch below handles it next boot
      }
    }
    // New file or stat drift → normal reconcile. A hash-skip (mtime-only touch)
    // returns null and refreshes the stat columns — not counted as a change.
    try {
      const id = await reconcileNote(relPath)
      if (id) changed++
    } catch (err) {
      log.memory.debug('notes-indexer: drift reconcile failed', {
        path: relPath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  // Deletions: indexed under a path spelling that no longer exists on disk.
  // Remove the row DIRECTLY — never via reconcileNote: on a case-insensitive
  // filesystem (macOS APFS) a stale-cased path ("Archive/x.md" after the
  // folder became "archive/") still READS fine, so reconcile re-indexed the
  // old spelling instead of deleting it, and every scan flip-flopped 400+
  // rows between the two spellings forever (changed:418/deleted:415 loop).
  // The on-disk spelling's row is created/updated by the loop above; whether
  // the file truly died or merely changed case, this exact-path row is stale.
  for (const relPath of indexed.keys()) {
    if (onDiskSet.has(relPath)) continue
    if (stopped || rebuilding) break
    await yieldIfSliceSpent()
    try {
      await withFileLock(NOTES_INDEX_PATH, async () => { deleteNoteByPath(relPath) })
      await removeSemantic(relPath)
      deleted++
    } catch { /* logged inside */ }
  }
  if (changed > 0 || deleted > 0) {
    log.memory.info('notes-index: drift scan reconciled offline changes', {
      changed,
      deleted,
      ms: Date.now() - startedAt,
    })
  }
  return { changed, deleted }
}

/**
 * Initialize the structural sidecar at server boot. If the DB is empty (fresh /
 * schema bump), kick off a chunked off-loop rebuild WITHOUT blocking boot.
 * Otherwise run the drift scan so changes made while the server was down
 * (Obsidian edits, agent writes, git pulls) are picked up without a rebuild.
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
  } else {
    // Deferred, off-loop drift scan. Boot never waits on it. The delay is a
    // COURTESY (skip the startup burst), not the safety mechanism — safety is
    // the time-budget yield inside the scan itself, which caps continuous loop
    // occupancy at DRIFT_SLICE_MS whenever it runs, busy or not.
    const timer = setTimeout(() => {
      if (stopped) return
      void scanForDrift().catch((err) => {
        log.memory.warn('notes-index: drift scan failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }, 30_000)
    timer.unref?.() // never keep the process alive for a maintenance scan
  }
  // Attachment OCR backfill: further deferred (60s), serial, hash-resumable.
  import('./attachment-text.js')
    .then(({ startAttachmentBackfill }) => startAttachmentBackfill())
    .catch(() => {})
}
