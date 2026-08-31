/**
 * /api/v1 session lifecycle endpoints (additive) — detail, patch, terminate,
 * restart, retry, permission response, execute-continue, changed-files data,
 * and rich history. Semantics are identical to the web routes
 * (src/web/routes/sessions.ts) because both call the SAME core functions in
 * core/sessions/session-lifecycle.ts.
 *
 *   GET   /sessions/:id                    → { session, pendingPermissions }
 *   PATCH /sessions/:id { title? | archived? | mode? | human_note? } → { session }
 *   POST  /sessions/:id/terminate { force? } → { status:'terminated', sessionId, tookMs? }
 *   POST  /sessions/:id/restart            → { status:'restarted', sessionId, pendingMessages }
 *   POST  /sessions/:id/retry              → { status:'reconnected'|'resuming'|'pending', … }
 *   POST  /sessions/:id/permission { requestId, allow, message? } → { status:'resolved', requestId, allow }
 *   POST  /sessions/:id/execute-continue   → { status:'started', sessionId }
 *   GET   /sessions/:id/changes?base&scope&light&refresh → { groups, … }
 *   GET   /sessions/:id/history?tail=N     → { messages, total, forkedFromSessionId?, … }
 *
 * Cloud companion (REPLICA): all Class B — session records + live CLIs live on
 * the primary box, so every endpoint RELAYS through the existing allowlisted
 * `session.control` daemon command with new action names. The daemon forwards
 * the action string opaquely, so no daemon protocol change is needed; an old
 * PRIMARY that predates these actions answers "Unknown control action" → 400.
 * Failure ladder mirrors session-control-v1.ts (needs_upgrade / bridge_offline
 * / verbatim 4xx passthrough).
 *
 * Frozen-contract note: everything here is additive (docs/reference/api-v1.md).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { relayControlAction, sendV1Error as sendError, v1ErrorCode } from './v1-control-relay.js'

export const sessionLifecycleV1Router = Router()

/** Session ids land in daemon commands — restrict to the safe id alphabet. */
const SID_RE = /^[A-Za-z0-9_-]+$/

function validSid(req: Request, res: Response): string | null {
  const sessionId = String(req.params.id ?? '')
  if (!SID_RE.test(sessionId)) {
    sendError(res, 400, 'bad_request', 'Invalid session id')
    return null
  }
  return sessionId
}

/**
 * Local-path runner: call a session-lifecycle core function, translate
 * SessionControlError into the frozen v1 shape, funnel the rest to next().
 */
async function runLocal(
  res: Response,
  next: NextFunction,
  successStatus: number,
  fn: () => Promise<unknown>,
): Promise<void> {
  const { SessionControlError } = await import('../../core/sessions/session-controls.js')
  try {
    res.status(successStatus).json(await fn())
  } catch (err) {
    if (err instanceof SessionControlError) {
      const code = typeof err.extra?.code === 'string' ? err.extra.code : v1ErrorCode(err.statusCode)
      sendError(res, err.statusCode, code, err.message)
      return
    }
    next(err)
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

/**
 * Collection-level subpaths served by LATER-mounted v1 routers. This router's
 * GET /sessions/:id is the first :id catch-all under /api/v1, so without this
 * forward it would swallow them as session ids (SID_RE happily matches
 * "list-dirs") and answer 404 "session not found".
 */
const RESERVED_SESSION_SUBPATHS = new Set(['list-dirs', 'recent', 'summaries'])

/**
 * Degraded read-only detail for when the PRIMARY can't answer: the git-synced
 * projection row, liveness-corrected by asking the SESSION HOST's own daemon
 * over its own bridge when that link is up.
 *
 * Why this exists (2026-08-20 field incident): the Mac lost DNS for ~108 min.
 * Its bridge to the cloud box dropped, but the clouddev bridge NEVER did — the
 * session kept streaming to the phone, and sends kept delivering through the
 * direct fallback. The only thing that failed was this detail poll (12s), and
 * its 503 painted a perfectly healthy clouddev session as unreachable. A
 * read-only status question must never be answered with a transport error when
 * a truthful (if partial) answer exists one hop away.
 *
 * pendingPermissions is honestly empty: prompts live on the primary, and an
 * empty list just means "none visible right now" — the same thing a pre-Wave-1
 * server said. `degraded:true` is additive for clients that care.
 */
async function degradedSessionDetail(sessionId: string): Promise<Record<string, unknown> | null> {
  try {
    const { readSessionProjection } = await import('../../core/session-projection.js')
    const row = (await readSessionProjection())?.sessions.find((s) => s.id === sessionId)
    if (!row) return null
    let processStatus = row.process_status
    const hostAlias = row.host === '' ? '__local__' : row.host
    try {
      const { bridgeRequest, bridgeForHost } = await import('../ws/bridge-registry.js')
      if (bridgeForHost(hostAlias).connected) {
        // `status` is already bridge-allowlisted (the direct send path uses it).
        const status = await bridgeRequest(hostAlias, 'status', { sid: sessionId }, 5_000)
        if (status.exists === true) {
          // The daemon knows process liveness, not turn activity — so only
          // correct the projection where liveness contradicts it.
          if (status.alive !== true) processStatus = 'stopped'
          else if (processStatus === 'stopped') processStatus = 'idle'
        }
      }
    } catch { /* host probe failed — the projection row is still the best truth */ }
    return {
      session: {
        claudeSessionId: sessionId,
        process_status: processStatus,
        ...(row.title ? { title: row.title } : {}),
        ...(row.mode ? { mode: row.mode } : {}),
      },
      pendingPermissions: [],
      degraded: true,
      degradedReason: 'primary_offline',
    }
  } catch {
    return null
  }
}

// GET /api/v1/sessions/:id — full session detail: the liveness-corrected
// record + live pending permission prompts (pair with POST …/permission).
sessionLifecycleV1Router.get('/sessions/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (RESERVED_SESSION_SUBPATHS.has(String(req.params.id))) { next(); return }
    const sessionId = validSid(req, res)
    if (!sessionId) return
    if (CLOUD_MODE) {
      const { callPrimaryControl } = await import('./v1-control-relay.js')
      // 10s, not the 30s relay default: the phone polls this on a 12s cadence
      // and abandons requests at 30s — a stuck primary link must degrade well
      // inside both budgets.
      const reply = await callPrimaryControl('detail', sessionId, undefined, 10_000)
      if (reply.ok) {
        res.status(200).json(reply.result)
        return
      }
      if (reply.failure.kind === 'error') {
        // The primary RAN the lookup and refused (404 etc) — verbatim truth.
        sendError(res, reply.failure.status, reply.failure.code, reply.failure.message)
        return
      }
      // bridge_offline / needs_upgrade: the primary can't answer. Serve the
      // degraded read-only detail instead of painting the session unreachable.
      const degraded = await degradedSessionDetail(sessionId)
      if (degraded) {
        res.status(200).json(degraded)
        return
      }
      sendError(res, 503, 'bridge_offline', reply.failure.message)
      return
    }
    const { getSessionDetail } = await import('../../core/sessions/session-lifecycle.js')
    await runLocal(res, next, 200, () => getSessionDetail(sessionId))
  } catch (err) {
    next(err)
  }
})

// PATCH /api/v1/sessions/:id { title? | archived? | mode? | human_note? | output_mode? } → { session }
sessionLifecycleV1Router.patch('/sessions/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = validSid(req, res)
    if (!sessionId) return
    const body = (req.body ?? {}) as Record<string, unknown>
    const patch = {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.archived !== undefined ? { archived: body.archived } : {}),
      ...(body.mode !== undefined ? { mode: body.mode } : {}),
      ...(body.human_note !== undefined ? { human_note: body.human_note } : {}),
      ...(body.output_mode !== undefined ? { output_mode: body.output_mode } : {}),
    }
    // The core tolerates an empty patch; the route requires at least one field
    // so a client bug (empty body) fails loudly instead of no-opping.
    if (Object.keys(patch).length === 0) {
      sendError(res, 400, 'bad_request', 'At least one of title, archived, mode, human_note, output_mode is required')
      return
    }
    if (CLOUD_MODE) {
      // Metadata-only patches (title/archived/human_note/output_mode) FAST-ACCEPT when the
      // bridge is down: persist the intent in the durable control queue and
      // answer 200 with the optimistic row — mirroring the durable
      // session.message relay. `mode` is EXCLUDED: it reconfigures the live
      // CLI (changeSessionMode), so only the primary can truthfully accept it.
      const metadataOnly = body.mode === undefined
      if (!metadataOnly) {
        await relayControlAction(res, 'patch', sessionId, patch, 200)
        return
      }
      const { callPrimaryControl } = await import('./v1-control-relay.js')
      const reply = await callPrimaryControl('patch', sessionId, patch, 20_000)
      if (reply.ok) {
        res.status(200).json(reply.result)
        return
      }
      if (reply.failure.kind === 'bridge_offline' || reply.failure.kind === 'needs_upgrade') {
        const { enqueueSessionPatch } = await import('../../core/control-queue.js')
        const opId = await enqueueSessionPatch(sessionId, patch)
        if (opId) {
          // Optimistic response in the frozen { session } shape, built from the
          // synced projection row when available (additive `queued` marker).
          let record: Record<string, unknown> = { claudeSessionId: sessionId }
          try {
            const { readSessionProjection } = await import('../../core/session-projection.js')
            const row = (await readSessionProjection())?.sessions.find((s) => s.id === sessionId)
            if (row) {
              record = {
                claudeSessionId: sessionId,
                process_status: row.process_status,
                ...(row.title !== undefined ? { title: row.title } : {}),
                ...(row.mode !== undefined ? { mode: row.mode } : {}),
              }
            }
          } catch { /* minimal record */ }
          res.status(200).json({ session: { ...record, ...patch }, queued: true })
          return
        }
        // Queue write failed — the honest transport error is all that's left.
        sendError(res, 503, 'bridge_offline', reply.failure.message)
        return
      }
      // Domain error: the primary RAN the patch and refused — verbatim passthrough.
      sendError(res, reply.failure.status, reply.failure.code, reply.failure.message)
      return
    }
    const { patchSession } = await import('../../core/sessions/session-lifecycle.js')
    await runLocal(res, next, 200, async () => ({ session: await patchSession(sessionId, patch) }))
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/sessions/:id/terminate { force? } — kill the CLI process.
// 409 { error:{code:'cron_owner'} } when the session owns armed crons and
// force is not set (see terminateSession for why that kill is a footgun).
sessionLifecycleV1Router.post('/sessions/:id/terminate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = validSid(req, res)
    if (!sessionId) return
    const force = (req.body ?? {}).force === true
    if (CLOUD_MODE) {
      await relayControlAction(res, 'terminate', sessionId, { force }, 200)
      return
    }
    const { terminateSession } = await import('../../core/sessions/session-lifecycle.js')
    await runLocal(res, next, 200, () => terminateSession(sessionId, { force }))
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/sessions/:id/restart — respawn a fresh CLI so the session
// re-initializes (wakes an idle-reaped/dead session — the documented v1 gap).
sessionLifecycleV1Router.post('/sessions/:id/restart', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = validSid(req, res)
    if (!sessionId) return
    if (CLOUD_MODE) {
      await relayControlAction(res, 'restart', sessionId, undefined, 200)
      return
    }
    const { restartSession } = await import('../../core/sessions/session-lifecycle.js')
    await runLocal(res, next, 200, () => restartSession(sessionId))
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/sessions/:id/retry — retry a failed/stopped session.
sessionLifecycleV1Router.post('/sessions/:id/retry', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = validSid(req, res)
    if (!sessionId) return
    if (CLOUD_MODE) {
      await relayControlAction(res, 'retry', sessionId, undefined, 200)
      return
    }
    const { retrySession } = await import('../../core/sessions/session-lifecycle.js')
    await runLocal(res, next, 200, () => retrySession(sessionId))
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/sessions/:id/permission { requestId, allow, message? }
// Answer a live CLI tool-permission prompt from the phone.
sessionLifecycleV1Router.post('/sessions/:id/permission', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = validSid(req, res)
    if (!sessionId) return
    const body = (req.body ?? {}) as Record<string, unknown>
    if (CLOUD_MODE) {
      await relayControlAction(res, 'permission', sessionId, {
        requestId: body.requestId,
        allow: body.allow,
        ...(body.message !== undefined ? { message: body.message } : {}),
        ...(body.optionId !== undefined ? { optionId: body.optionId } : {}),
        ...(body.answers !== undefined ? { answers: body.answers } : {}),
      }, 200)
      return
    }
    const { respondSessionPermission } = await import('../../core/sessions/session-lifecycle.js')
    await runLocal(res, next, 200, () => respondSessionPermission(sessionId, body.requestId, body.allow, body.message, body.optionId, body.answers))
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/sessions/:id/execute-continue — resume a completed plan
// session with bypass permissions ("Continue" on a finished plan).
sessionLifecycleV1Router.post('/sessions/:id/execute-continue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = validSid(req, res)
    if (!sessionId) return
    if (CLOUD_MODE) {
      await relayControlAction(res, 'execute-continue', sessionId, undefined, 200)
      return
    }
    const { executeContinueSession } = await import('../../core/sessions/session-lifecycle.js')
    await runLocal(res, next, 200, () => executeContinueSession(sessionId))
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/sessions/:id/changes?base=&scope=&light=1&refresh=1
// The files a session changed (Changed-tab data). `light=1` strips
// before/after content — names/roots only, sized for a phone list.
sessionLifecycleV1Router.get('/sessions/:id/changes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = validSid(req, res)
    if (!sessionId) return
    const input = {
      base: typeof req.query.base === 'string' ? req.query.base : undefined,
      scope: typeof req.query.scope === 'string' ? req.query.scope : undefined,
      light: req.query.light === '1' || req.query.light === 'true',
      refresh: req.query.refresh === '1' || req.query.refresh === 'true',
    }
    if (CLOUD_MODE) {
      await relayControlAction(res, 'changes', sessionId, input, 200)
      return
    }
    const { getSessionChanges } = await import('../../core/sessions/session-lifecycle.js')
    await runLocal(res, next, 200, () => getSessionChanges(sessionId, input))
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/sessions/:id/history?tail=N — full rich-block history (tool
// detail/results, subagent lanes, fork-ancestor prefix). Snapshot API: no
// delta cursors — live rendering rides the SSE stream. The frozen
// `transcript` endpoint (slim 100-row tail) is untouched.
const HISTORY_TAIL_MAX = 2000
sessionLifecycleV1Router.get('/sessions/:id/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = validSid(req, res)
    if (!sessionId) return
    let tail: number | undefined
    if (typeof req.query.tail === 'string' && req.query.tail !== '') {
      const n = Number(req.query.tail)
      if (!Number.isInteger(n) || n < 1) {
        sendError(res, 400, 'bad_request', 'tail must be a positive integer')
        return
      }
      tail = Math.min(n, HISTORY_TAIL_MAX)
    }
    if (CLOUD_MODE) {
      await relayControlAction(res, 'history', sessionId, tail !== undefined ? { tail } : undefined, 200)
      return
    }
    const { readSessionRichHistory } = await import('../../core/sessions/session-lifecycle.js')
    await runLocal(res, next, 200, () => readSessionRichHistory(sessionId, tail))
  } catch (err) {
    next(err)
  }
})

// Router-level error funnel — keeps unexpected failures in the frozen shape.
sessionLifecycleV1Router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log.web.error('api-v1 session lifecycle error', {
    error: err instanceof Error ? err.message : String(err),
  })
  if (res.headersSent) {
    res.end()
    return
  }
  sendError(res, 500, 'internal', 'Internal server error')
})
