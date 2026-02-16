/**
 * Serve local image files referenced by absolute path.
 *
 * GET /api/local-image?path=/absolute/path/to/file.png
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
import path from 'node:path'
import fsp from 'node:fs/promises'

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

localImageRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filePath = req.query.path
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

    // Must exist and be a regular file
    let stat
    try {
      stat = await fsp.stat(filePath)
    } catch {
      res.status(404).json({ error: 'File not found' })
      return
    }
    if (!stat.isFile()) {
      res.status(400).json({ error: 'Not a regular file' })
      return
    }

    // File size limit
    if (stat.size > MAX_FILE_SIZE) {
      res.status(400).json({ error: 'File too large' })
      return
    }

    const contentType = EXT_TO_MIME[ext]!
    const buffer = await fsp.readFile(filePath)

    res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.setHeader('Content-Length', buffer.length)
    res.send(buffer)
  } catch (err) {
    next(err)
  }
})
