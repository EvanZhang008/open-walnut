/**
 * A request whose host link failed is answered as the host's trouble, never a 500.
 *
 * A daemon command that got no answer in time, or whose connection closed before
 * the host answered, says nothing about the route that sent it: the host is busy,
 * swapping its daemon, or behind a tunnel that is reconnecting. 2026-11-03: every
 * open session panel polls `GET /api/sessions/:id/supervision`, a clouddev daemon
 * swap and two tunnel drops timed its 5 s `cron.supervision` out, and each one
 * reached the error handler as a 500, which the request logger turns into a red
 * "This API endpoint is failing" card (217 of them in a day).
 *
 * The answer (both dependency statuses in request-logger.ts, so never a card):
 *  - 503 `host_reconnecting` for a read, and for a command that never reached the
 *    host (`no-link`): nothing happened, try again;
 *  - 504 `host_no_answer` for a write whose command went out (`lost`, `no-answer`):
 *    it may have run there, so a client must not take it for "not sent" (the phone
 *    reads a 503 as not arrived, `LetterReplyFailure.swift`).
 * `detail` keeps the link's own words (a refused sign-in, a failed deploy), which a
 * lasting failure needs; the message stays plain.
 *
 * The app error handler answers it; every v1 router funnel hands such an error on
 * to it (`handsToAppErrorHandler`), as it does a needs-leader refusal, and a route
 * wrapper with no `next` answers it itself (`sendLinkFailure`).
 * Ratchet: tests/web/link-failure-answer.test.ts.
 */

import type { Request, Response } from 'express'
import { linkFailureKind, type LinkFailureKind } from '../../providers/link-failure.js'
import { isNeedsLeaderError } from '../../core/replication/needs-leader.js'
import { log } from '../../logging/index.js'
import { routeLogMessage } from '../../core/notifications/route-condition.js'

export interface LinkFailureAnswer {
  status: 503 | 504
  code: 'host_reconnecting' | 'host_no_answer'
  kind: LinkFailureKind
  message: string
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** The answer for a host link failure, or null when `err` is the work's own error. */
export function linkFailureAnswer(err: unknown, method = 'GET'): LinkFailureAnswer | null {
  const kind = linkFailureKind(err)
  if (!kind) return null
  if (kind === 'no-link') {
    return { status: 503, code: 'host_reconnecting', kind, message: 'The host is not connected right now. Try again in a moment.' }
  }
  const words = kind === 'lost' ? 'The connection to the host dropped before it answered.' : 'The host did not answer in time.'
  if (READ_METHODS.has(method.toUpperCase())) {
    return { status: 503, code: 'host_reconnecting', kind, message: `${words} Try again in a moment.` }
  }
  return { status: 504, code: 'host_no_answer', kind, message: `${words} The change may have gone through there; check before trying again.` }
}

/** True for an error a router's own funnel passes on (`next(err)`) for the app error handler to answer. */
export function handsToAppErrorHandler(err: unknown): boolean {
  return isNeedsLeaderError(err) || linkFailureKind(err) !== null
}

/** Answer a host link failure (true), or leave `err` to the caller (false). */
export function sendLinkFailure(req: Request, res: Response, err: unknown): boolean {
  if ((err as { status?: unknown } | null)?.status !== undefined) return false
  const link = linkFailureAnswer(err, req.method)
  if (!link) return false
  const detail = err instanceof Error ? err.message : String(err)
  log.web.warn(routeLogMessage(req.method, req.originalUrl, link.status), { reqId: req.reqId, detail, url: req.originalUrl, link: link.kind })
  if (res.headersSent) { res.end(); return true }
  const v1 = req.originalUrl.startsWith('/api/v1/')
  res.status(link.status).json(v1
    ? { error: { code: link.code, message: link.message, detail } }
    : { error: link.message, code: link.code, detail })
  return true
}
