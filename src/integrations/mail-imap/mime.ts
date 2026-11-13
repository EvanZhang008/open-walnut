/**
 * MIME: raw headers, the body structure, and the one place mailparser is called.
 *
 * The byte cap is not a nicety here. A MIME parse of a multi-megabyte message is CPU work in
 * the server process, and the server has ONE event loop that every route shares, so the caller
 * checks the size the server already reported and never hands this file a source over the cap: a
 * bigger message is read part by part from its structure instead (`bodyPartsOf`).
 * mailparser itself is stream based, which keeps the parse chunked rather than one long
 * synchronous burst, but "chunked" is not "free".
 *
 * mailparser is imported LAZILY, on the first body that needs it. A Walnut process that never
 * reads a mail body (a CLI invocation, a loader test, an install with no account) should not
 * pay for loading a MIME parser and its dependency tree.
 */
import {
  ADDRESS_SHAPE,
  type MailAddress,
  type MailAttachmentMeta,
  type MailEnvelope,
  type MailListUnsubscribe,
  type MailProviderSpec,
} from '../mail/api.js'
import type { ImapFetchedMessage } from './client.js'

/** The base's late-header shape, read off the contract (`fetchListHeaders`) rather than restated. */
export type LateHeaders = NonNullable<Awaited<ReturnType<NonNullable<MailProviderSpec['fetchListHeaders']>>>[number]['headers']>
import { encodeMessageId } from './coords.js'

/**
 * The most raw source this provider will download and parse: 2 MB.
 *
 * Stated here rather than imported from the base. The contract is transport-free on purpose, so
 * a provider is implementable against the documented cap without importing any of the base's
 * code, and the base refuses anything over its own cap independently. If the documented cap ever
 * moves, both numbers move; a provider that guessed high just gets its body refused.
 */
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024

/**
 * The most decoded text plus html a message over `MAX_SOURCE_BYTES` hands over: 2 MB, the base's
 * documented body cap (`MAX_BODY_BYTES`), restated for the same reason as the number above.
 *
 * A message over the source cap is no longer refused for that alone: its own text and html parts are
 * fetched from BODYSTRUCTURE and nothing else, so a 2.2 MB mail whose PDF is 2.19 MB of it opens with
 * its text. Only text that is itself over this cap is still `too-large`.
 */
export const MAX_BODY_TEXT_BYTES = 2 * 1024 * 1024

export interface ParsedBody {
  text?: string
  html?: string
  attachments: MailAttachmentMeta[]
  /**
   * The `List-*` headers of this message, ONLY, in `parseHeaders` shape.
   *
   * Capped to `LIST_HEADERS` deliberately: a body parse touches every read, and a mail carrying
   * four hundred headers must not ride all of them into the base. Absent when the message carried
   * none of the three.
   */
  headers?: Record<string, string>
}

type SimpleParser = typeof import('mailparser').simpleParser

let parser: SimpleParser | null = null

async function loadParser(): Promise<SimpleParser> {
  if (!parser) parser = (await import('mailparser')).simpleParser
  return parser
}

/** Test seam: hand in a fake parser instead of loading the real one. */
export function setMimeParserForTesting(fake: SimpleParser | null): void {
  parser = fake
}

/**
 * The headers that say how to leave a mailing list.
 *
 * ONE list, exported, because both paths to the same answer must ask for the same three: the POLL
 * adds them to its `WANTED_HEADERS` (provider.ts) and a BODY parse carries exactly these out of
 * mailparser. A list that drifted would mean new mail learned a field old mail never could.
 */
export const LIST_HEADERS = ['list-unsubscribe', 'list-unsubscribe-post', 'list-id'] as const

/**
 * `Precedence` and `Auto-Submitted`: two sorting signals (a bulk sender, an automated notice). The poll
 * asks for them with the list headers; like those they are NOT part of the envelope hash, so rows
 * cached before this existed are never rewritten to learn them.
 */
export const BULK_HEADERS = ['precedence', 'auto-submitted'] as const

/** Every header a late `fetchListHeaders` asks for (always with `BODY.PEEK`, never setting `\Seen`). */
export const LATE_HEADER_FIELDS = [...LIST_HEADERS, ...BULK_HEADERS] as const

/** `{ precedence, autoSubmitted }`, lowercased; `Auto-Submitted: no` means "not automated" and is dropped. */
export function bulkHeadersOf(headers: Record<string, string>): { precedence?: string; autoSubmitted?: string } | undefined {
  const precedence = (headers.precedence ?? '').trim().toLowerCase().split(/[\s;]/)[0] ?? ''
  const auto = (headers['auto-submitted'] ?? '').trim().toLowerCase().split(/[\s;]/)[0] ?? ''
  const autoSubmitted = auto && auto !== 'no' ? auto : ''
  if (!precedence && !autoSubmitted) return undefined
  return { ...(precedence ? { precedence } : {}), ...(autoSubmitted ? { autoSubmitted } : {}) }
}

/** The late-fetched headers of one message as the base stores them, or `null` when it carried none. */
export function lateHeadersOf(raw: Buffer | string | undefined): LateHeaders | null {
  const headers = parseHeaders(raw)
  const listUnsubscribe = parseListUnsubscribe(headers)
  const bulk = bulkHeadersOf(headers)
  const post = (headers['list-unsubscribe-post'] ?? '').trim()
  const out = {
    ...(listUnsubscribe ? { listUnsubscribe } : {}),
    ...(post && listUnsubscribe ? { listUnsubscribePost: post } : {}),
    ...(listUnsubscribe?.listId ? { listId: listUnsubscribe.listId } : {}),
    ...(bulk?.precedence ? { precedence: bulk.precedence } : {}),
    ...(bulk?.autoSubmitted ? { autoSubmitted: bulk.autoSubmitted } : {}),
  }
  return Object.keys(out).length > 0 ? out : null
}

/** UIDs in sets of at most `size`, as IMAP sequence-set strings (`4,7,9`). */
export function uidChunks(uids: ReadonlyArray<number>, size = 200): string[] {
  const out: string[] = []
  for (let at = 0; at < uids.length; at += size) out.push(uids.slice(at, at + size).join(','))
  return out
}

/**
 * Parse one raw message.
 *
 * `skipTextToHtml` and `skipImageLinks` are off because nothing here wants a generated HTML
 * view: the console renders the real HTML part (sanitized at its end) or the plain text, and a
 * synthesized third representation is work nobody reads.
 */
export async function parseMime(source: Buffer): Promise<ParsedBody> {
  const simpleParser = await loadParser()
  const parsed = await simpleParser(source, { skipTextToHtml: true, skipImageLinks: true })
  const headers = listHeadersOf(parsed.headerLines)
  return {
    ...(parsed.text ? { text: parsed.text } : {}),
    ...(parsed.html ? { html: parsed.html } : {}),
    attachments: (parsed.attachments ?? []).map((one) => ({
      ...(one.partId ? { id: one.partId } : {}),
      ...(one.filename ? { filename: one.filename } : {}),
      ...(one.contentType ? { mimeType: one.contentType } : {}),
      ...(typeof one.size === 'number' ? { bytes: one.size } : {}),
    })),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  }
}

/**
 * The `List-*` headers of a parsed message, from `headerLines` and NOT from `headers`.
 *
 * `parsed.headers` looks like the obvious source and is the wrong one: mailparser folds every
 * `List-*` header into ONE structured `list` entry that keeps a single url and a single mail
 * address (measured: a header carrying an https target and a mailto target comes back as
 * `{unsubscribe: {url, mail}}`), so a list offering two http mirrors and one https link loses the
 * one that matters. `headerLines` is mailparser's own raw record, folding included, which is the
 * same thing the POLL path reads — so both paths hand `parseListUnsubscribe` identical input and
 * the header rules live in exactly one place.
 */
function listHeadersOf(lines: Array<{ key?: string; line?: string }> | undefined): Record<string, string> {
  const wanted = new Set<string>(LIST_HEADERS)
  const kept: string[] = []
  for (const one of lines ?? []) {
    if (typeof one?.line !== 'string' || !wanted.has((one.key ?? '').toLowerCase())) continue
    kept.push(one.line)
  }
  // Through `parseHeaders`, so the folding rule (a continuation line is part of the value) and the
  // last-value-wins rule are the tested ones rather than a second implementation of both.
  return kept.length > 0 ? parseHeaders(kept.join('\r\n')) : {}
}

export interface StructureNode {
  part?: string
  type?: string
  /** The transfer encoding (`base64`, `quoted-printable`, `7bit`...), lowercased by imapflow. */
  encoding?: string
  disposition?: string
  dispositionParameters?: Record<string, string>
  parameters?: Record<string, string>
  /** The ENCODED size on the server: a base64 part decodes to about three quarters of it. */
  size?: number
  childNodes?: StructureNode[]
}

/** The name a part carries, from its disposition or its content type. */
function filenameOf(node: StructureNode): string | undefined {
  return node.dispositionParameters?.filename ?? node.parameters?.name
}

/**
 * Is this part an attachment, rather than a piece of the message or a container?
 *
 * ONE rule, read by both sides of the same question: `attachmentsFromStructure` lists what it says
 * yes to, and `bodyPartsOf` never reads one of them as the message's text. A part is one or the
 * other, never both, so a .txt file riding along is never shown as the mail and a body part is never
 * offered as a download. A forwarded message (`message/rfc822`) is always one attachment, named or
 * not: the file a mail client saves as `.eml`.
 */
function isAttachmentNode(node: StructureNode): boolean {
  const type = node.type?.toLowerCase() ?? ''
  // A multipart node never carries content of its own, so it can never be an attachment even
  // when a client put a filename parameter on it.
  if (type.startsWith('multipart/')) return false
  if (type === 'message/rfc822') return true
  return node.disposition?.toLowerCase() === 'attachment' || !!filenameOf(node)
}

/** The name of a forwarded message that carries none: what a mail client saves it as. */
const FORWARDED_NAME = 'forwarded-message.eml'

/**
 * Every node with the part number IMAP fetches it by, breadth first and bounded: the ONE numbering
 * the listing and the download both read, so a listed id always fetches the node it was listed for.
 *
 * Two places where imapflow's own `part` is not that number. A single-part message's root has none,
 * and IMAP calls its only part `1` (a scanner's "scan to email" is one PDF and nothing else). And a
 * forwarded message's own parts are not walked at all: imapflow numbers its body with the
 * message's OWN number (RFC 3501 calls a single-part one `<n>.1`), so the two would share an id and
 * the inner one could never be fetched. The forwarded message is listed whole instead.
 */
function numberedNodes(root: unknown, limit: number): Array<{ node: StructureNode; part: string | undefined }> {
  const out: Array<{ node: StructureNode; part: string | undefined }> = []
  if (!root) return out
  const top = root as StructureNode
  const queue = [{ node: top, part: top.part ?? (top.type?.toLowerCase().startsWith('multipart/') ? undefined : '1') }]
  while (queue.length > 0 && out.length < limit) {
    const entry = queue.shift()!
    out.push(entry)
    if (entry.node.type?.toLowerCase() === 'message/rfc822') continue
    for (const child of entry.node.childNodes ?? []) queue.push({ node: child, part: child.part })
  }
  return out
}

/**
 * Attachment metadata straight from BODYSTRUCTURE, with no download.
 *
 * This is why a list can show a paperclip without fetching anything: the poll already asked
 * for the structure, so filenames and sizes are free. Content is fetched only when a person asks
 * for one attachment (`getAttachment`), never cached, and never put in agent context.
 */
export function attachmentsFromStructure(root: unknown): MailAttachmentMeta[] {
  const out: MailAttachmentMeta[] = []
  for (const { node, part } of numberedNodes(root, 1_000)) {
    if (out.length >= 100) break
    if (!isAttachmentNode(node)) continue
    const filename = filenameOf(node) ?? (node.type?.toLowerCase() === 'message/rfc822' ? FORWARDED_NAME : undefined)
    out.push({
      ...(part ? { id: part } : {}),
      ...(filename ? { filename } : {}),
      ...(node.type ? { mimeType: node.type } : {}),
      ...(typeof node.size === 'number' ? { bytes: node.size } : {}),
    })
  }
  return out
}

/** The node with this part number in the same numbering as the listing, or undefined. */
export function structureNodeOf(root: unknown, part: string): StructureNode | undefined {
  return numberedNodes(root, 1_000)
    .find((entry) => entry.part === part && !entry.node.type?.toLowerCase().startsWith('multipart/'))?.node
}

/**
 * The fewest bytes this part can decode to, from its encoded size: what lets a too-big attachment
 * be refused before a byte of it moves. A LOWER bound on purpose, so nothing that fits is refused:
 * base64 with its line breaks decodes to about 0.73 of its size, quoted-printable to at least a third.
 */
export function decodedFloorOf(node: StructureNode): number {
  const size = typeof node.size === 'number' && node.size > 0 ? node.size : 0
  const encoding = node.encoding?.toLowerCase() ?? ''
  if (encoding === 'base64') return Math.floor(size * 0.7)
  if (encoding === 'quoted-printable') return Math.floor(size / 3)
  // 7bit, 8bit and binary are the bytes themselves; a charset conversion of a text part can still
  // shrink them (UTF-16 to UTF-8 halves it), so even this is halved.
  return Math.floor(size / 2)
}

/** At most this many text parts and html parts each: a body read is a bounded number of FETCHes. */
const BODY_PARTS_MAX = 8

/**
 * The message's OWN text and html parts, by part number, from BODYSTRUCTURE alone.
 *
 * What a message too big to download whole is read through: only these parts are fetched, so a
 * mail carrying a 20 MB PDF still opens with its few KB of text. The rules are the ones a mail
 * client reads a structure by (RFC 2046 and RFC 2387):
 *
 * - `multipart/alternative` offers the SAME content several ways: its best text and its best html
 *   are kept, and the last of each kind is the best (RFC 2046 orders them by fidelity).
 * - `multipart/related` is one document and its resources: only its root (the first part) is read,
 *   so the images an html part points at by `cid:` are not fetched. They do not render on this path.
 * - Every other multipart (`mixed`, `signed`, `report`...) is a sequence: its body parts are read in
 *   order, which is how a client that splits text around an inline image sends one message.
 * - An attachment (`isAttachmentNode`) and a forwarded `message/rfc822` are never the message's text.
 *
 * A single-part message has no part number on its root; IMAP calls that part `1`.
 */
export function bodyPartsOf(root: unknown): { text: string[]; html: string[] } {
  const walk = (node: StructureNode | undefined, depth: number): { text: string[]; html: string[] } => {
    const none = { text: [], html: [] }
    if (!node || depth > 16) return none
    const type = node.type?.toLowerCase() ?? ''
    if (type === 'message/rfc822') return none
    if (type.startsWith('multipart/')) {
      const children = (node.childNodes ?? []).map((child) => walk(child, depth + 1))
      if (type === 'multipart/alternative') {
        const best = (kind: 'text' | 'html') => [...children].reverse().find((one) => one[kind].length > 0)?.[kind] ?? []
        return { text: best('text'), html: best('html') }
      }
      if (type === 'multipart/related') return children[0] ?? none
      return { text: children.flatMap((one) => one.text), html: children.flatMap((one) => one.html) }
    }
    if (isAttachmentNode(node)) return none
    const part = node.part ?? (depth === 0 ? '1' : undefined)
    if (!part) return none
    if (type === 'text/plain') return { text: [part], html: [] }
    if (type === 'text/html') return { text: [], html: [part] }
    return none
  }
  const found = walk(root as StructureNode | undefined, 0)
  return { text: found.text.slice(0, BODY_PARTS_MAX), html: found.html.slice(0, BODY_PARTS_MAX) }
}

/**
 * Did the message really carry a plain-text part, according to the SERVER?
 *
 * `undefined` when there is no structure to read, so a caller can fall back to a guess.
 *
 * This exists because `parsed.text` cannot answer it. mailparser synthesizes plain text from the
 * HTML part whenever a message has no text part, and it does so even with `skipTextToHtml`
 * (that flag only suppresses `textAsHtml`, measured). So an html-only mail comes back with both
 * fields populated and gets labelled as carrying both representations, which is a lie the console
 * then shows as a "plain text" tab holding a machine's rendering of the HTML. BODYSTRUCTURE is
 * the server's own parse of the same bytes and it is free: the body fetch asks for it in the same
 * FETCH, so this costs no extra round trip.
 *
 * A `text/plain` ATTACHMENT does not count. A .txt file riding along is not the message's text.
 */
export function hasTextPart(root: unknown): boolean | undefined {
  if (!root) return undefined
  const queue: StructureNode[] = [root as StructureNode]
  while (queue.length > 0) {
    const node = queue.shift()!
    for (const child of node.childNodes ?? []) queue.push(child)
    if (node.type?.toLowerCase() !== 'text/plain') continue
    if (node.disposition?.toLowerCase() === 'attachment') continue
    return true
  }
  return false
}

/**
 * Raw header lines, unfolded, lowercased names, last value wins.
 *
 * Needed because the parsed ENVELOPE loses two things the cache wants: the ORIGINAL `Date`
 * string (mail dates are instants, and the header is kept verbatim next to the epoch) and the
 * full `References` chain, which is what thread grouping is built from.
 */
export function parseHeaders(raw: Buffer | string | undefined): Record<string, string> {
  if (!raw) return {}
  const text = typeof raw === 'string' ? raw : raw.toString('utf8')
  const out: Record<string, string> = {}
  // Split only at a newline NOT followed by whitespace: a folded header continues on the next
  // line, and splitting on every newline turns one References chain into several broken ones.
  for (const line of text.split(/\r?\n(?![ \t])/)) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    out[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).replace(/\s+/g, ' ').trim()
  }
  return out
}

/** The `<...>` ids in a References or In-Reply-To header, in order. */
export function messageIdList(value: string | undefined): string[] {
  if (!value) return []
  return [...value.matchAll(/<[^<>\s]+>/g)].map((match) => match[0])
}

// ── one fetched message as an envelope ──
//
// Here rather than in provider.ts because every line of it is header and structure parsing, which is
// this file's subject, and provider.ts's is the transport: connections, UID ranges, cursors and
// health. Nothing below touches a socket.

/** Reply-To addresses kept. A header is whatever the sender typed, so it is bounded. */
const REPLY_TO_MAX = 10

export function firstAddress(list: Array<{ name?: string; address?: string }> | undefined) {
  const first = list?.[0]
  return {
    ...(first?.name ? { name: first.name } : {}),
    address: first?.address ?? '',
  }
}

export function addressList(list: Array<{ name?: string; address?: string }> | undefined) {
  return (list ?? [])
    .filter((one) => !!one.address)
    .map((one) => ({ ...(one.name ? { name: one.name } : {}), address: one.address! }))
}

/**
 * `Reply-To`, from the header text.
 *
 * From the header rather than from the fetched envelope, because the envelope shape this client
 * exposes has no reply-to field. The split ignores commas inside quotes and inside angle brackets,
 * so a display name like `"Doe, Jane" <jane@example.invalid>` stays ONE recipient rather than
 * becoming two, one of which is not an address at all.
 *
 * SHAPE CHECKED, and that is not tidiness. A header is whatever the sender typed, this field is
 * PREFERRED over `From` when a reply is prefilled, and the draft route rejects a recipient that is
 * not an address: `Reply-To: undisclosed-recipients:;` and `Reply-To: <>` are both real headers, and
 * both used to turn Reply into a 400 for a message whose `From` would have worked perfectly. A list
 * that filters down to nothing is reported as no Reply-To at all, which is exactly the fallback.
 */
export function replyToList(value: string | undefined): MailAddress[] {
  if (!value) return []
  const out: MailAddress[] = []
  let current = ''
  let quoted = false
  let angled = false
  // A trailing comma so the last address is flushed by the same branch as every other one.
  for (const char of `${value},`) {
    if (char === '"') quoted = !quoted
    if (char === '<') angled = true
    if (char === '>') angled = false
    if (char === ',' && !quoted && !angled) {
      const part = current.trim()
      current = ''
      const match = /^(.*?)<([^<>]+)>$/.exec(part)
      const address = (match ? match[2]! : part).trim()
      const name = match ? match[1]!.trim().replace(/^"(.*)"$/, '$1') : ''
      if (ADDRESS_SHAPE.test(address) && out.length < REPLY_TO_MAX) {
        out.push({ ...(name ? { name } : {}), address })
      }
      continue
    }
    current += char
  }
  return out
}

// ── how to leave a mailing list, from three headers ──
//
// Every cap below exists because this value is written by whoever sent the mail, it is stored in a
// payload blob that is read on every list page, and a url taken from it is one the SERVER will
// fetch when a human asks to leave the list. So: https only, a bounded number of targets, a bounded
// length each, and a mailto that is not a real address is not kept at all.

/** https targets kept. Four is already more than any real list offers. */
const UNSUBSCRIBE_HTTPS_MAX = 4
/** mailto targets kept. */
const UNSUBSCRIBE_MAILTO_MAX = 2
/** Per URL. A longer one is CLIPPED rather than dropped, so the ladder can still report it. */
const UNSUBSCRIBE_URL_MAX_CHARS = 2048
/** `<...>` groups even looked at. A header with thousands of them is not a list of real URLs. */
const UNSUBSCRIBE_TARGETS_MAX = 64
/** `List-Id` is a key, not prose. */
const LIST_ID_MAX_CHARS = 200

/**
 * The `<...>` targets of a `List-Unsubscribe` header, in order, bounded.
 *
 * `matchAll` hands back an ITERATOR, so a hostile header carrying thousands of bracket pairs is
 * walked only as far as the cap rather than materialised as an array first.
 *
 * The unbracketed fallback is for real senders, not for the RFC: RFC 2369 requires the brackets,
 * and a bare `https://…` value is common enough in the wild to be worth reading. It is only taken
 * when there is no bracketed group at all.
 *
 * A bare value can still name SEVERAL targets, and that is the whole reason this splits rather than
 * taking the value whole. `List-Unsubscribe: https://lists.example.invalid/u, mailto:leave@x.invalid`
 * used to come back as ONE https target whose path carried the mailto: `new URL` accepts it, the SSRF
 * guard passes it (the host is clean), the request 404s, and the console then tells the user "the
 * unsubscribe page refused" about a list whose link was perfectly good. The bracketed path has always
 * read that value as two targets, and one header must not mean two things.
 *
 * The split is deliberately narrow: only at a separator that a NEW target follows, so the comma in
 * `mailto:x@y?subject=a,b` or in `https://x/u?ids=1,2` is left alone. A raw space cannot appear inside
 * a url either, so it separates targets too — which is the other form senders emit.
 */
function unsubscribeTargets(raw: string | undefined): string[] {
  if (!raw) return []
  const out: string[] = []
  for (const match of raw.matchAll(/<([^<>]*)>/g)) {
    const one = match[1]!.trim()
    if (one) out.push(one)
    if (out.length >= UNSUBSCRIBE_TARGETS_MAX) return out
  }
  if (out.length > 0) return out
  const bare = raw.trim()
  if (!/^(https?:\/\/|mailto:)/i.test(bare)) return []
  // The limit bounds the work the same way `matchAll`'s iterator does above: a hostile bare value
  // carrying thousands of urls stops being walked at the cap instead of becoming an array first.
  return bare
    .split(/[\s,]+(?=(?:https?:\/\/|mailto:))/i, UNSUBSCRIBE_TARGETS_MAX)
    .map((one) => one.trim())
    .filter((one) => !!one)
}

/**
 * The address a `mailto:` target would send to, when it is one.
 *
 * SHAPE CHECKED for the same reason `replyToList` is: `mailto:undisclosed-recipients:;` and
 * `mailto:` are both real values, and one that is not an address can only become a draft the send
 * route refuses in a place the human cannot see. A target naming several recipients fails this
 * too, which is the wanted answer: "unsubscribe me" is one recipient.
 */
function mailtoAddress(target: string): string | undefined {
  const rest = target.slice('mailto:'.length).split('?')[0]!.trim()
  const address = rest.includes('%') ? safeDecode(rest) : rest
  return ADDRESS_SHAPE.test(address) ? address : undefined
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value) }
  catch { return value }
}

/** `List-Id: Weekly news <news.example.invalid>` → `news.example.invalid`. */
function parseListId(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const match = /<([^<>]+)>/.exec(raw)
  const id = (match ? match[1]! : raw).trim().toLowerCase()
  return id ? id.slice(0, LIST_ID_MAX_CHARS) : undefined
}

/**
 * How this message says it can be unsubscribed from, or `undefined` when it says nothing usable.
 *
 * Pure, and the ONE place the three headers are read: the poll path (`toEnvelope`) and the body
 * path (`getBody`, for mail cached before this existed) both come through here, so a rule cannot
 * hold for new mail and not for old.
 *
 * `undefined` rather than an empty object when there is no https target, no usable mailto and no
 * `List-Id`: "this message offered nothing" and "this row predates the field" are the same answer
 * to the console, and writing a hollow object into every payload blob would just grow the cache.
 *
 * `oneClick` needs BOTH headers. `List-Unsubscribe-Post` on its own names a POST with nowhere to
 * send it, which is why RFC 8058 defines it as a companion.
 */
export function parseListUnsubscribe(headers: Record<string, string>): MailListUnsubscribe | undefined {
  const raw = headers['list-unsubscribe']
  const https: string[] = []
  const mailto: string[] = []
  for (const target of unsubscribeTargets(raw)) {
    // https ONLY. A plaintext unsubscribe link is a request this server will not make: it leaks
    // that the mail was read, over a hop anybody can rewrite.
    if (/^https:\/\//i.test(target)) {
      if (https.length < UNSUBSCRIBE_HTTPS_MAX) https.push(target.slice(0, UNSUBSCRIBE_URL_MAX_CHARS))
      continue
    }
    if (!/^mailto:/i.test(target) || mailto.length >= UNSUBSCRIBE_MAILTO_MAX) continue
    const clipped = target.slice(0, UNSUBSCRIBE_URL_MAX_CHARS)
    if (mailtoAddress(clipped)) mailto.push(clipped)
  }
  const listId = parseListId(headers['list-id'])
  if (https.length === 0 && mailto.length === 0 && !listId) return undefined
  return {
    ...(https.length > 0 ? { https } : {}),
    ...(mailto.length > 0 ? { mailto } : {}),
    oneClick: !!raw && /list-unsubscribe\s*=\s*one-click/i.test(headers['list-unsubscribe-post'] ?? ''),
    ...(listId ? { listId } : {}),
  }
}

export function millis(value: Date | string | undefined): number | undefined {
  if (!value) return undefined
  const at = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isFinite(at) ? at : undefined
}

export function toEnvelope(mailbox: string, uidValidity: string, message: ImapFetchedMessage): MailEnvelope {
  const headers = parseHeaders(message.headers)
  const received = millis(message.internalDate)
  const sentAt = millis(message.envelope?.date) ?? received ?? 0
  const references = messageIdList(headers.references)
  const inReplyTo = messageIdList(headers['in-reply-to'])[0] ?? message.envelope?.inReplyTo
  const replyTo = replyToList(headers['reply-to'])
  const listUnsubscribe = parseListUnsubscribe(headers)
  const bulkHeaders = bulkHeadersOf(headers)
  return {
    messageId: encodeMessageId(mailbox, uidValidity, message.uid),
    rfcMessageId: message.envelope?.messageId ?? headers['message-id'] ?? '',
    mailboxId: mailbox,
    from: firstAddress(message.envelope?.from),
    to: addressList(message.envelope?.to),
    ...(message.envelope?.cc?.length ? { cc: addressList(message.envelope.cc) } : {}),
    ...(replyTo.length ? { replyTo } : {}),
    subject: message.envelope?.subject ?? '',
    // Epoch milliseconds plus the header verbatim: mail dates are instants, and the header is
    // the only record of what the sender's clock and offset actually said.
    sentAt,
    ...(headers.date ? { sentAtHeader: headers.date } : {}),
    ...(received !== undefined ? { receivedAt: received } : {}),
    flags: [...(message.flags ?? [])],
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references.length ? { references } : {}),
    attachments: attachmentsFromStructure(message.bodyStructure),
    ...(typeof message.size === 'number' ? { bodyBytes: message.size } : {}),
    ...(listUnsubscribe ? { listUnsubscribe } : {}),
    ...(bulkHeaders ? { bulkHeaders } : {}),
  }
}
