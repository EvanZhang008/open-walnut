/**
 * Serve local or remote file content for the FileViewer overlay.
 *
 * GET /api/file-content?path=/absolute/path/to/file.ts&host=optional-ssh-host
 * PUT /api/file-content  { path, host?, content, expectedHash? }  → save an edit
 *
 * Security:
 * - Must be absolute path
 * - No directory traversal (explicit .. rejection)
 * - File size limit (512 KB for text content)
 * - Binary detection (first 8KB NUL scan)
 * - Localhost-only server
 *
 * The WRITE path reuses the read path's guards verbatim (`assertPathAllowed`) —
 * one sandbox for both verbs, so a future denylist entry can't protect reads
 * while leaving writes open. On top of that it refuses to clobber anything the
 * viewer can't faithfully round-trip (binary, >512 KB) and takes an optional
 * `expectedHash` for optimistic locking (mirrors the notes save contract).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { createFileReader } from '../../core/session-file-reader.js'
import type { DaemonFileReader } from '../../core/daemon-file-reader.js'
import { CLOUD_MODE, WALNUT_HOME } from '../../constants.js'
import { computeContentHash } from '../../utils/file-ops.js'
import { withFileLock } from '../../utils/file-lock.js'
import { log } from '../../logging/index.js'

/**
 * In CLOUD mode a LOCAL file read (no `host=`) is confined to a small root
 * allowlist. The public box holds git-synced provider secrets (config.yaml),
 * auth.json (token hashes) and AWS creds; the old `..`-only check let any
 * paired-device token read them by absolute path. Remote reads (`host=`) still
 * go through the daemon on the target host and are unaffected. On the Mac
 * (trusted LAN, owner's own machine) the FileViewer needs the whole FS, so this
 * confinement is cloud-only.
 */
function cloudLocalReadAllowed(absPath: string): boolean {
  const resolved = path.resolve(absPath)
  const roots = [
    path.join(os.tmpdir(), 'open-walnut'),
    path.join(os.tmpdir(), 'open-walnut-streams'),
    '/tmp/open-walnut',
    '/tmp/open-walnut-streams',
    path.join(os.homedir(), '.open-walnut', 'tmp'), // daemon stream files (2026-08 move)
  ]
  return roots.some((r) => resolved === r || resolved.startsWith(r + path.sep))
}

/** Absolute paths / dirs whose contents are secrets — never served locally. */
function isSecretPath(absPath: string): boolean {
  const resolved = path.resolve(absPath)
  const home = os.homedir()
  const denied = [
    path.join(WALNUT_HOME, 'auth.json'),
    path.join(WALNUT_HOME, 'sync', 'bridge-tokens.json'),
    path.join(home, '.aws'),
    path.join(home, '.ssh'),
    path.join(home, '.config', 'walnut-secrets'),
  ]
  return denied.some((d) => resolved === d || resolved.startsWith(d + path.sep))
    || /(^|\/)config\.ya?ml$/.test(resolved)
}

export const fileContentRouter = Router()

const MAX_FILE_SIZE = 512 * 1024 // 512 KB

/**
 * Extensions served as byte-exact raw streams with a real Content-Type, so the
 * BROWSER renders them with its own built-in viewer (PDF.js, image decoder,
 * media player) instead of Walnut re-implementing one. Text decoding would
 * corrupt every one of these, which is why they bypass the JSON payload path.
 */
const RAW_INLINE_MIME: Record<string, string> = {
  // Video / audio — <video>/<audio> issue Range requests to seek.
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  // Documents the browser renders natively.
  pdf: 'application/pdf',
  // Raster images (svg stays on the text path — it IS text).
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  heic: 'image/heic',
  tiff: 'image/tiff',
  tif: 'image/tiff',
}

/** Per-write chunk when streaming remote bytes (matches DaemonFileReader.CHUNK_SIZE —
 *  one WS frame per chunk keeps corp SSH proxies from killing the tunnel). */
const REMOTE_STREAM_CHUNK = 1024 * 1024

/**
 * Parse an HTTP Range header against a known file size.
 * Returns null when absent (serve 200 full), 'unsatisfiable' for a bad/out-of-range
 * spec (serve 416), or the inclusive byte window. Only single ranges are supported —
 * that's all <video>/<audio> ever send.
 */
function parseRangeHeader(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return 'unsatisfiable'
  const [, startStr, endStr] = m
  if (startStr === '' && endStr === '') return 'unsatisfiable'
  if (startStr === '') {
    // Suffix range: last N bytes
    const suffix = Number(endStr)
    if (suffix === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(startStr)
  const end = endStr === '' ? size - 1 : Math.min(Number(endStr), size - 1)
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}

/**
 * Serve a file's raw bytes with Range support — the playback path for video/audio
 * (<video src> issues Range requests to seek) and the universal download fallback.
 * Local: fs stream. Remote: daemon fs.readRange in 1MB chunks (never one whole-file
 * frame — see DaemonFileReader.CHUNK_THRESHOLD). Aborts cleanly when the player
 * cancels mid-stream (seek) so a whale video doesn't keep transferring.
 */
async function serveRawBytes(
  req: Request,
  res: Response,
  filePath: string,
  host: string | undefined,
  ctype: string,
  download: boolean,
): Promise<void> {
  const isRemote = typeof host === 'string' && host.length > 0

  let size: number
  if (isRemote) {
    const reader = (await createFileReader(host)) as DaemonFileReader
    let st: { size: number } | null
    try {
      st = await reader.stat(filePath)
    } catch (err) {
      res.status(502).type('text/plain')
        .send(`Cannot reach remote host: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (st === null) {
      res.status(404).type('text/plain').send('File not found')
      return
    }
    size = st.size

    const range = parseRangeHeader(req.headers.range, size)
    if (range === 'unsatisfiable') {
      res.status(416).set('Content-Range', `bytes */${size}`).end()
      return
    }
    const start = range ? range.start : 0
    const end = range ? range.end : size - 1
    res.status(range ? 206 : 200)
    res.set({
      'Content-Type': ctype,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
      ...(download ? { 'Content-Disposition': `attachment; filename="${path.basename(filePath)}"` } : {}),
    })

    let offset = start
    while (offset <= end) {
      if (res.destroyed || res.writableEnded) return // player aborted (e.g. seek)
      const want = Math.min(REMOTE_STREAM_CHUNK, end - offset + 1)
      let chunk: { buf: Buffer; eof: boolean } | null
      try {
        chunk = await reader.readRangeBytes(filePath, offset, want)
      } catch {
        res.destroy() // headers already sent — can only cut the connection
        return
      }
      if (chunk === null || chunk.buf.length === 0) { res.end(); return }
      const ok = res.write(chunk.buf)
      offset += chunk.buf.length
      if (!ok) {
        // Race drain against close: a player abort mid-backpressure would
        // otherwise never emit 'drain' and leak this promise forever.
        await new Promise<void>((resolve) => {
          const done = () => { res.off('drain', done); res.off('close', done); resolve() }
          res.once('drain', done)
          res.once('close', done)
        })
      }
    }
    res.end()
    return
  }

  // Local file
  let stat
  try {
    stat = await fsp.stat(filePath)
  } catch {
    res.status(404).type('text/plain').send('File not found')
    return
  }
  if (!stat.isFile()) {
    res.status(404).type('text/plain').send('Not a regular file')
    return
  }
  size = stat.size

  const range = parseRangeHeader(req.headers.range, size)
  if (range === 'unsatisfiable') {
    res.status(416).set('Content-Range', `bytes */${size}`).end()
    return
  }
  const start = range ? range.start : 0
  const end = range ? range.end : size - 1
  res.status(range ? 206 : 200)
  res.set({
    'Content-Type': ctype,
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    ...(download ? { 'Content-Disposition': `attachment; filename="${path.basename(filePath)}"` } : {}),
  })
  const stream = fs.createReadStream(filePath, { start, end })
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

/** Detect binary content by scanning for NUL bytes in the first 8KB */
function isBinaryContent(buffer: Buffer): boolean {
  const scanLen = Math.min(buffer.length, 8192)
  for (let i = 0; i < scanLen; i++) {
    if (buffer[i] === 0) return true
  }
  return false
}

/** Validation failure with an HTTP-ish status — each edge maps its own shape. */
export class FileContentError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message)
    this.name = 'FileContentError'
  }
}

export interface FileContentPayload {
  content: string | null
  size: number
  truncated: boolean
  binary: boolean
  extension: string
  error?: string
  /**
   * Hash of the bytes served, for the editor's optimistic lock on save. Present
   * only for a complete text read — a TRUNCATED payload deliberately has none,
   * because hashing the first 512 KB would let a save round-trip a partial file
   * back over the whole thing. No hash → the editor stays read-only.
   */
  contentHash?: string
}

/**
 * The path sandbox BOTH verbs share. Validates + normalizes a caller-supplied
 * path and reports whether it addresses a remote host.
 *
 * Extracted so read and write can never drift: every guard added here applies to
 * both. `intent` only widens the cloud-mode rule — see below.
 *
 * Throws FileContentError for anything invalid/forbidden; returns the local
 * absolute path (`~` expanded) or, for remote, the path untouched (the daemon
 * expands `~` against the remote HOME).
 */
export function assertPathAllowed(
  rawPath: unknown,
  host: string | undefined,
  intent: 'read' | 'write' = 'read',
): { filePath: string; isRemote: boolean } {
  if (!rawPath || typeof rawPath !== 'string') {
    throw new FileContentError('Missing or invalid path parameter', 400)
  }
  // No directory traversal
  if (rawPath.includes('..')) {
    throw new FileContentError('Invalid path', 400)
  }

  // Expand `~`/`~/…` for local reads; remote keeps `~` (daemon expands it).
  let filePath = rawPath
  const isRemote = typeof host === 'string' && host.length > 0
  if (!isRemote && (filePath === '~' || filePath.startsWith('~/'))) {
    filePath = os.homedir() + filePath.slice(1)
  }
  if (!isRemote && !path.isAbsolute(filePath)) {
    throw new FileContentError('Path must be absolute', 400)
  }
  if (!isRemote && CLOUD_MODE) {
    // Cloud box: confine local reads to safe roots and never serve secret files.
    if (isSecretPath(filePath) || !cloudLocalReadAllowed(filePath)) {
      throw new FileContentError('Path not permitted', 403)
    }
    // …and never WRITE a local file there at all. The cloud replica's only
    // readable roots ARE its live session state (/tmp/open-walnut/sessions.json,
    // the stream JSONLs) — handing a paired device an editor for those is a
    // corruption vector with no user-facing purpose. Remote (`host=`) writes are
    // unaffected: they execute on the trusted exec host's daemon.
    if (intent === 'write') {
      throw new FileContentError('Editing files is not available in cloud mode', 403)
    }
  }
  return { filePath, isRemote }
}

/**
 * Read a file's text content as the FileViewer JSON payload — the ONE
 * implementation shared by the internal route and GET /api/v1/file-content.
 * ALL the security guards live here so every edge gets the identical sandbox:
 * traversal rejection, absolute-path requirement, and (cloud mode) the
 * safe-root allowlist + secret-path denylist.
 *
 * Missing/unreadable files come back as a payload with `error` set (never a
 * throw) — the legacy viewer contract. Throws FileContentError only for
 * invalid/forbidden requests.
 */
export async function readFileContentPayload(
  rawPath: unknown,
  host: string | undefined,
): Promise<FileContentPayload> {
  const { filePath, isRemote } = assertPathAllowed(rawPath, host, 'read')

  const ext = path.extname(filePath).slice(1).toLowerCase()

  if (isRemote) {
    // Remote file via SSH daemon
    try {
      const reader = await createFileReader(host as string)
      const content = await reader.readFile(filePath)
      if (content === null) {
        return { content: null, size: 0, truncated: false, binary: false, error: 'File not found', extension: ext }
      }
      const truncated = content.length > MAX_FILE_SIZE
      return {
        content: truncated ? content.slice(0, MAX_FILE_SIZE) : content,
        size: content.length,
        truncated,
        binary: false,
        extension: ext,
        // Only a WHOLE read gets a hash — see FileContentPayload.contentHash.
        ...(truncated ? {} : { contentHash: computeContentHash(content) }),
      }
    } catch (err) {
      return {
        content: null,
        size: 0,
        truncated: false,
        binary: false,
        error: `Cannot reach remote host: ${err instanceof Error ? err.message : String(err)}`,
        extension: ext,
      }
    }
  }

  // Local file
  let stat
  try {
    stat = await fsp.stat(filePath)
  } catch {
    return { content: null, size: 0, truncated: false, binary: false, error: 'File not found', extension: ext }
  }
  if (!stat.isFile()) {
    return { content: null, size: 0, truncated: false, binary: false, error: 'Not a regular file', extension: ext }
  }

  // Binary detection
  const fd = await fsp.open(filePath, 'r')
  try {
    const probe = Buffer.alloc(Math.min(8192, stat.size))
    await fd.read(probe, 0, probe.length, 0)
    if (isBinaryContent(probe)) {
      return { content: null, size: stat.size, truncated: false, binary: true, extension: ext }
    }
  } finally {
    await fd.close()
  }

  const truncated = stat.size > MAX_FILE_SIZE
  const buffer = truncated
    ? await readPartial(filePath, MAX_FILE_SIZE)
    : await fsp.readFile(filePath)
  const content = buffer.toString('utf-8')
  return {
    content,
    size: stat.size,
    truncated,
    binary: false,
    extension: ext,
    // Only a WHOLE read gets a hash — see FileContentPayload.contentHash.
    ...(truncated ? {} : { contentHash: computeContentHash(content) }),
  }
}

/** Result of a successful save. */
export interface FileWriteResult {
  ok: true
  size: number
  contentHash: string
}

/** A save rejected because the file changed under the editor (HTTP 409). */
export class FileConflictError extends Error {
  constructor(public currentHash: string) {
    super('File was modified externally')
    this.name = 'FileConflictError'
  }
}

/**
 * Write a file's text content — the editor's save path, shared by the internal
 * route and PUT /api/v1/file-content.
 *
 * Refuses everything the viewer can't faithfully round-trip, because for a save
 * "render it approximately" means "destroy the rest of the file":
 *   - a path outside the read sandbox        → 400/403 (assertPathAllowed)
 *   - content over MAX_FILE_SIZE             → 413
 *   - an existing file that reads as BINARY  → 415 (a text editor must not
 *     overwrite a binary; the viewer never showed its bytes to begin with)
 *   - an existing file over MAX_FILE_SIZE    → 409 truncated_source (the editor
 *     only ever held the first 512 KB, so saving would delete the tail)
 *   - a stale `expectedHash`                 → 409 (FileConflictError)
 *
 * Creating a NEW file is allowed (the tree's "new file" affordance) — a missing
 * target with no expectedHash is not a conflict. Parent dirs are NOT created:
 * an editor save into a non-existent directory is a typo, not an intent.
 */
export async function writeFileContentPayload(
  rawPath: unknown,
  host: string | undefined,
  content: unknown,
  expectedHash?: unknown,
): Promise<FileWriteResult> {
  const { filePath, isRemote } = assertPathAllowed(rawPath, host, 'write')
  if (typeof content !== 'string') {
    throw new FileContentError('content (string) is required', 400)
  }
  if (expectedHash != null && typeof expectedHash !== 'string') {
    throw new FileContentError('expectedHash must be a string', 400)
  }
  if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_SIZE) {
    throw new FileContentError(
      `Content too large to save (max ${MAX_FILE_SIZE} bytes) — the editor only loads the first ${MAX_FILE_SIZE} bytes of a file`,
      413,
    )
  }
  const nextHash = computeContentHash(content)

  if (isRemote) {
    // Remote: read-compare-write over the daemon. There is no remote file lock,
    // so the hash check is the only guard — same best-effort contract the notes
    // save has, and the window is one WS round-trip.
    const reader = (await createFileReader(host as string)) as DaemonFileReader
    // stat FIRST, for the same reason the local branch does: a file bigger than
    // the editor can load must be refused before we read it, not truncated by the
    // save. A daemon too old for fs.stat throws; treat that as "can't verify" and
    // fall through to the read (which is itself size-guarded by readFile).
    try {
      const st = await reader.stat(filePath)
      if (st && st.size > MAX_FILE_SIZE) {
        throw new FileContentError('File is larger than the editor can load — saving would truncate it', 409)
      }
    } catch (err) {
      if (err instanceof FileContentError) throw err
      /* stat unavailable — the read below is the fallback guard */
    }
    const current = await reader.readFile(filePath)
    if (current !== null) {
      assertOverwritable(current, filePath)
      if (expectedHash && computeContentHash(current) !== expectedHash) {
        throw new FileConflictError(computeContentHash(current))
      }
    } else {
      // Creating a remote file: the daemon's fs.write does `mkdir -p`, so refuse
      // here if the parent is missing. Matches the local branch — a save into a
      // directory that doesn't exist is a typo, and silently materializing a tree
      // on a remote host is worse than a clear error.
      //
      // fs.stat (not fs.ls) because it distinguishes absent from empty: listDir
      // returns [] for BOTH a failed call and an empty directory.
      let parentExists: boolean
      try {
        parentExists = (await reader.stat(path.dirname(filePath))) !== null
      } catch {
        parentExists = true // old daemon without fs.stat — don't block the save
      }
      if (!parentExists) {
        throw new FileContentError(`Directory does not exist on ${host}: ${path.dirname(filePath)}`, 404)
      }
    }
    await reader.writeFile(filePath, content)
    log.web.info('file saved (remote)', { path: filePath, host, size: Buffer.byteLength(content, 'utf-8') })
    return { ok: true, size: Buffer.byteLength(content, 'utf-8'), contentHash: nextHash }
  }

  // Parent dir must already exist, checked BEFORE taking the lock: withFileLock
  // mkdir -p's the lock's own parent (`<file>.lock`'s dirname IS the file's
  // dirname), so entering the lock would silently create the missing directory —
  // the opposite of this endpoint's contract.
  const parent = path.dirname(filePath)
  try {
    const pstat = await fsp.stat(parent)
    if (!pstat.isDirectory()) throw new FileContentError(`Not a directory: ${parent}`, 400)
  } catch (err) {
    if (err instanceof FileContentError) throw err
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FileContentError(`Directory does not exist: ${parent}`, 404)
    }
    throw err
  }

  // Local: check + write under the file lock, so a concurrent agent write (which
  // takes the same lock via writeFileChecked) can't slip between them.
  const conflict = await withFileLock(filePath, async () => {
    let stat
    try {
      stat = await fsp.stat(filePath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      stat = null // new file — nothing to conflict with
    }
    if (stat) {
      if (!stat.isFile()) throw new FileContentError('Not a regular file', 400)
      if (stat.size > MAX_FILE_SIZE) {
        throw new FileContentError(
          'File is larger than the editor can load — saving would truncate it',
          409,
        )
      }
      const current = await fsp.readFile(filePath, 'utf-8')
      assertOverwritable(current, filePath)
      if (expectedHash && computeContentHash(current) !== expectedHash) {
        return computeContentHash(current)
      }
    }
    await fsp.writeFile(filePath, content, 'utf-8')
    return null
  })
  if (conflict) throw new FileConflictError(conflict)

  log.web.info('file saved', { path: filePath, size: Buffer.byteLength(content, 'utf-8') })
  return { ok: true, size: Buffer.byteLength(content, 'utf-8'), contentHash: nextHash }
}

/** Refuse to let a TEXT editor overwrite bytes it could never have displayed. */
function assertOverwritable(current: string, filePath: string): void {
  if (isBinaryContent(Buffer.from(current.slice(0, 8192), 'utf-8'))) {
    throw new FileContentError(`Refusing to overwrite a binary file: ${path.basename(filePath)}`, 415)
  }
}

/**
 * Serve a file's bytes directly with a real Content-Type so the client treats
 * it as a standalone document — the ONE raw-mode implementation shared by the
 * internal route (?raw=1, the web console's HTML preview iframe) and
 * GET /api/v1/file-content?raw=1 (the iOS app's WKWebView HTML preview).
 * Serving via `src`/URL gives the page its own document URL, so in-page
 * anchors and scripts resolve against the file itself instead of the SPA.
 *
 * Runs the SAME sandbox as the JSON payload path (assertPathAllowed): both
 * edges throw FileContentError for invalid/forbidden requests, which each
 * caller maps onto its own error envelope.
 */
export async function serveRawFileContent(
  req: Request,
  res: Response,
  rawPath: unknown,
  rawHost: string | undefined,
  download: boolean,
): Promise<void> {
  const { filePath, isRemote } = assertPathAllowed(rawPath, rawHost, 'read')
  const ext = path.extname(filePath).slice(1).toLowerCase()

  // Media/PDF/image playback + universal download: byte-exact streaming with
  // Range support. Text decoding would corrupt these, so they take their own path.
  // hasOwn guard: a file named e.g. "x.constructor" must not hit Object.prototype.
  const inlineType = Object.hasOwn(RAW_INLINE_MIME, ext) ? RAW_INLINE_MIME[ext] : undefined
  if (download || inlineType) {
    const ctype = inlineType ?? 'application/octet-stream'
    await serveRawBytes(req, res, filePath, isRemote ? rawHost : undefined, ctype, download)
    return
  }

  // Read may throw on a remote transport failure (DaemonFileReader.readFile
  // only returns null for ENOENT). Catch it so the viewer gets a clean
  // text/plain error instead of the outer error handler's JSON/stack body.
  let content: string | null = null
  try {
    if (isRemote) {
      const reader = await createFileReader(rawHost as string)
      content = await reader.readFile(filePath)
    } else {
      content = await fsp.readFile(filePath, 'utf-8')
    }
  } catch (err) {
    const msg = isRemote
      ? `Cannot reach remote host: ${err instanceof Error ? err.message : String(err)}`
      : 'File not found'
    res.status(isRemote ? 502 : 404).type('text/plain').send(msg)
    return
  }
  if (content === null) {
    res.status(404).type('text/plain').send('File not found')
    return
  }
  const ctype = ext === 'htm' || ext === 'html' ? 'text/html; charset=utf-8'
    : ext === 'svg' ? 'image/svg+xml'
    : 'text/plain; charset=utf-8'
  // The doc runs with the server's origin (web: iframe sandbox allow-scripts +
  // allow-same-origin; iOS: WKWebView on a non-persistent data store). Acceptable
  // for a personal tool serving files the user explicitly opened; no
  // untrusted-upload surface.
  res.type(ctype).send(content)
}

fileContentRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawPath = req.query.path
    const host = typeof req.query.host === 'string' ? req.query.host : undefined

    // Raw mode — shared implementation (see serveRawFileContent above).
    const raw = req.query.raw === '1' || req.query.raw === 'true'
    const download = req.query.download === '1' || req.query.download === 'true'
    if (raw) {
      await serveRawFileContent(req, res, rawPath, host, download)
      return
    }

    // JSON viewer payload — the shared core (also serves /api/v1/file-content).
    // ONE sandbox for both modes and both verbs — see assertPathAllowed. Its
    // FileContentError throws are mapped to the same {error} bodies by this
    // handler's catch, so the wire contract is unchanged.
    // (Remote `host=` reads run on the target daemon and keep their own scope.
    // The Mac/trusted-LAN FileViewer is intentionally unconfined — it's the
    // owner's own machine.)
    res.json(await readFileContentPayload(rawPath, host))
  } catch (err) {
    if (err instanceof FileContentError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    next(err)
  }
})

/**
 * PUT /api/file-content — save an edit made in the Files-panel editor.
 *
 * Body: { path, host?, content, expectedHash? }
 *   → 200 { ok, size, contentHash }
 *   → 409 { error, code:'conflict', currentHash }  file changed under the editor
 *   → 400/403/413/415  see writeFileContentPayload
 *
 * The path lives in the BODY (not the query) so a save never lands in an access
 * log or browser history alongside its bytes.
 */
fileContentRouter.put('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { path: rawPath, host, content, expectedHash } = req.body ?? {}
    const result = await writeFileContentPayload(
      rawPath,
      typeof host === 'string' && host.length > 0 ? host : undefined,
      content,
      expectedHash,
    )
    res.json(result)
  } catch (err) {
    if (err instanceof FileConflictError) {
      res.status(409).json({ error: err.message, code: 'conflict', currentHash: err.currentHash })
      return
    }
    if (err instanceof FileContentError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    // A daemon/transport failure on a remote save is the user's problem to see,
    // not a 500 stack: report it as a bad gateway with the daemon's own message.
    const msg = err instanceof Error ? err.message : String(err)
    if (/fs\.write failed|daemon|not connected|timeout/i.test(msg)) {
      log.web.warn('file save failed (remote transport)', { error: msg })
      res.status(502).json({ error: `Could not save on the remote host: ${msg}` })
      return
    }
    next(err)
  }
})

/** Read first N bytes of a file */
async function readPartial(filePath: string, bytes: number): Promise<Buffer> {
  const fd = await fsp.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    await fd.read(buf, 0, bytes, 0)
    return buf
  } finally {
    await fd.close()
  }
}
