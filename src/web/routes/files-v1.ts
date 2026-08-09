/**
 * /api/v1 file browsing (additive, Wave 2) — session file-explorer listing,
 * path resolution for clickable transcript paths, and the FileViewer content
 * read. Semantics identical to the web routes (files.ts / file-content.ts)
 * because all three call the SAME shared functions — including, critically,
 * the SAME sandbox guards (traversal rejection, absolute-path requirement,
 * shell-metacharacter rejection, and in cloud mode the safe-root allowlist +
 * secret-path denylist for content reads).
 *
 *   GET /files/list?path=&host=&showHidden=1  → { path, selectedFile?, entries }
 *   GET /files/resolve-path?rel=&cwd=&host=   → { path, resolved }
 *   GET /file-content?path=&host=             → { content, size, truncated, binary, extension, error? }
 *
 * Cloud companion (REPLICA):
 * - list / resolve-path relay to the PRIMARY via the box-level
 *   `server.files.list` / `server.files.resolve` control actions (names-only
 *   metadata; no threat-model expansion beyond the existing session.launch
 *   relay). The primary serves them exactly like a local request — including
 *   `host=` targets over its SSH daemon channel.
 * - file-content does NOT relay: the daemon bridge deliberately never grants
 *   arbitrary file READS on exec hosts (only the narrow fs.readImage — see
 *   BRIDGE_ALLOWED_COMMANDS), and a server-side relay would hand a
 *   compromised cloud box every file on the primary. On a REPLICA, local
 *   reads stay confined to the /tmp/open-walnut roots (same as the internal
 *   route) and `host=` reads answer 501 not_supported_cloud.
 *
 * Frozen-contract note: everything here is additive (docs/reference/api-v1.md).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { relayControlAction, sendV1Error as sendError } from './v1-control-relay.js'

export const filesV1Router = Router()

/** Placeholder sessionId for the box-level `server.*` relay actions. */
const SERVER_RELAY_SID = '__server__'

// GET /api/v1/files/list?path=/abs/dir&host=&showHidden=1 — one directory
// level (lazy tree), dirs before files, capped.
filesV1Router.get('/files/list', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const host = typeof req.query.host === 'string' && req.query.host ? req.query.host : undefined
    const showHidden = req.query.showHidden === '1' || req.query.showHidden === 'true'
    if (CLOUD_MODE) {
      await relayControlAction(res, 'server.files.list', SERVER_RELAY_SID, {
        path: req.query.path, ...(host ? { host } : {}), showHidden,
      }, 200)
      return
    }
    const { listSessionFiles, FilesOpError } = await import('./files.js')
    try {
      res.json(await listSessionFiles(req.query.path, host, showHidden))
    } catch (err) {
      if (err instanceof FilesOpError) {
        sendError(res, err.statusCode, 'bad_request', err.message)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/files/resolve-path?rel=&cwd=&host= — resolve a (possibly
// package-relative) path a transcript mentioned against the session cwd.
// Unresolvable paths return { path: <cwd-joined fallback>, resolved: false }.
filesV1Router.get('/files/resolve-path', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const host = typeof req.query.host === 'string' && req.query.host ? req.query.host : undefined
    if (CLOUD_MODE) {
      await relayControlAction(res, 'server.files.resolve', SERVER_RELAY_SID, {
        rel: req.query.rel, cwd: req.query.cwd, ...(host ? { host } : {}),
      }, 200)
      return
    }
    const { resolveSessionPath, FilesOpError } = await import('./files.js')
    try {
      res.json(await resolveSessionPath(req.query.rel, req.query.cwd, host))
    } catch (err) {
      if (err instanceof FilesOpError) {
        sendError(res, err.statusCode, 'bad_request', err.message)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/file-content?path=&host= — the FileViewer JSON payload (text
// content, truncated at 512 KB, binary-detected). Missing files come back as
// 200 with `error` set (the viewer contract), not 404.
filesV1Router.get('/file-content', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const host = typeof req.query.host === 'string' && req.query.host ? req.query.host : undefined
    // REPLICA: remote-host content reads would need an arbitrary-read channel
    // the bridge deliberately does not have. Local reads fall through to the
    // shared core, whose CLOUD_MODE guard confines them to the safe roots.
    if (CLOUD_MODE && host) {
      sendError(res, 501, 'not_supported_cloud', 'Remote file content is not readable through the cloud companion (the bridge has no arbitrary-read channel)')
      return
    }
    const { readFileContentPayload, FileContentError } = await import('./file-content.js')
    try {
      res.json(await readFileContentPayload(req.query.path, host))
    } catch (err) {
      if (err instanceof FileContentError) {
        sendError(res, err.statusCode, err.statusCode === 403 ? 'not_supported_cloud' : 'bad_request', err.message)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// Router-level error funnel — keeps unexpected failures in the frozen shape.
filesV1Router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log.web.error('api-v1 files route error', {
    error: err instanceof Error ? err.message : String(err),
  })
  if (res.headersSent) {
    res.end()
    return
  }
  sendError(res, 500, 'internal', 'Internal server error')
})
