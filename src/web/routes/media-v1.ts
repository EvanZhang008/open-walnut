/**
 * GET /api/v1/media?path=/absolute/file.png[&session=<sid>] — image bytes for
 * mobile clients, additive to the frozen v1 contract.
 *
 * The ONE image URL that works from anywhere:
 * - Primary box: serve the local file; if absent and the session lives on a
 *   remote host, fetch via the trusted daemon channel (same as local-image).
 * - Cloud box: no disk copy — proxy over the daemon bridge using the narrow
 *   fs.readImage command (extension allowlist + size cap on the daemon side).
 *   Host = the session's host from the projection, else the primary box.
 *
 * Security mirrors local-image.ts: absolute paths only, no '..', extension
 * allowlist (no SVG — XSS), 50MB cap. Auth inherited from /api middleware.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import crypto from 'node:crypto'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { CLOUD_MODE, REMOTE_IMAGES_DIR } from '../../constants.js'
import { log } from '../../logging/index.js'

export const mediaV1Router = Router()

const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

const MAX_FILE_SIZE = 50 * 1024 * 1024 // 50 MB

const SID_RE = /^[A-Za-z0-9_-]+$/

/** Cache slot for a remote fetch — keyed by the FULL source path (hashed),
 *  not the basename: two different dirs on one host can both hold chart.png,
 *  and a basename key would serve the wrong bytes during a bridge outage. */
function cachePathFor(host: string, filePath: string): string {
  const hash = crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16)
  return path.join(REMOTE_IMAGES_DIR, host, `${hash}-${path.basename(filePath)}`)
}

/** Session's exec host: projection on cloud, tracker on the primary. */
async function hostForSession(sessionId: string): Promise<string | null> {
  if (CLOUD_MODE) {
    const { readSessionProjection } = await import('../../core/session-projection.js')
    const projection = await readSessionProjection()
    const s = projection?.sessions.find((p) => p.id === sessionId)
    if (!s) return null
    return s.host === '' ? '__local__' : s.host
  }
  const { getSessionByClaudeId } = await import('../../core/session-tracker.js')
  const record = await getSessionByClaudeId(sessionId)
  return record?.host ?? null
}

/** Primary box: fetch via the trusted daemon channel (falls back to fs.read for old daemons). */
async function fetchViaDaemon(host: string, remotePath: string): Promise<Buffer | null> {
  try {
    const { getDaemonConnection } = await import('../../providers/daemon-connection.js')
    const { getConfig } = await import('../../core/config-manager.js')
    const config = await getConfig()
    const hostDef = config.hosts?.[host]
    if (!hostDef?.hostname) return null
    const conn = await getDaemonConnection(host, { hostname: hostDef.hostname, user: hostDef.user, port: hostDef.port })
    let result = await conn.send('fs.readImage', { path: remotePath }).catch(() => null)
    if (!result?.ok) {
      // Old daemon without fs.readImage — trusted SSH channel, fs.read is fine.
      result = await conn.send('fs.read', { path: remotePath, encoding: 'base64' }).catch(() => null)
    }
    if (!result?.ok || typeof result.data !== 'string') return null
    return Buffer.from(result.data, 'base64')
  } catch { return null }
}

/** Cloud box: fetch over the bridge (fs.readImage is in BRIDGE_ALLOWED_COMMANDS). */
async function fetchViaBridge(host: string, remotePath: string): Promise<Buffer | null> {
  try {
    const { bridgeRequest, bridgeForHost } = await import('../ws/bridge-registry.js')
    if (!bridgeForHost(host).connected) return null
    const res = await bridgeRequest(host, 'fs.readImage', { path: remotePath }, 20_000)
    if (res.ok !== true || typeof res.data !== 'string') return null
    return Buffer.from(res.data as string, 'base64')
  } catch { return null }
}

mediaV1Router.get('/media', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filePath = req.query.path
    const session = typeof req.query.session === 'string' && SID_RE.test(req.query.session)
      ? req.query.session : undefined
    if (!filePath || typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('..')) {
      res.status(400).json({ error: { code: 'bad_request', message: 'path must be an absolute file path' } })
      return
    }
    const ext = path.extname(filePath).slice(1).toLowerCase()
    const mime = EXT_TO_MIME[ext]
    if (!mime) {
      res.status(400).json({ error: { code: 'bad_request', message: 'file type not allowed' } })
      return
    }

    // 1. Local file (primary's own disk, or the cloud box's own IMAGES_DIR for
    //    images the phone itself attached to cloud-butler chats).
    let buffer: Buffer | null = null
    try {
      const st = await fsp.stat(filePath)
      if (st.isFile() && st.size <= MAX_FILE_SIZE) buffer = await fsp.readFile(filePath)
    } catch { /* not local — try the session's host below */ }

    // 2. The session's exec host (daemon channel on primary, bridge on cloud);
    //    cloud also falls back to the primary box for butler-chat images.
    if (!buffer) {
      const hosts: string[] = []
      if (session) {
        const h = await hostForSession(session)
        if (h) hosts.push(h)
      }
      if (CLOUD_MODE && !hosts.includes('__local__')) hosts.push('__local__')
      for (const host of hosts) {
        buffer = CLOUD_MODE
          ? await fetchViaBridge(host, filePath)
          : (host !== '__local__' ? await fetchViaDaemon(host, filePath) : null)
        if (buffer) {
          // Cache so scroll-backs don't re-ride the bridge/SSH.
          try {
            const cachePath = cachePathFor(host, filePath)
            await fsp.mkdir(path.dirname(cachePath), { recursive: true })
            await fsp.writeFile(cachePath, buffer)
          } catch { /* cache is best-effort */ }
          break
        }
      }
      // 3. Cache from a previous fetch (covers a bridge that has since dropped).
      if (!buffer) {
        for (const host of hosts) {
          try {
            const cached = cachePathFor(host, filePath)
            const st = await fsp.stat(cached)
            if (st.isFile() && st.size <= MAX_FILE_SIZE) { buffer = await fsp.readFile(cached); break }
          } catch { /* no cache */ }
        }
      }
    }

    if (!buffer) {
      log.web.debug('v1 media not found', { filePath, session: session ?? '', cloud: CLOUD_MODE })
      res.status(404).json({ error: { code: 'not_found', message: 'Image not found' } })
      return
    }
    if (buffer.length > MAX_FILE_SIZE) {
      res.status(400).json({ error: { code: 'bad_request', message: 'File too large' } })
      return
    }
    res.setHeader('Content-Type', mime)
    res.setHeader('Cache-Control', 'private, max-age=3600')
    res.setHeader('Content-Length', buffer.length)
    res.send(buffer)
  } catch (err) {
    next(err)
  }
})
