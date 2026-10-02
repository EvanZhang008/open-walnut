/**
 * Express error handling middleware.
 */

import type { Request, Response, NextFunction } from 'express'
import { log } from '../../logging/index.js'
import { routeLogMessage, routeRecoveryKey } from '../../core/notifications/route-condition.js'

/**
 * 404 handler for unknown API routes.
 * Must be mounted after all route handlers.
 */
export function notFoundHandler(req: Request, res: Response, _next: NextFunction): void {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` })
}

/**
 * Catch-all error handler.
 * Must be the last middleware mounted on the app.
 */
export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const status = (err as { status?: number }).status ?? 500
  const message = err.message || 'Internal server error'

  // Same normalization as the request logger, and for the same reason: this
  // log.error becomes a notification card, and the bridge fingerprints the
  // MESSAGE — so a raw originalUrl (query string, entity ids) mints a new card per
  // request for one broken route. The exception text stays in the meta (see
  // `detail` below), outside the bridge's dedup allowlist, so two different root
  // causes on one endpoint still fold into one card that shows the LATEST cause
  // (one condition = one row).
  //
  // 5xx only gets a key: a 4xx here (a route throwing a 400/404) is a client
  // problem, and there is no "this endpoint recovered" to signal.
  //
  // `status` is deliberately NOT in the meta any more. It IS in the bridge's dedup
  // allowlist, and a thrown 5xx is logged TWICE — here, and again by the request
  // logger when the response finishes. With `status` on only one of them the two
  // hashed differently and one broken route produced two cards side by side. The
  // message already states the status, so nothing is lost from the log file.
  //
  // Only a 5xx is logged at error (= becomes a card). A thrown 4xx used to take
  // the same level, which contradicted the request logger's rule for the same
  // status and minted the live feed's `POST /api/browser-logs → 400 ×11`: every
  // one was the body parser's `request aborted` (a client that hung up while the
  // event loop was stalled), a condition with nothing for the user to act on.
  // An aborted body goes further down to debug: the client is gone, and the
  // request logger never saw the request (the parser runs before it).
  //
  // The exception text rides as `detail`: `message` would overwrite the line's
  // own message in the log file (the writer spreads meta over it), and `error`
  // is in the bridge's dedup allowlist, which would split one broken endpoint
  // into a card per distinct exception text.
  const aborted = (err as { type?: string }).type === 'request.aborted'
  const meta = {
    reqId: req.reqId,
    detail: message,
    url: req.originalUrl,
    ...(aborted ? { type: 'request.aborted' } : {}),
    ...(status >= 500 ? { stack: err.stack, recoveryKey: routeRecoveryKey(req.method, req.originalUrl) } : {}),
  }
  const line = routeLogMessage(req.method, req.originalUrl, status)
  if (status >= 500) log.web.error(line, meta)
  else if (aborted) log.web.debug(line, meta)
  else log.web.warn(line, meta)

  res.status(status).json({
    error: message,
    ...(process.env.NODE_ENV !== 'production' && { details: err.stack }),
  })
}
