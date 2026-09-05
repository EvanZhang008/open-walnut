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
import type {
  MailAddress,
  MailAttachmentMeta,
  MailEnvelope,
  ProviderErrorCode,
} from './types.js'

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
