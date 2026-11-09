/**
 * Message bodies: files on disk, plus the two derived strings the row keeps.
 *
 * Why bodies are not rows. A list view and most agent reads want a subject, a sender and a
 * sentence, and paying a multi-megabyte column read for that is how a cache becomes slower
 * than the provider. So the row keeps a snippet (at most 2 KB of plain text) and a `body_ref`,
 * and the bytes live under the plugin's own data directory, where uninstalling the plugin
 * takes them with it.
 *
 * Three constraints the shapes here encode:
 *
 * - A hard byte cap. Above it nothing is parsed and nothing is stored: the provider raises
 *   `too-large` from the size it already knows, and this module refuses too, because one
 *   multi-MB parse on the server's single event loop freezes every route.
 * - Plain text is extracted ONCE, at ingest, and handed to FTS. Cache search has to find a
 *   word deep in an HTML body even when the provider has no search capability, and doing the
 *   extraction at query time would mean reading every file on every search.
 * - HTML is stored RAW. Sanitizing here would leave the console rendering something this
 *   module decided was safe, and a sanitizer belongs next to the renderer that knows what its
 *   own DOM does with the result.
 */
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { MailBody } from './types.js'

/** Above this, a body is never parsed and never stored. Providers refuse it as `too-large`. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024

/** The row's snippet budget. Lists and most agent reads never go past this. */
export const SNIPPET_MAX_BYTES = 2 * 1024

/** How many files the disk-usage walk will look at before it answers with what it has. */
const USAGE_FILE_LIMIT = 50_000

export type StoredBodyFormat = 'text' | 'html' | 'both'

export interface StoredBody {
  /** Relative to the plugin data directory, extension-less: `bodies/<acct>/<yyyymm>/<hash>`. */
  ref: string
  format: StoredBodyFormat
  bytes: number
  /** At most SNIPPET_MAX_BYTES of plain text, whitespace collapsed. */
  snippet: string
  /** The whole plain text, for the FTS index. Not stored in the row. */
  text: string
  truncated: boolean
  /** Exactly what went to disk, so a caller never re-reads the file it just wrote. */
  storedText?: string
  storedHtml?: string
}

export class MailBodyTooLargeError extends Error {
  readonly code = 'too-large'

  constructor(bytes: number) {
    super(`the message body is ${bytes} bytes, over the ${MAX_BODY_BYTES} byte cap`)
    this.name = 'MailBodyTooLargeError'
  }
}

export class MailBodySnapshotError extends Error {
  constructor() {
    super('The cached email body changed while it was being read')
    this.name = 'MailBodySnapshotError'
  }
}

function bodyHash(accountId: string, messageId: string, text: string, html: string): string {
  return crypto.createHash('sha256').update(JSON.stringify([accountId, messageId, text, html])).digest('hex')
}

function accountFolder(accountId: string): string {
  // Hashed, not the address: an account id contains an email address, and a directory name
  // is the one part of a cache that shows up in a screen share or a crash log.
  return crypto.createHash('sha1').update(accountId).digest('hex').slice(0, 12)
}

function monthFolder(sentAt: number): string {
  const date = new Date(Number.isFinite(sentAt) && sentAt > 0 ? sentAt : Date.now())
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

function clip(value: string, limit: number): { value: string; truncated: boolean } {
  const buffer = Buffer.from(value, 'utf8')
  if (buffer.byteLength <= limit) return { value, truncated: false }
  // `toString` on a cut buffer can end mid-codepoint; the replacement character it produces
  // is preferable to throwing, and a snippet is not a checksum.
  return { value: buffer.subarray(0, limit).toString('utf8'), truncated: true }
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#160': ' ',
}

/**
 * Enough HTML-to-text for a search index and a snippet, and deliberately not more.
 *
 * It runs on untrusted input in the server process, so it is a set of replacements over a
 * string with no parser and no DOM: nothing here can execute, fetch or recurse. Block-level
 * tags become newlines so that a sentence does not fuse with the next one, script and style
 * bodies go before anything else, and the remaining tags are dropped.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|table|section|article)\s*>/gi, '\n')
    .replace(/<(li|tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&([a-zA-Z]+|#\d{1,6});/g, (whole, name: string) => {
      const named = ENTITIES[name.toLowerCase()] ?? ENTITIES[name]
      if (named !== undefined) return named
      if (name.startsWith('#')) {
        const code = Number(name.slice(1))
        return Number.isInteger(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' '
      }
      return whole
    })
    // `\u00a0` as an ESCAPE, never the character: a literal non-breaking space inside a
    // character class is invisible in every diff and every editor, and one deleted by a
    // careless reformat would silently stop collapsing the whitespace HTML mail is full of.
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The row's snippet: one line, whitespace collapsed, cut at the byte budget. */
export function snippetOf(text: string): string {
  return clip(text.replace(/\s+/g, ' ').trim(), SNIPPET_MAX_BYTES).value
}

/**
 * The same snippet, minus a first line that only repeats the subject.
 *
 * Almost every HTML newsletter opens with an `<h1>` holding its own subject, and `htmlToText`
 * turns that into the first line of the extracted text, so the list showed every row as
 * "Subject. Subject, and then the actual..." and the preview was half wasted on a string
 * already rendered two pixels away. Compared whitespace-normalized and case-insensitively,
 * because the header and the `Subject:` header are typed by different code paths and differ in
 * casing and spacing more often than they match exactly.
 *
 * Only the FIRST line, and only when it is the subject and nothing else: a body whose opening
 * sentence merely starts with the subject keeps it, since dropping that would eat real content.
 */
export function snippetForSubject(text: string, subject: string): string {
  const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase()
  const wanted = normalized(subject)
  if (!wanted) return snippetOf(text)
  const at = text.indexOf('\n')
  const firstLine = at < 0 ? text : text.slice(0, at)
  if (normalized(firstLine) !== wanted) return snippetOf(text)
  return snippetOf(at < 0 ? '' : text.slice(at + 1))
}

/** The plain text a body contributes to FTS, whichever half the provider returned. */
export function plainTextOf(body: Pick<MailBody, 'text' | 'html'>): string {
  if (body.text && body.text.trim()) return body.text
  if (body.html) return htmlToText(body.html)
  return ''
}

/** Same-directory temp file then rename, so a reader of the path sees the old bytes or the new, never a truncated file. */
async function writeWhole(target: string, value: string): Promise<void> {
  const temp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    await fsp.writeFile(temp, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await fsp.rename(temp, target)
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

export class MailBodyStore {
  constructor(private readonly dataDir: string) {}

  // A later body gets another reference, so a confirmed snapshot is never overwritten in place.
  async write(
    accountId: string,
    messageId: string,
    sentAt: number,
    body: MailBody,
    /** The row's subject, so the snippet does not open by repeating it. */
    subject = '',
  ): Promise<StoredBody> {
    const declared = body.bytes ?? 0
    if (declared > MAX_BODY_BYTES) throw new MailBodyTooLargeError(declared)

    const text = clip(body.text ?? '', MAX_BODY_BYTES)
    const html = clip(body.html ?? '', MAX_BODY_BYTES)
    const hash = bodyHash(accountId, messageId, text.value, html.value)
    const ref = `bodies/${accountFolder(accountId)}/${monthFolder(sentAt)}/${hash}`
    const absolute = path.join(this.dataDir, ref)
    await fsp.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 })

    // The text half is ALWAYS written, even empty. A message whose only content is attachments
    // otherwise left a `body_ref` pointing at nothing: the reader saw `hasBody: true` with no body
    // and no error, and nothing ever refetched it. An empty file is an honest "no text content".
    await writeWhole(`${absolute}.txt`, text.value)
    // The ref names its content, so an empty html half never had a file and none is removed: a
    // reader of this ref (or of a legacy handle-named ref) never sees a half vanish under it.
    if (html.value) await writeWhole(`${absolute}.html`, html.value)

    const plain = plainTextOf({ text: text.value, html: html.value })
    // Labelled by what the PROVIDER handed over, not by what is on disk: a provider that only
    // had HTML says `html`, and the plain text derived from it for search must not make that
    // look like a message that carried both representations.
    const format: StoredBodyFormat = body.format === 'both' || body.format === 'html' || body.format === 'text'
      ? body.format
      : text.value && html.value ? 'both' : html.value ? 'html' : 'text'
    return {
      ref,
      format,
      bytes: declared || Buffer.byteLength(text.value) + Buffer.byteLength(html.value),
      snippet: snippetForSubject(plain, subject),
      text: plain,
      truncated: text.truncated || html.truncated,
      storedText: text.value,
      ...(html.value ? { storedHtml: html.value } : {}),
    }
  }

  async read(ref: string, identity?: { accountId: string; messageId: string }): Promise<{ text?: string; html?: string }> {
    const absolute = path.join(this.dataDir, ref)
    const [text, html] = await Promise.all([
      fsp.readFile(`${absolute}.txt`, 'utf8').catch(() => undefined),
      fsp.readFile(`${absolute}.html`, 'utf8').catch(() => undefined),
    ])
    if (identity) {
      const hash = path.basename(ref)
      // Both halves must match the confirmed content, even when only one vanished during eviction.
      if (text === undefined || (/^[a-f0-9]{64}$/.test(hash)
        && bodyHash(identity.accountId, identity.messageId, text, html ?? '') !== hash)) {
        throw new MailBodySnapshotError()
      }
    }
    return { ...(text !== undefined ? { text } : {}), ...(html !== undefined ? { html } : {}) }
  }

  async remove(ref: string): Promise<void> {
    const absolute = path.join(this.dataDir, ref)
    await Promise.all([
      fsp.rm(`${absolute}.txt`, { force: true }),
      fsp.rm(`${absolute}.html`, { force: true }),
    ])
  }

  /** Bytes the body cache currently occupies, for the retention cap. */
  async usageBytes(): Promise<number> {
    let total = 0
    let seen = 0
    const queue = [path.join(this.dataDir, 'bodies')]
    while (queue.length > 0 && seen < USAGE_FILE_LIMIT) {
      const current = queue.shift()!
      const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        const absolute = path.join(current, entry.name)
        if (entry.isDirectory()) { queue.push(absolute); continue }
        seen += 1
        const stat = await fsp.stat(absolute).catch(() => null)
        if (stat) total += stat.size
      }
    }
    return total
  }
}
