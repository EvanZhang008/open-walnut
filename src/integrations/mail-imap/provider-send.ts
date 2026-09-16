/**
 * The outgoing half of the IMAP provider: one SMTP attempt, then a Sent copy nobody waits for.
 *
 * Split out of provider.ts because it is the only part of that file with a second transport in it,
 * and because the deadline arithmetic below is the sort of thing that has to be readable in one
 * screen.
 *
 * The arithmetic, which is the whole reason this file is shaped like this: the base gives a send
 * 30s (`SEND_DEADLINE_MS`) and treats a timeout as an outcome nobody can know. The SMTP attempt
 * takes 25s of that. An IMAP APPEND is a second connection to a second server and can itself take
 * 12s per command, so awaiting it inside the send would push a perfectly accepted message past the
 * base's clock and report it as `unknown`: a slow mailbox would turn into "Walnut cannot tell
 * whether your mail went". So the result is computed and returned FIRST, and the copy is filed on
 * a detached promise with its own budget. Nothing it does can change the outcome, which is also
 * the honest model: by the time it runs, the message is already delivered.
 */
import type { MailAddress, MailSendResult, OutgoingMail } from '../mail/api.js'
import { providerError, type ImapPool } from './client.js'
import type { ImapAccountStore, ImapAccountEntry } from './config.js'
import { mailboxRole } from './coords.js'
import { sendMail } from './smtp.js'

interface SendLog {
  debug(message: string, meta?: Record<string, unknown>): void
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
}

/**
 * One SMTP attempt, a little under the base's own 30s send deadline.
 *
 * Deliberately shorter: whichever clock fires first decides the outcome, and this one knows the
 * protocol position the failure happened at, while the base's generic deadline can only assume the
 * unsafe answer.
 */
export const SEND_BUDGET_MS = 25_000

/**
 * The whole Sent-copy attempt, LIST plus APPEND, on its own clock.
 *
 * It runs after the response, so this budget exists to stop a wedged IMAP server from holding a
 * connection and a few megabytes of MIME for the rest of the process's life, not to protect a
 * caller: there is no caller left.
 */
const SENT_COPY_BUDGET_MS = 20_000

export function createImapSender(deps: {
  store: ImapAccountStore
  pool: ImapPool
  log: SendLog
  accountOf: (accountId: string) => Promise<ImapAccountEntry>
}) {
  const { store, pool, log, accountOf } = deps

  /**
   * Put a copy of the message we just sent into the Sent folder.
   *
   * SMTP and IMAP are two unrelated conversations: the outgoing server delivers the mail and tells
   * the mailbox nothing, so without this the user's Sent folder stays empty and the thread they
   * see on their phone has a hole where their own reply should be.
   *
   * It can NEVER change the outcome of the send, and after the fix above it can never delay it
   * either. The message is already delivered by the time this runs, so a failure here is a missing
   * copy, and reporting it as a failed send would invite a retry that delivers the mail twice.
   */
  const appendSentCopy = async (entry: ImapAccountEntry, raw: Buffer | undefined): Promise<void> => {
    if (!raw) return
    const policy = await store.sentCopyPolicy(entry.accountId)
    if (!policy.appendSent || policy.serverSavesSent) return
    const connection = await pool.for(entry.accountId)
    const boxes = await connection.run('a mailbox list', (client) => client.list())
    const sent = boxes.find((one) => mailboxRole(one, entry.roles) === 'sent')
    if (!sent) {
      log.debug('imap has no Sent folder to copy into', { accountId: entry.accountId })
      return
    }
    await connection.run(
      'a Sent copy',
      (client) => client.append(sent.path, raw, ['\\Seen'], new Date()),
    )
    log.debug('imap filed a sent copy', { accountId: entry.accountId, mailbox: sent.path })
  }

  /** Start the copy and forget it, under a clock, never touching the send's own promise chain. */
  const fileSentCopy = (entry: ImapAccountEntry, raw: Buffer | undefined): void => {
    if (!raw) return
    const timer = setTimeout(() => {
      log.warn('imap gave up on filing a Sent copy, the message was still sent', {
        accountId: entry.accountId, budgetMs: SENT_COPY_BUDGET_MS,
      })
    }, SENT_COPY_BUDGET_MS)
    timer.unref?.()
    void appendSentCopy(entry, raw)
      .catch((error: unknown) => {
        log.warn('imap could not file a copy in Sent, the message was still sent', {
          accountId: entry.accountId, error: String(error).slice(0, 200),
        })
      })
      .finally(() => clearTimeout(timer))
  }

  const send = async (
    accountId: string,
    mail: OutgoingMail,
    options: { idempotencyKey: string },
  ): Promise<MailSendResult> => {
    const entry = await accountOf(accountId)
    if (!entry.smtp) {
      throw providerError(
        'unsupported',
        `The account "${accountId}" has no outgoing (SMTP) server configured, so Walnut cannot`
        + ' send from it. Add the outgoing settings to the account and try again.',
      )
    }
    const password = await store.password(accountId)
    if (!password) {
      throw providerError('auth', `No stored password for "${accountId}". Add the account again.`)
    }
    const result = await sendMail({
      settings: entry.smtp,
      user: entry.settings.address,
      password,
      log,
      timeoutMs: SEND_BUDGET_MS,
      message: {
        from: { name: entry.displayName, address: entry.settings.address },
        to: mail.to as MailAddress[],
        ...(mail.cc?.length ? { cc: mail.cc } : {}),
        ...(mail.bcc?.length ? { bcc: mail.bcc } : {}),
        subject: mail.subject,
        // The base already rendered the html half and already sanitized it. Re-rendering here is
        // exactly the "two layers disagreeing" bug the contract's comment warns about.
        text: mail.bodyMarkdown,
        ...(mail.bodyHtml ? { html: mail.bodyHtml } : {}),
        ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo } : {}),
        ...(mail.references?.length ? { references: mail.references } : {}),
        idempotencyKey: options.idempotencyKey,
      },
    })
    // Detached, on purpose: see the file comment. The answer below is what the ledger records.
    fileSentCopy(entry, result.raw)
    return {
      ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
      acceptedAt: result.acceptedAt,
    }
  }

  return { send }
}
