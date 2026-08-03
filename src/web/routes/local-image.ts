/**
 * Serve image files referenced by absolute path.
 *
 * GET /api/local-image?path=/absolute/path/to/file.png[&host=clouddev]
 *
 * When `host` is provided and the file doesn't exist locally, the bytes come
 * from the remote host via the daemon and are cached in the REMOTE_IMAGES_DIR
 * mirror (with a .src.json sidecar recording their origin). Mirror hits are
 * revalidated against the remote mtime/size before serving, so an image the
 * session regenerated on the remote host shows its NEW bytes — the old
 * download-once behavior served the first version forever.
 *
 * Freshness: responses carry `Cache-Control: no-cache` + a strong ETag. The
 * browser revalidates each render and gets a bodyless 304 unless the bytes
 * actually changed — the previous `max-age=3600` made the BROWSER pin stale
 * bytes for an hour even after the server had fresh ones.
 *
 * Security:
 * - Extension whitelist (png, jpg, jpeg, gif, webp) — no SVG (XSS risk)
 * - Must be absolute path
 * - No directory traversal (explicit .. rejection)
 * - File size limit (50 MB)
 * - Must be a regular file
 * - Localhost-only server
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import crypto from 'node:crypto'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { REMOTE_IMAGES_DIR } from '../../constants.js'
import {
  isMirrorPath,
  revalidateMirror,
  downloadToMirror,
  readMirrorSidecar,
} from '../../core/remote-image-mirror.js'

export const localImageRouter = Router()

const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

const ALLOWED_EXTENSIONS = new Set(Object.keys(EXT_TO_MIME))

const MAX_FILE_SIZE = 50 * 1024 * 1024 // 50 MB

async function resolveSessionHost(sessionId: string): Promise<string | null> {
  try {
    const { getSessionByClaudeId } = await import('../../core/session-tracker.js')
    const record = await getSessionByClaudeId(sessionId)
    return record?.host ?? null
  } catch { return null }
}

/** Mirror slot for an explicit host= fetch — hash-keyed by the FULL source path
 *  (same scheme as media-v1) so two dirs' chart.png can't collide. */
function hostCachePath(host: string, filePath: string): string {
  const hash = crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16)
  return path.join(REMOTE_IMAGES_DIR, host, `${hash}-${path.basename(filePath)}`)
}

/** Send the buffer with a strong ETag; answers If-None-Match with a 304. */
function sendImage(req: Request, res: Response, buffer: Buffer, mime: string): void {
  const etag = `"${crypto.createHash('sha1').update(buffer).digest('base64url')}"`
  res.setHeader('ETag', etag)
  // no-cache = cached but ALWAYS revalidated — the 304 path keeps it cheap.
  res.setHeader('Cache-Control', 'no-cache')
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end()
    return
  }
  res.setHeader('Content-Type', mime)
  res.setHeader('Content-Length', buffer.length)
  res.send(buffer)
}

localImageRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filePath = req.query.path
    const host = req.query.host
    if (!filePath || typeof filePath !== 'string') {
      res.status(400).json({ error: 'Missing or invalid path parameter' })
      return
    }

    // Must be absolute
    if (!path.isAbsolute(filePath)) {
      res.status(400).json({ error: 'Path must be absolute' })
      return
    }

    // Extension whitelist
    const ext = path.extname(filePath).slice(1).toLowerCase()
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      res.status(400).json({ error: 'File type not allowed' })
      return
    }

    // No directory traversal: reject paths containing '..' segments
    if (filePath.includes('..')) {
      res.status(400).json({ error: 'Invalid path' })
      return
    }

    // Try local file first
    let buffer: Buffer | null = null
    try {
      const stat = await fsp.stat(filePath)
      if (stat.isFile() && stat.size <= MAX_FILE_SIZE) {
        // Mirror files carry a .src.json sidecar — check the remote source
        // before serving so a regenerated image doesn't stay stale forever.
        // Best-effort: any failure serves the cached bytes.
        if (isMirrorPath(filePath)) {
          buffer = await revalidateMirror(filePath)
        }
        if (!buffer) buffer = await fsp.readFile(filePath)
      }
    } catch {
      // File not found locally — try remote fallback
    }

    // Remote fallback: serve from the host mirror (revalidated), else download.
    if (!buffer && host && typeof host === 'string') {
      const cachePath = hostCachePath(host, filePath)
      const hasCache = await fsp.stat(cachePath).then((s) => s.isFile()).catch(() => false)
      if (hasCache && (await readMirrorSidecar(cachePath))) {
        buffer = await revalidateMirror(cachePath)
        if (!buffer) buffer = await fsp.readFile(cachePath).catch(() => null)
      }
      if (!buffer) buffer = await downloadToMirror(host, filePath, cachePath)
    }

    // Auto-detect remote session images: /tmp/open-walnut/images/remote/<sessionId>/file.png
    // The path is identical on the remote host (EKS MCP writes there directly).
    if (!buffer && filePath.startsWith(REMOTE_IMAGES_DIR + '/')) {
      const relToRemote = filePath.slice(REMOTE_IMAGES_DIR.length + 1)
      const slashIdx = relToRemote.indexOf('/')
      if (slashIdx > 0) {
        const sessionId = relToRemote.slice(0, slashIdx)
        const remoteHost = await resolveSessionHost(sessionId)
        if (remoteHost) {
          buffer = await downloadToMirror(remoteHost, filePath, filePath)
        }
      }
    }

    if (!buffer) {
      res.status(404).json({ error: 'File not found' })
      return
    }

    if (buffer.length > MAX_FILE_SIZE) {
      res.status(400).json({ error: 'File too large' })
      return
    }

    sendImage(req, res, buffer, EXT_TO_MIME[ext]!)
  } catch (err) {
    next(err)
  }
})
