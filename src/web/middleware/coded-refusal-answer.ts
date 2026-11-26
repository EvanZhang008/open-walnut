/**
 * A refusal that carries its own status and code (lib/coded-refusal.ts) is answered by them,
 * whichever route it came through, never as a 500.
 *
 * The app error handler answers it; every router funnel hands such an error on to it
 * (`handsToAppErrorHandler`), and a route wrapper that answers a caught error itself calls
 * `sendOwnAnswer` first, which also answers a host link failure (link-failure-answer.ts).
 * Ratchets: tests/web/link-failure-answer.test.ts (the funnels and the wrappers),
 * tests/web/coded-refusal-answer.test.ts.
 */

import type { Request, Response } from 'express'
import { codedRefusalOf } from '../../lib/coded-refusal.js'
import { log } from '../../logging/index.js'
import { routeLogMessage } from '../../core/notifications/route-condition.js'
import { sendLinkFailure } from './link-failure-answer.js'

/** Answer a coded refusal (true), or leave `err` to the caller (false). */
export function sendCodedRefusal(req: Request, res: Response, err: unknown): boolean {
  const refusal = codedRefusalOf(err)
  if (!refusal) return false
  // The caller's to fix: a warn line, never a card (the request logger's rule for a 4xx).
  log.web.warn(routeLogMessage(req.method, req.originalUrl, refusal.status), { reqId: req.reqId, detail: refusal.message, url: req.originalUrl, code: refusal.code })
  if (res.headersSent) { res.end(); return true }
  const v1 = req.originalUrl.startsWith('/api/v1/')
  res.status(refusal.status).json(v1
    ? { error: { code: refusal.code, message: refusal.message } }
    : { error: refusal.message, code: refusal.code })
  return true
}

/** Answer what the error says it is, a coded refusal or a host link failure (true), or leave it to the caller (false). */
export function sendOwnAnswer(req: Request, res: Response, err: unknown): boolean {
  return sendCodedRefusal(req, res, err) || sendLinkFailure(req, res, err)
}
