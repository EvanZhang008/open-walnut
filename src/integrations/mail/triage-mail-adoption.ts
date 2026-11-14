// Once at start: the mail an older build buffered for Inbox Triage (triage-state.json `pending.mail`,
// until 2026-11-14, when every mailbox went straight to its router) joins the router intake's pending
// queue, so its router gets it instead of the deploy dropping it. Its own module because the intake
// path itself never reads the triage code (tests/core/router-no-triage-hop.test.ts).
import { takeTriageLegacyMail } from '../../core/triage/state.js'
import type { MailIntakeQueue } from './intake-pending.js'

/**
 * Moves those rows into `pending`, first seen when they were buffered, and out of triage-state.json;
 * its Slack rows stay. Idempotent: the queue keeps one entry per mail, and a failed move leaves the
 * rows for the next start. Answers how many mails moved; never throws.
 */
export async function adoptTriageMail(
  home: string, pending: MailIntakeQueue, log?: { warn(message: string, data?: Record<string, unknown>): void },
): Promise<number> {
  try {
    return await takeTriageLegacyMail(async (rows) => {
      await pending.add(rows.flatMap((row) => row.messageIds.map((message) => ({ account: row.accountId, message, at: row.atMs }))))
    }, home)
  } catch (error) {
    log?.warn('mail router intake could not take the old triage mail; it tries again at the next start', {
      error: (error instanceof Error ? error.message : String(error)).slice(0, 200),
    })
    return 0
  }
}
