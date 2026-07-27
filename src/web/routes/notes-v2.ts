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
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { Router, type Request, type Response, type NextFunction } from 'express'
import { NOTES_DIR, CLOUD_MODE } from '../../constants.js'
import { computeContentHash } from '../../utils/file-ops.js'
import { withFileLock } from '../../utils/file-lock.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { log } from '../../logging/index.js'
import { memoryNotesSearch } from '../../core/memory-search.js'
import { isQmdBackgroundIndexRunning } from '../../core/qmd-background-indexer.js'
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
  countNotesUnderFolder,
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
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf',
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
const INLINE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf'])

// RFC 5987 ext-value: encodeURIComponent leaves ' * ( ) unescaped, but a bare
// ' collides with the UTF-8'' delimiter and breaks download filenames.
function rfc5987Encode(s: string): string {
  return encodeURIComponent(s).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
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
    // Inline so the browser renders PDF/images in-page; Office docs download
    // (with their real filename) since the browser can't render them.
    res.setHeader(
      'Content-Disposition',
      INLINE_EXTS.has(ext)
        ? 'inline'
        : `attachment; filename*=UTF-8''${rfc5987Encode(path.basename(fullPath))}`,
    )
    res.send(buffer)
  } catch (err) {
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
    // Index bookkeeping is notes-only — attachments aren't in the structural
    // index, and reconciling a binary file would just churn.
    if (!isAttachment) {
      // Fast path: a one-row path update keeps the id (and all edges) intact.
      updateNotePath(fromRel, toRel)
      // Then reconcile both paths: the old path's QMD doc deactivates (file gone),
      // the new path indexes (and re-points the QMD virtual path).
      scheduleNotesIndexUpdate(fromRel)
      scheduleNotesIndexUpdate(toRel)
    }

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
  /** Folder whose NAME matched the query (query "dairy" → "Areas/Journal/Dairy"). */
  folderMatch?: string
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
 * Semantic-only relevance floor + cap. QMD happily returns low-score noise
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
 * Interactive-search relevance floor for the RRF-only (rerank-disabled) semantic
 * leg. Without the local reranker QMD scores a hit as `1 / rrfRank`, so the
 * [0,1] cosine-like scale SEMANTIC_FLOOR assumes no longer applies: rank 1 =
 * 1.0, rank 2 = 0.5, rank 3 = 0.33 … Reusing 0.45 here would keep only the top
 * TWO semantic rows. 1/6 keeps the top six — the same recall the reranked path
 * produced — while still dropping the long RRF tail.
 *
 * Why rerank is off at all: the reranker is a local llama.cpp cross-encoder over
 * up to 40 candidate chunks. Cold (uncached query) that costs 5–8s of the ~8s
 * total request, and it runs on EVERY keystroke-debounced search. `/api/search`
 * already passes `rerank: false` for exactly this reason; the notes panel was
 * the last interactive surface still paying for it.
 */
const SEMANTIC_RRF_FLOOR = 1 / 6

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
    // the embedding model (hundreds of MB, pins the small instance). String/FTS
    // search is the cloud answer (same gate as initQmdStores in server.ts).
    const wantString = mode === 'hybrid' || mode === 'string'
    const wantSemantic = !CLOUD_MODE && (mode === 'hybrid' || mode === 'semantic')

    const [stringSettled, semanticSettled] = await Promise.allSettled([
      wantString ? Promise.resolve(stringSearch(q, limit * 2)) : Promise.resolve([]),
      // rerank:false + overfetch 1 — see SEMANTIC_RRF_FLOOR. This is the
      // difference between a ~60ms and a ~8s notes search.
      wantSemantic
        ? memoryNotesSearch(q, ['note_vault'], limit * 2, undefined, {
            rerank: false,
            overfetchMultiplier: 1,
          })
        : Promise.resolve([]),
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
          stringScore: h.stringScore, // real banded relevance (title > folder > body > LIKE)
          ...(h.folderMatch ? { folderMatch: h.folderMatch } : {}),
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
        } else if (h.score >= SEMANTIC_RRF_FLOOR) {
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

    // Matching FOLDERS become their own rows above the notes, with a TRUE
    // recursive note count from the index (not a count of rows in this window).
    const matchedFolders = new Set<string>()
    for (const r of results) if (r.folderMatch) matchedFolders.add(r.folderMatch)
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
    for (const r of results) {
      if (r.matchType === 'semantic') {
        if (semanticOnly >= SEMANTIC_ONLY_CAP) continue
        semanticOnly++
      }
      // folderMatch + a stringScore still in the folder band (<0.90, i.e. no title
      // hit and no body-FTS hit outranked it) ⇒ the folder name is the only reason
      // this note is here. A strong semantic hit exempts it — that's a real
      // content match, not folder membership.
      const isFolderOnly =
        !!r.folderMatch && (r.stringScore ?? 0) < 0.9 && (r.semanticScore ?? 0) < 0.5
      if (isFolderOnly) {
        if (folderOnly >= FOLDER_ONLY_CAP) continue
        folderOnly++
      }
      capped.push(r)
      if (capped.length >= limit) break
    }

    const payload: {
      results: SearchResultRow[]
      folders?: FolderGroupRow[]
      degraded?: 'semantic-unavailable'
    } = { results: capped }
    if (folders.length > 0) payload.folders = folders
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
    } else {
      // Never open SQLite from a status request. During a worker pass that can
      // synchronously wait on the writer lock and freeze every HTTP request.
      embedState = isQmdBackgroundIndexRunning() ? 'embedding' : 'idle'
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
