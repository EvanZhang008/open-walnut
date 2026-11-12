/**
 * What the mail router's "noise" decision does to the email (when the person turned the experiment
 * on): it marks the mail read, then moves it from the inbox to the account's archive with the filter
 * mover's provider call, the same reversible move a "keep out of the inbox" rule makes. Never a delete, never
 * a send. Mail outside the inbox (a filter or the person filed it) is only marked read: its folder
 * was someone's choice. The decision, with what was done ("Marked read and archived: ..."), stays in
 * the area's ledger and on the router's page. The archive's copy is another cached row, and a decision
 * never shows on a row only because its Message-ID matches (router-decoration.ts: that header can be
 * forged).
 *
 * Known limit: the re-check right before the move reads the cache. A server that moves or flags a
 * whole conversation (Outlook) also takes a reply it holds that no poll has cached yet.
 */
import type { RouterNoiseOutcome } from '../../core/router/source-registry.js'
import type { RouterSource } from '../../core/router/types.js'
import { mailRowDeliveryVersion } from './router-source.js'
import type { MailStore, MessageRow } from './store.js'

export interface MailNoiseDeps {
  store: Pick<MailStore, 'getMessage' | 'listMailboxes'>
  canMarkRead(accountId: string): boolean
  markRead(accountId: string, messageId: string): Promise<unknown>
  canArchive(accountId: string): boolean
  /** Moves one inbox mail to the archive now, while `stillCurrent`; `ok` once the server moved it. */
  archive(accountId: string, messageId: string, stillCurrent: () => Promise<boolean>): Promise<{ ok: boolean; reason?: string }>
}

const isRead = (row: MessageRow): boolean => {
  try {
    const flags: unknown = JSON.parse(row.flags_json || '[]')
    return Array.isArray(flags) && flags.includes('\\Seen')
  } catch { return false }
}

const why = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 160)

export async function tidyNoiseMail(deps: MailNoiseDeps, source: RouterSource): Promise<RouterNoiseOutcome> {
  if (source.kind !== 'mail') return { read: false, archived: false }
  const row = await deps.store.getMessage(source.account, source.message)
  // Only the exact email the router read: a copy that changed or went is left alone.
  if (!row) return { read: false, archived: false, note: 'the email is no longer in the cache' }
  if (source.version !== undefined && mailRowDeliveryVersion(row) !== source.version) {
    return { read: false, archived: false, note: 'a later delivery replaced the email' }
  }
  let read = isRead(row)
  let note: string | undefined
  if (!read) {
    if (!deps.canMarkRead(source.account)) note = 'this account cannot change read flags'
    else {
      try {
        await deps.markRead(source.account, source.message)
        read = true
      } catch (error) { note = why(error) }
    }
  }
  const role = (await deps.store.listMailboxes(source.account)).find((box) => box.mailbox_id === row.mailbox_id)?.role
  let archived = false
  if (role === 'inbox') {
    if (!deps.canArchive(source.account)) note ??= 'this account has no archive'
    else {
      try {
        // Asked again right before the move: a reply that arrived meanwhile (an Outlook row is a
        // conversation) is a new delivery the router has not read, and must stay in the inbox.
        const stillCurrent = async () => {
          const now = await deps.store.getMessage(source.account, source.message)
          return !!now && now.mailbox_id === row.mailbox_id && (source.version === undefined || mailRowDeliveryVersion(now) === source.version)
        }
        const moved = await deps.archive(source.account, source.message, stillCurrent)
        archived = moved.ok
        if (!moved.ok) note ??= moved.reason ?? 'the mail server did not move it'
      } catch (error) { note ??= why(error) }
    }
  }
  return { read, archived, ...(note ? { note } : {}) }
}
