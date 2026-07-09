/**
 * Notes v2 routes — multi-file notes with CRUD, hybrid search, backlinks, tags.
 * Storage: ~/.open-walnut/notes/ (flat markdown files in folder hierarchy).
 *
 * Structure (search / backlinks / list / tags) is served from a rebuildable
 * structural sidecar (notes-index.sqlite) instead of O(n) full-vault file scans.
 * The semantic leg of search comes from the existing QMD store (memory-search.ts).
 * Files on disk stay the source of truth; the sidecar reconciles on change.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Router, type Request, type Response, type NextFunction } from 'express'
import { NOTES_DIR, CLOUD_MODE } from '../../constants.js'
import { computeContentHash } from '../../utils/file-ops.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { log } from '../../logging/index.js'
import { memoryNotesSearch } from '../../core/memory-search.js'
import {
  parseFrontmatter,
  readId,
  generateNoteId,
  stampId,
} from '../../core/parse-frontmatter.js'
import { resolveAttachmentPath } from './notes-attachment.js'
import {
  scheduleNotesIndexUpdate,
  reconcileNoteNow,
  normalizeTag,
  rebuildIndex,
  isRebuilding,
  stopNotesIndexer,
  resetNotesIndexer,
} from '../../core/notes-indexer.js'
import {
  stringSearch,
  backlinksForId,
  ambiguousBacklinksForId,
  forwardLinksForId,
  listNotes,
  tagCounts,
  notesForTag,
  notePathsForTag,
  getNoteIdByPath,
  updateNotePath,
  docCount,
  dbSizeBytes,
  getIndexMeta,
  NOTES_INDEX_SCHEMA_VERSION,
  type LinkStatus,
} from '../../core/notes-index.js'

export const MAX_NOTE_SIZE = 2_000_000 // 2 MB

export const notesV2Router = Router()

// ── One-time structural index bootstrap + in-process reconcile subscription ──
// Honors the DO-NOT-TOUCH on server.ts: we don't wire boot there. The index
// initializes off-loop on first router use; the in-process fast path reconciles
// via the existing NOTES_UPDATED bus event (the fs.watch catch-all lives in
// qmd-watcher.ts). interest-filtered so we don't wake on unrelated events.
let indexBootstrapped = false
export function ensureIndexBootstrap(): void {
  if (indexBootstrapped) return
  indexBootstrapped = true
  resetNotesIndexer() // re-arm if a prior lifecycle stopped the reconciler
  import('../../core/notes-indexer.js')
    .then(({ initNotesIndex }) => initNotesIndex())
    .catch((err) => {
      log.memory.warn('notes-index bootstrap failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  bus.subscribe(
    'notes-index-reconcile',
    (event) => {
      const data = event.data as { source?: string } | undefined
      const source = data?.source
      if (!source || !source.startsWith('notes/')) return
      const relPath = source.slice('notes/'.length) + '.md'
      scheduleNotesIndexUpdate(relPath)
    },
    { global: true, interest: [EventNames.NOTES_UPDATED] },
  )
}

/**
 * Tear down the in-process index bootstrap: stop the reconciler's debounce timer
 * and unsubscribe the bus listener. Called by the ephemeral server on shutdown and
 * by tests between cases so a stray debounced reconcile can't re-create the sidecar
 * in a directory being removed. Idempotent.
 */
export function resetIndexBootstrap(): void {
  if (!indexBootstrapped) return
  indexBootstrapped = false
  bus.unsubscribe('notes-index-reconcile')
  stopNotesIndexer()
}

/** Ensure notes dir exists */
export async function ensureNotesDir(): Promise<void> {
  await fsp.mkdir(NOTES_DIR, { recursive: true })
}

/** Resolve and validate a note path — prevent directory traversal */
export function resolveSafePath(relativePath: string): string | null {
  const cleaned = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned || cleaned === '.' || cleaned === '..') return null
  const resolved = path.resolve(NOTES_DIR, cleaned)
  // Must be strictly inside NOTES_DIR (not NOTES_DIR itself)
  if (!resolved.startsWith(NOTES_DIR + path.sep)) {
    return null
  }
  return resolved
}

/** Vault-relative, forward-slash, .md-suffixed path from an absolute path. */
export function toRelPath(absPath: string): string {
  return path.relative(NOTES_DIR, absPath).replace(/\\/g, '/')
}

/** Extract wildcard path param — Express 5 returns arrays for *name params */
export function getWildcardPath(req: Request): string | null {
  const raw = (req.params as any).path
  if (typeof raw === 'string') return raw || null
  if (Array.isArray(raw)) return raw.join('/') || null
  return null
}

// ─── Tree ────────────────────────────────────────────────────────────────

// Attachment file types surfaced in the tree (Obsidian _attachment folders hold
// these). `kind: 'attachment'` lets the FE preview them via /attachment instead of
// loading them as markdown. Match case-insensitively (real vaults have `.PDF`).
const ATTACHMENT_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf'])

function isAttachmentFile(name: string): boolean {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return name.includes('.') && ATTACHMENT_EXTS.has(ext)
}

export interface TreeNode {
  name: string
  path: string       // relative to NOTES_DIR, forward slashes
  type: 'file' | 'folder'
  // 'note' = markdown (default; open in editor). 'attachment' = image/pdf
  // (preview via /attachment, never markdown-load). Absent on folders.
  kind?: 'note' | 'attachment'
  children?: TreeNode[]
}

export async function scanDir(dirPath: string, relBase: string): Promise<TreeNode[]> {
  let entries: import('fs').Dirent[]
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true })
  } catch (err: any) {
    if (err.code === 'ENOENT') return []
    throw err
  }

  const nodes: TreeNode[] = []

  // Sort: folders first, then alphabetical
  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1
    if (!a.isDirectory() && b.isDirectory()) return 1
    return a.name.localeCompare(b.name)
  })

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue // skip hidden files
    const relPath = relBase ? `${relBase}/${entry.name}` : entry.name

    if (entry.isDirectory()) {
      const children = await scanDir(path.join(dirPath, entry.name), relPath)
      nodes.push({ name: entry.name, path: relPath, type: 'folder', children })
    } else if (entry.name.endsWith('.md')) {
      nodes.push({ name: entry.name, path: relPath, type: 'file', kind: 'note' })
    } else if (isAttachmentFile(entry.name)) {
      // Attachments (images/pdf) — shown with their own icon; clicking previews.
      nodes.push({ name: entry.name, path: relPath, type: 'file', kind: 'attachment' })
    }
  }

  return nodes
}

// GET /api/notes-v2 — file tree
notesV2Router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    ensureIndexBootstrap()
    await ensureNotesDir()
    const tree = await scanDir(NOTES_DIR, '')
    res.json({ tree })
  } catch (err) {
    next(err)
  }
})

// ─── Attachment streaming ──────────────────────────────────────────────────
// Single notes-owned endpoint that serves vault attachments (images + PDF) for
// the tree preview AND ![[embed]] rendering. Deliberately does NOT touch
// local-image.ts (owned elsewhere, no PDF). Local-only — the notes vault lives
// under NOTES_DIR; no remote/daemon fan-out needed. SVG excluded (XSS).
const ATTACHMENT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
}

const MAX_ATTACHMENT_SIZE = 50 * 1024 * 1024 // 50 MB (mirror local-image)

// GET /api/notes-v2/attachment?path=<vault-relative path under NOTES_DIR>
notesV2Router.get('/attachment', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const raw = req.query.path
    if (!raw || typeof raw !== 'string') {
      res.status(400).json({ error: 'path required' })
      return
    }

    // Reject a disallowed extension up-front (before any fs touch). No SVG.
    const reqExt = path.extname(raw).slice(1).toLowerCase()
    if (!ATTACHMENT_MIME[reqExt]) {
      res.status(400).json({ error: 'File type not allowed' })
      return
    }

    // Resolution handles the three Obsidian `![[...]]` embed forms (see
    // resolveAttachmentPath): a vault-relative path, a legacy `Notion/`-rooted
    // path, or a bare shortest-unique attachment name searched across the vault.
    // It also keeps the FE contract simple — the editor just sends the raw inner
    // `![[...]]` text and never has to know where attachments physically live.
    // resolveAttachmentPath enforces the same traversal/escape guard + NOTES_DIR
    // containment as resolveSafePath, and only returns an existing regular file.
    const fullPath = await resolveAttachmentPath(raw)
    if (!fullPath) {
      res.status(404).json({ error: 'Attachment not found' })
      return
    }

    const ext = path.extname(fullPath).slice(1).toLowerCase()
    const mime = ATTACHMENT_MIME[ext]
    if (!mime) {
      res.status(400).json({ error: 'File type not allowed' })
      return
    }

    let stat: import('fs').Stats
    try {
      stat = await fsp.stat(fullPath)
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: 'Attachment not found' })
        return
      }
      throw err
    }
    if (!stat.isFile()) {
      res.status(404).json({ error: 'Attachment not found' })
      return
    }
    if (stat.size > MAX_ATTACHMENT_SIZE) {
      res.status(400).json({ error: 'File too large' })
      return
    }

    const buffer = await fsp.readFile(fullPath)
    res.setHeader('Content-Type', mime)
    res.setHeader('Content-Length', buffer.length)
    res.setHeader('Cache-Control', 'public, max-age=3600')
    // Inline so the browser renders the PDF/image in-page instead of downloading.
    res.setHeader('Content-Disposition', 'inline')
    res.send(buffer)
  } catch (err) {
    next(err)
  }
})

// ─── Attachment upload (image paste) ───────────────────────────────────────
// POST /api/notes-v2/attachment — save a pasted image INTO THE VAULT beside the
// note being edited (Obsidian convention: an `_attachment/` folder next to the
// note), returning the vault-relative path used as the `![[...]]` embed target.
// Deliberately NOT /api/images/upload: that's the chat image store OUTSIDE the
// vault (~/.open-walnut/logs/images), so pasted note images stored there don't
// sync/export with the vault and serialize as non-portable `![](/api/images/…)`.
const PASTE_MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}
const MAX_UPLOAD_BASE64 = 10_000_000 // ~7.5 MB decoded (mirror images.ts)

notesV2Router.post('/attachment', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { notePath, data, mediaType } = req.body ?? {}
    if (typeof notePath !== 'string' || typeof data !== 'string' || typeof mediaType !== 'string') {
      res.status(400).json({ error: 'notePath, data (base64) and mediaType are required' })
      return
    }
    const ext = PASTE_MIME_TO_EXT[mediaType]
    if (!ext) {
      res.status(400).json({ error: `Unsupported media type: ${mediaType}` })
      return
    }
    if (data.length > MAX_UPLOAD_BASE64) {
      res.status(413).json({ error: 'Image too large (max 10MB base64)' })
      return
    }

    const fullPath = resolveSafePath(notePath)
    if (!fullPath) { res.status(400).json({ error: 'invalid path' }); return }
    const noteFile = fullPath.endsWith('.md') ? fullPath : fullPath + '.md'

    const buffer = Buffer.from(data, 'base64')
    if (buffer.length === 0) { res.status(400).json({ error: 'empty image data' }); return }

    // Timestamped name plus a short content hash so two pastes in the same
    // second (or the same image twice) never collide/overwrite. NO SPACES —
    // spaces %20-encode in obsidian:// deep links and shell one-liners, which
    // breaks/uglifies them (user-reported).
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const ts =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 6)
    const filename = `pasted-image-${ts}-${hash}.${ext}`

    const attachmentDir = path.join(path.dirname(noteFile), '_attachment')
    await fsp.mkdir(attachmentDir, { recursive: true })
    const filePath = path.join(attachmentDir, filename)
    await fsp.writeFile(filePath, buffer)

    const relPath = toRelPath(filePath)
    log.memory.info('Note attachment saved', { notePath, path: relPath, bytes: buffer.length })
    // The tree only refetches on explicit create/delete/move or this event —
    // a new _attachment/ folder + file appeared outside that path, so without
    // this the sidebar file explorer never shows the pasted image until the
    // user manually does something that happens to trigger a refresh.
    bus.emit(EventNames.NOTES_TREE_CHANGED, { path: relPath }, ['web-ui'])
    res.json({ ok: true, path: relPath, name: filename })
  } catch (err) {
    next(err)
  }
})

// ─── Content CRUD ────────────────────────────────────────────────────────

// GET /api/notes-v2/content/*path — read note (now also returns id when known)
notesV2Router.get('/content/*path', async (req: Request, res: Response, next: NextFunction) => {
  try {
    ensureIndexBootstrap()
    const notePath = getWildcardPath(req)
    if (!notePath) { res.status(400).json({ error: 'path required' }); return }

    const fullPath = resolveSafePath(notePath)
    if (!fullPath) { res.status(400).json({ error: 'invalid path' }); return }

    // Ensure .md extension
    const filePath = fullPath.endsWith('.md') ? fullPath : fullPath + '.md'

    let content = ''
    let updatedAt: string | null = null
    try {
      content = await fsp.readFile(filePath, 'utf-8')
      const stat = await fsp.stat(filePath)
      updatedAt = stat.mtime.toISOString()
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: 'Note not found' })
        return
      }
      throw err
    }

    const contentHash = computeContentHash(content)
    // id from frontmatter (authoritative), falling back to the index if known.
    const { data } = parseFrontmatter(content)
    const relPath = toRelPath(filePath)
    const id = readId(data) ?? getNoteIdByPath(relPath)
    res.json({ content, updatedAt, contentHash, ...(id ? { id } : {}) })
  } catch (err) {
    next(err)
  }
})

// PUT /api/notes-v2/content/*path — create/update note. Stamps id at create time.
notesV2Router.put('/content/*path', async (req: Request, res: Response, next: NextFunction) => {
  try {
    ensureIndexBootstrap()
    const notePath = getWildcardPath(req)
    if (!notePath) { res.status(400).json({ error: 'path required' }); return }

    const { content, expectedHash } = req.body
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'content (string) is required' })
      return
    }
    if (content.length > MAX_NOTE_SIZE) {
      res.status(413).json({ error: `Content too large (max ${MAX_NOTE_SIZE} bytes)` })
      return
    }

    const fullPath = resolveSafePath(notePath)
    if (!fullPath) { res.status(400).json({ error: 'invalid path' }); return }

    const filePath = fullPath.endsWith('.md') ? fullPath : fullPath + '.md'

    // Optimistic locking: reject if file was modified externally.
    // Optional for backward compatibility — callers that don't send
    // expectedHash accept last-write-wins semantics.
    if (expectedHash) {
      try {
        const currentContent = await fsp.readFile(filePath, 'utf-8')
        const currentHash = computeContentHash(currentContent)
        if (currentHash !== expectedHash) {
          res.status(409).json({
            error: 'Content was modified externally',
            currentHash,
          })
          return
        }
      } catch (err: any) {
        if (err.code !== 'ENOENT') throw err
        // File doesn't exist — no conflict possible
      }
    }

    // IDENTITY: stamp an id into frontmatter at create time (not lazily) so the
    // bytes written — and hence contentHash — reflect the stamped content. The
    // FE refreshes its expected hash from the response id+hash without a spurious
    // 409. Existing frontmatter is preserved byte-for-byte except the id: line.
    const { data } = parseFrontmatter(content)
    let id = readId(data)
    let finalContent = content
    if (!id) {
      id = generateNoteId()
      finalContent = stampId(content, id)
    }

    await fsp.mkdir(path.dirname(filePath), { recursive: true })
    await fsp.writeFile(filePath, finalContent, 'utf-8')

    const stat = await fsp.stat(filePath)
    const contentHash = computeContentHash(finalContent)
    const normalizedPath = notePath.replace(/\.md$/, '')
    log.memory.info('Note updated', { path: notePath, size: finalContent.length })
    // source format `notes/{path}` is a shared contract with files-tools.ts and useNoteContent.ts
    bus.emit(EventNames.NOTES_UPDATED, { source: `notes/${normalizedPath}`, contentHash }, ['web-ui'])
    res.json({ ok: true, updatedAt: stat.mtime.toISOString(), contentHash, id })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/notes-v2/content/*path — delete note (fires reconcile)
notesV2Router.delete('/content/*path', async (req: Request, res: Response, next: NextFunction) => {
  try {
    ensureIndexBootstrap()
    const notePath = getWildcardPath(req)
    if (!notePath) { res.status(400).json({ error: 'path required' }); return }

    const fullPath = resolveSafePath(notePath)
    if (!fullPath) { res.status(400).json({ error: 'invalid path' }); return }

    const filePath = fullPath.endsWith('.md') ? fullPath : fullPath + '.md'
    const relPath = toRelPath(filePath)

    try {
      await fsp.unlink(filePath)
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: 'Note not found' })
        return
      }
      throw err
    }

    // Try to remove empty parent directories
    try {
      let dir = path.dirname(filePath)
      while (dir !== NOTES_DIR && dir.startsWith(NOTES_DIR)) {
        const entries = await fsp.readdir(dir)
        if (entries.length > 0) break
        await fsp.rmdir(dir)
        dir = path.dirname(dir)
      }
    } catch { /* best-effort cleanup */ }

    log.memory.info('Note deleted', { path: notePath })
    // Reconcile the deletion (removes the row, marks inbound links unresolved).
    scheduleNotesIndexUpdate(relPath)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ─── Move / Rename ───────────────────────────────────────────────────────

// POST /api/notes-v2/move — rename/move only. updateWikiLinksInAll REMOVED:
// id-keyed links survive a rename because the edge keys on the target's
// frontmatter id, not the basename. Move = file rename + one-row path update
// in the index + one QMD virtual-path remap (handled by reconcile of both paths).
notesV2Router.post('/move', async (req: Request, res: Response, next: NextFunction) => {
  try {
    ensureIndexBootstrap()
    const { from, to } = req.body
    if (typeof from !== 'string' || typeof to !== 'string') {
      res.status(400).json({ error: 'from and to (strings) are required' })
      return
    }

    const fromFull = resolveSafePath(from)
    const toFull = resolveSafePath(to)
    if (!fromFull || !toFull) { res.status(400).json({ error: 'invalid path' }); return }

    const fromFile = fromFull.endsWith('.md') ? fromFull : fromFull + '.md'
    const toFile = toFull.endsWith('.md') ? toFull : toFull + '.md'

    // Check source exists
    try {
      await fsp.stat(fromFile)
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: 'Source note not found' })
        return
      }
      throw err
    }

    // Check destination does not already exist — prevent silent overwrite
    try {
      await fsp.stat(toFile)
      res.status(409).json({ error: 'Destination note already exists' })
      return
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err
      // ENOENT is expected — destination is free, proceed
    }

    // Move file
    await fsp.mkdir(path.dirname(toFile), { recursive: true })
    await fsp.rename(fromFile, toFile)

    const fromRel = toRelPath(fromFile)
    const toRel = toRelPath(toFile)
    // Fast path: a one-row path update keeps the id (and all edges) intact.
    updateNotePath(fromRel, toRel)
    // Then reconcile both paths: the old path's QMD doc deactivates (file gone),
    // the new path indexes (and re-points the QMD virtual path).
    scheduleNotesIndexUpdate(fromRel)
    scheduleNotesIndexUpdate(toRel)

    log.memory.info('Note moved', { from, to })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ─── Search (hybrid) ───────────────────────────────────────────────────────

type MatchType = 'exact' | 'semantic' | 'both'

interface SearchResultRow {
  id: string
  path: string
  title: string
  snippet: string
  matchType: MatchType
  score: number
  stringScore?: number
  semanticScore?: number
  matchedTags?: string[]
}

/**
 * Strip markdown noise so snippets read as prose, not source. Embeds like
 * `![[folder/img.png]]` → `[img]`, wikilinks `[[A/B/Title]]` → `Title`,
 * md links `[text](url)` → `text`, headings/bullets/table pipes/emphasis
 * markers collapsed, whitespace squeezed. Applied BEFORE highlight so <mark>
 * offsets land on visible text.
 */
function cleanSnippetText(s: string): string {
  return s
    .replace(/!\[\[[^\]]*?\.(png|jpe?g|gif|webp|svg|pdf)\]\]/gi, '[img]')
    .replace(/!\[\[[^\]]*?\]\]/g, '[embed]')
    .replace(/\[\[([^\]]+?)\]\]/g, (_m, inner: string) => {
      const s2 = inner.split('|')[0] // alias
      return s2.split('/').pop() ?? s2
    })
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[img]') // standard md image
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // standard md link → text
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '') // heading markers
    .replace(/^[ \t]*[-*+][ \t]+/gm, '') // bullet markers
    .replace(/^[ \t]*\|/gm, '') // leading table pipe
    .replace(/\|/g, ' ') // remaining table pipes
    .replace(/[*_`~]+/g, '') // emphasis / code ticks
    .replace(/\s+/g, ' ')
    .trim()
}

/** Wrap the first occurrence of the query in <mark>…</mark> for FE highlight. */
function highlightSnippet(text: string, q: string): string {
  if (!q) return text
  const idx = text.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return text
  return (
    text.slice(0, idx) +
    '<mark>' +
    text.slice(idx, idx + q.length) +
    '</mark>' +
    text.slice(idx + q.length)
  )
}

/** Build a ±context snippet around the first match of q in body, cleaned + highlighted. */
function makeSnippet(body: string, q: string): string {
  const lower = body.toLowerCase()
  const idx = lower.indexOf(q.toLowerCase())
  if (idx < 0) {
    return highlightSnippet(cleanSnippetText(body.slice(0, 240)).slice(0, 160), q)
  }
  // Widen the raw window before cleaning, since cleaning removes characters.
  const start = Math.max(0, idx - 80)
  const end = Math.min(body.length, idx + q.length + 160)
  const cleaned = cleanSnippetText(body.slice(start, end))
  const raw = (start > 0 ? '…' : '') + cleaned + (end < body.length ? '…' : '')
  return highlightSnippet(raw, q)
}

/**
 * Convert a QMD absolute filepath → vault-relative → note id (case-insensitive).
 * BLOCKING correctness: the semantic leg returns an ABSOLUTE filepath; the index
 * stores vault-relative paths. Without this, every both-leg note double-lists.
 * Falls back to the relPath as the dedupe key only if the note is unindexed.
 */
function idFromQmdPath(filepath: string): string {
  let rel = path.relative(NOTES_DIR, filepath).replace(/\\/g, '/')
  if (rel.startsWith('..')) rel = filepath.replace(/\\/g, '/') // not under vault
  const id = findNoteIdByRelPath(rel)
  return id ?? rel
}

function findNoteIdByRelPath(rel: string): string | undefined {
  return getNoteIdByPath(rel) ?? getNoteIdByPath(rel.replace(/\.md$/, '') + '.md')
}

const BIG = 1_000_000

/**
 * Semantic-only relevance floor + cap. QMD happily returns 0.3-score noise
 * ("Shoping", "Post office" for query "dental") which made search feel broken.
 * We keep semantic hits that either (a) ALSO matched as a string (matchType
 * 'both', no floor) or (b) clear this cosine floor; and we cap how many
 * semantic-ONLY rows survive so the list isn't flooded with weak matches.
 */
const SEMANTIC_FLOOR = 0.45
const SEMANTIC_ONLY_CAP = 10

// GET /api/notes-v2/search?q&mode&limit — hybrid string+semantic, deduped, labeled
notesV2Router.get('/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    ensureIndexBootstrap()
    const q = ((req.query.q as string) || '').trim()
    if (!q) { res.json({ results: [] }); return }

    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 30))
    const mode = ((req.query.mode as string) || 'hybrid') as 'hybrid' | 'string' | 'semantic'

    await ensureNotesDir()

    // Run both legs; allSettled so one failing never zeroes the other.
    // Cloud companion has no QMD store — the semantic leg would lazily init
    // the embedding model (1GB+ download, pins the small instance). String/FTS
    // search is the cloud answer (same gate as initQmdStores in server.ts).
    const wantString = mode === 'hybrid' || mode === 'string'
    const wantSemantic = !CLOUD_MODE && (mode === 'hybrid' || mode === 'semantic')

    const [stringSettled, semanticSettled] = await Promise.allSettled([
      wantString ? Promise.resolve(stringSearch(q, limit * 2)) : Promise.resolve([]),
      wantSemantic ? memoryNotesSearch(q, ['note_vault'], limit * 2) : Promise.resolve([]),
    ])

    const byId = new Map<string, SearchResultRow>()

    if (stringSettled.status === 'fulfilled') {
      for (const h of stringSettled.value) {
        byId.set(h.id, {
          id: h.id,
          path: h.path,
          title: h.title,
          snippet: makeSnippet(h.body, q),
          matchType: 'exact',
          score: 0,
          stringScore: h.stringScore, // real banded relevance (title > body > LIKE)
        })
      }
    }

    let degraded: 'semantic-unavailable' | undefined
    if (semanticSettled.status === 'fulfilled') {
      for (const h of semanticSettled.value) {
        const id = idFromQmdPath(h.filepath)
        const existing = byId.get(id)
        if (existing) {
          // Already a string hit → promote to 'both' (no floor — string match
          // already proves relevance). Keep the highlighted string snippet.
          existing.matchType = 'both'
          existing.semanticScore = h.score
          if (!existing.snippet.includes('<mark>') && h.snippet) {
            existing.snippet = cleanSnippetText(h.snippet)
          }
        } else if (h.score >= SEMANTIC_FLOOR) {
          // Semantic-only: keep only above the relevance floor (drops noise).
          byId.set(id, {
            id,
            path: id.endsWith('.md') ? id : (getPathForId(id) ?? id),
            title: h.title || path.basename(id, '.md'),
            snippet: cleanSnippetText(h.snippet || ''),
            matchType: 'semantic',
            score: 0,
            semanticScore: h.score,
          })
        }
      }
    } else if (wantSemantic) {
      degraded = 'semantic-unavailable'
    }

    // FROZEN ranking: exact/both NEVER below purely-semantic.
    //   tier1 {exact,both} ordered by max(stringScore, semanticScore)
    //   tier2 semantic ordered by semanticScore
    const results = [...byId.values()]
    for (const r of results) {
      const tier = r.matchType === 'semantic' ? 0 : 1
      const base = Math.max(r.stringScore ?? 0, r.semanticScore ?? 0)
      r.score = tier * BIG + base
    }
    results.sort((a, b) => b.score - a.score)

    // Cap semantic-only rows so weak matches don't flood the list, while never
    // touching exact/both hits (they're all kept, up to the overall limit).
    const capped: SearchResultRow[] = []
    let semanticOnly = 0
    for (const r of results) {
      if (r.matchType === 'semantic') {
        if (semanticOnly >= SEMANTIC_ONLY_CAP) continue
        semanticOnly++
      }
      capped.push(r)
      if (capped.length >= limit) break
    }

    const payload: { results: SearchResultRow[]; degraded?: 'semantic-unavailable' } = {
      results: capped,
    }
    if (degraded) payload.degraded = degraded
    res.json(payload)
  } catch (err) {
    next(err)
  }
})

/** Best-effort path lookup for a semantic-only hit keyed by id. */
function getPathForId(id: string): string | undefined {
  const row = listNotes().find((n) => n.id === id)
  return row?.path
}

// ─── Backlinks ───────────────────────────────────────────────────────────

interface BacklinkResult {
  id: string
  path: string
  title: string
  name: string
  snippet: string
  status: LinkStatus
  candidates?: string[]
}

// GET /api/notes-v2/backlinks/*path — index-backed, id-keyed, returns status
notesV2Router.get('/backlinks/*path', async (req: Request, res: Response, next: NextFunction) => {
  try {
    ensureIndexBootstrap()
    const notePath = getWildcardPath(req)
    if (!notePath) { res.status(400).json({ error: 'path required' }); return }

    const fullPath = resolveSafePath(notePath)
    if (!fullPath) { res.status(400).json({ error: 'invalid path' }); return }
    const relPath = toRelPath(fullPath.endsWith('.md') ? fullPath : fullPath + '.md')

    let dstId = getNoteIdByPath(relPath)
    if (!dstId) {
      // Not yet indexed — reconcile now so backlinks are correct on first view.
      await reconcileNoteNow(relPath).catch(() => {})
      dstId = getNoteIdByPath(relPath)
    }

    const backlinks: BacklinkResult[] = []
    if (dstId) {
      for (const r of backlinksForId(dstId)) {
        backlinks.push({
          id: r.id,
          path: r.path,
          title: r.title,
          name: path.basename(r.path, '.md'),
          snippet: r.context,
          status: r.status,
        })
      }
      // Ambiguous inbound edges that list this id among candidates.
      for (const r of ambiguousBacklinksForId(dstId)) {
        let candidates: string[] | undefined
        try { candidates = JSON.parse(r.candidates || '[]') } catch { candidates = undefined }
        backlinks.push({
          id: r.id,
          path: r.path,
          title: r.title,
          name: path.basename(r.path, '.md'),
          snippet: r.context,
          status: 'ambiguous',
          candidates,
        })
      }
    }

    res.json({ backlinks })
  } catch (err) {
    next(err)
  }
})

// GET /api/notes-v2/links/*path — forward links of a note (optional)
notesV2Router.get('/links/*path', async (req: Request, res: Response, next: NextFunction) => {
  try {
    ensureIndexBootstrap()
    const notePath = getWildcardPath(req)
    if (!notePath) { res.status(400).json({ error: 'path required' }); return }
    const fullPath = resolveSafePath(notePath)
    if (!fullPath) { res.status(400).json({ error: 'invalid path' }); return }
    const relPath = toRelPath(fullPath.endsWith('.md') ? fullPath : fullPath + '.md')

    const srcId = getNoteIdByPath(relPath)
    const links = srcId
      ? forwardLinksForId(srcId).map((l) => ({
          dstId: l.dst_id,
          dstName: l.dst_name,
          status: l.status,
          ...(l.title ? { title: l.title } : {}),
          ...(l.path ? { path: l.path } : {}),
        }))
      : []
    res.json({ links })
  } catch (err) {
    next(err)
  }
})

// ─── Folder CRUD ─────────────────────────────────────────────────────────

// POST /api/notes-v2/folder — create folder
notesV2Router.post('/folder', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { path: folderPath } = req.body
    if (typeof folderPath !== 'string') {
      res.status(400).json({ error: 'path (string) is required' })
      return
    }

    const fullPath = resolveSafePath(folderPath)
    if (!fullPath) { res.status(400).json({ error: 'invalid path' }); return }

    await fsp.mkdir(fullPath, { recursive: true })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ─── List (for wiki-link autocomplete) ─────────────────────────────────────

// GET /api/notes-v2/list — flat note list. Now returns id per note (feeds [[ authoring).
notesV2Router.get('/list', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    ensureIndexBootstrap()
    await ensureNotesDir()
    const rows = listNotes()
    if (rows.length > 0) {
      const notes = rows.map((r) => ({
        id: r.id,
        title: r.title,
        path: r.path,
        name: path.basename(r.path, '.md'),
      }))
      res.json({ notes })
      return
    }
    // Index empty (cold start before first rebuild) — fall back to a file walk so
    // [[ autocomplete works immediately; ids fill in once the index settles.
    const allFiles = await getAllMdFilesFallback(NOTES_DIR)
    const notes = allFiles.map((f) => {
      const relPath = toRelPath(f)
      const name = path.basename(relPath, '.md')
      return { id: '', title: name, path: relPath, name }
    })
    res.json({ notes })
  } catch (err) {
    next(err)
  }
})

// ─── Tags ──────────────────────────────────────────────────────────────────

// GET /api/notes-v2/tags — all tags, frequency-ranked
notesV2Router.get('/tags', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    ensureIndexBootstrap()
    res.json({ tags: tagCounts() })
  } catch (err) {
    next(err)
  }
})

// GET /api/notes-v2/tags/:tag/notes — notes carrying a tag, newest first
notesV2Router.get('/tags/:tag/notes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    ensureIndexBootstrap()
    const tag = normalizeTag(String(req.params.tag || ''))
    if (!tag) { res.status(400).json({ error: 'tag required' }); return }
    const notes = notesForTag(tag).map((r) => ({
      id: r.id,
      title: r.title,
      path: r.path,
      snippet: r.body.slice(0, 160).trim(),
      modified: r.modified,
    }))
    res.json({ notes })
  } catch (err) {
    next(err)
  }
})

// POST /api/notes-v2/tags/rename — targeted rewrite (carrying notes only)
notesV2Router.post('/tags/rename', async (req: Request, res: Response, next: NextFunction) => {
  try {
    ensureIndexBootstrap()
    const from = normalizeTag(String(req.body?.from || ''))
    const to = normalizeTag(String(req.body?.to || ''))
    if (!from || !to) { res.status(400).json({ error: 'from and to (strings) are required' }); return }
    if (from === to) { res.json({ ok: true, updated: 0 }); return }

    // Targeted by the tag index — NOT a vault scan.
    const paths = notePathsForTag(from)
    let updated = 0
    const inlineRe = new RegExp(`(^|[\\s(])#${escapeRegExp(from)}\\b`, 'g')

    for (const relPath of paths) {
      const abs = resolveSafePath(relPath)
      if (!abs) continue
      const filePath = abs.endsWith('.md') ? abs : abs + '.md'
      let content: string
      try {
        content = await fsp.readFile(filePath, 'utf-8')
      } catch { continue }

      const { data, body, raw } = parseFrontmatter(content)
      let changed = false

      // 1) frontmatter tags[]
      let newRaw = raw
      if (raw && Array.isArray(data.tags)) {
        const replaced = (data.tags as unknown[]).map((t) =>
          typeof t === 'string' && normalizeTag(t) === from ? to : t,
        )
        if (JSON.stringify(replaced) !== JSON.stringify(data.tags)) {
          // Rewrite only the tag tokens in the raw block to stay byte-minimal.
          newRaw = raw.replace(
            new RegExp(`(^|[\\s,\\[])#?${escapeRegExp(from)}(?=$|[\\s,\\]])`, 'gm'),
            (_m, pre) => `${pre}${to}`,
          )
          changed = changed || newRaw !== raw
        }
      }

      // 2) inline #from → #to in body
      const newBody = body.replace(inlineRe, (_m, pre) => `${pre}#${to}`)
      if (newBody !== body) changed = true

      if (changed) {
        const next = (newRaw || raw) + newBody
        await fsp.writeFile(filePath, next, 'utf-8')
        updated++
        scheduleNotesIndexUpdate(relPath)
      }
    }

    res.json({ ok: true, updated })
  } catch (err) {
    next(err)
  }
})

// ─── Index admin / observability ─────────────────────────────────────────

// GET /api/notes-v2/index/status — index health/observability + test hook
notesV2Router.get('/index/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    ensureIndexBootstrap()
    const lastRebuild = getIndexMeta('last_full_rebuild')
    let embedState: 'idle' | 'embedding' | 'unavailable' = 'idle'
    if (CLOUD_MODE) {
      // No QMD store on the companion — don't lazy-init it just to report status.
      embedState = 'unavailable'
    } else try {
      const { getNotesStore } = await import('../../core/qmd-store.js')
      const store = await getNotesStore()
      const status = await store.getStatus()
      embedState = status.needsEmbedding > 0 ? 'embedding' : 'idle'
    } catch {
      embedState = 'unavailable'
    }
    res.json({
      docCount: docCount(),
      lastRebuild: lastRebuild ?? null,
      schemaVersion: NOTES_INDEX_SCHEMA_VERSION,
      embedState,
      dbSizeBytes: dbSizeBytes(),
      rebuilding: isRebuilding(),
      ...(embedState === 'unavailable' ? { degraded: 'semantic-unavailable' as const } : {}),
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/notes-v2/index/rebuild — drop + rebuild structural sidecar (off-loop)
notesV2Router.post('/index/rebuild', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    ensureIndexBootstrap()
    // Off-loop, bounded; respond immediately. Status endpoint reports progress.
    void rebuildIndex().catch((err) => {
      log.memory.warn('notes-index rebuild failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
    res.json({ ok: true, rebuilding: true })
  } catch (err) {
    next(err)
  }
})

// POST /api/notes-v2/index/stamp-ids — "stamp all ids now" admin action (§12.3).
// Batches the id back-write across the whole vault so a user can reach full id
// coverage immediately (instead of file-by-file as each note is next touched).
// Awaits so the response carries the {scanned, stamped, skipped} summary.
notesV2Router.post('/index/stamp-ids', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    ensureIndexBootstrap()
    const { stampAllIds } = await import('../../core/notes-identity.js')
    const result = await stampAllIds()
    res.json({ ok: true, ...result })
  } catch (err) {
    next(err)
  }
})

// POST /api/notes-v2/index/merge-ids — earliest-created-wins merge (§8.3 layer 3).
// Resolves divergent ids for the same logical note (two machines stamped one
// id-less note, git merge left two copies): re-points inbound links to the
// earliest-created winner. Awaits so the response carries the merge summary.
notesV2Router.post('/index/merge-ids', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    ensureIndexBootstrap()
    const { mergeDivergentIds } = await import('../../core/notes-identity.js')
    const result = await mergeDivergentIds()
    res.json({ ok: true, ...result })
  } catch (err) {
    next(err)
  }
})

// ─── Helpers ─────────────────────────────────────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Fallback file walk for /list before the index has built (cold start only). */
async function getAllMdFilesFallback(dir: string): Promise<string[]> {
  const results: string[] = []
  let entries: import('fs').Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...(await getAllMdFilesFallback(full)))
    } else if (entry.name.endsWith('.md')) {
      results.push(full)
    }
  }
  return results
}
