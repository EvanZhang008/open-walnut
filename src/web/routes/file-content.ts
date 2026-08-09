/**
 * Serve local or remote file content for the FileViewer overlay.
 *
 * GET /api/file-content?path=/absolute/path/to/file.ts&host=optional-ssh-host
 *
 * Security:
 * - Must be absolute path
 * - No directory traversal (explicit .. rejection)
 * - File size limit (512 KB for text content)
 * - Binary detection (first 8KB NUL scan)
 * - Localhost-only server
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { createFileReader } from '../../core/session-file-reader.js'
import type { DaemonFileReader } from '../../core/daemon-file-reader.js'
import { CLOUD_MODE, WALNUT_HOME } from '../../constants.js'

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

/** Media extensions served as streamable raw bytes (video/audio players). */
const MEDIA_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
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
  // Cloud box: confine local reads to safe roots and never serve secret files.
  if (!isRemote && CLOUD_MODE && (isSecretPath(filePath) || !cloudLocalReadAllowed(filePath))) {
    throw new FileContentError('Path not permitted', 403)
  }

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
  return {
    content: buffer.toString('utf-8'),
    size: stat.size,
    truncated,
    binary: false,
    extension: ext,
  }
}

fileContentRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawPath = req.query.path
    const host = req.query.host

    if (!rawPath || typeof rawPath !== 'string') {
      res.status(400).json({ error: 'Missing or invalid path parameter' })
      return
    }

    // No directory traversal
    if (rawPath.includes('..')) {
      res.status(400).json({ error: 'Invalid path' })
      return
    }

    // Expand `~`/`~/…` for local reads (Node fs has no shell expansion). Remote
    // keeps `~` — the daemon's fs.read expands it on the remote host's HOME.
    let filePath = rawPath
    if (!host && (filePath === '~' || filePath.startsWith('~/'))) {
      filePath = os.homedir() + filePath.slice(1)
    }

    // Must be absolute (after ~ expansion); remote `~` paths are allowed through.
    const isRemote = typeof host === 'string' && host.length > 0
    if (!isRemote && !path.isAbsolute(filePath)) {
      res.status(400).json({ error: 'Path must be absolute' })
      return
    }

    // Cloud box: confine local reads to safe roots and never serve secret files.
    // (Remote `host=` reads run on the target daemon and keep their own scope.
    // The Mac/trusted-LAN FileViewer is intentionally unconfined — it's the
    // owner's own machine.)
    if (!isRemote && CLOUD_MODE && (isSecretPath(filePath) || !cloudLocalReadAllowed(filePath))) {
      res.status(403).json({ error: 'Path not permitted' })
      return
    }

    const ext = path.extname(filePath).slice(1).toLowerCase()

    // Raw mode: serve the file's bytes directly with a real Content-Type so the
    // browser treats it as a standalone document. Used by the HTML preview iframe
    // (via `src`), which gives the page its own URL — so in-page anchors, relative
    // links and scripts resolve against the file itself instead of the Walnut SPA.
    const raw = req.query.raw === '1' || req.query.raw === 'true'
    const download = req.query.download === '1' || req.query.download === 'true'

    // Media playback + universal download: byte-exact streaming with Range
    // support. Text decoding would corrupt these, so they take their own path.
    // hasOwn guard: a file named e.g. "x.constructor" must not hit Object.prototype.
    const mediaType = Object.hasOwn(MEDIA_MIME, ext) ? MEDIA_MIME[ext] : undefined
    if (raw && (download || mediaType)) {
      const ctype = mediaType ?? 'application/octet-stream'
      await serveRawBytes(req, res, filePath, isRemote ? (host as string) : undefined, ctype, download)
      return
    }

    if (raw) {
      // Read may throw on a remote transport failure (DaemonFileReader.readFile
      // only returns null for ENOENT). Catch it so the iframe gets a clean
      // text/plain error instead of the outer error handler's JSON/stack body.
      let content: string | null = null
      try {
        if (isRemote) {
          const reader = await createFileReader(host as string)
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
      // The framed doc runs as the SPA's own origin (sandbox allow-scripts +
      // allow-same-origin in FileContentView). Acceptable for a localhost personal
      // tool serving files the user explicitly opened; no untrusted-upload surface.
      res.type(ctype).send(content)
      return
    }

    // JSON viewer payload — the shared core (also serves /api/v1/file-content).
    res.json(await readFileContentPayload(rawPath, isRemote ? (host as string) : undefined))
  } catch (err) {
    if (err instanceof FileContentError) {
      res.status(err.statusCode).json({ error: err.message })
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
