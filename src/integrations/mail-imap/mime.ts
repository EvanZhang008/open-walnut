/**
 * MIME: raw headers, the body structure, and the one place mailparser is called.
 *
 * The byte cap is not a nicety here. A MIME parse of a multi-megabyte message is CPU work in
 * the server process, and the server has ONE event loop that every route shares, so the caller
 * checks the size the server already reported and refuses before this file ever sees the bytes.
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
} from '../mail/api.js'
import type { ImapFetchedMessage } from './client.js'
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

interface StructureNode {
  part?: string
  type?: string
  disposition?: string
  dispositionParameters?: Record<string, string>
  parameters?: Record<string, string>
  size?: number
  childNodes?: StructureNode[]
}

/**
 * Attachment metadata straight from BODYSTRUCTURE, with no download.
 *
 * This is why a list can show a paperclip without fetching anything: the poll already asked
 * for the structure, so filenames and sizes are free. v1 never caches attachment CONTENT and
 * never puts one in agent context.
 */
export function attachmentsFromStructure(root: unknown): MailAttachmentMeta[] {
  const out: MailAttachmentMeta[] = []
  const queue: StructureNode[] = root ? [root as StructureNode] : []
  while (queue.length > 0 && out.length < 100) {
    const node = queue.shift()!
    for (const child of node.childNodes ?? []) queue.push(child)
    const filename = node.dispositionParameters?.filename ?? node.parameters?.name
    const attached = node.disposition?.toLowerCase() === 'attachment'
    if (!attached && !filename) continue
    // A multipart node never carries content of its own, so it can never be an attachment even
    // when a client put a filename parameter on it.
    if (node.type?.toLowerCase().startsWith('multipart/')) continue
    out.push({
      ...(node.part ? { id: node.part } : {}),
      ...(filename ? { filename } : {}),
      ...(node.type ? { mimeType: node.type } : {}),
      ...(typeof node.size === 'number' ? { bytes: node.size } : {}),
    })
  }
  return out
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
  }
}
