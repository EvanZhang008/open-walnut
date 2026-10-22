import { createHash } from 'node:crypto'
import type { InboxItemDisplay, InboxLetterItem, InboxReadObservation } from '../../../packages/plugin-api/src/inbox-items.js'
import { inboxSourceSchema } from '../../core/human-inbox/item-schema.js'
import type { MailAccountDto } from './contract.js'
import type { MessageRow } from './store.js'
import { clipChars, NAME_CHARS, SUBJECT_CHARS } from './agent-format.js'
import { oneLine } from './untrusted.js'

export const EMAIL_SUMMARY_UNAVAILABLE = 'Email summary unavailable'

export interface DigestItem {
  sender: string
  subject: string
  sentAt: number
  account?: string
  message?: string
  summary?: string
  display?: InboxItemDisplay
  readObservation?: InboxReadObservation
}

function text(value: unknown, cap: number): string {
  return typeof value === 'string' ? clipChars(oneLine(value), cap) : ''
}
function timestamp(value: number): string | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

/** One bounded cache row, without a provider lookup or a snippet posing as a summary. */
export function digestItemFromRow(row: MessageRow, account: MailAccountDto): DigestItem {
  let payload: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(row.payload ?? '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>
  } catch { /* An older broken payload does not make the whole digest unavailable. */ }
  const from = payload.from && typeof payload.from === 'object' ? payload.from as Record<string, unknown> : {}
  const name = text(from.name, NAME_CHARS)
  const address = text(from.address, 500) || text(row.from_addr, 500)
  const sentAt = timestamp(row.sent_at)
  const accountLabel = text(account.displayName, NAME_CHARS)
  const accountHint = text(account.address, 1000)
  let flags: unknown
  try { flags = JSON.parse(row.flags_json ?? 'null') } catch { flags = undefined }
  const observedAt = timestamp(row.updated_at)
  return {
    account: row.account_id, message: row.message_id,
    sender: name || address, subject: text(row.subject, SUBJECT_CHARS), sentAt: row.sent_at,
    summary: text(payload.summary, 4000) || EMAIL_SUMMARY_UNAVAILABLE,
    display: {
      ...(name || address ? { sender: { ...(name ? { name } : {}), ...(address ? { address } : {}) } } : {}),
      ...(sentAt ? { sentAt } : {}), ...(accountLabel ? { accountLabel } : {}), ...(accountHint ? { accountHint } : {}),
    },
    ...(Array.isArray(flags) && flags.every(flag => typeof flag === 'string') && observedAt ? {
      readObservation: { read: flags.includes('\\Seen'), observedAt },
    } : {}),
  }
}

/** Identity is the exact stored pair, never the subject, display fields or RFC task key. */
export function digestLetterItem(item: DigestItem): InboxLetterItem | undefined {
  const parsed = inboxSourceSchema.safeParse({ kind: 'mail', account: item.account, message: item.message })
  if (!parsed.success) return undefined
  const id = `mail-${createHash('sha256').update(JSON.stringify([parsed.data.account, parsed.data.message])).digest('hex')}`
  return {
    id, source: parsed.data, subject: text(item.subject, SUBJECT_CHARS) || '(no subject)',
    summary: text(item.summary, 4000) || EMAIL_SUMMARY_UNAVAILABLE,
    ...(item.display ? { display: item.display } : {}),
    ...(item.readObservation ? { readObservation: item.readObservation } : {}),
    actions: (['mark_read', 'find_task', 'create_task'] as const).map(intent => ({ id: `${id}:${intent}`, kind: 'op', intent })),
  }
}
