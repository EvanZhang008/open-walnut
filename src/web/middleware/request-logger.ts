/**
 * Request logging middleware — logs every HTTP request with method, path,
 * status code, duration, and a unique request ID.
 *
 * The request ID is also attached to `req.reqId` so downstream code
 * (route handlers, error handler) can include it in their own log lines,
 * making it possible to correlate all logs from a single request.
 *
 * Example log output:
 *   INF [web] GET /api/tasks → 200 (12ms) { reqId: "a1b2c3", query: { status: "active" } }
 *   ERR [web] POST /api/sessions/start-quick → 500 (340ms) { reqId: "d4e5f6" }
 */

import type { Request, Response, NextFunction } from 'express'
import crypto from 'node:crypto'
import { log } from '../../logging/index.js'

// Extend Express Request to carry the request ID
declare global {
  namespace Express {
    interface Request {
      reqId?: string
    }
  }
}

/** Paths to skip logging (high-frequency polling / health checks). */
const SKIP_PATHS = new Set([
  '/api/heartbeat',
  '/api/heartbeat/',
])

/** Paths that are polled frequently — log at debug level instead of info. */
const QUIET_PREFIXES = [
  '/api/browser-logs',
]

function isQuietPath(path: string): boolean {
  return QUIET_PREFIXES.some((p) => path.startsWith(p))
}

/**
 * Sanitize query params for logging — redact anything that looks sensitive.
 */
function safeQuery(query: Record<string, unknown>): Record<string, unknown> | undefined {
  const keys = Object.keys(query)
  if (keys.length === 0) return undefined
  const safe: Record<string, unknown> = {}
  for (const k of keys) {
    const lower = k.toLowerCase()
    if (lower.includes('key') || lower.includes('token') || lower.includes('secret') || lower.includes('password')) {
      safe[k] = '[REDACTED]'
    } else {
      safe[k] = query[k]
    }
  }
  return safe
}

/**
 * Express middleware: log every API request with timing + request ID.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  // Skip noisy endpoints entirely
  if (SKIP_PATHS.has(req.path)) {
    next()
    return
  }

  // Assign a short request ID (8 hex chars — enough for local correlation)
  const reqId = crypto.randomBytes(4).toString('hex')
  req.reqId = reqId
  // Echo it to the client so browser-side logs (e.g. the api client's JSON
  // parse-failure forensics) can name the exact server request they observed —
  // without this, concurrent duplicate GETs to the same URL are unpairable.
  res.setHeader('X-Request-Id', reqId)

  const start = Date.now()

  // Hook into response finish to log after the response is sent
  res.on('finish', () => {
    const duration = Date.now() - start
    const status = res.statusCode
    const method = req.method
    const url = req.originalUrl

    const meta: Record<string, unknown> = { reqId }

    // Include query params for GET requests (helps debug "wrong data" issues)
    const q = safeQuery(req.query as Record<string, unknown>)
    if (q) meta.query = q

    // Include content-length for POST/PUT/PATCH
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      const cl = req.headers['content-length']
      if (cl) meta.bodyBytes = Number(cl)
    }

    // Response body size when known (compression streams are chunked → absent).
    // A 200 with respBytes:0 or a surprise 304 is the cache-race fingerprint
    // behind "Untitled session" (inc-1784686852150) — keep this visible.
    const respCl = res.getHeader('content-length')
    if (respCl !== undefined) meta.respBytes = Number(respCl)
    // A 304 can only come from conditional-request handling; record what the
    // client sent so we can tell browser-cache revalidation from proxies.
    if (status === 304 && req.headers['if-none-match']) {
      meta.ifNoneMatch = String(req.headers['if-none-match'])
    }

    const line = `${method} ${url} → ${status} (${duration}ms)`

    if (status >= 500) {
      log.web.error(line, meta)
    } else if (status >= 400) {
      log.web.warn(line, meta)
    } else if (isQuietPath(req.path)) {
      log.web.debug(line, meta)
    } else {
      log.web.info(line, meta)
    }
  })

  next()
}
