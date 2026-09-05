/**
 * How a cached message becomes text an agent can read, and the caps that make that safe.
 *
 * Split out of `agent-surface.ts` (which owns the six flows) because it is a different question:
 * that file decides WHAT to answer, this one decides what the answer may look like. Every rule
 * here is a rule about a value an outside party chose.
 *
 * The line every function is on one side of: a field printed OUTSIDE the `<external-content>`
 * block is in Walnut's own voice, so it must first pass a SHAPE check (`isRfcMessageId`,
 * `isCacheKey`, `ADDRESS_SHAPE`); a field printed inside it is quoted and merely clipped. A value
 * that fails its shape check is never promoted to metadata: it is named as unusable outside and
 * repeated as data inside.
 *
 * The caps are PER FIELD, then per row, then per table, and that order is the point. One shared
 * budget is a pool, and a pool is drained by whoever is greediest: a single 200 KB subject spent
 * the whole allowance of a fifty-row list, so the other forty-nine messages were invisible and a
 * sender could hide the mailbox by being verbose in a header nobody reads.
 */
import type { MailAccountDto, MailMessageDto } from './contract.js'
import {
  LIST_ITEM_MAX_BYTES,
  oneLine,
  truncateUtf8,
  wrapUntrusted,
} from './untrusted.js'

/** A list row's preview. Long enough to triage, short enough for 50 of them. */
export const LIST_SNIPPET_CHARS = 160

/** A thread row's preview, per the design: enough to follow who said what. */
export const THREAD_SNIPPET_CHARS = 600

export const SUBJECT_CHARS = 200
export const NAME_CHARS = 120
export const FILENAME_CHARS = 120
/** RFC 5321 caps a path at 254 characters, so anything longer is not an address. */
export const ADDRESS_CHARS = 254
export const MESSAGE_ID_CHARS = 256
/** Attachment lines listed by name. Beyond this the count is stated instead. */
export const ATTACHMENTS_LISTED = 20
/** How many recipients are spelled out before the rest are counted. */
const ADDRESSES_LISTED = 10

/** A whole table, whatever the row count. Fifty rows of 2 KB is not a tool result. */
const TABLE_MAX_BYTES = 16 * 1024

/** The authored header lines of a `mail_read`. What is left over belongs to the body. */
export const AUTHORED_MAX_BYTES = 4 * 1024

/** The same shape check `drafts.ts` applies before it will send to an address. */
export const ADDRESS_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function accountLabel(account: MailAccountDto): string {
  return account.displayName || account.address || account.accountId
}

/**
 * One line, control characters gone, clipped.
 *
 * `oneLine` rather than a bare whitespace collapse: a `\n` or `\t` in a subject forges a row in
 * the tab-separated table below, which invents a message the mailbox does not contain. The
 * table's structure belongs to Walnut, exactly like the closing tag does.
 */
export function clipChars(text: string, max: number): string {
  const one = oneLine(text)
  return one.length <= max ? one : `${one.slice(0, max)}...`
}

export function isoOf(sentAt: number): string {
  return Number.isFinite(sentAt) && sentAt > 0 ? new Date(sentAt).toISOString() : 'date unknown'
}

/** IMAP flags in words, so an agent does not have to know what `\Seen` means. */
export function flagSummary(flags: string[]): string {
  const set = new Set(flags)
  const out = [set.has('\\Seen') ? 'read' : 'unread']
  if (set.has('\\Flagged')) out.push('flagged')
  if (set.has('\\Answered')) out.push('answered')
  if (set.has('\\Draft')) out.push('draft')
  return out.join('+')
}

/**
 * Recipient ADDRESSES, outside the block, so a reply can be aimed without another tool call.
 *
 * Addresses only: a display name is authored text and belongs inside the block with the subject.
 * Each one is shape-checked, and one that fails is counted rather than printed, because an
 * unparseable address is not something the agent can put in a `to:` anyway.
 */
export function addressList(list: Array<{ address: string }> | undefined): string {
  const all = list ?? []
  const usable = all.map((one) => one.address).filter((one) => ADDRESS_SHAPE.test(one))
  const shown = usable.slice(0, ADDRESSES_LISTED)
  const hidden = all.length - shown.length
  if (shown.length === 0) return all.length === 0 ? '(none)' : `(${all.length} not usable as addresses)`
  return `${shown.join(', ')}${hidden > 0 ? ` and ${hidden} more` : ''}`
}

/**
 * One row of a table, tab separated, every authored field clipped to its own cap.
 *
 * Tabs rather than a markdown table: a subject legitimately contains `|`, and a subject that can
 * break the table's own shape is the small version of the problem the wrapper solves.
 */
function envelopeLine(message: MailMessageDto, snippetChars: number): string {
  return [
    isoOf(message.sentAt),
    flagSummary(message.flags),
    clipChars(message.messageId, MESSAGE_ID_CHARS),
    clipChars(message.from.address, ADDRESS_CHARS) || '(no address)',
    clipChars(message.subject, SUBJECT_CHARS) || '(no subject)',
    clipChars(message.snippet, snippetChars),
  ].join('\t')
}

const TABLE_HEADER = 'sent\tflags\tmessage\tfrom\tsubject\tpreview'

/**
 * A table of envelopes, all of it inside ONE block. Never one block per row.
 *
 * Two caps, not one, and the per-row one is the load-bearing half: a single budget for the whole
 * table is a pool that any one row can drain, so one enormous field hides every other message.
 * Each row is cut to its own byte allowance first, then the table is cut to a fixed ceiling that
 * does not grow with the requested limit.
 */
export function envelopeTable(
  account: MailAccountDto,
  messages: MailMessageDto[],
  snippetChars: number,
  /** Authored text that belongs with the table, e.g. an id that failed its shape check. */
  insideNote?: string,
): string {
  const rows = messages.map((one) => truncateUtf8(envelopeLine(one, snippetChars), LIST_ITEM_MAX_BYTES).text)
  const lines = insideNote ? [insideNote, '', TABLE_HEADER, ...rows] : [TABLE_HEADER, ...rows]
  return wrapUntrusted({
    source: 'mail',
    account: account.accountId,
    message: `${messages.length} messages`,
    text: lines.join('\n'),
    maxBytes: TABLE_MAX_BYTES,
  })
}

/** What a body failure reads like. Plain words, never a throw: the envelope is still real data. */
export function bodyErrorSentence(code: string): string {
  if (code === 'too-large') {
    return 'The body is over the size cap Walnut will parse, so it was never stored. The envelope above is all there is; open it in the Mail app to read it.'
  }
  if (code === 'not-found') {
    return 'The mail server no longer has this message, so the body can never be fetched. It was probably moved or deleted elsewhere.'
  }
  if (code === 'auth') {
    return 'The mail account needs its password fixed before a body can be fetched. The user does that in the Mail app.'
  }
  return `The body could not be fetched (${code}). Pass retry: true to ask the mail server again.`
}
