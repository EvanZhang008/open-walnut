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
import { MAX_BASE64_BYTES, compressForApi } from '../../utils/image-compress.js'
import { imageContextBlock } from '../../lib/attachment-headers.js'

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
/**
 * Pictures one message may carry where they travel as model image blocks (the
 * main agent's chat, the cloud chat-turn relay). A longer list is REFUSED with
 * an ImageAttachError, never cut short.
 */
const MAX_IMAGES_PER_MESSAGE = 5
/**
 * Pictures one message to a Claude Code session may carry. The session reads
 * each one from its file path (its stdin takes text only), so the per-message
 * model cap does not apply; but every picture it reads stays in its context, and
 * the API takes at most 100 images per request, so this stays well under that.
 * Past it the send is refused, never cut short.
 */
export const MAX_SESSION_IMAGES = 20

/**
 * Why a message's pictures cannot go as sent. Thrown BEFORE anything is sent,
 * so the sender's words stay in the composer with the reason beside them:
 * a picture is never dropped while the words go on without it (2026-11-23, the
 * user: messages, and what they carry, are never lost).
 *
 * `status` is the HTTP answer (the express error handler and the v1 routes read
 * it); a WS RPC answers with the message.
 */
export type ImageAttachCode =
  | 'image_invalid'
  | 'image_unsupported_type'
  | 'too_many_images'
  | 'image_not_found'
  | 'image_too_large'
  | 'image_save_failed'

export class ImageAttachError extends Error {
  readonly status: number
  constructor(readonly code: ImageAttachCode, message: string) {
    super(message)
    this.name = 'ImageAttachError'
    this.status = code === 'image_save_failed' ? 500 : code === 'image_too_large' ? 413 : 400
  }
}

export function isImageAttachError(err: unknown): err is ImageAttachError {
  return err instanceof ImageAttachError
}

/** "Picture 2 of 3" for one that is named in an error. */
function nth(i: number, total: number): string {
  return total === 1 ? 'The picture' : `Picture ${i + 1} of ${total}`
}

/**
 * The inline pictures of a request body, every one checked: the list as it came
 * (in order, none left out), or an ImageAttachError naming the first that cannot
 * go. Absent or empty is no pictures. Size is not checked here: the save
 * downscales and recompresses an oversized picture to fit (compressForApi).
 */
export function checkImagePayloads(raw: unknown, max: number = MAX_IMAGES_PER_MESSAGE): ImagePayload[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new ImageAttachError('image_invalid', '`images` must be a list of { data, mediaType } pictures.')
  if (raw.length === 0) return []
  if (raw.length > max) {
    throw new ImageAttachError('too_many_images',
      `This message has ${raw.length} pictures and one message takes at most ${max}. Send the rest in another message.`)
  }
  return raw.map((img, i) => {
    const entry = img as { data?: unknown; mediaType?: unknown } | null
    if (!entry || typeof entry !== 'object' || typeof entry.data !== 'string' || entry.data.length === 0
      || typeof entry.mediaType !== 'string') {
      throw new ImageAttachError('image_invalid', `${nth(i, raw.length)} has no picture data (it needs base64 \`data\` and a \`mediaType\`).`)
    }
    if (!ALLOWED_IMAGE_TYPES.has(entry.mediaType)) {
      throw new ImageAttachError('image_unsupported_type',
        `${nth(i, raw.length)} is ${entry.mediaType}; pictures must be PNG, JPEG, GIF or WebP. Convert it, or attach it as a file.`)
    }
    return { data: entry.data, mediaType: entry.mediaType }
  })
}

/**
 * The upload names of a request body's `imageRefs`, every one checked the same
 * way: a name the upload endpoint could not have produced is refused, not
 * skipped.
 */
export function checkImageRefNames(refs: unknown, max: number = MAX_IMAGES_PER_MESSAGE): string[] {
  if (refs === undefined || refs === null) return []
  if (!Array.isArray(refs)) throw new ImageAttachError('image_invalid', '`imageRefs` must be a list of { filename } uploads.')
  if (refs.length > max) {
    throw new ImageAttachError('too_many_images',
      `This message has ${refs.length} pictures and one message takes at most ${max}. Send the rest in another message.`)
  }
  return refs.map((r, i) => {
    const name = r && typeof r === 'object' ? (r as { filename?: unknown }).filename : r
    if (!isSafeImageFilename(name)) {
      throw new ImageAttachError('image_invalid', `${nth(i, refs.length)} names no uploaded picture. Attach it again.`)
    }
    return name
  })
}

/** Pictures compressed at once: each sharp run can hold a decoded bitmap of tens of MB. */
const SAVE_CONCURRENCY = 4

/**
 * Compress (downscale/recompress an oversized one) and save each picture, at most
 * SAVE_CONCURRENCY at a time, in order. All or nothing: a picture that still does
 * not fit after compressing refuses the send with 'image_too_large' (413), one
 * that cannot be written with 'image_save_failed' (500); either way the pictures
 * this call already wrote are removed again, so a refused send leaves nothing.
 */
export async function savePicturesToDisk(images: ImagePayload[]): Promise<Array<{ filePath: string; filename: string; mediaType: string; data: string }>> {
  const out: Array<{ filePath: string; filename: string; mediaType: string; data: string }> = new Array(images.length)
  const written: string[] = []
  let next = 0
  let failed: unknown = null
  const saveOne = async (img: ImagePayload, i: number) => {
    const { buffer, mimeType } = await compressForApi(Buffer.from(img.data, 'base64'), img.mediaType)
    const data = buffer.toString('base64')
    if (data.length > MAX_BASE64_BYTES) {
      throw new ImageAttachError('image_too_large',
        `${nth(i, images.length)} is ${Math.round(buffer.length / 1024 / 1024)} MB even after shrinking it, past the ${Math.floor(MAX_BASE64_BYTES * 3 / 4 / 1024 / 1024)} MB a picture can be. Attach it as a file instead.`)
    }
    let saved: { filePath: string; filename: string }
    try {
      saved = await saveImageToDisk(data, mimeType)
    } catch (err) {
      log.web.warn('a picture could not be saved; the send is refused', { error: err instanceof Error ? err.message : String(err) })
      throw new ImageAttachError('image_save_failed',
        `${nth(i, images.length)} could not be saved on the server (${err instanceof Error ? err.message : String(err)}). Your message was not sent; send it again.`)
    }
    written.push(saved.filePath)
    out[i] = { ...saved, mediaType: mimeType, data }
  }
  const worker = async () => {
    while (failed === null && next < images.length) {
      const i = next++
      try {
        await saveOne(images[i]!, i)
      } catch (err) {
        failed ??= err
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(SAVE_CONCURRENCY, images.length) }, worker))
  if (failed !== null) {
    await Promise.all(written.map((p) => fsp.rm(p, { force: true }).catch(() => {})))
    throw failed instanceof ImageAttachError ? failed
      : new ImageAttachError('image_save_failed', `A picture could not be saved on the server (${failed instanceof Error ? failed.message : String(failed)}). Your message was not sent; send it again.`)
  }
  return out
}

/**
 * The saved paths of a message to a Claude Code session, from whichever form the
 * body carries (`imageRefs` uploads win over inline `images`, as everywhere).
 * Every picture is kept or the send is refused with ImageAttachError; none is
 * dropped. The session reads them from these paths.
 */
export async function saveSessionPictures(images: unknown, imageRefs: unknown): Promise<string[]> {
  if (Array.isArray(imageRefs) && imageRefs.length > 0) {
    const resolved = await resolveImageRefs(imageRefs, MAX_SESSION_IMAGES)
    return resolved?.savedImages.map((s) => s.filePath) ?? []
  }
  const checked = checkImagePayloads(images, MAX_SESSION_IMAGES)
  if (checked.length === 0) return []
  return (await savePicturesToDisk(checked)).map((s) => s.filePath)
}

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
 *
 * Every picture is kept or the call throws ImageAttachError (a bad entry, more
 * than `max`, a failed save): it never returns fewer pictures than it was given.
 * Null only for an empty list.
 */
export async function processAndSaveImages(images: unknown, max: number = MAX_IMAGES_PER_MESSAGE): Promise<ProcessedImages | null> {
  const checked = checkImagePayloads(images, max)
  if (checked.length === 0) return null
  const saved = await savePicturesToDisk(checked)
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
 * All or nothing: a ref naming no upload, or an upload no longer on disk,
 * refuses the send with ImageAttachError, so the composer keeps the words and
 * the person attaches the picture again. Skipping it sent the words alone, and
 * the agent answered about a picture it never saw.
 */
export async function resolveImageRefs(refs: unknown[], max: number = MAX_IMAGES_PER_MESSAGE): Promise<ProcessedImages | null> {
  const filenames = checkImageRefNames(refs, max)
  if (filenames.length === 0) return null

  const saved = await Promise.all(filenames.map(async (filename, i) => {
    const filePath = path.join(IMAGES_DIR, filename)
    const image = await readImageAsBase64(filePath)
    if (!image) {
      log.web.warn('image ref not found on disk; the send is refused', { filename })
      throw new ImageAttachError('image_not_found',
        `${nth(i, filenames.length)} is no longer on the server. Remove it and attach it again.`)
    }
    return { filePath, filename, mediaType: image.mediaType, data: image.data }
  }))

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
  return processAndSaveImages(images)
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
  // One builder with its parser (lib/attachment-headers.ts), so the queue card reads it back.
  return imageContextBlock(savedImages.map((s) => s.filePath))
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
