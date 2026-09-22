/**
 * One cached row (or one freshly fetched envelope) as the shape every layer above `service.ts`
 * speaks, and the payload blob those shapes are half-built from.
 *
 * Split out of service.ts because it is the one part of that file with no I/O in it at all: given a
 * row, these functions are pure, which is what makes the interesting rules checkable without a
 * database. Two of them are worth knowing before adding a field:
 *
 * - THE BLOB IS FOR FIELDS NO QUERY FILTERS ON. `cc`, `replyTo`, the threading headers and the body
 *   shape all live in `payload` rather than in columns, so adding one needs no migration. A field a
 *   WHERE clause has to name is a column instead, and that is a migration.
 * - A MISSING FIELD IS NOT AN EMPTY FIELD. `cc` and `replyTo` are optional rather than defaulted to
 *   `[]`, because the cache holds rows written before those fields existed and "the message had no
 *   Cc" and "this row predates the field" are different facts.
 */
import type { StoredBodyFormat } from './bodies.js'
import { snippetOf } from './bodies.js'
import { threadIdOf, type MailMessageDto } from './contract.js'
import type { MessageRow } from './store.js'
import type { MailUnsubscribeAvailability } from './contract.js'
import type {
  MailAddress,
  MailAttachmentMeta,
  MailEnvelope,
  MailListUnsubscribe,
  ProviderErrorCode,
} from './types.js'

/**
 * What the cache knows about leaving this list: the provider's headers, plus what the base found
 * in the stored html itself.
 *
 * The split matters. The header fields come from the ENVELOPE (or, for old mail, from a body read)
 * and describe the message; `bodyLink` and `bodyCandidates` describe the BYTES currently on disk,
 * so they are dropped when that body is retired (`payloadForRetiredBody`) while the header fields
 * survive. A provider can only ever set the first group: `MailListUnsubscribe` is the contract
 * surface, and the base owns the second group.
 */
export interface StoredListUnsubscribe extends MailListUnsubscribe {
  /** An https unsubscribe link found in the stored html, for a message whose headers offered none. */
  bodyLink?: string
  /** How many anchors matched. More than one means "ambiguous", which is a question for a human. */
  bodyCandidates?: number
}

/** What rides the payload blob: everything no query filters on. */
export interface MessagePayload {
  from?: MailAddress
  to?: MailAddress[]
  cc?: MailAddress[]
  /** The `Reply-To` header. In the blob, not a column: nothing queries on it. */
  replyTo?: MailAddress[]
  sentAtHeader?: string
  inReplyTo?: string
  references?: string[]
  bodyFormat?: StoredBodyFormat
  bodyTruncated?: boolean
  /** The size the POLL reported, so a body fetch can be refused before it is issued. */
  bodyBytesHint?: number
  /**
   * How to leave this list. In the blob, so the field needed no migration at all.
   *
   * Absent on every row cached before it existed, and it stays absent until either a poll reports it
   * (new mail) or a body is fetched (old mail): the envelope hash ignores the field on purpose, so
   * no upgrade rewrites a mailbox to backfill it.
   */
  listUnsubscribe?: StoredListUnsubscribe
}

/**
 * Which rung of the unsubscribe ladder this message can be handed to, from the payload alone.
 *
 * PURE and free: no request, no ledger read, so a fifty-row page costs nothing to decorate. The
 * order is the order of how little the human has to do — a one-click POST the sender explicitly
 * invited, then a mail Walnut can draft, then a link somebody has to look at.
 */
export function unsubscribeAvailability(
  held: StoredListUnsubscribe | undefined,
): MailUnsubscribeAvailability {
  if (!held) return 'none'
  if (held.oneClick && held.https?.length) return 'one-click'
  if (held.mailto?.length) return 'mailto'
  if (held.https?.length || held.bodyLink) return 'link'
  return 'none'
}

/**
 * What "the other mail from this list" is keyed on: the ledger's `list_key`.
 *
 * A human does not unsubscribe from a MESSAGE, they leave a list, so the ledger has to be keyed on
 * something every message of that list carries. `List-Id` is that thing when the sender set one.
 * When they did not, the sender's own address is the fallback, and it is deliberately coarser: one
 * sender running three lists off one address shares a key, so leaving one marks all three. Nine times
 * out of ten that is what the person meant, and the console says "this sender" rather than "this
 * list" when the key came from the address so the wording never overstates it.
 *
 * Both halves are lowercased, because a `List-Id` is case-insensitive and two mails from one list
 * can capitalise a domain differently. An empty key is replaced by one scoped to the message: a
 * blank `list_key` would match every other row with an unknown sender, which is the one outcome
 * worse than no memory at all.
 */
export function unsubscribeListKey(
  held: StoredListUnsubscribe | undefined,
  fromAddr: string,
  messageId: string,
): string {
  const listId = (held?.listId ?? '').trim().toLowerCase()
  if (listId) return listId
  const sender = fromAddr.trim().toLowerCase()
  if (sender) return sender
  return `message:${messageId}`
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try { return JSON.parse(raw) as T }
  catch { return fallback }
}

/**
 * The size the poll already reported for this message, when it reported one.
 *
 * Passed to `getBody` so a provider can refuse an over-cap message BEFORE issuing the fetch. The
 * IMAP path could only check after downloading up to 2 MB, which is the whole cost the cap exists
 * to avoid, repeated on every read.
 *
 * From the PAYLOAD blob, not a column: it is a field no query filters on. `body_bytes` cannot serve
 * here because it is the size of what was STORED, and nothing is stored yet when the hint is wanted.
 */
export function sizeHintOf(row: MessageRow): number | undefined {
  const hint = parseJson<MessagePayload>(row.payload, {}).bodyBytesHint
  return typeof hint === 'number' && hint > 0 ? hint : undefined
}

export function toDto(row: MessageRow): MailMessageDto {
  const payload = parseJson<MessagePayload>(row.payload, {})
  return {
    messageId: row.message_id,
    accountId: row.account_id,
    mailboxId: row.mailbox_id,
    rfcMessageId: row.rfc_message_id,
    from: payload.from ?? { address: row.from_addr },
    to: payload.to ?? [],
    ...(payload.cc?.length ? { cc: payload.cc } : {}),
    ...(payload.replyTo?.length ? { replyTo: payload.replyTo } : {}),
    subject: row.subject,
    snippet: row.snippet,
    sentAt: row.sent_at,
    ...(payload.sentAtHeader ? { sentAtHeader: payload.sentAtHeader } : {}),
    ...(row.received_at ? { receivedAt: row.received_at } : {}),
    flags: parseJson<string[]>(row.flags_json, []),
    attachments: parseJson<MailAttachmentMeta[]>(row.attachments_json, []),
    hasBody: !!row.body_ref,
    ...(row.body_error ? { bodyError: row.body_error as ProviderErrorCode } : {}),
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    // Only when something was captured: a row that predates the field carries no key at all, and a
    // client reads that as `'none'` (see `MailMessageDto.unsubscribe`). `done`/`pending` are added
    // later, by the one ledger query the page makes.
    ...(payload.listUnsubscribe
      ? { unsubscribe: { available: unsubscribeAvailability(payload.listUnsubscribe) } }
      : {}),
  }
}

export function envelopeToDto(
  accountId: string,
  envelope: MailEnvelope,
  hasBody: boolean,
): MailMessageDto {
  return {
    messageId: envelope.messageId,
    accountId,
    mailboxId: envelope.mailboxId,
    rfcMessageId: envelope.rfcMessageId ?? '',
    from: envelope.from,
    to: envelope.to ?? [],
    ...(envelope.cc?.length ? { cc: envelope.cc } : {}),
    ...(envelope.replyTo?.length ? { replyTo: envelope.replyTo } : {}),
    subject: envelope.subject ?? '',
    snippet: envelope.snippet ? snippetOf(envelope.snippet) : '',
    sentAt: envelope.sentAt,
    ...(envelope.sentAtHeader ? { sentAtHeader: envelope.sentAtHeader } : {}),
    ...(envelope.receivedAt ? { receivedAt: envelope.receivedAt } : {}),
    flags: envelope.flags ?? [],
    attachments: envelope.attachments ?? [],
    hasBody,
    threadId: threadIdOf(envelope),
  }
}
