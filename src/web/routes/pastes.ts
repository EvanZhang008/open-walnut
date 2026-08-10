/**
 * Oversized-paste spill route.
 *
 * A chat message rides a single WebSocket RPC frame, and the WS server caps a
 * frame (maxPayload in attachWss) — `ws` enforces the cap by CLOSING the
 * connection with 1009, so a multi-MB paste (a whole log file) must never go
 * on the socket. Same story as image attachments (see ImageRef in images.ts):
 * the bytes go over HTTP here, and the message carries only the file path.
 *
 * The path lands inside the message text, so the session CLI reads it with the
 * Read tool, and RemoteSessionManager.prepareOutbound() ships it to the remote
 * host exactly like it ships image paths.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import path from 'node:path'
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import { PASTES_DIR } from '../../constants.js'
import { log } from '../../logging/index.js'

export const pastesRouter = Router()

/** Matches the express.json body budget (15mb) with JSON-envelope headroom. */
const MAX_PASTE_CHARS = 12_000_000

// POST /api/pastes — spill a large text paste to disk, return its path.
pastesRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { text } = req.body as { text?: unknown }
    if (typeof text !== 'string' || text.length === 0) {
      res.status(400).json({ error: 'text (non-empty string) is required' })
      return
    }
    if (text.length > MAX_PASTE_CHARS) {
      res.status(413).json({ error: `Paste too large (max ${MAX_PASTE_CHARS} chars)` })
      return
    }

    await fsp.mkdir(PASTES_DIR, { recursive: true })
    // Content-addressed like image files: {timestamp}-{hash}.txt
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 12)
    const filename = `${Date.now()}-${hash}.txt`
    const filePath = path.join(PASTES_DIR, filename)
    await fsp.writeFile(filePath, text, 'utf8')

    log.web.info('paste spilled to disk', { filePath, chars: text.length })
    res.json({ path: filePath, filename, chars: text.length })
  } catch (err) {
    next(err)
  }
})
