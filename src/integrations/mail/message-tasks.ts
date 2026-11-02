/**
 * The message-to-task ledger's key, and the links that open a message in the Mail console.
 *
 * A message no longer becomes a task here: the Mail reader and an Inbox letter's mail items offer
 * Talk to CEO and New task instead, which hand the content to the CEO or a new task through the
 * shared content actions. What stays is what older tasks still need. The store's `message_tasks`
 * ledger holds the task each message was turned into by an earlier Walnut (and by the legacy Inbox
 * `create_task` path older phone apps still call, `item-source.ts`), and the read paths decorate a
 * message with that task id so its pill keeps showing. Both read and write key it the same way,
 * through `messageTaskKey`.
 */
import { oneLine } from './untrusted.js'
import type { MailMessageDto } from './contract.js'

/**
 * The ledger's key for one message.
 *
 * The RFC `Message-ID` when the message has one, because that is the only handle that survives the
 * things that change a provider handle: a folder move, a re-sync after eviction, the same mail
 * arriving in a second account. `cache:[...]` is the fallback and it is not optional: the column
 * defaults to `''`, so without it every Message-ID-less message in the install would collide on one
 * primary key and share a single task. JSON rather than a joining character for the same reason
 * `pairKey` in the console does it: an account id and a message id both legitimately contain
 * colons, so `a:b` + `c` and `a` + `b:c` have to stay two keys.
 *
 * BOTH forms are prefixed, and that is not decoration. A `Message-ID` is a header, which means a
 * sender chooses it: one spelled exactly `cache:["acct","uid-9"]` would otherwise land on the key
 * of somebody else's Message-ID-less message and take over its task.
 */
export function messageTaskKey(accountId: string, rfcMessageId: string, messageId: string): string {
  const rfc = oneLine(rfcMessageId ?? '')
  return rfc ? `rfc:${rfc}` : `cache:${JSON.stringify([accountId, messageId])}`
}

/** The same key, from a DTO. */
export function keyOfMessage(message: MailMessageDto): string {
  return messageTaskKey(message.accountId, message.rfcMessageId, message.messageId)
}

/**
 * Where the console opens this account's mail.
 *
 * `/mail`, not `/apps/mail`: the Mail console is a CORE app registered at `/mail`, and `/apps/:id`
 * is the host for plugin-provided Apps. Percent-encoded because an account id is a provider string and
 * routinely contains `&`, `#`, a space and a colon.
 */
export function mailAccountLink(accountId: string): string {
  return `/mail?account=${encodeURIComponent(accountId)}`
}
