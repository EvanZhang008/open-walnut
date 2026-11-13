/**
 * An attachment, on a person's click: the base's half of `getAttachment` (contract 1.14.0).
 *
 * Four rules, each one a way this could go wrong:
 *
 * - NOTHING AHEAD OF TIME. The base asks the provider only when the route is called, and the route is
 *   called only by a click (the console never prefetches, never fetches on hover). Agents get names
 *   and sizes from `mail_read`, never content.
 * - NOTHING KEPT. The bytes stream from the provider to the browser at the browser's pace and are not
 *   written anywhere on the way, and `Cache-Control: no-store` asks the browser not to keep them either.
 *   The one exception is a person's own Download in the Mac app (`save`), whose web view has no
 *   download of its own: the file is written to their Downloads folder and nowhere else.
 * - THE SENDER CHOSE THE NAME AND THE TYPE. A file is shown inline only when its type is on a short
 *   list a browser renders without running anything (a PDF, four raster image formats); everything
 *   else, html, svg and every unknown type included, goes out as `application/octet-stream` with
 *   `attachment` disposition. `nosniff` stops the browser second-guessing the type, a sandbox CSP
 *   covers the one inline document that is not an image, and the filename is cleaned before it
 *   reaches a header.
 * - BOUNDED. 50 MB decoded at most, refused from the listing when even its smallest possible decoded
 *   size is over that, and by the provider from the bytes otherwise.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { safeFilename } from './attachment-name.js'
import { callProvider, MailServiceError } from './contract.js'
import type { MailService } from './service.js'

export { safeFilename }

/** The most decoded bytes one attachment hands over. */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

/**
 * Until the first byte: a cold IMAP connect of its own, the SELECT, the structure and one chunk.
 * Above the provider's own open budget, so a slow server's own words win over a generic timeout.
 */
export const ATTACHMENT_OPEN_DEADLINE_MS = 25_000

/** The whole download, at the browser's pace: the route's lifetime (the host allows ten minutes). */
export const ATTACHMENT_STREAM_MS = 5 * 60_000

/** What a browser may show inline: a PDF and four raster formats. Nothing here can run a script. */
const INLINE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** The declared type when the browser may show it inline, normalized; undefined for everything else. */
export function inlineTypeOf(mimeType: string | undefined): string | undefined {
  const type = (mimeType ?? '').split(';')[0]!.trim().toLowerCase()
  const normalized = type === 'image/jpg' || type === 'image/pjpeg' ? 'image/jpeg' : type
  return INLINE_TYPES.has(normalized) ? normalized : undefined
}

/**
 * `Content-Disposition` with both names RFC 6266 defines: a plain ASCII `filename` for old clients,
 * and the real name as RFC 5987 `filename*=UTF-8''...`, which every current browser prefers.
 */
export function contentDispositionOf(kind: 'inline' | 'attachment', filename: string): string {
  const name = safeFilename(filename)
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/**
 * The response headers for one attachment. `download` forces `attachment` disposition (the viewer's
 * Download button) and keeps the type; an attachment never shown inline is `application/octet-stream`.
 */
export function attachmentHeaders(
  meta: { filename?: string; mimeType?: string },
  options: { download?: boolean } = {},
): Record<string, string> {
  const inlineType = inlineTypeOf(meta.mimeType)
  const inline = !!inlineType && !options.download
  return {
    'Content-Type': inlineType ?? 'application/octet-stream',
    'Content-Disposition': contentDispositionOf(inline ? 'inline' : 'attachment', meta.filename ?? ''),
    'X-Content-Type-Options': 'nosniff',
    // `sandbox` on everything: a document opened from here has no origin and runs nothing. The PDF
    // keeps only that, because `default-src 'none'` would also stop a browser's own PDF viewer.
    'Content-Security-Policy': inlineType === 'application/pdf' ? 'sandbox' : "default-src 'none'; sandbox",
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
  }
}

export interface OpenedAttachment {
  filename: string
  mimeType?: string
  content: AsyncIterable<Uint8Array>
}

/** Where `save` puts a file: the Downloads folder of the user this server runs as. */
export function downloadsFolder(): string {
  return path.join(os.homedir(), 'Downloads')
}

/** A file being written to Downloads: its name and path now, `done` when the last byte is on disk. */
export interface SavingAttachment {
  name: string
  path: string
  done: Promise<{ bytes: number }>
}

export class MailAttachments {
  constructor(private readonly deps: { service: MailService; downloadsDir?: () => string }) {}

  /**
   * The provider's stream for one attachment the cached envelope lists.
   *
   * Refused before the provider is asked when the message lists no such attachment (404), when the
   * provider cannot download (501), or when even the smallest size the listing allows is over the cap
   * (413). `signal` is the request's: it aborts when the browser goes away or the route gives up, and
   * the provider releases its connection then.
   */
  async open(accountId: string, messageId: string, attachmentId: string, signal: AbortSignal): Promise<OpenedAttachment> {
    const cached = await this.deps.service.cachedAttachment(accountId, messageId, attachmentId)
    const spec = this.deps.service.provider(accountId)
    if (spec.capabilities.attachments !== 'download' || typeof spec.getAttachment !== 'function') {
      throw new MailServiceError('unsupported', `${spec.label} accounts cannot open attachments in Walnut.`, 501)
    }
    // A listing's size is the ENCODED one for most transports (base64 decodes to about 0.73 of it),
    // so only a file that could not fit even then is refused here; the provider decides the rest.
    const listed = cached.attachment.bytes
    if (typeof listed === 'number' && listed * 0.7 > MAX_ATTACHMENT_BYTES) {
      throw new MailServiceError(
        'too-large',
        `That attachment is about ${Math.round(listed / (1024 * 1024))} MB, over the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB Walnut opens.`,
        413,
      )
    }
    const got = await callProvider(
      'an attachment',
      () => spec.getAttachment!(accountId, cached.messageId, attachmentId, { maxBytes: MAX_ATTACHMENT_BYTES, signal }),
      ATTACHMENT_OPEN_DEADLINE_MS,
    )
    // The LISTING's type first: it is what the console decided its viewer from, so the browser is
    // handed the same answer the click was made on.
    const mimeType = cached.attachment.mimeType ?? got.mimeType
    return {
      filename: safeFilename(got.filename ?? cached.attachment.filename),
      ...(mimeType ? { mimeType } : {}),
      content: got.content,
    }
  }

  /**
   * The same attachment, written to the Downloads folder instead of handed to the browser: what the
   * Mac app's Download does, because its web view has no download of its own (2026-11-13: a Download
   * there did nothing, or replaced the console with the PDF). Under the cleaned name, never over a
   * file that is there (`name (1).ext`, created with `wx`), never into a folder it had to make.
   *
   * Everything that can fail fast fails before this returns (no Downloads folder, an unknown
   * attachment, the provider refusing to open it, no free name). The copy then runs on its own and
   * `done` says how it ended: a failure or an abort (the browser went away, the route gave up) removes
   * the partial file, so Downloads never holds half an attachment.
   */
  async save(accountId: string, messageId: string, attachmentId: string, signal: AbortSignal): Promise<SavingAttachment> {
    const dir = (this.deps.downloadsDir ?? downloadsFolder)()
    const folder = await fsp.stat(dir).catch(() => null)
    if (!folder?.isDirectory()) {
      throw new MailServiceError('no_downloads_folder', `There is no Downloads folder at ${dir}, so Walnut did not save the attachment.`, 409)
    }
    const opened = await this.open(accountId, messageId, attachmentId, signal)
    let file: FreshFile
    try {
      file = await freshFile(dir, diskName(opened.filename))
    } catch (error) {
      await opened.content[Symbol.asyncIterator]().return?.()
      throw error
    }
    const done = copyInto(file, opened.content, signal)
    // Read by the route; never an unhandled rejection when nobody is left to read it.
    done.catch(() => undefined)
    return { name: file.name, path: file.path, done }
  }
}

/** Most bytes of a saved name: macOS and Linux refuse a name over 255 bytes, and `(12)` must fit. */
const DISK_NAME_MAX_BYTES = 200

/** The safe name, with the characters a Mac or Windows file name trips on as `_`, cut to fit a disk. */
function diskName(filename: string): string {
  const name = safeFilename(filename).replace(/[<>:"|?*]/g, '_')
  if (Buffer.byteLength(name) <= DISK_NAME_MAX_BYTES) return name
  const { base, ext } = splitName(name)
  const chars = [...base]
  while (chars.length > 1 && Buffer.byteLength(chars.join('') + ext) > DISK_NAME_MAX_BYTES) chars.pop()
  return chars.join('').trim() + ext
}

function splitName(name: string): { base: string; ext: string } {
  const match = /^(.+?)(\.[^.\s]{1,10})$/.exec(name)
  return match ? { base: match[1]!, ext: match[2]! } : { base: name, ext: '' }
}

interface FreshFile { name: string; path: string; handle: fsp.FileHandle }

/** The first free name in `dir`: `name`, then `name (1)`, `name (2)`..., created there and then (`wx`). */
async function freshFile(dir: string, name: string): Promise<FreshFile> {
  const { base, ext } = splitName(name)
  for (let n = 0; n < 1_000; n += 1) {
    const candidate = n === 0 ? name : `${base} (${n})${ext}`
    const full = path.join(dir, candidate)
    try {
      return { name: candidate, path: full, handle: await fsp.open(full, 'wx') }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new MailServiceError('exists', `Downloads already holds ${name} and 999 copies of it.`, 409)
}

async function copyInto(file: FreshFile, content: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<{ bytes: number }> {
  let bytes = 0
  try {
    for await (const chunk of content) {
      if (signal.aborted) break
      bytes += chunk.byteLength
      // The provider caps its stream too; this is the base's own word on it.
      if (bytes > MAX_ATTACHMENT_BYTES) {
        throw new MailServiceError('too-large', `That attachment is over the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB Walnut opens.`, 413)
      }
      await file.handle.write(chunk)
    }
    if (signal.aborted) throw new MailServiceError('cancelled', 'The save stopped before the whole file arrived, so nothing was kept.', 409)
    await file.handle.close()
    return { bytes }
  } catch (error) {
    await file.handle.close().catch(() => undefined)
    await fsp.rm(file.path, { force: true }).catch(() => undefined)
    throw error
  }
}
