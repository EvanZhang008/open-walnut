/**
 * Notes v2 routes — multi-file notes with CRUD, hybrid search, backlinks, tags.
 * Storage: ~/.open-walnut/notes/ (flat markdown files in folder hierarchy).
 *
 * Structure (search / backlinks / list / tags) is served from a rebuildable
 * structural sidecar (notes-index.sqlite) instead of O(n) full-vault file scans.
 * The semantic leg of search comes from the hybrid search index (search/wiring.ts).
 * Files on disk stay the source of truth; the sidecar reconciles on change.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { Router, type Request, type Response, type NextFunction } from 'express'
import { NOTES_DIR, CLOUD_MODE } from '../../constants.js'
import { computeContentHash } from '../../utils/file-ops.js'
import { withFileLock } from '../../utils/file-lock.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { log } from '../../logging/index.js'
import { timed } from '../../core/observability/metrics.js'
import { getConfig } from '../../core/config-manager.js'
import {
  parseFrontmatter,
  readId,
  generateNoteId,
  stampId,
} from '../../core/parse-frontmatter.js'
import { resolveAttachmentPath, invalidateAttachmentIndex } from './notes-attachment.js'
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
  attachmentSearch,
  normalizeExcludeFolders,
  isPathExcluded,
  backlinksForId,
  ambiguousBacklinksForId,
  forwardLinksForId,
  listNotes,
  tagCounts,
  notesForTag,
  notePathsForTag,
  getNoteIdByPath,
  getNotePathById,
  findNoteIdsByName,
  countNotesUnderFolder,
  searchFolders,
  updateNotePath,
  docCount,
  dbSizeBytes,
  getIndexMeta,
  NOTES_INDEX_SCHEMA_VERSION,
  contentTokens,
  type LinkStatus,
} from '../../core/notes-index.js'

export const MAX_NOTE_SIZE = 2_000_000 // 2 MB

export const notesV2Router = Router()

/**
 * Error with an HTTP status, thrown by the extracted note-op functions below
 * (attachment upload, move, folder create) so BOTH route layers — this
 * router's `{error: string}` shape and /api/v1's `{error:{code,message}}` —
 * can map it without duplicating the operation logic.
 */
export class NotesOpError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message)
    this.name = 'NotesOpError'
  }
}

// ── One-time structural index bootstrap + in-process reconcile subscription ──
// Honors the DO-NOT-TOUCH on server.ts: we don't wire boot there. The index
// initializes off-loop on first router use; the in-process fast path reconciles
// via the existing NOTES_UPDATED bus event (the fs.watch catch-all lives in
// notes-watcher.ts). interest-filtered so we don't wake on unrelated events.
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
      // Source names are canonical `notes/{vault-path-without-.md}` from every
      // emitter (legacy /api/notes route + agent files tool included — both
      // translate their 'notes/global' alias to 'notes/global-notes' before
      // emitting). 'notes/instructions' is AGENTS.md — vault-resident but
      // deliberately not bus-reconciled (rebuild/fs.watch still index it).
      if (source === 'notes/instructions') return
      scheduleNotesIndexUpdate(source.slice('notes/'.length) + '.md')
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
// Office docs are listed (not rendered): clicking opens them in the local app
// (Word/Excel) via /reveal, or downloads through /attachment as a fallback.
const ATTACHMENT_EXTS = new Set([
  // heic/heif: what an iPhone camera actually writes. Excluding them meant
  // every photo imported straight off a phone answered 400 "File type not
  // allowed" and rendered as a broken embed.
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'pdf',
  'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt',
])

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
    if (entry.name.startsWith('~$')) continue // Office owner/lock temp files
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
  // iPhone camera format. Safari/iOS decode it natively; other browsers
  // download it. Either way it must not 400 — these are ordinary user photos.
  heic: 'image/heic',
  heif: 'image/heif',
  pdf: 'application/pdf',
  // Office formats: served as downloads (Content-Disposition below switches to
  // `attachment` for these) — the browser can't render them inline.
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
}

// Extensions the browser can render inline; everything else downloads.
// heic/heif are inline for iOS (native decode) and for the iOS app, which hands
// the bytes to ImageIO — it decodes heic fine.
const INLINE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'pdf'])

// RFC 5987 ext-value: encodeURIComponent leaves ' * ( ) unescaped, but a bare
// ' collides with the UTF-8'' delimiter and breaks download filenames.
function rfc5987Encode(s: string): string {
  return encodeURIComponent(s).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

const MAX_ATTACHMENT_SIZE = 50 * 1024 * 1024 // 50 MB (mirror local-image)

/**
 * Resolve + read a vault attachment for streaming. Shared by this router's
 * GET /attachment and GET /api/v1/notes/attachment. Throws NotesOpError for
 * every failure; the caller writes the headers/body.
 *
 * Resolution (see resolveAttachmentPath) tries the exact vault-relative path,
 * then the same with a legacy `Notion/` root stripped, then the longest matching
 * PATH SUFFIX — so an embed that names its folder gets the copy in that folder
 * even when the same filename exists elsewhere in the vault. `notePath` (the
 * embedding note) only breaks remaining ties by proximity.
 *
 * resolveAttachmentPath enforces the same traversal/escape guard + NOTES_DIR
 * containment as resolveSafePath, and only returns an existing regular file.
 */
export async function readNoteAttachment(raw: unknown, notePath?: unknown): Promise<{
  buffer: Buffer
  mime: string
  /** Browser-renderable → serve inline; Office docs → download. */
  contentDisposition: string
}> {
  if (!raw || typeof raw !== 'string') throw new NotesOpError('path required', 400)

  // Reject a disallowed extension up-front (before any fs touch). No SVG.
  // An Obsidian size suffix (`![[x.png|300]]`) is part of the embed, not the
  // filename — strip it before reading the extension or every sized embed 400s.
  const reqExt = path.extname(raw.split('|')[0]).slice(1).toLowerCase()
  if (!ATTACHMENT_MIME[reqExt]) throw new NotesOpError('File type not allowed', 400)

  const fullPath = await resolveAttachmentPath(
    raw,
    typeof notePath === 'string' ? notePath : undefined,
  )
  if (!fullPath) throw new NotesOpError('Attachment not found', 404)

  const ext = path.extname(fullPath).slice(1).toLowerCase()
  const mime = ATTACHMENT_MIME[ext]
  if (!mime) throw new NotesOpError('File type not allowed', 400)

  let stat: import('fs').Stats
  try {
    stat = await fsp.stat(fullPath)
  } catch (err: any) {
    if (err.code === 'ENOENT') throw new NotesOpError('Attachment not found', 404)
    throw err
  }
  if (!stat.isFile()) throw new NotesOpError('Attachment not found', 404)
  if (stat.size > MAX_ATTACHMENT_SIZE) throw new NotesOpError('File too large', 400)

  const buffer = await fsp.readFile(fullPath)
  const contentDisposition = INLINE_EXTS.has(ext)
    ? 'inline'
    : `attachment; filename*=UTF-8''${rfc5987Encode(path.basename(fullPath))}`
  return { buffer, mime, contentDisposition }
}

// GET /api/notes-v2/attachment?path=<vault-relative path under NOTES_DIR>
//   &note=<vault path of the embedding note>  (optional; breaks duplicate-name ties)
notesV2Router.get('/attachment', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { buffer, mime, contentDisposition } = await readNoteAttachment(req.query.path, req.query.note)
    res.setHeader('Content-Type', mime)
    res.setHeader('Content-Length', buffer.length)
    res.setHeader('Cache-Control', 'public, max-age=3600')
    // Inline so the browser renders PDF/images in-page; Office docs download
    // (with their real filename) since the browser can't render them.
    res.setHeader('Content-Disposition', contentDisposition)
    res.send(buffer)
  } catch (err) {
    if (err instanceof NotesOpError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    next(err)
  }
})

// ─── Reveal / open on the local machine (tree context menu) ────────────────
// POST /api/notes-v2/reveal { path, mode: 'finder' | 'app' | 'vscode' | 'path' }
// Walnut's server runs on the SAME Mac as the browser (localhost console), so
// "Open in Finder / Word / VS Code" is a local `open` spawn. 'path' only
// resolves and returns the absolute path (for Copy path — clipboard lives in
// the browser). Path is vault-contained (resolveSafePath /
// resolveAttachmentPath) — never arbitrary.
// Local-only: rejected in cloud mode where there's no desktop to open into.
notesV2Router.post('/reveal', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (CLOUD_MODE) { res.status(400).json({ error: 'Not available in cloud mode' }); return }
    const { path: notePath, mode } = req.body ?? {}
    if (typeof notePath !== 'string' || !['finder', 'app', 'vscode', 'path'].includes(mode)) {
      res.status(400).json({ error: 'path and mode (finder|app|vscode|path) are required' })
      return
    }
    // Folders resolve via resolveSafePath; files may also match by basename
    // (attachment fallback) — try the strict resolver first.
    let isDir = false
    let fullPath = resolveSafePath(notePath)
    if (fullPath) {
      try { isDir = (await fsp.stat(fullPath)).isDirectory() } catch { fullPath = null }
    }
    if (!fullPath) fullPath = await resolveAttachmentPath(notePath)
    if (!fullPath) { res.status(404).json({ error: 'Not found' }); return }

    if (mode !== 'path') {
      // FILE type allowlist for anything we hand to `open`: only notes +
      // known attachment types. The vault syncs from git / agent writes, so
      // an arbitrary dropped file (.command, .webloc, .html…) must never be
      // launchable through this endpoint. Folders are fine (Finder/VS Code).
      if (!isDir) {
        const ext = path.extname(fullPath).slice(1).toLowerCase()
        if (ext !== 'md' && !ATTACHMENT_EXTS.has(ext)) {
          res.status(400).json({ error: `File type not allowed: .${ext}` })
          return
        }
      }
      // `open` is macOS-only; -R reveals in Finder, -a targets an app. execFile
      // (not exec) — args are never shell-interpolated. Await the exit so a
      // failure (app not installed, `open` error) surfaces as a real error —
      // fire-and-forget made the context menu silently do nothing.
      const args =
        mode === 'finder' ? ['-R', fullPath]
        : mode === 'vscode' ? ['-a', 'Visual Studio Code', fullPath]
        : [fullPath] // 'app' — default application (Word/Excel/Preview…)
      try {
        await new Promise<void>((resolve, reject) => {
          execFile('open', args, { timeout: 5000 }, (err) => (err ? reject(err) : resolve()))
        })
      } catch (err) {
        log.memory.warn('notes reveal failed', { path: notePath, mode, error: String(err) })
        res.status(500).json({ error: `open failed: ${err instanceof Error ? err.message : String(err)}` })
        return
      }
      log.memory.info('notes reveal', { path: notePath, mode })
    }
    res.json({ ok: true, fullPath })
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

/**
 * Save a pasted-image attachment into the vault. Shared by this router's
 * POST /attachment and POST /api/v1/notes/attachment — throws NotesOpError
 * for every validation failure so each edge maps its own error shape.
 */
export async function saveNoteAttachment(
  notePath: unknown, data: unknown, mediaType: unknown,
): Promise<{ ok: true; path: string; name: string }> {
  if (typeof notePath !== 'string' || typeof data !== 'string' || typeof mediaType !== 'string') {
    throw new NotesOpError('notePath, data (base64) and mediaType are required', 400)
  }
  const ext = PASTE_MIME_TO_EXT[mediaType]
  if (!ext) throw new NotesOpError(`Unsupported media type: ${mediaType}`, 400)
  if (data.length > MAX_UPLOAD_BASE64) throw new NotesOpError('Image too large (max 10MB base64)', 413)

  const fullPath = resolveSafePath(notePath)
  if (!fullPath) throw new NotesOpError('invalid path', 400)
  const noteFile = fullPath.endsWith('.md') ? fullPath : fullPath + '.md'

  const buffer = Buffer.from(data, 'base64')
  if (buffer.length === 0) throw new NotesOpError('empty image data', 400)

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
  // The resolver's vault index must see the new file immediately: the editor
  // inserts the embed and fetches it in the same breath.
  invalidateAttachmentIndex()
  log.memory.info('Note attachment saved', { notePath, path: relPath, bytes: buffer.length })
  // The tree only refetches on explicit create/delete/move or this event —
  // a new _attachment/ folder + file appeared outside that path, so without
  // this the sidebar file explorer never shows the pasted image until the
  // user manually does something that happens to trigger a refresh.
  bus.emit(EventNames.NOTES_TREE_CHANGED, { path: relPath }, ['web-ui'])
  return { ok: true, path: relPath, name: filename }
}

notesV2Router.post('/attachment', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { notePath, data, mediaType } = req.body ?? {}
    res.json(await saveNoteAttachment(notePath, data, mediaType))
  } catch (err) {
    if (err instanceof NotesOpError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
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

    // Optimistic locking: reject if file was modified externally.
    // Optional for backward compatibility — callers that don't send
    // expectedHash accept last-write-wins semantics.
    // check+write run under the file lock — the agent's writeFileChecked path
    // locks too, so an agent write can't slip between our check and write.
    await fsp.mkdir(path.dirname(filePath), { recursive: true })
    const conflict = await withFileLock(filePath, async () => {
      if (expectedHash) {
        try {
          const currentContent = await fsp.readFile(filePath, 'utf-8')
          const currentHash = computeContentHash(currentContent)
          if (currentHash !== expectedHash) return currentHash
        } catch (err: any) {
          if (err.code !== 'ENOENT') throw err
          // File doesn't exist — no conflict possible
        }
      }
      await fsp.writeFile(filePath, finalContent, 'utf-8')
      return null
    })
    if (conflict) {
      res.status(409).json({ error: 'Content was modified externally', currentHash: conflict })
      return
    }

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

/**
 * Delete a binary attachment (the note-delete path force-appends .md, so
 * attachments need their own op). Shared by this router's
 * DELETE /attachment/*path and DELETE /api/v1/notes/attachment/*path.
 */
export async function deleteNoteAttachment(relPath: unknown): Promise<{ ok: true }> {
  if (typeof relPath !== 'string' || !relPath) throw new NotesOpError('path required', 400)
  const fullPath = resolveSafePath(relPath)
  if (!fullPath || fullPath.endsWith('.md')) throw new NotesOpError('invalid path', 400)
  try {
    await fsp.unlink(fullPath)
  } catch (err: any) {
    if (err.code === 'ENOENT') throw new NotesOpError('Attachment not found', 404)
    throw err
  }
  try {
    const { deleteAttachmentText } = await import('../../core/notes-index.js')
    deleteAttachmentText(toRelPath(fullPath))
  } catch { /* best-effort */ }
  // Drop the resolver's index so a deleted file can't keep answering requests
  // (it would then 404 at the stat, but only after picking it over a live copy).
  invalidateAttachmentIndex()
  log.memory.info('Attachment deleted', { path: relPath })
  return { ok: true }
}

// DELETE /api/notes-v2/attachment/*path — delete a binary attachment. The
// note-delete route force-appends .md, so attachments need their own route.
notesV2Router.delete('/attachment/*path', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await deleteNoteAttachment(getWildcardPath(req)))
  } catch (err) {
    if (err instanceof NotesOpError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    next(err)
  }
})

/**
 * Recursively delete a vault folder (notes, attachments, subfolders). Index
 * rows for every contained note reconcile away; extracted attachment text
 * rows drop. Shared by this router's DELETE /folder/*path and
 * DELETE /api/v1/notes/folder/*path. Destructive — both edges gate it behind
 * an explicit client confirm.
 */
export async function deleteNotesFolder(folderPath: unknown): Promise<{ ok: true; deletedNotes: number }> {
  ensureIndexBootstrap()
  if (typeof folderPath !== 'string' || !folderPath) throw new NotesOpError('path required', 400)

  const fullPath = resolveSafePath(folderPath)
  // Root guard: resolveSafePath('') maps to NOTES_DIR itself — never rm that.
  if (!fullPath || path.resolve(fullPath) === path.resolve(NOTES_DIR)) {
    throw new NotesOpError('invalid path', 400)
  }

  let stat
  try {
    stat = await fsp.stat(fullPath)
  } catch (err: any) {
    if (err.code === 'ENOENT') throw new NotesOpError('Folder not found', 404)
    throw err
  }
  if (!stat.isDirectory()) throw new NotesOpError('not a folder', 400)

  // Snapshot contained notes BEFORE rm so we can reconcile their index rows
  // (the post-delete reconcile hits the ENOENT branch per note).
  const relPrefix = toRelPath(fullPath).replace(/\/+$/, '') + '/'
  const containedNotes: string[] = []
  const collect = async (dir: string): Promise<void> => {
    let entries
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) await collect(full)
      else if (e.name.endsWith('.md')) containedNotes.push(toRelPath(full))
    }
  }
  await collect(fullPath)

  await fsp.rm(fullPath, { recursive: true })

  for (const rel of containedNotes) scheduleNotesIndexUpdate(rel)
  // Drop extracted-text rows for attachments that lived under the folder.
  try {
    const { listAttachmentMeta, deleteAttachmentText } = await import('../../core/notes-index.js')
    for (const row of listAttachmentMeta()) {
      if (row.path.startsWith(relPrefix)) deleteAttachmentText(row.path)
    }
  } catch { /* best-effort */ }

  log.memory.info('Folder deleted', { path: folderPath, notes: containedNotes.length })
  return { ok: true, deletedNotes: containedNotes.length }
}

// DELETE /api/notes-v2/folder/*path — recursively delete a folder (notes,
// attachments, subfolders). Destructive: FE gates it behind a typed-confirm
// dialog.
notesV2Router.delete('/folder/*path', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await deleteNotesFolder(getWildcardPath(req)))
  } catch (err) {
    if (err instanceof NotesOpError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    next(err)
  }
})

// ─── Move / Rename ───────────────────────────────────────────────────────

// POST /api/notes-v2/move — rename/move only. updateWikiLinksInAll REMOVED:
// id-keyed links survive a rename because the edge keys on the target's
// frontmatter id, not the basename. Move = file rename + one-row path update
// in the index + one search-index ref remap (handled by reconcile of both paths).
/**
 * Move/rename a note or attachment. Shared by this router's POST /move and
 * POST /api/v1/notes/move — throws NotesOpError so each edge maps its shape.
 */
export async function moveNote(from: unknown, to: unknown): Promise<{ ok: true }> {
  ensureIndexBootstrap()
  if (typeof from !== 'string' || typeof to !== 'string') {
    throw new NotesOpError('from and to (strings) are required', 400)
  }

  const fromFull = resolveSafePath(from)
  const toFull = resolveSafePath(to)
  if (!fromFull || !toFull) throw new NotesOpError('invalid path', 400)

  // Attachments (png/pdf/docx/…) move verbatim; only NOTE paths get the
  // legacy `.md` suffix convention. Without this branch, dragging an
  // attachment stat'ed `img.png.md` → always 404 (tree drag was a silent no-op).
  const isAttachment = isAttachmentFile(path.basename(fromFull))
  const fromFile = isAttachment || fromFull.endsWith('.md') ? fromFull : fromFull + '.md'
  const toFile = isAttachment || toFull.endsWith('.md') ? toFull : toFull + '.md'

  // Check source exists
  try {
    await fsp.stat(fromFile)
  } catch (err: any) {
    if (err.code === 'ENOENT') throw new NotesOpError('Source note not found', 404)
    throw err
  }

  // Check destination does not already exist — prevent silent overwrite
  try {
    await fsp.stat(toFile)
    throw new NotesOpError('Destination note already exists', 409)
  } catch (err: any) {
    if (err instanceof NotesOpError) throw err
    if (err.code !== 'ENOENT') throw err
    // ENOENT is expected — destination is free, proceed
  }

  // Move file
  await fsp.mkdir(path.dirname(toFile), { recursive: true })
  await fsp.rename(fromFile, toFile)

  const fromRel = toRelPath(fromFile)
  const toRel = toRelPath(toFile)
  // Index bookkeeping is notes-only — attachments aren't in the structural
  // index, and reconciling a binary file would just churn.
  if (!isAttachment) {
    // Fast path: a one-row path update keeps the id (and all edges) intact.
    updateNotePath(fromRel, toRel)
    // Then reconcile both paths: the old path's index doc is removed (file
    // gone), the new path indexes.
    scheduleNotesIndexUpdate(fromRel)
    scheduleNotesIndexUpdate(toRel)
  }

  log.memory.info('Note moved', { from, to })
  return { ok: true }
}

notesV2Router.post('/move', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from, to } = req.body ?? {}
    res.json(await moveNote(from, to))
  } catch (err) {
    if (err instanceof NotesOpError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    next(err)
  }
})

// ─── Search (hybrid) ───────────────────────────────────────────────────────

type MatchType = 'exact' | 'semantic' | 'both' | 'attachment'

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
  /** Folder whose NAME matched the query (query "dairy" → "Areas/Journal/Dairy"). */
  folderMatch?: string
  /** Section heading that matched the query (query "sin" → "SIN"). */
  headingMatch?: string
}

/** A folder whose name matched, with how many of its notes are in this result set. */
interface FolderGroupRow {
  path: string
  name: string
  noteCount: number
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

// ── Token-aware snippet + highlight ─────────────────────────────────────────
//
// A multi-word query ("canada non resident tax") almost never occurs in a note
// as a contiguous phrase, so a whole-query indexOf produced NO window and NO
// highlight for most real queries — rows fell back to the note's opening line
// (often its own title, which the FE then hides as an echo). The unit of
// matching is the TOKEN, same as the index legs: window on the densest token
// cluster, mark every token occurrence.

const SNIPPET_WINDOW = 240
/** Pre-anchor context. The result row renders ONE line with ellipsis (~40-50
 *  visible chars), so a long lead-in pushes the first <mark> out of view — the
 *  row then looks unhighlighted even though the marks exist. Keep the lead
 *  short enough that the match is always visible. */
const SNIPPET_LEAD = 28
const MAX_SNIPPET_MARKS = 12

function hasCjkText(s: string): boolean {
  return /[㐀-鿿豈-﫿぀-ヿ가-힯]/u.test(s)
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Occurrence regex for one query token. Latin tokens must START at a word
 *  boundary and the mark extends to the word's end ("resident" marks the whole
 *  "Residents") — mid-word hits ("sin" in "Business") are noise, exactly the
 *  rule the title bands learned. CJK has no word boundaries: substring IS the
 *  match unit. Capture-group form, not lookbehind — this logic is mirrored
 *  client-side where old WebKit throws on lookbehind at parse time. */
function tokenOccurrenceRe(tok: string): RegExp {
  return hasCjkText(tok)
    ? new RegExp(`()(${escapeRe(tok)})`, 'giu')
    : new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRe(tok)}[\\p{L}\\p{N}]*)`, 'giu')
}

/** Highlight tokens for a query: its content words plus the fuzzy-corrected
 *  spelling's (the corrected form is what the note actually contains). Falls
 *  back to every ≥2-char word when stopword-stripping leaves nothing ("how to
 *  do it"). Longest-first so a longer token can't be shadowed by a shorter
 *  prefix of itself. */
export function snippetTokens(q: string, corrected?: string): string[] {
  const toks = new Set<string>(contentTokens(q))
  if (corrected) for (const t of contentTokens(corrected)) toks.add(t)
  if (toks.size === 0) {
    for (const t of q.toLowerCase().trim().split(/\s+/)) if (t.length >= 2) toks.add(t)
  }
  return [...toks].sort((a, b) => b.length - a.length)
}

/** Wrap the whole query phrase (when present) and every token occurrence in
 *  <mark>…</mark>. Overlapping ranges collapse into the earlier/longer one. */
export function highlightTokens(text: string, tokens: string[], fullQuery?: string): string {
  if (!text) return text
  const ranges: Array<[number, number]> = []
  const overlaps = (s: number, e: number) => ranges.some(([rs, re]) => s < re && e > rs)
  const phrase = fullQuery?.trim().toLowerCase()
  if (phrase && phrase.length >= 2) {
    const idx = text.toLowerCase().indexOf(phrase)
    if (idx >= 0) ranges.push([idx, idx + phrase.length])
  }
  for (const tok of tokens) {
    const re = tokenOccurrenceRe(tok)
    let m: RegExpExecArray | null
    while (ranges.length < MAX_SNIPPET_MARKS && (m = re.exec(text))) {
      const s = m.index + m[1].length
      const e = s + m[2].length
      if (!overlaps(s, e)) ranges.push([s, e])
      if (re.lastIndex === m.index) re.lastIndex++ // zero-width safety
    }
  }
  if (ranges.length === 0) return text
  ranges.sort((a, b) => a[0] - b[0])
  let out = ''
  let cursor = 0
  for (const [s, e] of ranges) {
    out += text.slice(cursor, s) + '<mark>' + text.slice(s, e) + '</mark>'
    cursor = e
  }
  return out + text.slice(cursor)
}

/** First position of the window holding the most DISTINCT query tokens — the
 *  words of a multi-word query cluster around the topical paragraph even when
 *  the phrase never occurs verbatim. -1 when no token occurs at all. */
function densestTokenWindow(lower: string, tokens: string[]): number {
  const occs: Array<{ pos: number; tok: number }> = []
  tokens.forEach((tok, ti) => {
    const re = tokenOccurrenceRe(tok)
    let m: RegExpExecArray | null
    let n = 0
    while (n < 20 && (m = re.exec(lower))) {
      occs.push({ pos: m.index + m[1].length, tok: ti })
      n++
      if (re.lastIndex === m.index) re.lastIndex++
    }
  })
  if (occs.length === 0) return -1
  occs.sort((a, b) => a.pos - b.pos)
  let best = occs[0].pos
  let bestCount = 0
  for (let i = 0; i < occs.length; i++) {
    const seen = new Set<number>()
    for (let j = i; j < occs.length && occs[j].pos <= occs[i].pos + SNIPPET_WINDOW; j++) {
      seen.add(occs[j].tok)
    }
    if (seen.size > bestCount) {
      bestCount = seen.size
      best = occs[i].pos
    }
  }
  return best
}

/** Build a ±context snippet around the best match region, cleaned + highlighted.
 *  Window anchor priority: whole phrase > section heading (`anchor`) > densest
 *  token cluster > note opening (title/folder matches with no body evidence). */
export function makeSnippet(
  body: string,
  q: string,
  opts: { anchor?: string; corrected?: string } = {},
): string {
  const tokens = snippetTokens(q, opts.corrected)
  const lower = body.toLowerCase()
  const phrase = q.trim().toLowerCase()

  let anchorIdx = phrase.length >= 2 ? lower.indexOf(phrase) : -1
  if (anchorIdx < 0 && opts.anchor) anchorIdx = lower.indexOf(opts.anchor.toLowerCase())
  if (anchorIdx < 0) anchorIdx = densestTokenWindow(lower, tokens)
  if (anchorIdx < 0) {
    // No literal occurrence in the body (title/folder/fuzzy-only match) —
    // opening as context; token highlight may still catch a cleaned-form hit.
    return highlightTokens(cleanSnippetText(body.slice(0, 240)).slice(0, 160), tokens, q)
  }
  // Widen the raw window before cleaning, since cleaning removes characters.
  let start = Math.max(0, anchorIdx - SNIPPET_LEAD)
  if (start > 0) {
    // Snap to a word start so the lead-in doesn't open mid-word.
    const sp = body.indexOf(' ', start)
    if (sp >= 0 && sp < anchorIdx) start = sp + 1
  }
  const end = Math.min(body.length, anchorIdx + SNIPPET_WINDOW)
  const cleaned = cleanSnippetText(body.slice(start, end))
  const raw = (start > 0 ? '…' : '') + cleaned + (end < body.length ? '…' : '')
  return highlightTokens(raw, tokens, q)
}

/**
 * Convert an absolute note filepath → vault-relative → note id (case-insensitive).
 * BLOCKING correctness: the semantic leg returns an ABSOLUTE filepath; the index
 * stores vault-relative paths. Without this, every both-leg note double-lists.
 * Falls back to the relPath as the dedupe key only if the note is unindexed.
 */
function idFromAbsPath(filepath: string): string {
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
 * Semantic-only relevance floor + cap. The index happily returns low-score noise
 * ("Shoping", "Post office" for query "dental") which made search feel broken.
 * We keep semantic hits that either (a) ALSO matched as a string (matchType
 * 'both', no floor) or (b) clear the floor; and we cap how many semantic-ONLY
 * rows survive so the list isn't flooded with weak matches.
 */
const SEMANTIC_ONLY_CAP = 10

/**
 * How many notes matched ONLY by their containing folder's name may appear. The
 * folder row itself carries the full count and opens the folder, so these rows
 * are just a sample — uncapped, a 233-note folder would consume the whole list.
 */
const FOLDER_ONLY_CAP = 5

/**
 * How many attachment (OCR/PDF text) rows may appear. Attachments are real
 * string evidence but extraction noise makes them junk-prone: a vague query
 * once put SIX scanned-form PDFs above every authored note. Three keeps the
 * legit "find my scanned document" case working without the flooding.
 */
const ATTACHMENT_CAP = 3

/**
 * Same job for the search-v2 leg (WALNUT_SEARCH_V2=1), different scale: the v2
 * leg is banded on its COSINE component. qwen3 cosines for genuinely related
 * notes sit ≥0.5; loosely-topical neighbours ~0.4; below 0.35 is noise that
 * only crowds the page.
 */
const SEARCH_V2_NOTE_COS_FLOOR = 0.35

export interface NotesSearchPayload {
  results: SearchResultRow[]
  folders?: FolderGroupRow[]
  /** The content-bearing query words the index matched on — the client uses
   *  them to highlight titles/folder names token-wise (the server only
   *  highlights snippets). One tokenization truth, not a client re-derivation. */
  queryTokens?: string[]
  degraded?: 'semantic-unavailable'
}

/**
 * The hybrid notes search, req/res-free — shared by the internal
 * GET /api/notes-v2/search route below and GET /api/v1/notes/search
 * (search-memory-v1.ts). One implementation, two error shapes at the edges.
 */
export async function performNotesSearch(opts: {
  q: string
  limit?: number
  mode?: 'hybrid' | 'string' | 'semantic'
  includeAll?: boolean
}): Promise<NotesSearchPayload> {
  // Metric per mode: `string` must stay double-digit ms (keystroke path);
  // `hybrid` is the two-stage upgrade. A regression shows as a p90 split.
  return timed('search.notes', () => performNotesSearchInner(opts), { mode: opts.mode || 'hybrid' })
}

async function performNotesSearchInner(opts: {
  q: string
  limit?: number
  mode?: 'hybrid' | 'string' | 'semantic'
  includeAll?: boolean
}): Promise<NotesSearchPayload> {
  ensureIndexBootstrap()
  const q = opts.q.trim()
  if (!q) return { results: [] }

  const limit = Math.max(1, Math.min(100, opts.limit || 30))
  const mode = opts.mode || 'hybrid'

  await ensureNotesDir()

    // User-configured folder exclusion (settings → search.excluded_folders,
    // e.g. ['archive']). Query-time view filter — the index keeps everything,
    // so toggling the setting needs no reindex. `all=1` searches everything
    // (the UI's "include excluded folders" escape hatch).
    const includeAll = opts.includeAll === true
    let excludeFolders: string[] = []
    if (!includeAll) {
      try {
        const cfg = await getConfig()
        excludeFolders = normalizeExcludeFolders(cfg.search?.excluded_folders)
      } catch { /* config unreadable → no exclusion */ }
    }

    // Run both legs; allSettled so one failing never zeroes the other.
    // Cloud companion has no index — the semantic leg would lazily init the
    // embedding model (hundreds of MB, pins the small instance). String/FTS
    // search is the cloud answer (same gate as the wiring in server.ts).
    const wantString = mode === 'hybrid' || mode === 'string'
    const wantSemantic = !CLOUD_MODE
      && process.env.WALNUT_DISABLE_SEARCH !== '1'
      && (mode === 'hybrid' || mode === 'semantic')

    // Maps index hits to the shape the merge loop consumes (filepath/score/
    // snippet/title).
    const v2SemanticLeg = async () => {
      const { searchV2Lane } = await import('../../core/search/wiring.js')
      const { extractSnippet } = await import('../../core/search.js')
      // 1s deadline (default 150ms): a query landing while the embed worker is
      // mid-passage (backfill / session re-embed) waits for that one inference
      // call (~0.5-0.7s measured). At 150ms EVERY such query silently degraded
      // to keyword order — junk rows labelled 'semantic'. The backfill yields
      // between passages, so only the first query of a burst ever waits.
      const hits = await searchV2Lane(q, { kinds: ['note'], limit: limit * 2, semanticDeadlineMs: 1000 })
      return hits.map((h) => ({
        filepath: h.ref,
        score: h.score,
        // The pure similarity component, only when the rescore really ran —
        // the additive `score` mixes bm25/coverage/recency, which the string
        // leg already banded; on a degraded leg the order is keyword, not
        // semantic, and must not be dressed up as a semantic opinion.
        cos: h.semantic === 'ok' ? h.components.cosine : undefined,
        snippet: extractSnippet(h.text, q),
        title: h.title,
      }))
    }

    const [stringSettled, semanticSettled] = await Promise.allSettled([
      wantString ? Promise.resolve(stringSearch(q, limit * 2, { excludeFolders })) : Promise.resolve([]),
      wantSemantic ? v2SemanticLeg() : Promise.resolve([]),
    ])

    const byId = new Map<string, SearchResultRow>()

    if (stringSettled.status === 'fulfilled') {
      for (const h of stringSettled.value) {
        // Defense-in-depth: the SQL-level exclusion uses LIKE (ASCII-only case
        // folding), the JS mirror full-Unicode toLowerCase. Re-filter here so a
        // non-ASCII-cased folder name (Été/ vs été) can never leak through the
        // string leg while the semantic leg filters it — one view, one rule.
        if (isPathExcluded(h.path, excludeFolders)) continue
        byId.set(h.id, {
          id: h.id,
          path: h.path,
          title: h.title,
          // A heading hit anchors at the heading's own section (the first body
          // occurrence may be an unrelated word elsewhere); a fuzzy hit
          // highlights the CORRECTED spelling — that's what the body contains.
          snippet: makeSnippet(h.body, q, { anchor: h.headingMatch, corrected: h.correctedQuery }),
          matchType: 'exact',
          score: 0,
          stringScore: h.stringScore, // real banded relevance (title > folder > heading > tag > body > LIKE)
          ...(h.folderMatch ? { folderMatch: h.folderMatch } : {}),
          ...(h.headingMatch ? { headingMatch: h.headingMatch } : {}),
          ...(h.matchedTags ? { matchedTags: h.matchedTags } : {}),
        })
      }
    }

    let degraded: 'semantic-unavailable' | undefined
    if (semanticSettled.status === 'fulfilled') {
      // The v2 leg's raw scores are ADDITIVE components in ~[0, 1.3] — a scale
      // the string bands (≤1.0, title ≥0.90 > folder 0.875-0.89 > heading 0.87
      // > tag 0.86 > body 0.50-0.85) were never designed against. Fed raw into
      // the tier-1 max() below, dozens of body+semantic 'both' rows outscored a
      // PERFECT title match (query "goals" buried the note literally titled
      // "GOALS" at rank 20). Map v2 scores into the body band [0.55, 0.85]:
      // monotonic (semantic-only ordering and caps keep v2's own ranking), and
      // by construction never above any title/folder/heading/tag band — a
      // semantic opinion can lift a body hit to the top of the body band, but
      // can never outrank deliberate authored structure.
      const toSemanticBand = (raw: number): number =>
        0.55 + 0.35 * Math.max(0, Math.min(1, raw))
      for (const h of semanticSettled.value) {
        // Folder exclusion for the semantic leg: the index stores absolute
        // paths, so filter on the vault-relative form (JS mirror of the SQL filter).
        const relForFilter = path.relative(NOTES_DIR, h.filepath).replace(/\\/g, '/')
        if (isPathExcluded(relForFilter, excludeFolders)) continue
        // v2 bands from COSINE, not the leg's additive score: the additive mix
        // re-counts keyword evidence the string leg already banded (a body-
        // noise doc containing all query words rode it to the 0.85 ceiling as
        // a fake 'both'), while a doc with no cosine at all carries no
        // semantic opinion worth merging.
        const sem = h.cos
        if (sem === undefined) continue
        const id = idFromAbsPath(h.filepath)
        const existing = byId.get(id)
        if (existing) {
          // Already a string hit → promote to 'both' (no floor — string match
          // already proves relevance). Keep the highlighted string snippet.
          existing.matchType = 'both'
          existing.semanticScore = toSemanticBand(sem)
          if (!existing.snippet.includes('<mark>') && h.snippet) {
            existing.snippet = highlightTokens(cleanSnippetText(h.snippet), snippetTokens(q), q)
          }
        } else if (sem >= SEARCH_V2_NOTE_COS_FLOOR) {
          // Semantic-only: keep only above the relevance floor (drops noise).
          byId.set(id, {
            id,
            path: id.endsWith('.md') ? id : (getPathForId(id) ?? id),
            title: h.title || path.basename(id, '.md'),
            // Semantic hits usually share SOME query words even when the match
            // is conceptual — mark them when present, plain context otherwise.
            snippet: highlightTokens(cleanSnippetText(h.snippet || ''), snippetTokens(q), q),
            matchType: 'semantic',
            score: 0,
            semanticScore: toSemanticBand(sem),
          })
        }
      }
    } else if (wantSemantic) {
      degraded = 'semantic-unavailable'
    }

    // Attachment leg: OCR/PDF-extracted text of binary files. Their paths never
    // collide with note ids (different namespace), so no dedupe against notes.
    // They rank in tier 1 (real string evidence) at their low 0.40–0.45 band —
    // above semantic guesses, below any authored-note text match.
    if (wantString) {
      try {
        for (const a of attachmentSearch(q, Math.min(limit, 10), { excludeFolders })) {
          if (isPathExcluded(a.path, excludeFolders)) continue // see string-leg note
          const key = `attachment:${a.path}`
          byId.set(key, {
            id: key,
            path: a.path,
            title: path.basename(a.path),
            snippet: makeSnippet(a.text, q),
            matchType: 'attachment',
            score: 0,
            stringScore: a.stringScore,
          })
        }
      } catch { /* attachment leg is best-effort */ }
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

    // Matching FOLDERS become their own rows above the notes, with a TRUE
    // recursive note count from the index (not a count of rows in this window).
    const matchedFolders = new Set<string>()
    for (const r of results) if (r.folderMatch) matchedFolders.add(r.folderMatch)
    // Direct folder-name scan: a folder holding only attachments (a PDF dossier
    // folder) has zero note rows, so no result can ever carry its folderMatch —
    // without this it is simply unfindable by name.
    if (wantString) {
      try {
        for (const p of searchFolders(q, 5, { excludeFolders })) matchedFolders.add(p)
      } catch { /* folder scan is best-effort */ }
    }
    const folders: FolderGroupRow[] = [...matchedFolders]
      .map((p) => ({
        path: p,
        name: p.split('/').pop() ?? p,
        noteCount: countNotesUnderFolder(p),
      }))
      .sort((a, b) => b.noteCount - a.noteCount || a.path.localeCompare(b.path))

    // Cap semantic-only rows so weak matches don't flood the list, while never
    // touching exact/both hits (they're all kept, up to the overall limit).
    //
    // FOLDER-only rows get their own cap for the same reason: query "journal"
    // matches 233 notes under Areas/Journal/, and listing 30 date-named children
    // buries every other kind of match. The folder ROW above already says "233
    // notes" and opens the folder, so a handful of samples is enough. A note that
    // ALSO matched by title/body/semantics is not folder-only and is never capped.
    const capped: SearchResultRow[] = []
    let semanticOnly = 0
    let folderOnly = 0
    let attachments = 0
    // "Strong semantic" on the banded scale: after
    // toSemanticBand ≥0.70 (cosine ≥0.43). The band floor is ~0.67, so the old
    // 0.5 would exempt EVERY v2 semantic hit from the folder-only cap.
    const strongSemantic = 0.7
    for (const r of results) {
      if (r.matchType === 'semantic') {
        if (semanticOnly >= SEMANTIC_ONLY_CAP) continue
        semanticOnly++
      }
      // Attachments are OCR/PDF text — real string evidence but junk-prone
      // (stopwordy queries match boilerplate in scanned forms). A few rows is
      // signal; six PDF rows burying every authored note is flooding.
      if (r.matchType === 'attachment') {
        if (attachments >= ATTACHMENT_CAP) continue
        attachments++
      }
      // folderMatch + a stringScore still in the folder band (<0.90, i.e. no title
      // hit and no body-FTS hit outranked it) ⇒ the folder name is the only reason
      // this note is here. A strong semantic hit exempts it — that's a real
      // content match, not folder membership.
      const isFolderOnly =
        !!r.folderMatch && (r.stringScore ?? 0) < 0.9 && (r.semanticScore ?? 0) < strongSemantic
      if (isFolderOnly) {
        if (folderOnly >= FOLDER_ONLY_CAP) continue
        folderOnly++
      }
      capped.push(r)
      if (capped.length >= limit) break
    }

    const payload: NotesSearchPayload = { results: capped, queryTokens: snippetTokens(q) }
    if (folders.length > 0) payload.folders = folders
    if (degraded) payload.degraded = degraded
    return payload
}

// GET /api/notes-v2/search?q&mode&limit — hybrid string+semantic, deduped, labeled
notesV2Router.get('/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const payload = await performNotesSearch({
      q: (req.query.q as string) || '',
      limit: Number(req.query.limit) || 30,
      mode: ((req.query.mode as string) || 'hybrid') as 'hybrid' | 'string' | 'semantic',
      includeAll: req.query.all === '1' || req.query.all === 'true',
    })
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

/**
 * Index-backed backlinks for a note (id-keyed; includes ambiguous inbound
 * edges). Shared by this router's GET /backlinks/*path and
 * GET /api/v1/notes/backlinks/*path — throws NotesOpError for bad paths.
 */
export async function getNoteBacklinks(notePath: unknown): Promise<{ backlinks: BacklinkResult[] }> {
  ensureIndexBootstrap()
  if (typeof notePath !== 'string' || !notePath) throw new NotesOpError('path required', 400)
  const fullPath = resolveSafePath(notePath)
  if (!fullPath) throw new NotesOpError('invalid path', 400)
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
  return { backlinks }
}

/**
 * Forward links of a note. Shared by this router's GET /links/*path and
 * GET /api/v1/notes/links/*path — throws NotesOpError for bad paths.
 */
export function getNoteForwardLinks(notePath: unknown): {
  links: Array<{ dstId: string | null; dstName: string; status: LinkStatus; title?: string; path?: string }>
} {
  ensureIndexBootstrap()
  if (typeof notePath !== 'string' || !notePath) throw new NotesOpError('path required', 400)
  const fullPath = resolveSafePath(notePath)
  if (!fullPath) throw new NotesOpError('invalid path', 400)
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
  return { links }
}

// GET /api/notes-v2/backlinks/*path — index-backed, id-keyed, returns status
notesV2Router.get('/backlinks/*path', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await getNoteBacklinks(getWildcardPath(req)))
  } catch (err) {
    if (err instanceof NotesOpError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    next(err)
  }
})

// GET /api/notes-v2/links/*path — forward links of a note (optional)
notesV2Router.get('/links/*path', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(getNoteForwardLinks(getWildcardPath(req)))
  } catch (err) {
    if (err instanceof NotesOpError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    next(err)
  }
})

// ─── Folder CRUD ─────────────────────────────────────────────────────────

/**
 * Create a vault folder. Shared by this router's POST /folder and
 * POST /api/v1/notes/folder — throws NotesOpError for validation failures.
 */
export async function createNotesFolder(folderPath: unknown): Promise<{ ok: true }> {
  if (typeof folderPath !== 'string') throw new NotesOpError('path (string) is required', 400)
  const fullPath = resolveSafePath(folderPath)
  if (!fullPath) throw new NotesOpError('invalid path', 400)
  await fsp.mkdir(fullPath, { recursive: true })
  return { ok: true }
}

// POST /api/notes-v2/folder — create folder
notesV2Router.post('/folder', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await createNotesFolder((req.body ?? {}).path))
  } catch (err) {
    if (err instanceof NotesOpError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    next(err)
  }
})

// ─── List (for wiki-link autocomplete) ─────────────────────────────────────

/**
 * Flat note list with ids (feeds [[ authoring / autocomplete). Shared by
 * GET /api/notes-v2/list and GET /api/v1/notes/list.
 */
export async function listNotesFlat(): Promise<{ notes: Array<{ id: string; title: string; path: string; name: string }> }> {
  ensureIndexBootstrap()
  await ensureNotesDir()
  const rows = listNotes()
  if (rows.length > 0) {
    return {
      notes: rows.map((r) => ({
        id: r.id,
        title: r.title,
        path: r.path,
        name: path.basename(r.path, '.md'),
      })),
    }
  }
  // Index empty (cold start before first rebuild) — fall back to a file walk so
  // [[ autocomplete works immediately; ids fill in once the index settles.
  const allFiles = await getAllMdFilesFallback(NOTES_DIR)
  return {
    notes: allFiles.map((f) => {
      const relPath = toRelPath(f)
      const name = path.basename(relPath, '.md')
      return { id: '', title: name, path: relPath, name }
    }),
  }
}

/**
 * Resolve one note REFERENCE to its vault path. A reference is any of the three
 * things a caller actually holds: a frontmatter id (`n_...`, the FIRST field of
 * every note_search hit), a vault-relative path (with or without `.md`), or a
 * bare title/basename. Shared by the internal route and GET /api/v1/notes/resolve.
 *
 * Throws NotesOpError 404 when nothing matches and 409 when a title is
 * ambiguous — a confident wrong answer here means the caller reads (or worse,
 * overwrites) a different note than the one they meant.
 */
export async function resolveNoteRef(
  ref: unknown,
): Promise<{ id: string | null; path: string; title: string | null; matchedBy: 'id' | 'path' | 'name' }> {
  if (typeof ref !== 'string' || !ref.trim()) {
    throw new NotesOpError('ref (note id, path, or title) is required', 400)
  }
  ensureIndexBootstrap()
  const raw = ref.trim()

  // 1. Frontmatter id — the only form that cannot also be a path.
  const byId = getNotePathById(raw)
  if (byId) return { id: raw, path: byId, title: null, matchedBy: 'id' }

  // 2. A real file at that path (index-independent, so it works cold too).
  const fullPath = resolveSafePath(raw)
  if (!fullPath) throw new NotesOpError('invalid path', 400)
  const filePath = fullPath.endsWith('.md') ? fullPath : fullPath + '.md'
  try {
    await fsp.stat(filePath)
    const relPath = toRelPath(filePath)
    return { id: getNoteIdByPath(relPath) ?? null, path: relPath, title: null, matchedBy: 'path' }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  // 3. Title / basename, the way [[wikilinks]] resolve.
  const named = findNoteIdsByName(raw)
  if (named.length === 1) {
    return { id: named[0].id, path: named[0].path, title: raw, matchedBy: 'name' }
  }
  if (named.length > 1) {
    throw new NotesOpError(
      `"${raw}" matches ${named.length} notes: ${named.slice(0, 5).map((n) => n.path).join(', ')}. Pass one exact path or id.`,
      409,
    )
  }
  if (raw.startsWith('n_')) {
    throw new NotesOpError(`No note with id ${raw} (the id index may be cold; try the path from note_search)`, 404)
  }
  throw new NotesOpError(`Note not found: ${raw}`, 404)
}

// GET /api/notes-v2/list — flat note list. Now returns id per note (feeds [[ authoring).
notesV2Router.get('/list', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await listNotesFlat())
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

/**
 * Rename a tag across every carrying note (frontmatter tags[] + inline #tag).
 * Shared by POST /api/notes-v2/tags/rename and POST /api/v1/notes/tags/rename.
 * Throws NotesOpError(400) on missing/invalid input.
 */
export async function renameNoteTag(rawFrom: unknown, rawTo: unknown): Promise<{ ok: true; updated: number }> {
  ensureIndexBootstrap()
  const from = normalizeTag(String(rawFrom || ''))
  const to = normalizeTag(String(rawTo || ''))
  if (!from || !to) throw new NotesOpError('from and to (strings) are required', 400)
  if (from === to) return { ok: true, updated: 0 }

  // Targeted by the tag index — NOT a vault scan.
  const paths = notePathsForTag(from)
  let updated = 0
  // Negative lookahead on the FULL tag charset (see INLINE_TAG_RE): `\b`
  // treats `-`/`/` as boundaries, so renaming #work also hit #work-log.
  const inlineRe = new RegExp(`(^|[\\s(])#${escapeRegExp(from)}(?![A-Za-z0-9/_-])`, 'g')

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
        // Rewrite only the tag tokens, and ONLY on lines that belong to the
        // `tags:` key (inline array or block list) — an unscoped rewrite also
        // hit bare words in other fields (`title: my work notes`).
        const tokenRe = new RegExp(`(^|[\\s,\\[])#?${escapeRegExp(from)}(?=$|[\\s,\\]])`, 'g')
        let inTagsBlock = false
        newRaw = raw
          .split('\n')
          .map((line) => {
            const key = line.match(/^([A-Za-z_][\w-]*):/)
            if (key) inTagsBlock = key[1] === 'tags'
            else if (!/^\s*(-\s|#)/.test(line) && line.trim() !== '') inTagsBlock = false
            const isTagsLine = inTagsBlock || /^tags:/.test(line)
            return isTagsLine ? line.replace(tokenRe, (_m, pre) => `${pre}${to}`) : line
          })
          .join('\n')
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

  return { ok: true, updated }
}

// POST /api/notes-v2/tags/rename — targeted rewrite (carrying notes only)
notesV2Router.post('/tags/rename', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await renameNoteTag(req.body?.from, req.body?.to))
  } catch (err) {
    if (err instanceof NotesOpError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
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
    if (CLOUD_MODE || process.env.WALNUT_DISABLE_SEARCH === '1') {
      // No search index on the companion (or when indexing is off) — don't
      // lazy-init one just to report status.
      embedState = 'unavailable'
    } else {
      // Read the wiring's in-memory backfill flag; never open SQLite from a
      // status request (that can synchronously wait on the writer lock and
      // freeze every HTTP request).
      const { getSearchIndexStatus } = await import('../../core/search/wiring.js')
      embedState = getSearchIndexStatus().backfillRunning ? 'embedding' : 'idle'
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
