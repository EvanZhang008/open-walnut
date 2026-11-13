/**
 * Reading ONE PART of a message instead of its whole source: the body of a big message, and an
 * attachment someone clicked.
 *
 * Split out of provider.ts because both reads share the one thing that file does not otherwise do:
 * IMAP's per-part download (imapflow `download`, a loop of `BODY.PEEK[<part>]<offset.length>` FETCHes
 * that undoes the transfer encoding and converts a text part's charset to UTF-8). The two reads run on
 * different connections, and that difference is the point of each:
 *
 * - A BODY runs on the account's shared connection under its gate and its 12s budget: a few text parts,
 *   bounded by `MAX_BODY_TEXT_BYTES`, read to their end before the gate opens again.
 * - An ATTACHMENT runs on a connection of its own (`ImapPool.detached`): up to tens of MB at the
 *   browser's pace must not hold every poll of the account behind it, and a download the browser
 *   gave up on is stopped by closing that socket, which on the shared one would cost the IDLE watch.
 */
import type { MailAttachmentContent, MailBody } from '../mail/api.js'
import {
  FOLDER_RESET,
  openMailbox,
  providerError,
  type ImapDownloadStream,
  type ImapPool,
} from './client.js'
import {
  attachmentsFromStructure,
  bodyPartsOf,
  decodedFloorOf,
  hasTextPart,
  LIST_HEADERS,
  MAX_BODY_TEXT_BYTES,
  MAX_SOURCE_BYTES,
  parseHeaders,
  parseListUnsubscribe,
  structureNodeOf,
} from './mime.js'

interface PartsLog {
  info(message: string, meta?: Record<string, unknown>): void
}

/** One FETCH of a body part read on its own: a 2 MB html part in four round trips, not 32. */
const PART_CHUNK_BYTES = 512 * 1024
/** One FETCH of an attachment: a 30 MB file in 30 round trips rather than 480 at imapflow's 64 KB. */
const ATTACHMENT_CHUNK_BYTES = 1024 * 1024
/**
 * Before an attachment's first byte reaches the browser: a cold connect and LOGIN of its own
 * connection, the SELECT, the structure and the first chunk. The rest streams at the browser's pace.
 */
const ATTACHMENT_OPEN_BUDGET_MS = 20_000
/** A part number as BODYSTRUCTURE writes one (`2`, `1.2.3`): nothing else is ever asked for. */
const PART_NUMBER = /^[1-9]\d{0,3}(?:\.[1-9]\d{0,3}){0,15}$/

export function tooLarge(bytes: number) {
  return providerError(
    'too-large',
    `That message is ${Math.round(bytes / 1024)} KB, over the ${MAX_SOURCE_BYTES / 1024} KB cap Walnut will parse.`,
  )
}

function tooMuchText() {
  return providerError(
    'too-large',
    `That message's own text is over the ${MAX_BODY_TEXT_BYTES / 1024} KB Walnut keeps of a body.`,
  )
}

function tooLargeAttachment(bytes: number, cap: number) {
  return providerError(
    'too-large',
    `That attachment is at least ${Math.round(bytes / (1024 * 1024))} MB, over the ${Math.round(cap / (1024 * 1024))} MB Walnut opens.`,
  )
}

/**
 * A decoded part read to its end, or `null` once it passed `cap`.
 *
 * Read to the END even past the cap, because a body runs on the account's SHARED connection: a
 * download left half read keeps issuing chunk FETCHes after the gate opens, under whatever folder the
 * next command SELECTs. The download's own `maxBytes` (the caller passes `cap + 1`) is what makes
 * "to the end" a bounded amount.
 */
async function readPart(content: ImapDownloadStream, cap: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of content) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.byteLength
    if (total <= cap) chunks.push(buffer)
  }
  return total > cap ? null : Buffer.concat(chunks, total)
}

/**
 * The attachment's bytes as the route reads them, ending in `too-large` past the cap, and releasing
 * the connection however the read ends: at the last byte, at an error, or at the route's `return()`.
 */
async function* cappedStream(content: ImapDownloadStream, maxBytes: number, release: () => void): AsyncGenerator<Uint8Array> {
  let total = 0
  try {
    for await (const chunk of content) {
      total += chunk.byteLength
      if (total > maxBytes) throw tooLargeAttachment(total, maxBytes)
      yield chunk
    }
  } finally {
    release()
  }
}

export function createImapPartReader(deps: { pool: ImapPool; log: PartsLog }) {
  const { pool, log } = deps

  /**
   * A message over the source cap, read through its OWN text and html parts only (`bodyPartsOf`).
   *
   * Gmail mail with a 2.2 MB PDF used to come back "too big to cache" with its few KB of text never
   * fetched (2026-11-13): the whole source was the only thing this provider could read, and a source
   * over 2 MB was refused. One FETCH for the structure and the list headers, then one decoded download
   * per body part, so an attachment's bytes never move. Text plus html over `MAX_BODY_TEXT_BYTES` is
   * still `too-large`. `cid:` images inside the html are not fetched, so they do not render here.
   */
  const bodyByParts = async (
    accountId: string,
    messageId: string,
    coord: { mailbox: string; uid: number },
    size: number,
  ): Promise<MailBody> => {
    const connection = await pool.for(accountId)
    const read = await connection.run(`a body by parts for ${messageId}`, async (client) => {
      // A client without part downloads (none in production; some test fakes) can only refuse, as before.
      if (typeof client.download !== 'function') return null
      await openMailbox(client, coord.mailbox)
      const head = await client.fetchOne(
        String(coord.uid),
        // `headers` is `BODY.PEEK[HEADER.FIELDS (...)]`: the three list headers, and no \Seen.
        { uid: true, size: true, bodyStructure: true, headers: [...LIST_HEADERS] },
        { uid: true },
      )
      if (!head) throw providerError('not-found', `Message ${messageId} is no longer in ${coord.mailbox}.`)
      const parts = bodyPartsOf(head.bodyStructure)
      let used = 0
      const take = async (list: string[]): Promise<string> => {
        const out: string[] = []
        for (const part of list) {
          const room = MAX_BODY_TEXT_BYTES - used
          const { content } = await client.download!(String(coord.uid), part, { uid: true, maxBytes: room + 1, chunkSize: PART_CHUNK_BYTES })
          if (!content) continue
          const bytes = await readPart(content, room)
          if (!bytes) throw tooMuchText()
          used += bytes.byteLength
          out.push(bytes.toString('utf8'))
        }
        return out.join('\n')
      }
      const text = await take(parts.text)
      const html = await take(parts.html)
      return { head, text, html, used, parts: parts.text.length + parts.html.length }
    })
    if (!read) throw tooLarge(size)
    const structure = read.head.bodyStructure
    // Labelled by the server's structure, as the whole-source path is: a text part counts only when
    // there is one and it said something.
    const hadText = hasTextPart(structure) === true && read.text.length > 0
    const listUnsubscribe = parseListUnsubscribe(parseHeaders(read.head.headers))
    const attachments = attachmentsFromStructure(structure)
    log.info('imap read a big message by its parts', {
      accountId, size: read.head.size ?? size, parts: read.parts, bytes: read.used, attachments: attachments.length,
    })
    return {
      format: hadText && read.html ? 'both' : read.html ? 'html' : 'text',
      ...(read.text ? { text: read.text } : {}),
      ...(read.html ? { html: read.html } : {}),
      // What is handed over, not the message: the base refuses a body whose `bytes` is over its cap.
      bytes: read.used,
      ...(attachments.length ? { attachments } : {}),
      ...(listUnsubscribe ? { listUnsubscribe } : {}),
    }
  }

  /**
   * One attachment's decoded bytes, on a connection of its own (`ImapPool.detached`).
   *
   * Only a part the live BODYSTRUCTURE lists as an attachment is downloaded, so no id can name the
   * message's text, its header or a part of a forwarded mail that is not offered. A folder whose
   * UIDVALIDITY moved since the handle was made answers `not-found`: the same UID may be another mail
   * now. Over `maxBytes` is refused from the structure when its size already says so, and the stream
   * ends in `too-large` when the bytes do. The connection is disposed when the stream ends or the
   * signal aborts (the browser went away, the route gave up), which is what stops the FETCH loop.
   *
   * The bytes are the file as sent, with one exception imapflow has no switch for: a text/plain or
   * text/html part WITHOUT an attachment disposition comes back converted to UTF-8 (and format=flowed
   * unwrapped), as its `download` does for every text node it would show. A CSV is `text/csv` and an
   * attached .txt says `attachment`, so both arrive untouched.
   */
  const getAttachment = async (
    accountId: string,
    messageId: string,
    coord: { mailbox: string; uidValidity: string; uid: number },
    attachmentId: string,
    options: { maxBytes: number; signal: AbortSignal },
  ): Promise<MailAttachmentContent> => {
    const noSuchPart = () => providerError('not-found', `This message has no attachment "${attachmentId.slice(0, 40)}".`)
    if (!PART_NUMBER.test(attachmentId)) throw noSuchPart()
    const maxBytes = Math.max(0, Math.floor(options.maxBytes))
    const cancelled = () => providerError('unreachable', 'The attachment download was cancelled.')
    if (options.signal.aborted) throw cancelled()
    const connection = await pool.detached(accountId)
    let stream: ImapDownloadStream | undefined
    let released = false
    const release = () => {
      if (released) return
      released = true
      options.signal.removeEventListener('abort', release)
      try { stream?.destroy() }
      catch { /* already ended */ }
      void connection.dispose().catch(() => undefined)
    }
    options.signal.addEventListener('abort', release, { once: true })
    // An abort while the connection was being made fired before the listener existed.
    if (options.signal.aborted) {
      release()
      throw cancelled()
    }
    try {
      const opened = await connection.run(`an attachment of ${messageId}`, async (client) => {
        if (typeof client.download !== 'function') throw providerError('unsupported', 'This IMAP client cannot download an attachment.')
        const box = await openMailbox(client, coord.mailbox)
        if (String(box.uidValidity) !== coord.uidValidity) throw providerError('not-found', FOLDER_RESET)
        const found = await client.fetchOne(String(coord.uid), { uid: true, bodyStructure: true }, { uid: true })
        if (!found) throw providerError('not-found', `Message ${messageId} is no longer in ${coord.mailbox}.`)
        const listed = attachmentsFromStructure(found.bodyStructure).find((one) => one.id === attachmentId)
        const node = listed ? structureNodeOf(found.bodyStructure, attachmentId) : undefined
        if (!listed || !node) throw noSuchPart()
        const floor = decodedFloorOf(node)
        if (floor > maxBytes) throw tooLargeAttachment(floor, maxBytes)
        const { meta, content } = await client.download(String(coord.uid), attachmentId, {
          uid: true, maxBytes: maxBytes + 1, chunkSize: ATTACHMENT_CHUNK_BYTES,
        })
        if (!content) throw noSuchPart()
        return { listed, meta, content }
      }, ATTACHMENT_OPEN_BUDGET_MS)
      stream = opened.content
      // The browser may have gone while the connection opened: nobody will read this stream.
      if (released || options.signal.aborted) {
        release()
        try { opened.content.destroy() }
        catch { /* already ended */ }
        throw cancelled()
      }
      log.info('imap opened an attachment', { accountId, part: attachmentId, encodedBytes: opened.listed.bytes ?? 0 })
      const filename = opened.meta?.filename || opened.listed.filename
      const mimeType = opened.listed.mimeType ?? opened.meta?.contentType
      return {
        ...(filename ? { filename } : {}),
        ...(mimeType ? { mimeType } : {}),
        content: cappedStream(opened.content, maxBytes, release),
      }
    } catch (error) {
      release()
      throw error
    }
  }

  return { bodyByParts, getAttachment }
}
