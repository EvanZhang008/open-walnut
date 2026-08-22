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
 *   ERR [web] POST /api/sessions/start-quick → 500 { reqId: "d4e5f6", ms: 340 }
 *
 * The 5xx line is deliberately SHAPED DIFFERENTLY from the others: it carries no
 * latency and no query string in the message, because it becomes a notification
 * card and the log-error bridge fingerprints the message. See the ERROR-LINE
 * IDENTITY block below — nine cards for one broken endpoint is what the old
 * shape produced.
 */

import type { Request, Response, NextFunction } from 'express'
import crypto from 'node:crypto'
import { log } from '../../logging/index.js'
import { observe } from '../../core/observability/metrics.js'
import { routeLogMessage, routeRecoveryKey } from '../../core/notifications/route-condition.js'
import { createRecoveryTransitionTracker } from '../../core/notifications/recovery-transition.js'

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

/**
 * A path segment that is an identifier, not part of the route template:
 * UUIDs, hex ids, walnut ids like `ms4utt4g-1bc6`, numeric ids. Heuristic:
 * pure number, or ≥8 chars containing ≥2 digits. Route WORDS with a version
 * suffix (`notes-v2`, `search-memory-v1`) have only ONE digit and stay intact;
 * real ids always carry several. Errs toward collapsing — one id per request
 * minting a new metric series is the failure mode this guards against.
 */
const ID_SEGMENT_RE = /^(?=(?:.*\d){2}).{8,}$|^\d+$/

/** Paths that are polled frequently — log at debug level instead of info. */
const QUIET_PREFIXES = [
  '/api/browser-logs',
]

function isQuietPath(path: string): boolean {
  return QUIET_PREFIXES.some((p) => path.startsWith(p))
}

// ── Route recovery (an endpoint that fails and then works again) ───────────────
//
// A 5xx log becomes an error card keyed `route:<METHOD> <path>`; the card is
// retired the next time that same endpoint answers <500. This middleware cannot
// import the notification store (server.ts owns it, and importing server.ts from
// a middleware would be a cycle), so the signal is INJECTED at startup — same
// seam shape the disk/backup success points use.

type RecoveryPublisher = (keys: string[]) => void
let publishRouteRecovery: RecoveryPublisher | null = null

/**
 * Wire the recovery signal (server.ts, at startup). Null clears it.
 *
 * Also resets the failing-route memory: a fresh server has observed nothing, and
 * a leftover "failing" entry from a previous in-process server (tests start
 * several) would make the first healthy response of the new one fire a bogus
 * recovery.
 */
export function setRouteRecoveryPublisher(publish: RecoveryPublisher | null): void {
  publishRouteRecovery = publish
  routeHealth.reset()
}

/**
 * Which routes are currently failing. ONLY failing routes are ever inserted:
 * `observe()` on a healthy request would put an entry in this map for every
 * route the box serves, forever, to remember something that can never fire. So
 * the healthy branch pre-checks `isFailing` (a Map.get) and does nothing else —
 * which is the whole cost on the hot path for the overwhelming majority of
 * requests.
 */
const routeHealth = createRecoveryTransitionTracker()

/** Tests: inspect/clear the failing-route memory without a server. */
export function _resetRouteHealthForTest(): void {
  routeHealth.reset()
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

    // Metric: one histogram per route TEMPLATE. Raw paths carry ids (UUIDs,
    // task ids, session ids) which would explode label cardinality — replace
    // any id-looking segment with ':id' before truncating to three segments.
    // NB: derived from originalUrl, NOT req.path — inside res.on('finish') the
    // router has already rewritten req.path (mount-prefix stripping), which
    // produced garbage labels like '/:id/history' with no subsystem segment.
    const fullPath = url.split('?')[0]
    const routeGroup = fullPath
      .split('/')
      .map((seg) => (ID_SEGMENT_RE.test(seg) ? ':id' : seg))
      .slice(0, 4) // '', 'api', '<subsystem>', '<action-or-:id>'
      .join('/') || fullPath
    observe('http.request', duration, {
      route: routeGroup,
      method,
      status: String(Math.floor(status / 100) * 100), // 200/300/400/500 buckets
    })

    if (status >= 500) {
      // ── ERROR-LINE IDENTITY (the nine-cards bug) ────────────────────────────
      // log.error routes into the notification center, and the bridge's dedup
      // fingerprint is the MESSAGE. `${url}` carries the query string and
      // `(${duration}ms)` changes on literally every request, so one broken
      // endpoint minted a brand-new card per occurrence: the live feed held NINE
      // unresolved `GET/PUT /api/ui-prefs → 500` cards for a single condition,
      // none of them foldable and none retirable.
      //
      // So the 5xx message is normalized and latency-free, and everything that
      // varies moves into the meta — which the bridge's DEDUP_META_KEYS
      // allowlist ('error', 'code', 'sessionId', …) deliberately excludes, so
      // `ms`/`query`/`reqId` can't split the record either.
      //
      // 4xx and below keep the raw, fully detailed line: they log at warn/info,
      // never reach the sink, and their per-request detail is what makes the
      // request log useful. Only the notification path needs stable identity.
      const key = routeRecoveryKey(method, url)
      log.web.error(routeLogMessage(method, url, status), {
        ...meta, ms: duration, url, recoveryKey: key,
      })
      routeHealth.observe(key, true)
    } else {
      if (status >= 400) log.web.warn(line, meta)
      else if (isQuietPath(req.path)) log.web.debug(line, meta)
      else log.web.info(line, meta)
      // Recovery edge: this endpoint answered. A 4xx counts as recovered — the
      // condition the card described was "this endpoint is throwing", and a 404
      // or 400 means the route is reachable and reasoning about its input again.
      // isFailing() first so a healthy box never allocates: the tracker only
      // holds routes that have actually failed (see routeHealth above).
      const key = routeRecoveryKey(method, url)
      if (publishRouteRecovery && routeHealth.isFailing(key)) {
        routeHealth.forget(key)
        publishRouteRecovery([key])
      }
    }
  })

  next()
}
