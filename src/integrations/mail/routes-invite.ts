/**
 * GET / POST /messages/:accountId/:messageId/invite: a meeting invite's place on the calendar, and
 * the person's answer to it.
 *
 * Both routes reach the provider (a calendar read, an RSVP write), so both are refused on a replica
 * and both answer inside a budget. The provider call keeps running past the budget and settles on
 * its own, so a 202 never loses an answer: the reader asks GET again a moment later and sees it.
 */
import type { WalnutServerPluginApi } from '../../core/plugins/server-api.js'
import { errorReply, PRIMARY_ONLY, readBody, segmentsAfter, withBudget } from './contract.js'
import type { MailInvites } from './invites.js'

/** How long the browser waits for a calendar read before it is told to ask again. */
const READ_BUDGET_MS = 12_000
/** How long it waits for an answer to be sent. */
const ANSWER_BUDGET_MS = 15_000

function late(walnut: WalnutServerPluginApi, what: string) {
  return (outcome: { error?: unknown }) => {
    if (outcome.error) {
      walnut.log.warn(`mail ${what} failed after the response was already sent`, {
        error: String(outcome.error).slice(0, 300),
      })
      return
    }
    walnut.log.info(`mail ${what} finished after the response was already sent`, {})
  }
}

export function registerMailInviteRoutes(
  walnut: WalnutServerPluginApi,
  deps: { invites: MailInvites },
): void {
  const { invites } = deps

  walnut.http.route('get', '/messages/:accountId/:messageId/invite', async (request) => {
    if (walnut.replica) return PRIMARY_ONLY
    const [accountId, messageId] = segmentsAfter(request, '/messages/')
    if (!accountId || !messageId) {
      return { status: 400, json: { error: 'invalid', message: 'an account id and a message id are required' } }
    }
    try {
      const details = await withBudget(invites.details(accountId, messageId), READ_BUDGET_MS, late(walnut, 'invite read'))
      if (!details) {
        return {
          status: 202,
          json: { pending: true, message: 'Walnut is still checking your calendar.' },
        }
      }
      return { json: { invite: details } }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })

  /**
   * POST { response: 'accept' | 'tentative' | 'decline' }
   *
   *   200 { ok: true, invite }              the answer was sent; `invite` is the calendar after it
   *   202 { ok: true, completed: false }    still sending; GET shows the outcome
   *   409 { error: 'in-flight' | 'not-an-invite' | 'unsupported', message }
   *   400 { error: 'invalid', message }
   */
  walnut.http.route('post', '/messages/:accountId/:messageId/invite', async (request) => {
    if (walnut.replica) return PRIMARY_ONLY
    const [accountId, messageId] = segmentsAfter(request, '/messages/')
    if (!accountId || !messageId) {
      return { status: 400, json: { error: 'invalid', message: 'an account id and a message id are required' } }
    }
    const body = await readBody(request)
    // A body that did not parse is not an answer to anybody's meeting.
    if (body === null) return { status: 400, json: { error: 'invalid', message: 'body must be JSON' } }
    try {
      const answered = await withBudget(
        invites.respond(accountId, messageId, body.response),
        ANSWER_BUDGET_MS,
        late(walnut, 'invite answer'),
      )
      if (!answered) {
        return {
          status: 202,
          json: { ok: true, completed: false, message: 'Walnut is still sending your answer.' },
        }
      }
      return { json: { ok: true, invite: answered } }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })
}
