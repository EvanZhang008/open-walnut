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
import type { MailAttachmentMeta } from '../mail/api.js'

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
 * Parse one raw message.
 *
 * `skipTextToHtml` and `skipImageLinks` are off because nothing here wants a generated HTML
 * view: the console renders the real HTML part (sanitized at its end) or the plain text, and a
 * synthesized third representation is work nobody reads.
 */
export async function parseMime(source: Buffer): Promise<ParsedBody> {
  const simpleParser = await loadParser()
  const parsed = await simpleParser(source, { skipTextToHtml: true, skipImageLinks: true })
  return {
    ...(parsed.text ? { text: parsed.text } : {}),
    ...(parsed.html ? { html: parsed.html } : {}),
    attachments: (parsed.attachments ?? []).map((one) => ({
      ...(one.partId ? { id: one.partId } : {}),
      ...(one.filename ? { filename: one.filename } : {}),
      ...(one.contentType ? { mimeType: one.contentType } : {}),
      ...(typeof one.size === 'number' ? { bytes: one.size } : {}),
    })),
  }
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
