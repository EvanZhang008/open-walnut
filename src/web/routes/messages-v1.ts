/**
 * /api/v1/messages + /api/v1/requests — the unified send surface.
 *
 *   POST /messages        { to?, text, expect_reply?, reply_timeout?, in_reply_to?, messageId? }
 *                         → 202 SessionSendResult (session-send-core.ts)
 *   GET  /requests/:id    → { request } — status read for `walnut wait rq-…`
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
import { sendV1Error as sendError } from './v1-control-relay.js'

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
        expectReply: b.expect_reply === true,
        replyTimeoutSecs: num(b.reply_timeout),
        inReplyTo: str(b.in_reply_to),
        messageId: str(b.messageId),
        callerSid: header(req, 'x-walnut-caller-sid'),
        callerHost: header(req, 'x-walnut-caller-host'),
      })
      res.status(202).json(result)
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
    const request = await getSessionRequest(id)
    if (!request) {
      sendError(res, 404, 'not_found', `No such request: ${id}`)
      return
    }
    res.json({ request })
  } catch (err) {
    next(err)
  }
})
