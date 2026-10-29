/**
 * /api/v1/messages + /api/v1/requests — the unified send surface.
 *
 *   POST /messages        { to?, text, title?, expect_reply?, reply_timeout?, in_reply_to?, hands_on?, force?, reason?, messageId? }
 *                         → 202 SessionSendResult (session-send-core.ts)
 *   GET  /requests/:id    → { request, delivery? } — status read for `walnut wait rq-…`;
 *                         `delivery` while the asked message still waits to go in
 *   POST /messages/:id/send-now  (id = qm-… or rq-…) → { sent, messageId, sessionId }:
 *                         send a queued message now (the bubble's Send now, for agents)
 *
 * The caller is stamped from `x-walnut-caller-sid` (provenance, never
 * authorization): a session caller's words are peer-fenced and throttled; the
 * human's own CLI sends plain text. All the semantics live in
 * core/sessions/session-send-core.ts — this file is transport only.
 *
 * Replica: sends need the primary's session-runner + daemons; refuse honestly
 * (same posture as session start) instead of mutating replica-side state.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { isCompanion } from '../../core/server-role.js'
import { sendV1Error as sendError } from './v1-control-relay.js'
import { CALLER_KIND_HEADER, SENDER_LABEL_HEADER, senderLabel } from '../../lib/cli-sender.js'

export const messagesV1Router = Router()

function header(req: Request, name: string): string | undefined {
  const raw = req.headers[name]
  const v = (Array.isArray(raw) ? raw[0] : raw ?? '').trim()
  return v || undefined
}

/** SendError.code → HTTP status is carried by the error itself. */
messagesV1Router.post('/messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (CLOUD_MODE) {
      sendError(res, 501, 'not_supported_cloud', 'Session sends run on the primary box')
      return
    }
    const b = (req.body ?? {}) as Record<string, unknown>
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

    const { performSessionSend, SendError } = await import('../../core/sessions/session-send-core.js')
    try {
      const result = await performSessionSend({
        to: str(b.to),
        text: typeof b.text === 'string' ? b.text : '',
        // Tri-state, NOT `=== true`: omitting the flag must reach the core as
        // `undefined` so it can apply the session-caller default (on).
        expectReply: typeof b.expect_reply === 'boolean' ? b.expect_reply : undefined,
        replyTimeoutSecs: num(b.reply_timeout),
        inReplyTo: str(b.in_reply_to),
        handsOn: str(b.hands_on),
        title: str(b.title),
        force: b.force === true,
        reason: str(b.reason),
        messageId: str(b.messageId),
        // A reply's structured fields (core/peers/structured-reply.ts); absent on a plain send.
        ...(b.result !== undefined || b.evidence !== undefined || b.not_done !== undefined
          ? { reply: { result: b.result, evidence: b.evidence, not_done: b.not_done } } : {}),
        // No session and no person behind it (a script, a LaunchAgent, cron: the CLI's rule,
        // src/lib/cli-sender.ts): an anonymous sender that names itself, never the user.
        ...(!header(req, 'x-walnut-caller-sid') && header(req, CALLER_KIND_HEADER) === 'automation'
          ? { callerSid: 'external', callerLabel: senderLabel(header(req, SENDER_LABEL_HEADER)) }
          : { callerSid: header(req, 'x-walnut-caller-sid') }),
        callerHost: header(req, 'x-walnut-caller-host'),
      })
      // The sender reads what its message waits on the way the bubble does
      // (core/sessions/send-now.ts): the request keeps the row it went out as, and a
      // target whose host did not answer in time says so with its next try.
      const { sessionDeliveryWait } = await import('../../core/sessions/send-now.js')
      if (result.requestId && result.messageId) {
        const { noteRequestMessage } = await import('../../core/session-requests.js')
        await noteRequestMessage(result.requestId, result.messageId).catch(() => {})
      }
      const waiting = result.messageId && result.targetSessionId ? await sessionDeliveryWait(result.targetSessionId) : null
      res.status(202).json(waiting ? { ...result, waiting } : result)
    } catch (err) {
      if (err instanceof SendError) {
        sendError(res, err.statusCode, err.code, err.message, err.detail)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

messagesV1Router.get('/requests/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id ?? '')
    if (!/^rq-[a-f0-9]{6,}$/.test(id)) {
      sendError(res, 400, 'bad_request', 'Invalid request id (rq-…)')
      return
    }
    const { getSessionRequest } = await import('../../core/session-requests.js')
    let request = await getSessionRequest(id)
    // A request this server does not hold itself may be in its copy of the Mac's: the
    // companion answers here only a read the Mac did not (away, or the forward went
    // unanswered). No copy held (the Mac itself): nothing more to look at.
    if (!request) {
      const [{ readRequestCopy }, { assertCopyKept, copyKindAsOf, COPY_AS_OF_HEADER }] = await Promise.all([
        import('../../core/replication/kinds/requests.js'), import('../../core/replication/kinds/gate.js'),
      ])
      request = (await readRequestCopy(id)) ?? undefined
      if (request) res.setHeader(COPY_AS_OF_HEADER, String(await copyKindAsOf('requests') ?? 0))
      // Requests turned off for this replica: a miss is the Mac's to answer, never a 404 here.
      else await assertCopyKept('requests')
    }
    if (!request) {
      sendError(res, 404, 'not_found', `No such request: ${id}`)
      return
    }
    // Still to go in: where the asked message stands in the target's queue.
    let delivery: Awaited<ReturnType<typeof import('../../core/sessions/send-now.js')['deliveryWaitOf']>> = null
    if (!isCompanion() && request.messageId && (request.status === 'pending' || request.status === 'expired')) {
      const { deliveryWaitOf } = await import('../../core/sessions/send-now.js')
      delivery = await deliveryWaitOf(request.messageId).catch(() => null)
    }
    res.json(delivery ? { request, delivery } : { request })
  } catch (err) {
    next(err)
  }
})

/** Send a queued message now: a `qm-…` row, or the row an `rq-…` request went out as. */
messagesV1Router.post('/messages/:id/send-now', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (isCompanion()) {
      sendError(res, 501, 'not_supported_cloud', 'Session sends run on the primary box')
      return
    }
    const id = String(req.params.id ?? '')
    let messageId: string | undefined = id
    if (/^rq-[a-f0-9]{6,}$/.test(id)) {
      const { getSessionRequest } = await import('../../core/session-requests.js')
      const request = await getSessionRequest(id)
      if (!request) { sendError(res, 404, 'not_found', `No such request: ${id}`); return }
      messageId = request.messageId
      if (!messageId) {
        sendError(res, 409, 'not_queued', `${id} has no queued message to send (it was sent by an older Walnut, or started its task): read it with request_get.`)
        return
      }
    } else if (!/^qm-[A-Za-z0-9-]{1,64}$/.test(id)) {
      sendError(res, 400, 'bad_request', 'Pass a request id (rq-…) or a queued message id (qm-…)')
      return
    }
    // A session caller's send now is a peer's nudge (its turn interrupts a wait, as a
    // task_send's does); with no caller it is the person's, the bubble's Send now.
    const callerSid = header(req, 'x-walnut-caller-sid')
    const { sendQueuedNow } = await import('../../core/sessions/send-now.js')
    const out = await sendQueuedNow({ messageId, source: callerSid ? 'peer' : 'web-ui-retry', unpark: !callerSid })
    if (!out.sent) {
      if (out.why === 'parked') {
        sendError(res, 409, 'parked', `That message was set aside${out.reason ? ` (${out.reason})` : ''}, so it is not sent again from here: the user's Retry on it decides.`, { parkedReason: out.reason })
      } else {
        sendError(res, 409, 'not_queued', 'That message is no longer queued: it went in, or was deleted. Nothing was sent again.')
      }
      return
    }
    res.json({ sent: true, messageId, sessionId: out.sessionId })
  } catch (err) {
    next(err)
  }
})
