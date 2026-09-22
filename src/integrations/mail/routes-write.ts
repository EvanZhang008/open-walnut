/**
 * The write path: drafts, the approval ledger, the two ways a human says yes, and leaving a list.
 *
 * Split from routes.ts because these routes are one subject and the read routes are another. The
 * shape that matters in most of them is `revision`: a client sends the revision it was looking at,
 * and a mismatch is a 409 rather than a send of something the human never read.
 *
 * Two contracts that apply to this file and not to the read side:
 *
 * - REGISTRATION ORDER is load bearing. A route is mounted with `router.use(path, handler)`, so
 *   `/drafts/:draftId` would swallow `/drafts/:draftId/send` if it went in first.
 * - EVERY route here has a response budget, and none of them can lose work by hitting it. An
 *   approval letter, a ledger row and an SMTP attempt all outlive the request that started them
 *   and report themselves through `draft-changed` / `send-settled`; the budget only decides how
 *   long the browser waits, because a write that pins one of six connections for 30s makes the
 *   whole app look broken.
 */
import type { WalnutServerPluginApi } from '../../core/plugins/server-api.js'
import type { MailApprovals } from './approvals.js'
import {
  errorReply,
  firstQuery,
  intQuery,
  PRIMARY_ONLY,
  readBody,
  segmentsAfter,
  withBudget,
  type SendDto,
} from './contract.js'
import { replyHeaders } from './drafts.js'
import type { MailDrafts } from './drafts.js'
import type { MailSends } from './sends.js'
import type { MailService } from './service.js'
import { isRequestableUnsubscribeMethod, type MailUnsubscribe } from './unsubscribe.js'

/**
 * How long a write waits for the letter store, the database and the provider before it answers
 * with what it knows. One number for all of them, so the console can treat them alike.
 */
const WRITE_DEADLINE_MS = 10_000

/**
 * How long a console Send waits for the transport before it answers with what it knows.
 *
 * The ATTEMPT keeps the full 30s send deadline and settles its own row whatever happens here;
 * this only bounds the RESPONSE. A route that waited out a slow SMTP handshake would hold one of
 * the browser's six connections for half a minute, and the console learns the outcome from the
 * `send-settled` event or from `GET /sends` either way.
 */
const CONSOLE_SEND_DEADLINE_MS = 10_000

const DRAFT_LIST_LIMIT = 200
const DEFAULT_PAGE = 50

/**
 * What `GET /drafts` means when nobody says otherwise: the drafts that are still open.
 *
 * `sent` and `discarded` are terminal and they accumulate forever, so an unfiltered list is
 * eventually almost entirely history. The console has always dropped them on arrival, which made
 * the default wrong for every OTHER caller: an agent asking what is in flight was handed a hundred
 * mails that already went. An explicit `state=` still selects any single state, terminal ones
 * included, because "show me what I sent" is a real question.
 *
 * Six states means six queries rather than one filtered read, because filtering a newest-200 page
 * has a real hole: a page full of terminal rows hides every open draft older than it. With an
 * `account` they use `drafts_by_account_state`; without one (the console's own call) they use
 * `drafts_by_state_updated`, added in migration v6 for exactly this.
 */
const OPEN_DRAFT_STATES = [
  'composing', 'pending_approval', 'approved', 'sending', 'failed', 'unknown',
] as const

/** The one degraded answer shape every write here uses when its budget runs out. */
function slowReply(message: string, draft?: unknown) {
  return {
    status: 202,
    json: {
      ok: true,
      completed: false,
      message: `${message} Walnut is still working on it; the console updates itself when it lands.`,
      ...(draft ? { draft } : {}),
    },
  }
}

/** `withBudget` plus the one thing a route must never forget: handling the late loser. */
function bounded<T>(
  walnut: WalnutServerPluginApi,
  work: Promise<T>,
  what: string,
  ms = WRITE_DEADLINE_MS,
): Promise<T | undefined> {
  return withBudget(work, ms, (outcome) => {
    if (outcome.error) {
      walnut.log.warn(`mail ${what} failed after the response was already sent`, {
        error: String(outcome.error).slice(0, 300),
      })
      return
    }
    walnut.log.info(`mail ${what} finished after the response was already sent`, {})
  })
}

export function registerMailWriteRoutes(
  walnut: WalnutServerPluginApi,
  deps: {
    service: MailService
    drafts: MailDrafts
    approvals: MailApprovals
    sends: MailSends
    unsubscribe: MailUnsubscribe
  },
): void {
  const { service, drafts, approvals, sends, unsubscribe } = deps
  const primaryOnly = (): boolean => walnut.replica

  /**
   * POST /messages/:accountId/:messageId/unsubscribe  { method?, confirm? }
   *
   * Here rather than in routes.ts because it makes NETWORK EGRESS and (from S8) can send mail, which
   * is what this file is for. Registered after the read routes, which is safe and is also why it can
   * live here at all: the `/messages/:a/:m` mount only matches its own root, and `/read` and `/task`
   * are literal fourth segments that `unsubscribe` is not.
   *
   * Answers:
   *   200 { ok: true,  status: 'done',        method, at, message }
   *   200 { ok: true,  status: 'needs-human', method, reason, url?, message }
   *   200 { ok: false, status: 'failed',      method, reason, detail?, message }
   *   202 { ok: true,  status: 'in-flight',   method, completed: false, message }
   *   409 { error: 'in-flight' | 'already', unsubscribe: {...} }
   *   409 { error: 'unsupported', message }      — nothing to open; the sentence is printable
   *   400 { error: 'invalid', message }
   *   503 { error: 'primary_only' | 'db_unavailable' }
   *
   * A `failed` outcome is a 200 with `ok: false` on purpose. It is not a fault of this server or of
   * the request: the sender's own endpoint refused, or the guard would not open their link. The
   * console has a sentence to print either way, and a client that had to catch an HTTP error to read
   * it would show "something went wrong" instead of what actually happened.
   */
  walnut.http.route('post', '/messages/:accountId/:messageId/unsubscribe', async (request) => {
    if (primaryOnly()) return PRIMARY_ONLY
    const [accountId, messageId] = segmentsAfter(request, '/messages/')
    if (!accountId || !messageId) {
      return { status: 400, json: { error: 'invalid', message: 'an account id and a message id are required' } }
    }
    const body = await readBody(request)
    // A body that did not parse is not consent to leave a list. Same rule the read-flag route learned.
    if (body === null) return { status: 400, json: { error: 'invalid', message: 'body must be JSON' } }
    if (body.method !== undefined && !isRequestableUnsubscribeMethod(body.method)) {
      return {
        status: 400,
        json: { error: 'invalid', message: 'method must be one-click, mailto or link when it is given' },
      }
    }
    try {
      // Bounded like every other write here. The LADDER carries its own 10s deadline shared across
      // every rung and hop, so a late winner still writes its verdict into the ledger and still
      // announces it; this budget only decides how long the browser waits.
      const answered = await bounded(
        walnut,
        unsubscribe.run(accountId, messageId, {
          ...(body.method !== undefined ? { method: String(body.method) } : {}),
          ...(body.confirm === true ? { confirm: true } : {}),
        }),
        'unsubscribe',
      )
      if (!answered) {
        return {
          status: 202,
          json: {
            ok: true,
            completed: false,
            status: 'in-flight',
            message: 'Walnut is still unsubscribing you; the console updates itself when it lands.',
          },
        }
      }
      if (answered.status === 'conflict') {
        return {
          status: 409,
          json: {
            error: answered.conflict ?? 'in-flight',
            message: answered.message,
            ...(answered.ledger ? { unsubscribe: answered.ledger } : {}),
          },
        }
      }
      if (answered.status === 'in-flight') {
        return { status: 202, json: { ok: true, completed: false, ...answered } }
      }
      return { json: { ok: answered.status !== 'failed', ...answered } }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })

  walnut.http.route('post', '/drafts/:draftId/request-send', async (request) => {
    if (primaryOnly()) return PRIMARY_ONLY
    const [draftId] = segmentsAfter(request, '/drafts/')
    const body = await readBody(request)
    if (!draftId || !body) return { status: 400, json: { error: 'invalid', message: 'a draft id and a JSON body are required' } }
    try {
      // Bounded like every other write here: this path asks the provider whether the account can
      // send (15s of its own) and then writes a letter under the human inbox's lock, so unbounded
      // it can hold a browser connection for half a minute.
      const asked = await bounded(walnut, approvals.requestSend(draftId, Number(body.revision)), 'request-send')
      if (!asked) return slowReply('The approval letter is still being prepared.', await drafts.get(draftId))
      return { json: asked }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })

  walnut.http.route('post', '/drafts/:draftId/send', async (request) => {
    if (primaryOnly()) return PRIMARY_ONLY
    const [draftId] = segmentsAfter(request, '/drafts/')
    const body = await readBody(request)
    if (!draftId || !body) return { status: 400, json: { error: 'invalid', message: 'a draft id and a JSON body are required' } }
    try {
      // The row this request minted, reported as soon as it exists. Re-querying `GET /sends` for
      // the newest row instead would be a guess: two console sends a second apart share a
      // `created_at`, and the tie-break would hand the caller somebody else's send id.
      let minted: SendDto | undefined
      const answered = await bounded(
        walnut,
        approvals.consoleSend(draftId, Number(body.revision), (send) => { minted = send }),
        'console send',
        CONSOLE_SEND_DEADLINE_MS,
      )
      if (answered) return { json: answered }
      // The attempt is still running under its own deadline and will settle its own row. 202 says
      // exactly that, and the ledger row is handed over so the console can watch the right id.
      return {
        status: 202,
        json: {
          ok: true,
          completed: false,
          ...(minted ? { send: minted } : {}),
          draft: await drafts.get(draftId),
        },
      }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })

  walnut.http.route('post', '/sends/:sendId/retry', async (request) => {
    if (primaryOnly()) return PRIMARY_ONLY
    const [sendId] = segmentsAfter(request, '/sends/')
    if (!sendId) return { status: 400, json: { error: 'invalid', message: 'a send id is required' } }
    try {
      // A retry is a whole fresh approval round: the revision moves, so the ledger key moves, and
      // the human is asked again. It never re-attempts the send row it was given.
      const again = await bounded(walnut, approvals.retry(sendId), 'retry')
      if (!again) return slowReply('The fresh approval letter is still being prepared.')
      return { json: again }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })

  walnut.http.route('get', '/drafts/:draftId', async (request) => {
    if (primaryOnly()) return PRIMARY_ONLY
    const [draftId] = segmentsAfter(request, '/drafts/')
    if (!draftId) return { status: 400, json: { error: 'invalid', message: 'a draft id is required' } }
    try {
      return {
        json: {
          draft: await drafts.get(draftId),
          sends: await sends.list({ draftId, limit: DRAFT_LIST_LIMIT }),
        },
      }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })

  walnut.http.route('patch', '/drafts/:draftId', async (request) => {
    if (primaryOnly()) return PRIMARY_ONLY
    const [draftId] = segmentsAfter(request, '/drafts/')
    const body = await readBody(request)
    if (!draftId || !body) return { status: 400, json: { error: 'invalid', message: 'a draft id and a JSON body are required' } }
    try {
      const patched = await drafts.patch(draftId, body)
      if (!patched.wasPendingApproval) return { json: { draft: patched.draft } }
      // From here the request does letter work, so it gets the same budget as request-send: the
      // EDIT itself is already committed above and is never lost by a slow reply.
      // The outstanding letter described text that no longer exists, so it is withdrawn and a
      // fresh one is issued for the new revision. Leaving the old letter live would leave a Send
      // button pointing at a revision the ledger can no longer approve, which reads to the human
      // as "I tapped Send and nothing happened".
      await approvals.withdrawFor(
        patched.previousLetterId,
        'This draft was edited; a fresh letter follows.',
      )
      const again = await bounded(
        walnut,
        approvals.requestSend(draftId, patched.draft.revision),
        'request-send after an edit',
      )
      if (!again) return slowReply('The fresh approval letter is still being prepared.', patched.draft)
      return { json: { draft: again.draft, letterId: again.letterId } }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })

  walnut.http.route('delete', '/drafts/:draftId', async (request) => {
    if (primaryOnly()) return PRIMARY_ONLY
    const [draftId] = segmentsAfter(request, '/drafts/')
    if (!draftId) return { status: 400, json: { error: 'invalid', message: 'a draft id is required' } }
    try {
      const discarded = await drafts.discard(draftId)
      await approvals.withdrawFor(
        discarded.previousLetterId,
        'This draft was discarded in the Mail console; nothing was sent.',
      )
      return { json: { ok: true, draft: discarded.draft } }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })

  walnut.http.route('get', '/drafts', async (request) => {
    if (primaryOnly()) return PRIMARY_ONLY
    const account = firstQuery(request.query.account)
    const state = firstQuery(request.query.state)
    const limit = intQuery(request.query.limit, DRAFT_LIST_LIMIT, DRAFT_LIST_LIMIT)
    const common = { ...(account ? { accountId: account } : {}), limit }
    try {
      if (state) return { json: { drafts: await drafts.list({ ...common, state }) } }
      // One indexed query per open state, in parallel, rather than one unfiltered read that is
      // filtered afterwards. The filtered-afterwards shape has a hole this does not: a mailbox with
      // two hundred sent drafts fills the newest-first page with terminal rows, so an open draft
      // older than any of them is simply missing from the answer.
      const pages = await Promise.all(
        OPEN_DRAFT_STATES.map((one) => drafts.list({ ...common, state: one })),
      )
      const merged = pages.flat().sort(
        (left, right) => right.updatedAt - left.updatedAt || right.draftId.localeCompare(left.draftId),
      )
      return { json: { drafts: merged.slice(0, limit) } }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })

  walnut.http.route('post', '/drafts', async (request) => {
    if (primaryOnly()) return PRIMARY_ONLY
    const body = await readBody(request)
    if (!body) return { status: 400, json: { error: 'invalid', message: 'body must be JSON' } }
    const accountId = typeof body.accountId === 'string' ? body.accountId : ''
    if (!accountId) return { status: 400, json: { error: 'invalid', message: 'accountId is required' } }
    const target = body.inReplyTo as { accountId?: unknown; messageId?: unknown } | undefined
    try {
      // A reply's threading headers and its subject come from the CACHED message, never from the
      // request: a caller cannot aim a reply into a thread it never read, and `Re:` is added once
      // however many the original already carried.
      const cached = target?.messageId
        ? await service.replyTarget(
          typeof target.accountId === 'string' ? target.accountId : accountId,
          String(target.messageId),
        )
        : undefined
      // `replyHeaders` is what appends the answered message's OWN id to the chain, which is the
      // half of `References` a reader uses to place the reply under the message it answers.
      const reply = cached
        ? { ...replyHeaders(cached), subject: cached.subject }
        : undefined
      const draft = await drafts.create({
        accountId,
        to: body.to,
        cc: body.cc,
        bcc: body.bcc,
        subject: body.subject,
        bodyMarkdown: body.bodyMarkdown,
        origin: body.origin,
        sessionId: body.sessionId,
        ...(reply ? { reply } : {}),
      })
      return { status: 201, json: { draft } }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })

  walnut.http.route('get', '/sends', async (request) => {
    if (primaryOnly()) return PRIMARY_ONLY
    try {
      return {
        json: {
          sends: await sends.list({
            ...(firstQuery(request.query.account) ? { accountId: firstQuery(request.query.account)! } : {}),
            ...(firstQuery(request.query.draft) ? { draftId: firstQuery(request.query.draft)! } : {}),
            limit: intQuery(request.query.limit, DEFAULT_PAGE, DRAFT_LIST_LIMIT),
          }),
        },
      }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })

}
