/**
 * Leaving a mailing list, programmatically, in the order of how little the human has to do.
 *
 * The ladder, and the reason it is a ladder rather than one action: senders offer three different
 * exits and only one of them is machine-final. So each rung is tried and the first that can say "you
 * are off the list" wins, and when none can the honest answer is `needs-human` with the url — never a
 * green tick over a page nobody read.
 *
 *   1. RFC 8058 one-click. The sender explicitly invited one POST, no confirmation, no human.
 *   2. mailto. A real mail, drafted here and sent through the CONSOLE half of the approval ledger:
 *      the right-click IS the authorisation, so there is no second letter to answer, and the `sends`
 *      row names the click (`approval_kind: 'console'`, `approval_ref: 'unsubscribe:<messageId>'`).
 *   3. https GET. Fetch the page and read it (`unsubscribe-verdict.ts`).
 *   4. The model. NOT a rung here: the server never hands a page to an agent. The console opens the
 *      Ask drawer, or the plugin sends a letter, and a human is in that loop by construction.
 *
 * Rung 4's half of that is `requestFromAgent` + `onLetterAnswered` below, and the property they exist
 * to hold is worth stating on its own: AN AGENT CANNOT LEAVE A LIST. The op behind
 * `requestFromAgent` makes a letter and returns; it opens no socket, writes no mail, and never calls
 * `run`. The only thing that calls `run` is a human — their click in the console, or their answer to
 * that letter, which is recorded on the ledger row as the `ref` that authorised it.
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
 * - THE MAILTO RUNG SENDS UNDER SOMEBODY'S NAME, so it is reachable only from a human's own act. The
 *   console route is one; an answer to the agent's letter is the other, and that one arrives with an
 *   `authority` naming the letter. Nothing an agent calls reaches `consoleSend`, and a test pins it.
 */
import type { ApprovalLetters, LetterAnswer } from './approvals.js'
import {
  MailServiceError,
  reasonOf,
  type ApprovalKind,
  type DraftDto,
  type SendDto,
} from './contract.js'
import type { MailEvents } from './events.js'
import { renderUnsubscribeLetter } from './render.js'
import type { MailService, UnsubscribeSubject } from './service.js'
import type { MailStore } from './store.js'
import { UNSUBSCRIBE_RECLAIM_MS, type UnsubscribeRow } from './store-write.js'
import {
  fetchUnsubscribe,
  UNSUBSCRIBE_DEADLINE_MS,
  type UnsubscribeHttpSeam,
} from './unsubscribe-http.js'
import { parseUnsubscribeMailto } from './unsubscribe-mailto.js'
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
  /**
   * What this attempt is traceable to, written onto the ledger row when it settles.
   *
   * The `sends` row id for the mailto rung, which is the one rung whose work lives in a second
   * ledger: without it, "Walnut says it mailed the list" and "here is the mail it sent" are two
   * facts nothing joins. The letter id for an attempt a letter authorised (see `UnsubscribeAuthority`).
   */
  ref?: string
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

/**
 * Who authorised the run that is about to happen. The ONE thing that decides what a rung may do.
 *
 * Not a formality: the mailto rung puts a real mail on the wire, and a `sends` row has to state who
 * approved it (`approval_kind` / `approval_ref`, the rule written down at the top of `approvals.ts`).
 * There are exactly two answers and they are not interchangeable:
 *
 * - `console` — somebody clicked Unsubscribe in the Mail console. The click at the device IS the
 *   approval, which is what lets that path go straight through `consoleSend` with no second question.
 * - `letter` — somebody answered the agent's letter. The approval is the ANSWER, and the letter id is
 *   the record of it, so a `sends` row claiming a console click would name the wrong authorisation for
 *   a mail leaving their account.
 *
 * A UNION rather than a pair of optional fields, so a `letter` authority cannot exist without its ref
 * and a `console` one cannot smuggle one in. Ask `unsubscribeSendApproval` what to record; do not
 * compare `approvalKind` at more than one place, because two comparisons is how the two drift.
 */
export type UnsubscribeAuthority =
  | { approvalKind: 'console'; ref?: undefined }
  | { approvalKind: 'letter'; ref: string }

/** The default: somebody clicked Unsubscribe in the console, which is the authorisation. */
const CONSOLE_AUTHORITY: UnsubscribeAuthority = { approvalKind: 'console' }

/**
 * The buttons on the agent's letter. Fixed ids: `onLetterAnswered` switches on them.
 *
 * Two, not three. There is no Edit here, because there is nothing to edit: the question is whether to
 * leave a list, and the only two honest answers are yes and not now.
 */
export const UNSUBSCRIBE_LETTER_ACTIONS = [
  { id: 'unsubscribe', label: 'Unsubscribe', description: 'Leave this list now, the best way Walnut can' },
  { id: 'not-now', label: 'Not now', description: 'Change nothing and keep the mail where it is' },
] as const

/** What the op hands back, so its answer can name the letter and what it asked about. */
export interface UnsubscribeAskResult {
  letterId: string
  /** The rung the letter offered, which is the best one this message has. */
  method: UnsubscribeMethod
  /** The page that rung would open, when it has one. */
  url?: string
  /** What the ledger keys this on: the sender's `List-Id`, else its address. */
  listKey: string
}

/**
 * What a `sends` row records as the act that authorised an unsubscribe mail.
 *
 * ONE function, exported, because three places need the identical string and a string built twice is a
 * string that drifts: the mailto rung writes it, the console's `sends` list shows it, and a test
 * asserts on it. The message id rather than the list key on purpose — the human clicked one mail, and
 * that mail is what they would go looking for.
 */
export function unsubscribeApprovalRef(messageId: string): string {
  return `${UNSUBSCRIBE_APPROVAL_PREFIX}${messageId}`
}

export const UNSUBSCRIBE_APPROVAL_PREFIX = 'unsubscribe:'

/**
 * What a mail this run sends must record as its approval — kind AND ref, decided in ONE place.
 *
 * Every rung that can reach `provider.send` asks this and routes on the `kind` it gets back, rather
 * than testing `authority.approvalKind` where the send is written. The difference matters: a test can
 * pin this function's whole truth table in four lines, and a rung that forgets to ask cannot compile a
 * `sends` row at all, whereas a scattered `=== 'console'` is a condition somebody inverts one day and
 * a letter-authorised mail then goes out recorded as a click nobody made.
 */
export function unsubscribeSendApproval(
  authority: UnsubscribeAuthority,
  messageId: string,
): { kind: ApprovalKind; ref: string } {
  return authority.approvalKind === 'console'
    ? { kind: 'console', ref: unsubscribeApprovalRef(messageId) }
    : { kind: 'letter', ref: authority.ref }
}

/**
 * The drafts surface the mailto rung needs. A subset, so a test can hand over a small spy.
 *
 * The rung goes through `MailDrafts` rather than writing a row itself so that the unsubscribe mail is
 * validated, normalised and capped by the same code every other outgoing mail is: one recipient list,
 * no header injection through a display name or a subject, and one place that decides what a draft is.
 */
export interface UnsubscribeDrafts {
  create(input: {
    accountId: string
    to: unknown
    subject: unknown
    bodyMarkdown: unknown
    origin?: unknown
  }): Promise<DraftDto>
}

/**
 * The approval surface the mailto rung needs. A subset, for the same reason.
 *
 * `consoleSend` and nothing else: the rung must not be able to mint an approval any other way, and it
 * must not be able to reach `requestSend` (which would put a SECOND letter in front of a human who has
 * already clicked).
 */
export interface UnsubscribeApprovals {
  consoleSend(
    draftId: string,
    revision: number,
    onMinted?: (send: SendDto) => void,
    approvalRef?: string,
  ): Promise<{ send: SendDto; draft: DraftDto }>
}

export interface MailUnsubscribeDeps {
  store: MailStore
  service: MailService
  events: MailEvents
  /**
   * The host's letters, and the ONLY way this module asks for anything. It is what makes the AI rung
   * an ask rather than an action: see `requestFromAgent`.
   */
  letters: ApprovalLetters
  /** The mailto rung's two collaborators. See `UnsubscribeDrafts` / `UnsubscribeApprovals`. */
  drafts: UnsubscribeDrafts
  approvals: UnsubscribeApprovals
  log: Log
  now?: () => number
  /**
   * Socket and resolver seam, handed straight to `fetchUnsubscribe`. NOT a way past the guard: every
   * url and every redirect is still checked, and every address the resolver answers with is still
   * run through the blocklist.
   *
   * THE WHOLE PAIR, never a half. A seam that replaced only `fetch` would let the guard resolve a
   * hostname through the real DNS while the socket went somewhere else, which is the one shape that
   * turns a test seam into a bypass. `pairedSeam` refuses a half seam at runtime; this type is what
   * makes the same mistake a compile error here, where production code declares it.
   */
  http?: UnsubscribeHttpSeam
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
    /**
     * A SEPARATE parameter from `request`, deliberately: `request` is what an HTTP body maps onto, and
     * nothing a caller can put in a body may claim that a letter authorised this. The route passes
     * three arguments; only `onLetterAnswered` passes the fourth.
     */
    authority: UnsubscribeAuthority = CONSOLE_AUTHORITY,
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
    // EVERY exit from here settles the row this claim just took. Without that, an unexpected throw
    // anywhere in a rung left the row `in-flight` with nothing running, and for the next sixty seconds
    // every click answered "Walnut is already unsubscribing you from this one, give it a moment" — a
    // sentence describing work that had already died. The claim is a lock, so it needs a release on the
    // failure path, not only on the paths its author thought of.
    try {
      for (const rung of rungsFor(method)) {
        const outcome = await this.runRung(rung, subject, deadlineAt, startedAt, authority)
        last = outcome
        if (outcome.status === 'done') break
        trail.push(`${rung}: ${outcome.detail ?? outcome.reason ?? 'no answer'}`)
        // Only a `done` stops the ladder early. The clock stops it too: a rung that used the whole
        // budget leaves nothing for the next one, and starting it anyway would answer `timeout` twice.
        if (this.now >= deadlineAt) break
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      const crashed: UnsubscribeOutcome = {
        status: 'failed',
        method,
        at: this.now,
        reason: 'crashed',
        detail: [...trail, `${method}: ${detail}`].join(' | ').slice(0, 300),
        message: unsubscribeSentence({ status: 'failed', method, reason: 'crashed' }),
      }
      // Recorded as a failure, which is a status a later click may claim over immediately. Then the
      // original error goes on to the caller: a 500 is the honest answer to "Walnut broke", and
      // dressing it up as a normal `failed` outcome would hide a defect behind a retry button.
      await this.settle(subject, startedAt, crashed, authority.ref).catch(() => undefined)
      throw err
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
    await this.settle(subject, startedAt, settled, authority.ref)
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
    /** The claim's own `at`, which is the key the mailto rung's late settle is conditional on. */
    claimedAt: number,
    authority: UnsubscribeAuthority,
  ): Promise<UnsubscribeOutcome> {
    if (rung === 'mailto') return this.mailtoRung(subject, claimedAt, authority)
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
        // Absent when the guard refused the target — the refusal must not publish the url it refused
        // (see UnsubscribeFetchResult). The reason is what the console and the ask both print.
        ...(answered.url ? { url: answered.url } : {}),
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
   * The mailto rung: draft the one mail this list takes, and send it as the person's own click.
   *
   * This is the only rung that puts a message on the wire under somebody's name, so it is worth being
   * explicit about what makes that safe. The mail goes through the ordinary approval ledger — a
   * `drafts` row built by `MailDrafts` (so it is validated and capped like every other outgoing mail)
   * and `consoleSend`, which is the half of that ledger where the human's own click IS the approval.
   * The `sends` row records the click by name rather than as a generic `console`
   * (`approval_ref: 'unsubscribe:<messageId>'`), because "who authorised this" is the first question
   * anybody asks about a mail they did not expect, and "the console" is not an answer when the person
   * never opened a composer. No letter is created: asking twice for something already clicked is how a
   * console teaches people to stop reading letters.
   *
   * ONLY a console authority may send. An answer to the agent's letter is a human too, but a
   * letter-authorised mailto send needs a LETTER-kinded ledger row (its outcome has a thread to report
   * into), and that is a different mint than the one this rung owns. Until that exists the honest
   * answer is `needs-human` naming where the click lives — never a silent nothing, and never a send
   * whose row claims the console approved it. A test fails if this branch is removed.
   *
   * The answer is `in-flight`, not the transport's verdict, and that is a deliberate shape: an SMTP
   * handshake legitimately takes tens of seconds, and this response is holding one of the browser's six
   * connections. So the rung returns as soon as the `sends` row EXISTS, and the continuation below
   * writes the verdict onto the ledger row and announces it (`whenMailtoSendsSettle` is how a test and
   * a shutdown wait for that). A refusal BEFORE the row exists is not in flight at all: it comes back
   * as this attempt's outcome and settles through the ladder's ordinary path.
   */
  private async mailtoRung(
    subject: UnsubscribeSubject,
    claimedAt: number,
    authority: UnsubscribeAuthority,
  ): Promise<UnsubscribeOutcome> {
    const target = subject.held?.mailto?.[0]
    if (!target) {
      return this.outcome('mailto', {
        status: 'failed',
        reason: 'unsupported',
        detail: 'this message carries no unsubscribe address',
      })
    }
    // ONE place decides what a mail this run sends records as its approval, and this rung routes on the
    // `kind` it gets back rather than on the authority itself (see `unsubscribeSendApproval`). Only
    // `console` has a mint here: `consoleSend` writes `approval_kind: 'console'` by construction, so
    // reaching it with a letter's authority would file somebody's answer as a click they never made.
    // A LETTER-kinded mailto send needs its own mint (its outcome has a thread to report into) and that
    // is not this rung's to write, so the honest answer names where the click lives.
    const approval = unsubscribeSendApproval(authority, subject.messageId)
    if (approval.kind !== 'console') {
      return this.outcome('mailto', {
        status: 'needs-human',
        reason: 'mailto-console-only',
        detail: `this list unsubscribes by mail to ${target.slice(0, 200)}`,
      })
    }
    const parsed = parseUnsubscribeMailto(target)
    if (!parsed.ok) {
      return this.outcome('mailto', { status: 'failed', reason: parsed.reason, detail: parsed.detail })
    }

    // Asked BEFORE the draft, so a mailto-only list on an account with no SMTP costs nothing and
    // leaves nothing behind. `drafts.assertSendable` would refuse it a moment later anyway, but as a
    // thrown 409 inside `consoleSend` — after a draft row the human never asked for was written.
    let canSend = false
    try {
      canSend = (await this.deps.service.capabilitiesFor(subject.accountId)).send
    } catch (error) {
      return this.outcome('mailto', {
        status: 'failed',
        reason: 'unreachable',
        detail: `the account could not say whether it can send: ${reasonOf(error).slice(0, 200)}`,
      })
    }
    if (!canSend) {
      return this.outcome('mailto', {
        status: 'failed',
        reason: 'cannot-send',
        detail: `the account "${subject.accountId}" has no outgoing mail configured`,
      })
    }

    let draft: DraftDto
    try {
      draft = await this.deps.drafts.create({
        accountId: subject.accountId,
        to: [{ address: parsed.mail.to }],
        subject: parsed.mail.subject,
        bodyMarkdown: parsed.mail.body,
        // `console`, not `agent`: nothing in this mail came from a model. `origin` is what the console
        // shows next to a draft, and calling this one an agent's would be a lie about who wrote it.
        origin: 'console',
      })
    } catch (error) {
      return this.outcome('mailto', {
        status: 'failed',
        reason: 'mailto-unusable',
        detail: `Walnut could not build the unsubscribe mail: ${reasonOf(error).slice(0, 200)}`,
      })
    }

    let mintedSend: SendDto | undefined
    let reachedMint: () => void = () => {}
    const minted = new Promise<void>((resolve) => { reachedMint = resolve })
    // Folded into an outcome IMMEDIATELY, for two reasons: a rejection nobody is attached to becomes
    // an unhandled rejection the moment this method answers `in-flight`, and the continuation below
    // wants one shape to write down whichever way the transport went.
    const work: Promise<UnsubscribeOutcome> = this.deps.approvals
      .consoleSend(
        draft.draftId,
        draft.revision,
        (send) => { mintedSend = send; reachedMint() },
        approval.ref,
      )
      .then(
        (answered) => this.sendOutcome(answered.send),
        (error) => this.outcome('mailto', {
          status: 'failed',
          reason: 'send-refused',
          detail: reasonOf(error).slice(0, 300),
        }),
      )

    await Promise.race([minted, work])
    if (!mintedSend) {
      // No `sends` row was ever written, so no mail is on its way and this attempt is finished. It
      // settles through the ladder's own path, and nothing runs in the background.
      return work
    }
    const sendId = mintedSend.sendId
    // `authority.ref ?? sendId` at the CALL SITE, not inside `settle`: a letter id is what a later answer
    // finds this row by, so it has to win, and the send id is the trace link that is worth having when
    // there is no letter. Deciding it here keeps `settle` one statement with one meaning.
    this.trackMailtoSend(work.then((outcome) => this.settle(
      subject,
      claimedAt,
      outcome,
      authority.ref ?? sendId,
    )))
    this.deps.log.info('mail is sending an unsubscribe mail', {
      accountId: subject.accountId,
      messageId: subject.messageId,
      listKey: subject.listKey,
      draftId: draft.draftId,
      sendId,
      approvalRef: approval.ref,
    })
    return this.outcome('mailto', {
      status: 'in-flight',
      detail: `an unsubscribe mail to ${parsed.mail.to}`,
      ref: sendId,
    })
  }

  /**
   * What a `sends` row's final state means for the unsubscribe ledger.
   *
   * `unknown` becomes `needs-human` rather than `failed`, which is the same call `sends.ts` makes and
   * for the same reason: the mail may already be in the list's mailbox, so "it failed" sends the person
   * to do it again and "it worked" is a guess. The one honest answer points at the Sent folder.
   */
  private sendOutcome(send: SendDto): UnsubscribeOutcome {
    if (send.state === 'sent') {
      return this.outcome('mailto', { status: 'done', ref: send.sendId })
    }
    if (send.state === 'failed') {
      return this.outcome('mailto', {
        status: 'failed',
        reason: 'send-failed',
        detail: send.error ?? 'the transport refused the unsubscribe mail',
        ref: send.sendId,
      })
    }
    if (send.state === 'unknown') {
      return this.outcome('mailto', {
        status: 'needs-human',
        reason: 'send-unknown',
        detail: send.error ?? 'the transport never reported an outcome',
        ref: send.sendId,
      })
    }
    // `approved` or `sending`: this call did not own the attempt (`claimSendAttempt` refused it), so
    // whoever does owns the verdict too, and the row is left exactly as the claim made it.
    return this.outcome('mailto', {
      status: 'in-flight',
      detail: `the unsubscribe mail is ${send.state}`,
      ref: send.sendId,
    })
  }

  /**
   * Unsubscribe mails this process is still waiting on.
   *
   * Bounded twice over: by human clicks, and by the claim before that (one attempt in flight per
   * message). Two callers want it — a test that has to know the ledger was written before it reads it,
   * and anything that would rather not tear the database down in the middle of a settle.
   */
  private readonly sending = new Set<Promise<void>>()

  private trackMailtoSend(work: Promise<void>): void {
    const settled: Promise<void> = work.catch((error: unknown) => {
      this.deps.log.warn('mail could not finish recording an unsubscribe mail', {
        error: reasonOf(error).slice(0, 200),
      })
    })
    this.sending.add(settled)
    void settled.then(() => { this.sending.delete(settled) })
  }

  /**
   * Resolve once every unsubscribe mail this process started has settled its ledger row.
   *
   * The loop, rather than one `Promise.all`: a promise removes itself from the set in a `then` that
   * runs AFTER the `all` above it resolves, so one pass can leave the set non-empty while holding
   * nothing unfinished. Bounded so a bug here cannot become a hang.
   */
  async whenMailtoSendsSettle(): Promise<void> {
    for (let pass = 0; pass < 100 && this.sending.size > 0; pass += 1) {
      await Promise.all([...this.sending])
    }
  }

  private outcome(
    method: UnsubscribeMethod,
    fields: {
      status: UnsubscribeLedgerStatus
      reason?: string
      detail?: string
      url?: string
      ref?: string
    },
  ): UnsubscribeOutcome {
    return {
      status: fields.status,
      method,
      at: this.now,
      ...(fields.reason ? { reason: fields.reason } : {}),
      ...(fields.detail ? { detail: fields.detail } : {}),
      ...(fields.url ? { url: fields.url } : {}),
      ...(fields.ref ? { ref: fields.ref } : {}),
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
    /** What authorised this attempt, when it was not a console click: the letter id. */
    ref?: string,
  ): Promise<void> {
    // `in-flight` is the CLAIM, and the claim is already on the row carrying this attempt's `at`.
    // Writing it again would move `at`, which is the key every later settle is conditional on: the
    // mailto rung's own continuation would then be refused by its own guard and the row would sit in
    // flight for good. It is also not a verdict, so there is nothing to announce.
    if (outcome.status === 'in-flight') return
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
      ...(ref ? { ref } : {}),
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

  // ── rung 4: the agent asks, and only the human's answer acts ──

  /**
   * ASK the human to leave a list. The whole of what an agent can do about unsubscribing.
   *
   * It sends one letter and returns. Read the body of this method for the property: there is no
   * `fetchUnsubscribe`, no draft, no `consoleSend`, no call to `run`. An agent that has been told
   * "unsubscribe me from this" gets to put the question in front of the person, with what Walnut found
   * and what it would do, and that is the end of its reach.
   *
   * Two states are refused rather than asked about, because a letter is expensive (it badges a bell and
   * pushes to a phone) and a pointless one is worse than none:
   *
   * - a message with no way out at all. `chooseRung` throws the same `unsupported` the console's click
   *   gets, in the same words, so the agent can repeat it to the user.
   * - a message this plugin has ALREADY asked about and is still waiting on. The row's `ref` names
   *   that letter and the letter itself says whether it was answered, so a second ask is refused with
   *   the first letter's id rather than doubling the question.
   *
   * The claim comes BEFORE the letter. A crash between the two leaves an `in-flight` row that reclaims
   * itself in a minute and no letter at all; the other order would leave a live letter whose answer
   * belongs to nobody, which is exactly the "SUPERSEDED" confusion this slice exists to remove.
   */
  async requestFromAgent(accountId: string, messageId: string): Promise<UnsubscribeAskResult> {
    const subject = await this.deps.service.unsubscribeSubject(accountId, messageId)
    const method = this.chooseRung(subject, undefined)
    const held = await this.ledgerFor(subject.accountId, subject.messageId)
    if (held?.status === 'needs-human' && held.ref && await this.letterIsOpen(held.ref)) {
      throw new MailServiceError(
        'stale',
        `Walnut has already asked the user about this message and is still waiting for their answer`
        + ` (letter ${held.ref}). Leave it with them rather than asking twice.`,
        409,
      )
    }

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
      const now = await this.ledgerFor(subject.accountId, subject.messageId)
      throw new MailServiceError(
        'stale',
        now?.status === 'done'
          ? this.alreadySentence(now, subject)
          : 'An unsubscribe for this message is already under way, so nothing was asked.',
        409,
      )
    }

    const url = method === 'mailto' ? undefined : this.urlFor(subject)
    // From the MIRROR ROW, the same rule `message-tasks.ts` follows: a letter's account label has no
    // business reaching a mail server for a name that is in a column.
    const account = await this.deps.store.getAccount(subject.accountId).catch(() => undefined)
    let letterId = ''
    try {
      const letter = renderUnsubscribeLetter({
        accountLabel: account?.display_name || account?.address || subject.accountId,
        sender: { address: subject.fromAddr },
        subject: subject.subject,
        listName: subject.listKey,
        byListId: !!subject.held?.listId,
        method: method === 'manual' ? 'link' : method,
        ...(url ? { url } : {}),
        // A header link is the sender saying how to leave; a body link is all Walnut could find,
        // which is every message on an account whose provider gives up no headers at all.
        ...(url ? { urlSource: subject.held?.https?.length ? 'header' as const : 'body' as const } : {}),
        ...(subject.held?.mailto?.[0] ? { mailto: subject.held.mailto[0] } : {}),
      })
      const sent = await this.deps.letters.send({
        subject: letter.subject,
        markdown: letter.markdown,
        actions: UNSUBSCRIBE_LETTER_ACTIONS.map((one) => ({ ...one })),
      })
      letterId = sent.letterId
    } catch (error) {
      // The claim has to be given back, or the ledger holds an `in-flight` row for a question nobody
      // was ever asked and the console shows "Unsubscribing…" for a minute.
      await this.settle(subject, startedAt, this.outcome(method, {
        status: 'failed',
        reason: 'ask-failed',
        detail: String(error).slice(0, 200),
      }))
      throw error
    }

    // `needs-human` is the literal truth of this row: nothing was attempted, and a human has to decide.
    // It is also a status a later click may replace outright (see `claimUnsubscribe`), so asking never
    // blocks the console, and it is not `pending` in the DTO, so the row menu does not claim an attempt
    // is on the wire. NOT announced on the bus: nothing happened to the message, and the letter is the
    // announcement.
    await this.deps.store.write.settleUnsubscribe({
      accountId: subject.accountId,
      messageId: subject.messageId,
      claimedAt: startedAt,
      status: 'needs-human',
      method,
      reason: 'asked',
      detail: `waiting on letter ${letterId}`,
      ref: letterId,
      now: this.now,
    })
    this.deps.log.info('mail asked the human before unsubscribing', {
      accountId: subject.accountId, messageId: subject.messageId,
      listKey: subject.listKey, method, letterId,
    })
    return { letterId, method, ...(url ? { url } : {}), listKey: subject.listKey }
  }

  /**
   * A letter answer that belongs to THIS ledger. `false` means "not mine", and the caller hands it on.
   *
   * The router in index.ts asks this first and falls through to the approval ledger, because the two
   * ledgers issue different letters and only their own rows can say which is which. Ordering it the
   * other way round would be the bug it replaced: the approval path treats an answer it cannot find a
   * draft for as superseded and replies so, which for an unsubscribe letter is a confident wrong answer.
   *
   * It never throws. It runs on a bus subscription, so the only place a failure could be reported is
   * the log and the letter's own thread, and both are used.
   */
  async onLetterAnswered(answer: LetterAnswer): Promise<boolean> {
    const row = await this.deps.store.write.unsubscribeByRef(answer.letterId).catch(() => undefined)
    if (!row) return false
    // Our own withdrawal comes back through the same event. Acting on it would mean cancelling a
    // question and then answering it.
    if (answer.actionId === 'withdrawn') {
      this.deps.log.info('mail unsubscribe letter withdrawn, nothing done', {
        letterId: answer.letterId, messageId: row.message_id,
      })
      return true
    }
    if (answer.actionId !== 'unsubscribe') {
      if (answer.actionId !== 'not-now') {
        this.deps.log.warn('mail unsubscribe letter answered with an action it does not offer', {
          letterId: answer.letterId, actionId: answer.actionId,
        })
      }
      await this.reply(answer.letterId, 'Nothing was done: you are still on this list, and the mail is'
        + ' where it was. Ask again from the Mail console whenever you want to leave it.')
      return true
    }
    try {
      const outcome = await this.run(row.account_id, row.message_id, {}, {
        approvalKind: 'letter',
        ref: answer.letterId,
      })
      await this.reply(
        answer.letterId,
        outcome.url && outcome.status !== 'done'
          ? `${outcome.message}\n\nThe page is:\n\n\`\`\`\n${outcome.url.replace(/[`\r\n]/g, '')}\n\`\`\``
          : outcome.message,
      )
    } catch (error) {
      const said = error instanceof MailServiceError
        ? error.message
        : `Walnut could not carry that out: ${String(error).slice(0, 300)}`
      this.deps.log.warn('mail could not act on an answered unsubscribe letter', {
        letterId: answer.letterId, messageId: row.message_id, error: String(error).slice(0, 200),
      })
      await this.reply(answer.letterId, `${said} Nothing was changed.`)
    }
    return true
  }

  /** Is that letter still waiting for an answer? An unknown or unreadable letter is NOT waiting. */
  private async letterIsOpen(letterId: string): Promise<boolean> {
    const letter = await this.deps.letters.get(letterId).catch(() => null)
    return !!letter && !letter.answered
  }

  private async reply(letterId: string, markdown: string): Promise<void> {
    try { await this.deps.letters.reply(letterId, { markdown, text: markdown }) }
    catch (error) {
      this.deps.log.warn('mail unsubscribe letter could not be replied to', {
        letterId, error: String(error).slice(0, 200),
      })
    }
  }
}
