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
  // request for one broken route. `message` stays in the meta, which is outside the
  // bridge's dedup allowlist, so two different root causes on one endpoint still
  // fold into one card that shows the LATEST cause (one condition = one row).
  //
  // 5xx only gets a key: a 4xx here (a route throwing a 400/404) is a client
  // problem, and there is no "this endpoint recovered" to signal.
  //
  // `status` is deliberately NOT in the meta any more. It IS in the bridge's dedup
  // allowlist, and a thrown 5xx is logged TWICE — here, and again by the request
  // logger when the response finishes. With `status` on only one of them the two
  // hashed differently and one broken route produced two cards side by side. The
  // message already states the status, so nothing is lost from the log file.
  log.web.error(routeLogMessage(req.method, req.originalUrl, status), {
    reqId: req.reqId,
    message,
    url: req.originalUrl,
    stack: status >= 500 ? err.stack : undefined,
    ...(status >= 500 ? { recoveryKey: routeRecoveryKey(req.method, req.originalUrl) } : {}),
  })

  res.status(status).json({
    error: message,
    ...(process.env.NODE_ENV !== 'production' && { details: err.stack }),
  })
}
