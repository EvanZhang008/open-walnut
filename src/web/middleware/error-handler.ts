/**
 * Express error handling middleware.
 */

import type { Request, Response, NextFunction } from 'express'
import { log } from '../../logging/index.js'

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

  log.web.error(`${req.method} ${req.originalUrl} → ${status}`, {
    reqId: req.reqId,
    status,
    message,
    stack: status >= 500 ? err.stack : undefined,
  })

  res.status(status).json({
    error: message,
    ...(process.env.NODE_ENV !== 'production' && { details: err.stack }),
  })
}
