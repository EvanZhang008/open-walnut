/**
 * Reading one PART of an IMAP message: the body of a message too big to download whole, and one
 * attachment someone clicked (provider-parts.ts).
 *
 * 2026-11-13: a Gmail message carrying a 2.2 MB PDF opened as "This message body is too big to cache",
 * its few KB of text never fetched, and its attachment chip did nothing. Each case below is one way
 * the fix could be wrong:
 *
 * - The attachment's bytes must never move for a body read: only the message's own text and html
 *   parts are downloaded, picked from BODYSTRUCTURE the way a mail client reads one.
 * - The decoding is real. The fake below lends imapflow's OWN `download` (its base64 and
 *   quoted-printable decoders, its charset conversion) and answers only the FETCHes it sends, so a
 *   latin1 quoted-printable html part and a base64 UTF-8 text part are decoded by the library that
 *   decodes them in production, not by this file.
 * - An attachment download names a part the structure LISTS as an attachment, or nothing: never the
 *   text, never a header, never an id the console was not offered.
 * - It runs on a connection of its own, and that connection is closed when the stream ends, when it
 *   is over the cap, and when the browser goes away.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImapFlow } from 'imapflow'
import {
  ImapPool,
  setImapClientFactory,
  type ImapClient,
  type ImapConnectOptions,
  type ImapFetchedMessage,
} from '../../src/integrations/mail-imap/client.js'
import { ImapAccountStore } from '../../src/integrations/mail-imap/config.js'
import { encodeMessageId } from '../../src/integrations/mail-imap/coords.js'
import {
  attachmentsFromStructure,
  bodyPartsOf,
  decodedFloorOf,
  MAX_BODY_TEXT_BYTES,
  MAX_SOURCE_BYTES,
  setMimeParserForTesting,
  structureNodeOf,
} from '../../src/integrations/mail-imap/mime.js'
import { createImapProvider } from '../../src/integrations/mail-imap/provider.js'
import type { MailProviderSpec } from '../../src/integrations/mail/types.js'

const ADDRESS = 'robin@marina.example.invalid'
const UID = 7
const MESSAGE = encodeMessageId('INBOX', '9001', UID)
const log = { debug() {}, info() {}, warn() {} }

interface FakePart { mime: string; body: Buffer }

interface Wire {
  /** The message on the server, by UID: its structure, its part bodies (ENCODED), its headers. */
  message: {
    uid: number
    size: number
    structure: unknown
    headers: string
    /** Part bodies as the server stores them, keyed the way imapflow asks (`1.2`, or `text`). */
    parts: Record<string, FakePart>
    source?: Buffer
  } | null
  /** Every part whose CONTENT was fetched, in order, with the bytes asked for each time. */
  downloaded: Array<{ part: string; start: number; length: number }>
  commands: string[]
  connects: number
  uidValidity: string
}

let wire: Wire

/** base64 with the 76-column line breaks a real mailer writes. */
function base64(bytes: Buffer): Buffer {
  return Buffer.from(bytes.toString('base64').replace(/(.{76})/g, '$1\r\n'), 'latin1')
}

/** Quoted-printable over latin1 bytes, enough of RFC 2045 for this file: =XX for non-ASCII and '='. */
function quotedPrintableLatin1(text: string): Buffer {
  const out = [...Buffer.from(text, 'latin1')].map((byte) => (byte > 126 || byte === 61 ? `=${byte.toString(16).toUpperCase().padStart(2, '0')}` : String.fromCharCode(byte))).join('')
  return Buffer.from(out, 'latin1')
}

/**
 * A server that answers FETCH by the query imapflow sends, with imapflow's own `download` borrowed:
 * `download` is a loop of `fetchOne` calls asking for `<part>.mime` and `<part>` slices, so answering
 * those is all a fake has to do for the real decoders to run.
 */
class FakeImap implements ImapClient {
  usable = true
  readonly capabilities = new Set(['IMAP4rev1', 'IDLE'])
  mailbox: { path: string } | false = false
  _openDownloads = 0
  readonly id = 'fake-imap'
  readonly log = { warn() {}, error() {}, debug() {}, info() {}, trace() {} }
  download = (ImapFlow.prototype as unknown as { download: NonNullable<ImapClient['download']> }).download

  constructor(readonly options: ImapConnectOptions) {}
  autoidle() {}
  async connect() { wire.connects += 1 }
  async logout() { wire.commands.push('logout') }
  close() { wire.commands.push('close') }
  async list() { return [] }
  async mailboxOpen(path: string) {
    wire.commands.push(`open ${path}`)
    this.mailbox = { path }
    return { path, uidValidity: wire.uidValidity, exists: 1, uidNext: UID + 1 }
  }
  async *fetch(): AsyncIterable<ImapFetchedMessage> { /* not used */ }
  async fetchOne(range: string, query: unknown): Promise<ImapFetchedMessage | false> {
    const message = wire.message
    const asked = query as {
      size?: boolean
      bodyStructure?: boolean
      headers?: unknown
      source?: unknown
      bodyParts?: Array<string | { key: string; start: number; maxLength: number }>
    }
    wire.commands.push(`fetchOne ${range} ${Object.keys(asked).sort().join(',')}`)
    if (!message || Number(range) !== message.uid) return false
    const out: ImapFetchedMessage & { bodyParts?: Map<string, Buffer> } = { uid: message.uid }
    if (asked.size) out.size = message.size
    if (asked.bodyStructure) out.bodyStructure = message.structure
    if (asked.headers) out.headers = Buffer.from(message.headers, 'latin1')
    if (asked.source) out.source = message.source ?? Buffer.alloc(0)
    if (asked.bodyParts) {
      const map = new Map<string, Buffer>()
      for (const one of asked.bodyParts) {
        if (typeof one === 'string') {
          // `header` is how imapflow asks for a single-part message's MIME header (its part is TEXT).
          if (one === 'header') out.headers = Buffer.from(message.parts.text?.mime ?? '', 'latin1')
          else map.set(one, Buffer.from(message.parts[one.replace(/\.mime$/, '')]?.mime ?? '', 'latin1'))
          continue
        }
        const part = message.parts[one.key]
        if (!part) continue
        wire.downloaded.push({ part: one.key, start: one.start, length: one.maxLength })
        map.set(one.key, part.body.subarray(one.start, one.start + one.maxLength))
      }
      out.bodyParts = map
    }
    return out
  }
  async messageFlagsAdd() { return true }
  async messageFlagsRemove() { return true }
  async append() { return true }
  on() { return this }
  removeAllListeners() { return this }
}

const pools: ImapPool[] = []

async function provider(): Promise<{ spec: MailProviderSpec; accountId: string }> {
  let config: Record<string, unknown> = {}
  const secrets = new Map<string, string>()
  const host = {
    config: {
      get: async () => config,
      patch: async (patch: Record<string, unknown>) => { config = { ...config, ...patch }; return config },
    },
    secrets: {
      get: async (key: string) => secrets.get(key),
      set: async (key: string, value: string) => { secrets.set(key, value) },
      delete: async (key: string) => { secrets.delete(key) },
      list: async () => [...secrets.keys()],
    },
  }
  const store = new ImapAccountStore(host as never)
  const entry = await store.save({ address: ADDRESS, host: 'imap.example.invalid', port: 993, tls: 'tls', password: 'not-a-real-one' })
  const pool = new ImapPool({ settings: (id) => store.settings(id), password: (id) => store.password(id), log })
  pools.push(pool)
  return { spec: createImapProvider({ store, pool, log }), accountId: entry.accountId }
}

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), Buffer.alloc(1_700_000, 0x42), Buffer.from('\n%%EOF\n', 'latin1')])
// Test data with non-ASCII on purpose (the charset path is the subject), written as escapes.
const TEXT = 'The survey is done. Gr\u00fc\u00dfe from the north basin, \u2014 Priya'
const HTML = '<p>The caf\u00e9 on the pier = open.</p>'

/**
 * The shape of the reported mail: mixed > [alternative > [text, related > [html, image]], pdf]. The
 * text is base64 UTF-8, the html quoted-printable latin1, the PDF 2.3 MB of base64.
 */
function bigMessage(): NonNullable<Wire['message']> {
  const text = base64(Buffer.from(TEXT, 'utf8'))
  const html = quotedPrintableLatin1(HTML)
  const image = base64(Buffer.alloc(900, 0x89))
  const pdf = base64(PDF)
  return {
    uid: UID,
    size: pdf.length + text.length + html.length + image.length + 2_000,
    headers: 'List-Unsubscribe: <https://lists.example.invalid/u/1>\r\nList-Id: <survey.example.invalid>\r\n\r\n',
    structure: {
      type: 'multipart/mixed',
      childNodes: [
        {
          part: '1', type: 'multipart/alternative',
          childNodes: [
            { part: '1.1', type: 'text/plain', encoding: 'base64', size: text.length, parameters: { charset: 'utf-8' } },
            {
              part: '1.2', type: 'multipart/related',
              childNodes: [
                { part: '1.2.1', type: 'text/html', encoding: 'quoted-printable', size: html.length, parameters: { charset: 'iso-8859-1' } },
                { part: '1.2.2', type: 'image/png', encoding: 'base64', size: image.length, disposition: 'inline', dispositionParameters: { filename: 'logo.png' } },
              ],
            },
          ],
        },
        { part: '2', type: 'application/pdf', encoding: 'base64', size: pdf.length, disposition: 'attachment', dispositionParameters: { filename: 'survey.pdf' } },
      ],
    },
    parts: {
      '1.1': { mime: 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n', body: text },
      '1.2.1': { mime: 'Content-Type: text/html; charset=iso-8859-1\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n', body: html },
      '1.2.2': { mime: 'Content-Type: image/png\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: inline; filename="logo.png"\r\n\r\n', body: image },
      '2': { mime: 'Content-Type: application/pdf; name="survey.pdf"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="survey.pdf"\r\n\r\n', body: pdf },
    },
  }
}

async function drain(content: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of content) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

beforeAll(() => { setImapClientFactory(async (options) => new FakeImap(options)) })
afterAll(async () => {
  setImapClientFactory(null)
  setMimeParserForTesting(null)
  for (const pool of pools.splice(0)) await pool.disposeAll()
})
beforeEach(() => {
  wire = { message: bigMessage(), downloaded: [], commands: [], connects: 0, uidValidity: '9001' }
})

describe('the body of a message over the source cap', () => {
  it('reads its own text and html parts, decoded, and never downloads the attachment', async () => {
    const parser = vi.fn()
    setMimeParserForTesting(parser as never)
    const { spec, accountId } = await provider()
    expect(wire.message!.size).toBeGreaterThan(MAX_SOURCE_BYTES)

    const body = await spec.getBody(accountId, MESSAGE, wire.message!.size)

    // base64 UTF-8 text and quoted-printable latin1 html, both decoded by imapflow's own pipeline.
    expect(body.text).toBe(TEXT)
    expect(body.html).toBe(HTML)
    expect(body.format).toBe('both')
    expect(body.bytes).toBe(Buffer.byteLength(TEXT) + Buffer.byteLength(HTML))
    expect(body.bytes).toBeLessThan(MAX_BODY_TEXT_BYTES)
    // Only the two body parts moved: not the 2.3 MB PDF, not the inline image the html points at.
    expect([...new Set(wire.downloaded.map((one) => one.part))]).toEqual(['1.1', '1.2.1'])
    // Never the whole source, and never a parse of it.
    expect(wire.commands.some((one) => /\bsource\b/.test(one))).toBe(false)
    expect(parser).not.toHaveBeenCalled()
    // Attachments from the structure, and the list headers from a header-only fetch.
    expect(body.attachments).toEqual([
      { id: '2', filename: 'survey.pdf', mimeType: 'application/pdf', bytes: wire.message!.parts['2']!.body.length },
      { id: '1.2.2', filename: 'logo.png', mimeType: 'image/png', bytes: wire.message!.parts['1.2.2']!.body.length },
    ])
    expect(body.listUnsubscribe).toMatchObject({ https: ['https://lists.example.invalid/u/1'], listId: 'survey.example.invalid' })
    setMimeParserForTesting(null)
  })

  it('finds out from the source fetch when the poll gave no size, then reads by parts', async () => {
    const { spec, accountId } = await provider()
    wire.message!.source = Buffer.alloc(16, 0x61)

    const body = await spec.getBody(accountId, MESSAGE)

    expect(body.text).toBe(TEXT)
    expect(wire.commands.filter((one) => one.startsWith('fetchOne')).slice(0, 2)).toEqual([
      `fetchOne ${UID} bodyStructure,size,source,uid`,
      `fetchOne ${UID} bodyStructure,headers,size,uid`,
    ])
    expect(wire.downloaded.some((one) => one.part === '2')).toBe(false)
  })

  it('reads a single-part message through IMAP part 1 (its TEXT)', async () => {
    const { spec, accountId } = await provider()
    const text = Buffer.from('Only text, and a lot of it is attachments elsewhere.', 'utf8')
    wire.message = {
      uid: UID,
      size: MAX_SOURCE_BYTES + 10,
      headers: '\r\n',
      structure: { type: 'text/plain', encoding: '7bit', size: text.length, parameters: { charset: 'us-ascii' } },
      parts: { text: { mime: 'Content-Type: text/plain; charset=us-ascii\r\n\r\n', body: text } },
    }

    const body = await spec.getBody(accountId, MESSAGE, MAX_SOURCE_BYTES + 10)

    expect(body.text).toBe(text.toString('utf8'))
    expect(body.format).toBe('text')
    expect(body.html).toBeUndefined()
  })

  it('is still too-large when its own text is over the cap, and stops downloading near the cap', async () => {
    const { spec, accountId } = await provider()
    const huge = Buffer.alloc(MAX_BODY_TEXT_BYTES + 600_000, 0x61)
    wire.message!.parts['1.2.1'] = { mime: 'Content-Type: text/html; charset=utf-8\r\n\r\n', body: huge }

    await expect(spec.getBody(accountId, MESSAGE, wire.message!.size)).rejects.toMatchObject({ code: 'too-large' })

    // Bounded by `maxBytes`: the html is not pulled off the wire to its end to find out.
    const asked = wire.downloaded.filter((one) => one.part === '1.2.1').reduce((sum, one) => sum + one.length, 0)
    expect(asked).toBeLessThan(MAX_BODY_TEXT_BYTES + 600_000)
    expect(wire.downloaded.some((one) => one.part === '2')).toBe(false)
  })

  it('leaves a message under the cap on the one whole-source fetch it always had', async () => {
    const { spec, accountId } = await provider()
    setMimeParserForTesting(null)
    wire.message = {
      uid: UID,
      size: 120,
      headers: '',
      structure: { type: 'text/plain', part: '1', size: 20 },
      parts: {},
      source: Buffer.from('Subject: small\r\nContent-Type: text/plain\r\n\r\nhello there\r\n'),
    }

    const body = await spec.getBody(accountId, MESSAGE, 120)

    expect(body.text?.trim()).toBe('hello there')
    expect(wire.commands).toEqual(['open INBOX', `fetchOne ${UID} bodyStructure,size,source,uid`])
    expect(wire.downloaded).toEqual([])
  })
})

describe('which parts are the message itself', () => {
  it('takes the best text and html of an alternative, the root of a related, and no attachment or forwarded mail', () => {
    expect(bodyPartsOf(bigMessage().structure)).toEqual({ text: ['1.1'], html: ['1.2.1'] })
    expect(bodyPartsOf({
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/html' },
        { part: '2', type: 'image/jpeg', disposition: 'inline', dispositionParameters: { filename: 'pier.jpg' } },
        { part: '3', type: 'text/html' },
        { part: '4', type: 'text/plain', disposition: 'attachment', dispositionParameters: { filename: 'notes.txt' } },
        { part: '5', type: 'text/plain', parameters: { name: 'named.txt' } },
        { part: '6', type: 'message/rfc822', childNodes: [{ part: '6', type: 'multipart/alternative', childNodes: [{ part: '6.1', type: 'text/plain' }] }] },
      ],
    })).toEqual({ text: [], html: ['1', '3'] })
    // RFC 2046: the LAST alternative of a kind is the best one.
    expect(bodyPartsOf({
      type: 'multipart/alternative',
      childNodes: [{ part: '1', type: 'text/plain' }, { part: '2', type: 'text/html' }, { part: '3', type: 'text/html' }],
    })).toEqual({ text: ['1'], html: ['3'] })
    // A part is the message's or an attachment, never both.
    const listed = attachmentsFromStructure(bigMessage().structure).map((one) => one.id)
    const read = Object.values(bodyPartsOf(bigMessage().structure)).flat()
    expect(read.filter((id) => listed.includes(id))).toEqual([])
  })

  it('lists a forwarded message once, as itself, under the number that fetches it', () => {
    const structure = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain' },
        // imapflow numbers a forwarded message's single-part body with the forwarded message's own
        // number, so listing both handed out "2" twice and "2" fetched the outer one.
        {
          part: '2', type: 'message/rfc822', size: 4000,
          childNodes: [{ part: '2', type: 'application/pdf', encoding: 'base64', size: 3000, disposition: 'attachment', dispositionParameters: { filename: 'inner.pdf' } }],
        },
        {
          part: '3', type: 'message/rfc822', disposition: 'attachment', dispositionParameters: { filename: 'thread.eml' },
          childNodes: [{
            part: '3', type: 'multipart/mixed',
            childNodes: [{ part: '3.1', type: 'text/plain' }, { part: '3.2', type: 'image/png', dispositionParameters: { filename: 'pier.png' } }],
          }],
        },
      ],
    }
    expect(attachmentsFromStructure(structure)).toEqual([
      { id: '2', filename: 'forwarded-message.eml', mimeType: 'message/rfc822', bytes: 4000 },
      { id: '3', filename: 'thread.eml', mimeType: 'message/rfc822' },
    ])
    expect(structureNodeOf(structure, '2')?.type).toBe('message/rfc822')
    expect(structureNodeOf(structure, '3')?.type).toBe('message/rfc822')
    // Nothing inside a forwarded message is offered, so nothing inside one can be asked for.
    expect(structureNodeOf(structure, '3.2')).toBeUndefined()
    // ...and a forwarded message is never read as this message's text.
    expect(bodyPartsOf(structure)).toEqual({ text: ['1'], html: [] })
  })

  it('numbers the only part of a single-part message 1, as IMAP does', () => {
    // A scanner's "scan to email": the whole message is one PDF.
    const scan = { type: 'application/pdf', encoding: 'base64', size: 1200, disposition: 'attachment', dispositionParameters: { filename: 'scan.pdf' } }
    expect(attachmentsFromStructure(scan)).toEqual([{ id: '1', filename: 'scan.pdf', mimeType: 'application/pdf', bytes: 1200 }])
    expect(structureNodeOf(scan, '1')).toBe(scan)
    // A multipart root has no number: its first child is 1, and a container is never handed out.
    expect(structureNodeOf(bigMessage().structure, '1')).toBeUndefined()
  })

  it('hands out every id once, and every id fetches a part that holds content', () => {
    const shapes: unknown[] = [
      bigMessage().structure,
      { type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: 'scan.pdf' } },
      { type: 'text/plain', parameters: { name: 'note.txt' } },
      {
        type: 'multipart/mixed',
        childNodes: [
          { part: '1', type: 'text/html' },
          { part: '2', type: 'message/rfc822', childNodes: [{ part: '2', type: 'text/plain', parameters: { name: 'inner.txt' } }] },
          { part: '3', type: 'message/rfc822', childNodes: [{ part: '3', type: 'multipart/mixed', childNodes: [{ part: '3.1', type: 'text/plain' }, { part: '3.2', type: 'application/zip', disposition: 'attachment' }] }] },
          { part: '4', type: 'application/zip', disposition: 'attachment', dispositionParameters: { filename: 'a.zip' } },
        ],
      },
    ]
    for (const shape of shapes) {
      const ids = attachmentsFromStructure(shape).map((one) => one.id)
      expect(ids.every((id): id is string => typeof id === 'string'), JSON.stringify(ids)).toBe(true)
      expect(new Set(ids).size).toBe(ids.length)
      for (const id of ids) expect(structureNodeOf(shape, id!)?.type?.startsWith('multipart/')).toBe(false)
    }
  })

  it('never reads a decoded size above what the encoding allows', () => {
    const bytes = Buffer.alloc(30_000, 0x5a)
    const encoded = base64(bytes)
    expect(decodedFloorOf({ encoding: 'base64', size: encoded.length })).toBeLessThanOrEqual(bytes.length)
    expect(decodedFloorOf({ encoding: 'quoted-printable', size: 900 })).toBe(300)
    expect(decodedFloorOf({ encoding: '7bit', size: 900 })).toBe(450)
    expect(decodedFloorOf({})).toBe(0)
  })
})

describe('an attachment, on a click', () => {
  const signal = () => new AbortController().signal

  it('streams the decoded bytes of that part only, on a connection of its own that closes after', async () => {
    const { spec, accountId } = await provider()

    const got = await spec.getAttachment!(accountId, MESSAGE, '2', { maxBytes: 50 * 1024 * 1024, signal: signal() })

    expect(got).toMatchObject({ filename: 'survey.pdf', mimeType: 'application/pdf' })
    expect((await drain(got.content)).equals(PDF)).toBe(true)
    expect([...new Set(wire.downloaded.map((one) => one.part))]).toEqual(['2'])
    // Its own connection: one connect, and a logout once the stream ended.
    expect(wire.connects).toBe(1)
    await vi.waitFor(() => expect(wire.commands).toContain('logout'))
  })

  it('refuses an id the structure does not list as an attachment, and downloads nothing', async () => {
    const { spec, accountId } = await provider()
    for (const id of ['9', '1.1', '1.2.1', 'HEADER', 'TEXT', '1.MIME', '', '2;x', '../2']) {
      await expect(spec.getAttachment!(accountId, MESSAGE, id, { maxBytes: 1e9, signal: signal() }))
        .rejects.toMatchObject({ code: 'not-found' })
    }
    expect(wire.downloaded).toEqual([])
  })

  it('answers not-found for a message the folder no longer has, or a folder that was reset', async () => {
    const { spec, accountId } = await provider()
    await expect(spec.getAttachment!(accountId, encodeMessageId('INBOX', '9001', 99), '2', { maxBytes: 1e9, signal: signal() }))
      .rejects.toMatchObject({ code: 'not-found' })
    wire.uidValidity = '9002'
    await expect(spec.getAttachment!(accountId, MESSAGE, '2', { maxBytes: 1e9, signal: signal() }))
      .rejects.toMatchObject({ code: 'not-found' })
    expect(wire.downloaded).toEqual([])
  })

  it('refuses one over the cap from its size before a byte moves, and ends a stream that turns out bigger', async () => {
    const { spec, accountId } = await provider()
    await expect(spec.getAttachment!(accountId, MESSAGE, '2', { maxBytes: 1_000_000, signal: signal() }))
      .rejects.toMatchObject({ code: 'too-large' })
    expect(wire.downloaded).toEqual([])

    // The structure understates the size (a server may): the bytes decide, and the stream says so.
    const node = (wire.message!.structure as { childNodes: Array<{ size?: number }> }).childNodes[1]!
    node.size = 10
    const got = await spec.getAttachment!(accountId, MESSAGE, '2', { maxBytes: 1_000_000, signal: signal() })
    await expect(drain(got.content)).rejects.toMatchObject({ code: 'too-large' })
    const asked = wire.downloaded.reduce((sum, one) => sum + one.length, 0)
    expect(asked).toBeLessThan(wire.message!.parts['2']!.body.length)
    await vi.waitFor(() => expect(wire.commands).toContain('logout'))
  })

  it('downloads the only part of a single-part message, a scan sent as one PDF', async () => {
    const { spec, accountId } = await provider()
    const body = base64(PDF)
    wire.message = {
      uid: UID,
      size: body.length + 300,
      headers: '',
      structure: { type: 'application/pdf', encoding: 'base64', size: body.length, disposition: 'attachment', dispositionParameters: { filename: 'scan.pdf' } },
      // imapflow reads a single-part message's only part as TEXT, with its header as the MIME header.
      parts: { text: { mime: 'Content-Type: application/pdf; name="scan.pdf"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="scan.pdf"\r\n\r\n', body } },
    }
    const got = await spec.getAttachment!(accountId, MESSAGE, '1', { maxBytes: 50 * 1024 * 1024, signal: signal() })
    expect(got).toMatchObject({ filename: 'scan.pdf', mimeType: 'application/pdf' })
    expect((await drain(got.content)).equals(PDF)).toBe(true)
    expect([...new Set(wire.downloaded.map((one) => one.part))]).toEqual(['text'])
  })

  it('downloads a forwarded message whole, as the .eml it is', async () => {
    const { spec, accountId } = await provider()
    const forwarded = Buffer.from('From: harbour@example.invalid\r\nSubject: Tides\r\n\r\nHigh water at six.\r\n', 'latin1')
    wire.message = {
      uid: UID,
      size: forwarded.length + 500,
      headers: '',
      structure: {
        type: 'multipart/mixed',
        childNodes: [
          { part: '1', type: 'text/plain', size: 20 },
          { part: '2', type: 'message/rfc822', encoding: '7bit', size: forwarded.length, childNodes: [{ part: '2', type: 'text/plain', size: 20 }] },
        ],
      },
      parts: {
        '1': { mime: 'Content-Type: text/plain\r\n\r\n', body: Buffer.from('See below.') },
        '2': { mime: 'Content-Type: message/rfc822\r\nContent-Transfer-Encoding: 7bit\r\n\r\n', body: forwarded },
      },
    }
    const got = await spec.getAttachment!(accountId, MESSAGE, '2', { maxBytes: 50 * 1024 * 1024, signal: signal() })
    expect(got).toMatchObject({ mimeType: 'message/rfc822' })
    expect((await drain(got.content)).equals(forwarded)).toBe(true)
  })

  it('never opens the mailbox when the browser went away while the connection was being made', async () => {
    const { spec, accountId } = await provider()
    const pool = pools.at(-1)!
    const made = pool.detached.bind(pool)
    const controller = new AbortController()
    // The abort lands inside `detached`, before the provider listens for it.
    vi.spyOn(pool, 'detached').mockImplementation(async (id: string) => {
      const connection = await made(id)
      controller.abort()
      return connection
    })
    await expect(spec.getAttachment!(accountId, MESSAGE, '2', { maxBytes: 1e9, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'unreachable' })
    expect(wire.connects).toBe(0)
    expect(wire.commands).toEqual([])
    expect(wire.downloaded).toEqual([])
  })

  it('closes its connection when the browser goes away mid-download', async () => {
    const { spec, accountId } = await provider()
    // Eight FETCHes' worth, so "it stopped" is not one chunk away from "it finished".
    const big = base64(Buffer.alloc(6_000_000, 0x43))
    wire.message!.parts['2'] = { ...wire.message!.parts['2']!, body: big }
    ;(wire.message!.structure as { childNodes: Array<{ size?: number }> }).childNodes[1]!.size = big.length
    const controller = new AbortController()
    const got = await spec.getAttachment!(accountId, MESSAGE, '2', { maxBytes: 1e9, signal: controller.signal })
    const iterator = got.content[Symbol.asyncIterator]()
    await iterator.next()
    controller.abort()

    await vi.waitFor(() => expect(wire.commands).toContain('logout'))
    // The FETCH loop stopped: far less than the whole file was asked for.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const asked = wire.downloaded.reduce((sum, one) => sum + one.length, 0)
    expect(asked).toBeLessThan(big.length / 2)
  })
})
