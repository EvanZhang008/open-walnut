/**
 * Image storage and serving routes.
 *
 * Images are saved to ~/.open-walnut/images/{timestamp}-{hash}.{ext}
 * and served via GET /api/images/:filename.
 *
 * This avoids storing large base64 blobs in chat-history.json.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import path from 'node:path'
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import { IMAGES_DIR, MOBILE_STAGED_IMAGES_DIR } from '../../constants.js'
import { log } from '../../logging/index.js'
import { compressForApi } from '../../utils/image-compress.js'

export interface ImagePayload {
  data: string       // raw base64
  mediaType: string  // 'image/png', 'image/jpeg', etc.
}

/**
 * A pointer to an already-uploaded image (`POST /api/images/upload`).
 *
 * Why this exists: base64 image bytes must NOT ride a WebSocket RPC frame. The
 * WS server caps a single frame at 4MB (`attachWss`, a deliberate
 * memory-exhaustion guard) and `ws` answers an oversized frame by CLOSING the
 * connection with code 1009 — before any handler runs. A single phone screenshot
 * is ~4-6MB in base64, so "send an image" killed the socket and every in-flight
 * RPC with it ("WebSocket disconnected"), on a loop. Clients upload over HTTP
 * (15MB express.json limit) and then send this ~60-byte ref instead.
 */
export interface ImageRef {
  /** Filename returned by the upload endpoint, e.g. `1786…-abc123def456.png`. */
  filename: string
}

export interface ProcessedImages {
  savedImages: Array<{ filePath: string; filename: string; mediaType: string }>
  imageContentBlocks: Array<{ type: 'image'; source: { type: 'base64'; media_type: string; data: string } }>
}

const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_IMAGES_PER_MESSAGE = 5

/**
 * `image.save` caps, mirrored from the daemon twins so an oversized attachment
 * is refused HERE (and the caller can degrade) instead of after a full bridge
 * round trip. Decoded bytes and base64 length are both checked, exactly as the
 * daemon checks them.
 */
const IMAGE_SAVE_MAX_BASE64_LENGTH = 14_000_000
const IMAGE_SAVE_MAX_BYTES = 10 * 1024 * 1024

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
  } catch (err) {
    log.web.debug('failed to read image as base64', { filePath, error: err instanceof Error ? err.message : String(err) })
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
 * True when one base64 attachment fits the `image.save` limits the daemon (and
 * therefore the chat-turn relay) enforces. Checked replica-side so an oversized
 * picture degrades to the local loop rather than burning a bridge round trip and
 * a WS frame on a save the daemon will refuse anyway.
 */
export function fitsImageSaveLimits(base64: string): boolean {
  if (base64.length === 0 || base64.length > IMAGE_SAVE_MAX_BASE64_LENGTH) return false
  // Decoded size without materializing the buffer: 4 base64 chars = 3 bytes,
  // minus padding. A 10MB cap on a 14MB base64 ceiling makes this the binding
  // check for most real photos, so it must not itself allocate 10MB per call.
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  const decodedBytes = Math.floor(base64.length / 4) * 3 - padding
  return decodedBytes > 0 && decodedBytes <= IMAGE_SAVE_MAX_BYTES
}

/** How many images one message may carry — shared with the relay's payload cap. */
export function maxImagesPerMessage(): number {
  return MAX_IMAGES_PER_MESSAGE
}

/**
 * Compress/clamp image payloads IN MEMORY, without touching disk — for the
 * cloud chat-turn relay, which must ship the bytes to another box rather than
 * store them here.
 *
 * Two reasons this runs before staging rather than only on the receiving side:
 * an unclamped phone screenshot is several MB of base64 on a WS socket every
 * other RPC shares, and `image.save` refuses anything over its cap, so
 * compressing first is the difference between a relayed turn and a fallback.
 * The receiving box re-runs the same compression (it must, for locally-attached
 * images too) and early-exits on an already-small buffer.
 */
export async function compressImagesInMemory(images: ImagePayload[]): Promise<ImagePayload[]> {
  return Promise.all(images.map(async (img) => {
    const { buffer, mimeType } = await compressForApi(Buffer.from(img.data, 'base64'), img.mediaType)
    return { data: buffer.toString('base64'), mediaType: mimeType }
  }))
}

/**
 * True for a path the local daemon's `image.save` could have produced: inside
 * the fixed mobile staging directory, one flat filename, image extension.
 *
 * This is the trust boundary for a RELAYED chat turn. The path arrives from the
 * cloud replica, so it must never be able to name an arbitrary file: without
 * this gate a compromised replica could ask the primary to read any file it
 * likes and have the bytes echoed into chat history (and served back over
 * `GET /api/images/:filename`). No traversal, no symlink escape (the caller
 * realpaths), no non-image extension.
 */
export function isRelayedImageStagingPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0) return false
  if (path.dirname(p) !== MOBILE_STAGED_IMAGES_DIR) return false
  const name = path.basename(p)
  return isSafeImageFilename(name)
}

/**
 * Adopt images a cloud replica staged on THIS box (via the daemon's
 * `image.save`) into the primary's own image store, returning the exact shape
 * `processAndSaveImages` produces — so a relayed turn feeds the ordinary turn
 * path with no image-specific branch downstream.
 *
 * Why re-save instead of referencing the staged file directly:
 *
 *  - `image.save` deliberately does NOT compress or clamp (it is a narrow,
 *    dependency-free daemon primitive). An unclamped 4000px image poisons EVERY
 *    later turn of the conversation, because a stored image replays with each
 *    one — so the same `compressForApi` the local REST path runs must run here.
 *  - The staged file lives in the daemon's `images/mobile/` subdir, while the
 *    web console resolves a persisted image by BASENAME under `/api/images/`.
 *    Landing it in IMAGES_DIR like every other chat image keeps history,
 *    hydration and serving identical to a locally-attached image.
 *
 * ALL-OR-NOTHING, and that is the whole contract: null means "this turn cannot
 * run here", which the relay answers with a refusal so the replica falls back to
 * a loop that still holds every image. Dropping one bad path and answering with
 * the rest would produce a confident answer about a picture the model never saw,
 * which is strictly worse than an honestly degraded one.
 */
export async function adoptRelayedImagePaths(paths: unknown[]): Promise<ProcessedImages | null> {
  if (paths.length === 0 || paths.length > MAX_IMAGES_PER_MESSAGE) return null
  // Every path must clear the staging gate — a single reject fails the turn
  // rather than shortening the attachment set behind the user's back.
  if (!paths.every(isRelayedImageStagingPath)) {
    log.web.warn('relayed chat images rejected — a path is not a staged mobile image', {
      count: paths.length,
    })
    return null
  }

  // Resolve the staging dir ITSELF before comparing resolved file paths. On
  // macOS the production dir is under /tmp, which is a symlink to /private/tmp,
  // so realpath('/tmp/…/mobile/x.png') has dirname '/private/tmp/…/mobile' —
  // comparing that to the unresolved constant refuses EVERY legitimate image and
  // silently degrades every phone image turn to the fallback loop.
  let stagingRoot: string
  try {
    stagingRoot = await fsp.realpath(MOBILE_STAGED_IMAGES_DIR)
  } catch {
    // Nothing was ever staged here — no image can be adopted.
    return null
  }

  const staged = await Promise.all(paths.map(async (stagedPath) => {
    try {
      // realpath AFTER the dirname check: a symlink planted in the staging dir
      // must not turn into a read of /etc/… . Resolve, then re-assert containment
      // against the resolved root, which is the check that actually holds.
      const real = await fsp.realpath(stagedPath)
      if (path.dirname(real) !== stagingRoot) return null
      const image = await readImageAsBase64(real)
      if (!image) return null
      return { data: image.data, mediaType: image.mediaType }
    } catch {
      // Staged file already reaped, unreadable, or a symlink pointing out.
      return null
    }
  }))

  const usable = staged.filter((s): s is ImagePayload => s !== null)
  if (usable.length !== paths.length) {
    log.web.warn('relayed chat images incomplete — refusing to answer a partial attachment set', {
      requested: paths.length, usable: usable.length,
    })
    return null
  }
  return processAndSaveImages(usable)
}

/** True for a filename the upload endpoint could have produced (no path traversal). */
export function isSafeImageFilename(name: unknown): name is string {
  return typeof name === 'string'
    && /^[\w.-]+$/.test(name)
    && !name.includes('..')
    && name.includes('.')
    && !!EXT_TO_MIME[path.extname(name).slice(1).toLowerCase()]
}

/**
 * Resolve `ImageRef[]` (filenames from `POST /api/images/upload`) into the same
 * shape `processAndSaveImages` returns — no re-encoding, the upload already
 * compressed and clamped the bytes.
 *
 * Refs naming a missing/invalid file are skipped rather than throwing: a send
 * must never fail wholesale because one attachment went stale.
 */
export async function resolveImageRefs(refs: unknown[]): Promise<ProcessedImages | null> {
  const filenames = refs
    .map(r => (r && typeof r === 'object' ? (r as { filename?: unknown }).filename : r))
    .filter(isSafeImageFilename)
    .slice(0, MAX_IMAGES_PER_MESSAGE)

  if (filenames.length === 0) return null

  const resolved = await Promise.all(filenames.map(async (filename) => {
    const filePath = path.join(IMAGES_DIR, filename)
    const image = await readImageAsBase64(filePath)
    if (!image) {
      log.web.warn('image ref not found on disk — skipping', { filename })
      return null
    }
    return { filePath, filename, mediaType: image.mediaType, data: image.data }
  }))

  const saved = resolved.filter((r): r is NonNullable<typeof r> => r !== null)
  if (saved.length === 0) return null

  return {
    savedImages: saved.map(s => ({ filePath: s.filePath, filename: s.filename, mediaType: s.mediaType })),
    imageContentBlocks: saved.map(s => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: s.mediaType, data: s.data },
    })),
  }
}

/**
 * Resolve whatever image form a payload carries.
 *
 * `imageRefs` (HTTP-uploaded, the WS-safe path) wins over inline `images`
 * base64 — REST callers (iOS) still post inline bytes, and both must land on
 * identical downstream behavior.
 */
export async function resolvePayloadImages(
  images: unknown,
  imageRefs: unknown,
): Promise<ProcessedImages | null> {
  if (Array.isArray(imageRefs) && imageRefs.length > 0) {
    return resolveImageRefs(imageRefs)
  }
  if (Array.isArray(images) && images.length > 0) {
    return processAndSaveImages(images as ImagePayload[])
  }
  return null
}

/**
 * Build the <attached-images> text annotation for image paths.
 * Used for the main agent (Bedrock API) which understands the tag format.
 */
export function buildImageAnnotation(savedImages: Array<{ filePath: string }>): string {
  const imagePathLines = savedImages.map((s, i) => `Image ${i + 1}: ${s.filePath}`).join('\n')
  return `<attached-images>\n${imagePathLines}\n</attached-images>\n\n`
}

/**
 * Build a natural-language image context prefix for Claude Code sessions.
 * Unlike buildImageAnnotation(), this produces plain text that Claude Code
 * can understand (no XML tags that might confuse the CLI).
 */
export function buildSessionImageContext(savedImages: Array<{ filePath: string }>): string {
  if (savedImages.length === 0) return ''
  const paths = savedImages.map(s => s.filePath).join('\n')
  return `The user attached ${savedImages.length === 1 ? 'an image' : `${savedImages.length} images`}. Read ${savedImages.length === 1 ? 'this file' : 'these files'} for visual context:\n${paths}\n\n`
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
    // Compress/clamp on ingest so an `imageRefs` send behaves exactly like the
    // inline `images` path (which runs processAndSaveImages). Without this, a
    // 4000px screenshot uploaded here would reach the model unclamped and
    // poison the whole conversation (see MAX_IMAGE_DIMENSION).
    const { buffer, mimeType } = await compressForApi(Buffer.from(data, 'base64'), mediaType)
    const { filename } = await saveImageToDisk(buffer.toString('base64'), mimeType)
    // `filename` is what an ImageRef carries; `url` stays for the notes embed path.
    res.json({ url: `/api/images/${filename}`, filename, mediaType: mimeType })
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
    } catch (err) {
      log.web.debug('image file not found', { filePath, error: err instanceof Error ? err.message : String(err) })
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
