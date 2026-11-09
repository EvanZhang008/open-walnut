import type { MailMessageDto } from './contract.js'

/**
 * One mail held in several folders is several cache rows (Gmail keeps INBOX, `[Gmail]/All Mail`
 * and `[Gmail]/Important` copies). `oneCopyEach` in store.ts keeps one per message in SQL; this is
 * the same key for a list already read, where the copy to keep is not the store's choice: the
 * router read guard keeps the first copy its area may read, a thread keeps the message it was
 * opened on. A sender may reuse a Message-ID, so the time and subject are part of the key.
 */
export function mailCopyKey(message: Pick<MailMessageDto, 'accountId' | 'messageId' | 'rfcMessageId' | 'sentAt' | 'subject'>): string {
  return JSON.stringify([message.accountId, message.rfcMessageId || `id:${message.messageId}`, message.sentAt, message.subject])
}

/** The first row of each message, in the order given. */
export function firstCopyEach<T extends Pick<MailMessageDto, 'accountId' | 'messageId' | 'rfcMessageId' | 'sentAt' | 'subject'>>(messages: readonly T[]): T[] {
  const seen = new Set<string>()
  return messages.filter((message) => {
    const key = mailCopyKey(message)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
