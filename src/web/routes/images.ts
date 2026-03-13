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
import { compressForApi } from '../../utils/image-compress.js'

export interface ImagePayload {
  data: string       // raw base64
  mediaType: string  // 'image/png', 'image/jpeg', etc.
}

export interface ProcessedImages {
  savedImages: Array<{ filePath: string; filename: string; mediaType: string }>
  imageContentBlocks: Array<{ type: 'image'; source: { type: 'base64'; media_type: string; data: string } }>
}

const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_IMAGES_PER_MESSAGE = 5

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

/**
 * Validate, compress, save images to disk, and build API content blocks.
 * Shared by chat handler and quick-start session handler.
 */
export async function processAndSaveImages(images: ImagePayload[]): Promise<ProcessedImages | null> {
  const validImages = images
    .filter(img => ALLOWED_IMAGE_TYPES.has(img.mediaType))
    .filter(img => !!img.data)
    .slice(0, MAX_IMAGES_PER_MESSAGE)

  if (validImages.length === 0) return null

  const saved = await Promise.all(
    validImages.map(async (img) => {
      const rawBuffer = Buffer.from(img.data, 'base64')
      const { buffer, mimeType } = await compressForApi(rawBuffer, img.mediaType)
      const compressedBase64 = buffer.toString('base64')
      const { filePath, filename } = await saveImageToDisk(compressedBase64, mimeType)
      return { filePath, filename, mediaType: mimeType, data: compressedBase64 }
    }),
  )

  return {
    savedImages: saved.map(s => ({ filePath: s.filePath, filename: s.filename, mediaType: s.mediaType })),
    imageContentBlocks: saved.map(s => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: s.mediaType, data: s.data },
    })),
  }
}

/**
 * Build the <attached-images> text annotation for image paths.
 */
export function buildImageAnnotation(savedImages: Array<{ filePath: string }>): string {
  const imagePathLines = savedImages.map((s, i) => `Image ${i + 1}: ${s.filePath}`).join('\n')
  return `<attached-images>\n${imagePathLines}\n</attached-images>\n\n`
}

// POST /api/images/upload — upload a base64 image, return URL
imagesRouter.post('/upload', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data, mediaType } = req.body
    if (typeof data !== 'string' || typeof mediaType !== 'string') {
      res.status(400).json({ error: 'data (base64 string) and mediaType are required' })
      return
    }
    if (!MIME_TO_EXT[mediaType]) {
      res.status(400).json({ error: `Unsupported media type: ${mediaType}` })
      return
    }
    // Limit to 10MB
    if (data.length > 10_000_000) {
      res.status(413).json({ error: 'Image too large (max 10MB base64)' })
      return
    }
    const { filename } = await saveImageToDisk(data, mediaType)
    res.json({ url: `/api/images/${filename}` })
  } catch (err) {
    next(err)
  }
})

// GET /api/images/:filename — serve a saved image
imagesRouter.get('/:filename', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filename = req.params.filename as string
    // Sanitize: only allow alphanumeric, dash, dot; reject path traversal
    if (!/^[\w.-]+$/.test(filename) || filename.includes('..')) {
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
