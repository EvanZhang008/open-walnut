/**
 * Image storage and serving routes.
 *
 * Images are saved to ~/.walnut/images/{timestamp}-{hash}.{ext}
 * and served via GET /api/images/:filename.
 *
 * This avoids storing large base64 blobs in chat-history.json.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import path from 'node:path'
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import { IMAGES_DIR } from '../../constants.js'

export const imagesRouter = Router()

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/**
 * Save a base64 image to disk.
 * Returns the absolute file path and the filename.
 */
export async function saveImageToDisk(base64Data: string, mediaType: string): Promise<{ filePath: string; filename: string }> {
  await fsp.mkdir(IMAGES_DIR, { recursive: true })

  const ext = MIME_TO_EXT[mediaType] || 'png'
  const hash = createHash('sha256').update(base64Data).digest('hex').slice(0, 12)
  const timestamp = Date.now()
  const filename = `${timestamp}-${hash}.${ext}`
  const filePath = path.join(IMAGES_DIR, filename)

  const buffer = Buffer.from(base64Data, 'base64')
  await fsp.writeFile(filePath, buffer)

  return { filePath, filename }
}

/**
 * Read an image from disk and return as base64.
 * Used when hydrating image paths back to base64 for the Anthropic API.
 */
export async function readImageAsBase64(filePath: string): Promise<{ data: string; mediaType: string } | null> {
  try {
    const buffer = await fsp.readFile(filePath)
    const ext = path.extname(filePath).slice(1).toLowerCase()
    const mediaType = EXT_TO_MIME[ext] || 'image/png'
    return { data: buffer.toString('base64'), mediaType }
  } catch {
    return null
  }
}

// GET /api/images/:filename — serve a saved image
imagesRouter.get('/:filename', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filename = req.params.filename as string
    // Sanitize: only allow alphanumeric, dash, dot (prevent path traversal)
    if (!/^[\w.-]+$/.test(filename)) {
      res.status(400).json({ error: 'Invalid filename' })
      return
    }

    const filePath = path.join(IMAGES_DIR, filename)
    const ext = path.extname(filename).slice(1).toLowerCase()
    const contentType = EXT_TO_MIME[ext] || 'application/octet-stream'

    // Check file exists
    try {
      await fsp.access(filePath)
    } catch {
      res.status(404).json({ error: 'Image not found' })
      return
    }

    // Serve the file with cache headers (content-addressed filenames are immutable)
    const buffer = await fsp.readFile(filePath)
    res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    res.setHeader('Content-Length', buffer.length)
    res.send(buffer)
  } catch (err) {
    next(err)
  }
})
