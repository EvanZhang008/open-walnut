/**
 * Leaving a mailing list, programmatically, in the order of how little the human has to do.
 *
 * The ladder, and the reason it is a ladder rather than one action: senders offer three different
 * exits and only one of them is machine-final. So each rung is tried and the first that can say "you
 * are off the list" wins, and when none can the honest answer is `needs-human` with the url — never a
 * green tick over a page nobody read.
 *
 *   1. RFC 8058 one-click. The sender explicitly invited one POST, no confirmation, no human.
 *   2. mailto. A real mail Walnut drafts and the human authorises (S8; see the stub below).
 *   3. https GET. Fetch the page and read it (`unsubscribe-verdict.ts`).
 *   4. The model. NOT a rung here: the server never hands a page to an agent. The console opens the
 *      Ask drawer, or the plugin sends a letter, and a human is in that loop by construction.
 *
 * Three properties this file is responsible for, each of which is a bug someone could reintroduce in
 * one line:
 *
 * - ONE ATTEMPT IN FLIGHT PER MESSAGE, enforced by a single upsert in the ledger (see
 *   `claimUnsubscribe`), never by a read-then-write. Two clicks a millisecond apart must make one
 *   request.
 * - NOTHING RETRIES ITSELF. A failed rung is recorded with its reason and stops. A human clicking
 *   again is the retry; the 60-second reclaim of an `in-flight` row exists only for a process that
 *   died mid-attempt.
 * - EVERY NETWORK HOP GOES THROUGH THE GUARD. This module never calls `fetch`; it calls
 *   `fetchUnsubscribe`, which cannot be told to skip its checks.
 */
import { MailServiceError } from './contract.js'
import type { MailEvents } from './events.js'
import type { MailService, UnsubscribeSubject } from './service.js'
import type { MailStore } from './store.js'
import { UNSUBSCRIBE_RECLAIM_MS, type UnsubscribeRow } from './store-write.js'
import {
  fetchUnsubscribe,
  UNSUBSCRIBE_DEADLINE_MS,
  type UnsubscribeHttpSeam,
} from './unsubscribe-http.js'
import { unsubscribeSentence, unsubscribeVerdict } from './unsubscribe-verdict.js'

export { UNSUBSCRIBE_DEADLINE_MS, UNSUBSCRIBE_RECLAIM_MS }

/** Which rung was used. `manual` is reserved for a human telling Walnut they did it themselves. */
export type UnsubscribeMethod = 'one-click' | 'mailto' | 'link' | 'manual'

/** Ledger states. `in-flight` is the claim; the other three are settled. */
export type UnsubscribeLedgerStatus = 'in-flight' | 'done' | 'needs-human' | 'failed'

/** The ledger row as the wire shows it, so a 409 can hand the console what it already knows. */
export interface MailUnsubscribeLedgerDto {
  accountId: string
  messageId: string
  listKey: string
  method: string
  status: string
  reason?: string
  detail?: string
  ref?: string
  at: number
}

export interface UnsubscribeOutcome {
  status: UnsubscribeLedgerStatus | 'conflict'
  method: UnsubscribeMethod
  at: number
  reason?: string
  detail?: string
  /** The page a human has to finish, when there is one. */
  url?: string
  /** `in-flight` (another attempt owns it) or `already` (the human is off this list). */
  conflict?: 'in-flight' | 'already'
  /** What the ledger already holds, on a conflict. */
  ledger?: MailUnsubscribeLedgerDto
  /** One sentence a console prints verbatim. Always present. */
  message: string
}

/** Rungs a caller may ask for by name. `manual` is not one of them: it claims a fact, not an action. */
const REQUESTABLE: readonly string[] = ['one-click', 'mailto', 'link']

export function isRequestableUnsubscribeMethod(value: unknown): value is 'one-click' | 'mailto' | 'link' {
  return typeof value === 'string' && REQUESTABLE.includes(value)
}

export function unsubscribeLedgerDto(row: UnsubscribeRow): MailUnsubscribeLedgerDto {
  return {
    accountId: row.account_id,
    messageId: row.message_id,
    listKey: row.list_key,
    method: row.method,
    status: row.status,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.detail ? { detail: row.detail } : {}),
    ...(row.ref ? { ref: row.ref } : {}),
    at: row.at,
  }
}

/**
 * The rungs to try, given the rung that was asked for (or the best one available).
 *
 * One-click falls through to the plain GET on the SAME https url, because a sender that publishes
 * `List-Unsubscribe-Post` and then answers the POST with a 500 usually still serves the page. The
 * other two stand alone: a mailto has no page, and a link has no POST invitation.
 */
function rungsFor(method: UnsubscribeMethod): UnsubscribeMethod[] {
  if (method === 'one-click') return ['one-click', 'link']
  return [method]
}

interface Log {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  debug?(message: string, fields?: Record<string, unknown>): void
}

export interface MailUnsubscribeDeps {
  store: MailStore
  service: MailService
  events: MailEvents
  log: Log
  now?: () => number
  /**
   * Socket and resolver seam, handed straight to `fetchUnsubscribe`. NOT a way past the guard: every
   * url and every redirect is still checked, and every address the resolver answers with is still
   * run through the blocklist.
   */
  http?: Partial<UnsubscribeHttpSeam>
}

export class MailUnsubscribe {
  constructor(private readonly deps: MailUnsubscribeDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** What the ledger holds for one message, for the DTO decoration and for a 409. */
  async ledgerFor(accountId: string, messageId: string): Promise<MailUnsubscribeLedgerDto | undefined> {
    const row = await this.deps.store.write.getUnsubscribe(accountId, messageId)
    return row ? unsubscribeLedgerDto(row) : undefined
  }

  /**
   * Run the ladder for one message.
   *
   * Throws `MailServiceError` for the two refusals that are about the REQUEST rather than the outcome:
   * `unsupported` (409) when the message offers no way out at all, and `invalid` (400) when the caller
   * named a rung this message does not have. Everything else is an outcome, including failure: the
   * ledger holds it and the console prints the sentence.
   */
  async run(
    accountId: string,
    messageId: string,
    request: { method?: string; confirm?: boolean } = {},
  ): Promise<UnsubscribeOutcome> {
    const subject = await this.deps.service.unsubscribeSubject(accountId, messageId)
    const method = this.chooseRung(subject, request.method)

    const startedAt = this.now
    const claimed = await this.deps.store.write.claimUnsubscribe({
      accountId: subject.accountId,
      messageId: subject.messageId,
      listKey: subject.listKey,
      method,
      now: startedAt,
      reclaimBefore: startedAt - UNSUBSCRIBE_RECLAIM_MS,
    })
    if (claimed === 0) {
      const held = await this.ledgerFor(subject.accountId, subject.messageId)
      // A row that vanished between the claim and this read is the only way `held` is absent, and the
      // honest answer is still "somebody else has it": nothing here retries on a race.
      const already = held?.status === 'done' ? held : undefined
      return {
        status: 'conflict',
        method,
        at: held?.at ?? startedAt,
        conflict: already ? 'already' : 'in-flight',
        ...(held ? { ledger: held } : {}),
        message: already
          ? this.alreadySentence(already, subject)
          : 'Walnut is already unsubscribing you from this one. Give it a moment.',
      }
    }

    const deadlineAt = startedAt + UNSUBSCRIBE_DEADLINE_MS
    let last: UnsubscribeOutcome | undefined
    // Why each earlier rung gave up, kept so the ledger row names the whole attempt rather than only
    // its last step: "the one-click POST answered 500 and the page then said nothing" is the sentence
    // somebody reading this row a week later needs.
    const trail: string[] = []
    for (const rung of rungsFor(method)) {
      const outcome = await this.runRung(rung, subject, deadlineAt)
      last = outcome
      if (outcome.status === 'done') break
      trail.push(`${rung}: ${outcome.detail ?? outcome.reason ?? 'no answer'}`)
      // Only a `done` stops the ladder early. The clock stops it too: a rung that used the whole
      // budget leaves nothing for the next one, and starting it anyway would answer `timeout` twice.
      if (this.now >= deadlineAt) break
    }
    const settled: UnsubscribeOutcome = last
      ? (trail.length > 1 ? { ...last, detail: trail.join(' | ') } : last)
      : {
        status: 'failed',
        method,
        at: this.now,
        reason: 'unsupported',
        detail: 'no unsubscribe rung could run',
        message: unsubscribeSentence({ status: 'failed', method, reason: 'unsupported' }),
      }
    await this.settle(subject, startedAt, settled)
    return settled
  }

  /** Which rung this run uses: the one asked for, if the message has it, else the best available. */
  private chooseRung(subject: UnsubscribeSubject, asked: string | undefined): UnsubscribeMethod {
    if (subject.available === 'none') {
      throw new MailServiceError(
        'unsupported',
        'This message offers no unsubscribe link, so Walnut has nothing to open. Ask Walnut to look for one in the message itself.',
        409,
      )
    }
    if (asked === undefined) return subject.available as UnsubscribeMethod
    if (!isRequestableUnsubscribeMethod(asked)) {
      throw new MailServiceError('invalid', `"${String(asked)}" is not an unsubscribe method.`, 400)
    }
    if (!this.hasRung(subject, asked)) {
      throw new MailServiceError(
        'invalid',
        `This message has no ${asked} unsubscribe option.`,
        400,
      )
    }
    return asked
  }

  private hasRung(subject: UnsubscribeSubject, rung: 'one-click' | 'mailto' | 'link'): boolean {
    const held = subject.held
    if (!held) return false
    if (rung === 'one-click') return !!(held.oneClick && held.https?.length)
    if (rung === 'mailto') return !!held.mailto?.length
    return !!(held.https?.length || held.bodyLink)
  }

  /** The url each fetching rung uses: the header's link first, then the one found in the markup. */
  private urlFor(subject: UnsubscribeSubject): string | undefined {
    return subject.held?.https?.[0] ?? subject.held?.bodyLink
  }

  private async runRung(
    rung: UnsubscribeMethod,
    subject: UnsubscribeSubject,
    deadlineAt: number,
  ): Promise<UnsubscribeOutcome> {
    if (rung === 'mailto') return this.mailtoRung(subject)
    const url = this.urlFor(subject)
    if (!url) {
      return this.outcome(rung, { status: 'failed', reason: 'unsupported', detail: 'no https url to open' })
    }
    const answered = await fetchUnsubscribe(url, {
      method: rung === 'one-click' ? 'POST' : 'GET',
      // RFC 8058, exactly: the body is this one pair and nothing else.
      ...(rung === 'one-click'
        ? { body: 'List-Unsubscribe=One-Click', contentType: 'application/x-www-form-urlencoded' }
        : {}),
      deadlineAt,
      ...(this.deps.http ? { seam: this.deps.http } : {}),
      ...(this.deps.now ? { now: this.deps.now } : {}),
    })
    if (!answered.ok) {
      return this.outcome(rung, {
        status: 'failed',
        reason: answered.reason,
        detail: answered.detail,
        url: answered.url,
      })
    }
    // A one-click POST is graded by the STATUS ALONE: the sender promised that a 2xx means done, and
    // reading their confirmation page for words would let a 200 "are you sure?" pass as success.
    if (rung === 'one-click') {
      if (answered.status >= 200 && answered.status < 300) {
        return this.outcome(rung, { status: 'done', url: answered.url })
      }
      return this.outcome(rung, {
        status: 'failed',
        reason: `http-${answered.status}`,
        detail: `the one-click endpoint answered ${answered.status}`,
        url: answered.url,
      })
    }
    const verdict = unsubscribeVerdict({
      status: answered.status,
      body: answered.body,
      ...(answered.contentType ? { contentType: answered.contentType } : {}),
    })
    return this.outcome(rung, {
      status: verdict.status,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      ...(verdict.detail ? { detail: verdict.detail } : {}),
      // Handed back on anything unfinished, because it is the one thing a human needs next.
      ...(verdict.status === 'done' ? {} : { url: answered.url }),
    })
  }

  /**
   * The mailto rung: S8's work, stubbed so the route is TOTAL today.
   *
   * It answers `needs-human` with its own reason rather than throwing, because a mailto-only
   * newsletter is a real message a human can click on right now, and the honest answer to that click
   * is "this list only takes a mail, which Walnut cannot send yet" — not a 500 and not a silent
   * nothing. S8 replaces the body of this method with the draft + `consoleSend` path (the console
   * ledger, `approvalRef: 'unsubscribe:<messageId>'`) and the `202 in-flight` answer that goes with
   * it; the reason string `mailto-pending` is what disappears when that lands.
   */
  private mailtoRung(subject: UnsubscribeSubject): UnsubscribeOutcome {
    const target = subject.held?.mailto?.[0]
    return this.outcome('mailto', {
      status: 'needs-human',
      reason: 'mailto-pending',
      detail: target ? `this list unsubscribes by mail to ${target}` : 'this list unsubscribes by mail',
    })
  }

  private outcome(
    method: UnsubscribeMethod,
    fields: {
      status: UnsubscribeLedgerStatus
      reason?: string
      detail?: string
      url?: string
    },
  ): UnsubscribeOutcome {
    return {
      status: fields.status,
      method,
      at: this.now,
      ...(fields.reason ? { reason: fields.reason } : {}),
      ...(fields.detail ? { detail: fields.detail } : {}),
      ...(fields.url ? { url: fields.url } : {}),
      message: unsubscribeSentence({
        status: fields.status,
        method,
        ...(fields.reason ? { reason: fields.reason } : {}),
      }),
    }
  }

  /** The human's own words for a message they already left the list from. */
  private alreadySentence(held: MailUnsubscribeLedgerDto, subject: UnsubscribeSubject): string {
    const what = subject.held?.listId ? 'this list' : 'this sender'
    return `You already unsubscribed from ${what} on ${new Date(held.at).toISOString().slice(0, 10)}.`
  }

  /**
   * Write the verdict and announce it.
   *
   * The write is conditional on this attempt still owning the row (see `settleUnsubscribe`), so a
   * rung that finished after the response was already sent, and after somebody reclaimed the row,
   * records nothing and says nothing. That is the point: the ledger holds the newest claim's answer,
   * not whichever writer happened to be last.
   */
  private async settle(
    subject: UnsubscribeSubject,
    claimedAt: number,
    outcome: UnsubscribeOutcome,
  ): Promise<void> {
    const status = outcome.status === 'conflict' ? 'failed' : outcome.status
    const changed = await this.deps.store.write.settleUnsubscribe({
      accountId: subject.accountId,
      messageId: subject.messageId,
      claimedAt,
      status,
      // The rung that actually answered, which may not be the rung the claim named.
      method: outcome.method,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...(outcome.detail ? { detail: outcome.detail } : {}),
      now: this.now,
    }).catch((error: unknown) => {
      this.deps.log.warn('mail could not record an unsubscribe outcome', {
        accountId: subject.accountId, messageId: subject.messageId,
        error: String(error).slice(0, 200),
      })
      return 0
    })
    if (changed === 0) {
      this.deps.log.debug?.('mail unsubscribe outcome arrived after the row was reclaimed', {
        accountId: subject.accountId, messageId: subject.messageId, status,
      })
      return
    }
    this.deps.log.info('mail unsubscribe settled', {
      accountId: subject.accountId,
      messageId: subject.messageId,
      listKey: subject.listKey,
      method: outcome.method,
      status,
      reason: outcome.reason ?? '',
    })
    this.deps.events.unsubscribed({
      accountId: subject.accountId,
      messageId: subject.messageId,
      listKey: subject.listKey,
      method: outcome.method,
      status,
    })
  }
}
