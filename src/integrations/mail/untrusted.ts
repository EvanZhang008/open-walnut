/**
 * The one door every byte that came from a message goes through on its way to an agent.
 *
 * A mail body is written by whoever sent the mail. It can say "ignore your previous
 * instructions", it can claim to be the user, and it can try to close the block it is quoted
 * inside so that the rest of it reads as Walnut's own words. So the block is not decoration: it
 * is the frame that keeps authored content in the DATA role, and the escaping below is what
 * keeps the frame closed.
 *
 * What is wrapped and what is not, because the distinction is deliberate. Anything an outside
 * party TYPED (subject, display name, snippet, body, attachment filename) is wrapped. The
 * header fields an agent needs in order to address a reply (the raw address, the cache's own
 * message key, the date) are data too, but they are checked against their SHAPE instead and
 * printed as ordinary metadata, because an agent has to be able to copy a message id into the
 * next tool call, and a value inside the block is one the agent has been told not to act on.
 * A field that fails its shape check is never printed as metadata: it goes inside the block.
 *
 * Pure by construction: strings in, one string out, no I/O and no state, so every rule here is
 * reachable from a unit test without a database.
 */
import { plainTextOf } from './bodies.js'
// The cleaning primitives and the reminder live in the one core frame (core/outside-content.ts);
// re-exported so the plugin's modules and tests keep their imports.
import { escapeAttribute, escapeExternalContentTags, normalizeAngles, stripControls, truncateUtf8, UNTRUSTED_REMINDER } from '../../core/outside-content.js'

/** One `mail_read`. Big enough for a real mail, small enough to leave the context usable. */
export const AGENT_READ_MAX_BYTES = 24 * 1024

/** Per ROW of a list or a thread. A table of 50 rows is capped at 50 of these. */
export const LIST_ITEM_MAX_BYTES = 2 * 1024

export { escapeAttribute, escapeExternalContentTags, normalizeAngles, stripControls, truncateUtf8, UNTRUSTED_REMINDER }
export type { Utf8Cut } from '../../core/outside-content.js'

/**
 * One line, collapsed. For anything printed into a row or a header line.
 *
 * A `\n` or `\t` inside a subject is not a formatting quirk, it is a forged row: the tables this
 * module's callers build are tab separated and newline delimited, so a subject carrying either
 * one invents a message that does not exist. The structure of a table is Walnut's, not the
 * sender's, which is the same argument as the closing tag.
 */
export function oneLine(text: string): string {
  return stripControls(text).replace(/\s+/g, ' ').trim()
}

/**
 * An RFC 5322 `Message-ID`, as a shape.
 *
 * `rfcMessageId`, `threadId` and every entry of `references` arrive from the SENDER: the shipped
 * IMAP provider takes imapflow's `envelope.messageId` with no check at all, so the value can be
 * any text the sender liked, including a sentence addressed to the agent. These fields are
 * printed OUTSIDE the block (an agent has to be able to quote a message id), so the shape is the
 * whole defence: angle brackets, no whitespace, no nested brackets, bounded.
 */
export const RFC_ID_SHAPE = /^<[^<>\s]{1,255}>$/

export function isRfcMessageId(value: string): boolean {
  return RFC_ID_SHAPE.test(value)
}

/**
 * A cache key (`messageId`, `mailboxId`), as a shape.
 *
 * Deliberately NOT "no whitespace". These are provider-minted keys, and the shipped IMAP
 * provider builds `<mailbox>:<uidValidity>:<uid>` from the server's own mailbox path, which
 * legitimately contains spaces (`[Gmail]/All Mail`, `INBOX.Sent Items`). Rejecting a space would
 * refuse to print the id of a real message in a real mailbox. What is rejected is what can lie
 * about structure or run away with the context: control characters, line breaks and tabs (so the
 * value cannot forge a header line or a table row), a leading or trailing space, and length.
 */
const CACHE_KEY_MAX = 512

export function isCacheKey(value: string): boolean {
  if (!value || value.length > CACHE_KEY_MAX) return false
  if (value !== value.trim()) return false
  return value === oneLine(value)
}

/** What a field that failed its shape check is printed as, outside the block. */
export const NOT_A_USABLE_ID = '(not a usable id)'

export interface UntrustedInput {
  source: string
  /** The account this came from. Escaped, never trusted to be tag-safe. */
  account: string
  /** The RFC `Message-ID` when there is one, else the cache's own key. */
  message: string
  /** The plain-text half. */
  text?: string
  /**
   * The html half.
   *
   * Converted with the base's OWN extractor, the same one that feeds the FTS index, so search
   * and the agent see the same words. Html is never wrapped raw: markup inside the block is
   * both a token sink and one more thing that can look like structure to the reader.
   */
  html?: string
  maxBytes?: number
}

/**
 * One `<external-content>` block plus the reminder underneath it.
 *
 * Order of operations, and it matters: strip the controls and fold the angle variants, THEN cut
 * to the budget, THEN escape the tags. Escaping last is what makes the cut safe to reason about,
 * since a cut can only remove trailing bytes and could otherwise leave the tail of an escape
 * sequence behind. Folding before the escape is what puts `＜/external-content＞` in reach of it.
 */
export function wrapUntrusted(input: UntrustedInput): string {
  const maxBytes = input.maxBytes ?? AGENT_READ_MAX_BYTES
  const converted = plainTextOf({ text: input.text ?? '', html: input.html ?? '' })
  // What the message actually held, measured before anything was removed. The note below reports
  // THIS as the total: a count taken after the strip understates the message by however much was
  // stripped, and an agent deciding whether to open the mail in the app instead is entitled to
  // the real number.
  const totalBytes = Buffer.byteLength(converted, 'utf8')
  const stripped = normalizeAngles(stripControls(converted))
  const cut = truncateUtf8(stripped, maxBytes)
  const body = escapeExternalContentTags(cut.text)
  const note = cut.shown < cut.total ? `\n[truncated: ${cut.shown} of ${totalBytes} bytes shown]` : ''
  const attributes = [
    `source="${escapeAttribute(input.source)}"`,
    `account="${escapeAttribute(input.account)}"`,
    `message="${escapeAttribute(input.message)}"`,
    'trust="untrusted"',
  ].join(' ')
  return `<external-content ${attributes}>\n${body}${note}\n</external-content>\n${UNTRUSTED_REMINDER}`
}
