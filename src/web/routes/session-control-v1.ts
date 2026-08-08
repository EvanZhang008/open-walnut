/**
 * /api/v1 session control endpoints (additive) — model switch, effort switch,
 * fork, and the mobile picker's model-options data. Semantics are identical to
 * the web routes (src/web/routes/sessions.ts) because both call the SAME core
 * functions in core/sessions/session-controls.ts.
 *
 *   GET  /sessions/:id/model-options → { models, current, currentEffort }
 *   POST /sessions/:id/model  { model }  → { model, cliModel, appliedLive, effectiveModel }
 *   POST /sessions/:id/effort { effort } → { effort, appliedLive, effectiveEffort, overridden }
 *   POST /sessions/:id/fork   { create_child_task?, task_id?, message?, title? }
 *        → 201 { sessionId, taskId, title, status, sourceSessionId, … }
 *
 * Cloud companion (REPLICA): session records + live CLIs live on the primary
 * box, so every endpoint RELAYS through the primary's daemon bridge — the
 * narrow `session.control` command (allowlisted in the daemon twins) forwards
 * the request as a `control-request` event to the daemon's connected walnut
 * server, which runs the exact same core functions and replies. Failure
 * ladder mirrors session-launch-v1.ts: pre-session.control daemon → 400
 * session_control_needs_upgrade (self-heals on the next primary reconnect);
 * no live bridge / primary down → 503 bridge_offline; validation errors from
 * the primary surface verbatim with their original 4xx code.
 *
 * Frozen-contract note: everything here is additive (docs/reference/api-v1.md).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import type { SessionControlAction } from '../../core/sessions/session-controls.js'

export const sessionControlV1Router = Router()

// Same frozen error shape as api-v1.ts / session-launch-v1.ts.
function sendError(res: Response, status: number, code: string, message: string, extra?: Record<string, unknown>): void {
  res.status(status).json({ error: { code, message }, ...(extra ?? {}) })
}

/** Session ids land in daemon commands — restrict to the safe id alphabet. */
const SID_RE = /^[A-Za-z0-9_-]+$/

// ── Cloud relay: phone → cloud → bridge(__local__) → daemon → primary ───────
//
// The bridge hop always targets the PRIMARY's daemon ('__local__') regardless
// of which host the SESSION runs on — the primary's server owns the records
// and reaches every host's CLI exactly like a local request would.

const PRIMARY_BRIDGE_ALIAS = '__local__'
// Fork does task-store writes + bus emits on the primary; model/effort may
// wait out a live CLI control_request round trip (15s apply timeout).
const CONTROL_RELAY_TIMEOUT_MS = 30_000

/** errorKind from the relay reply → frozen v1 HTTP status. */
function relayErrorStatus(errorKind: string): number {
  if (errorKind === 'not_found') return 404
  if (errorKind === 'conflict') return 409
  if (errorKind === 'internal') return 500
  return 400
}

/**
 * Drive one control-relay action over the bridge and translate the reply into
 * the frozen v1 response. Never throws — every failure is a precise HTTP error.
 */
async function relayControlAction(
  res: Response,
  action: SessionControlAction,
  sessionId: string,
  params: Record<string, unknown> | undefined,
  successStatus: number,
): Promise<void> {
  const { bridgeRequest, BridgeOfflineError } = await import('../ws/bridge-registry.js')
  let reply: Record<string, unknown>
  try {
    reply = await bridgeRequest(
      PRIMARY_BRIDGE_ALIAS,
      'session.control',
      { action, sessionId, ...(params !== undefined ? { params } : {}) },
      CONTROL_RELAY_TIMEOUT_MS,
    )
  } catch (err) {
    if (err instanceof BridgeOfflineError) {
      sendError(res, 503, 'bridge_offline', 'No live bridge to the primary box — try again when it reconnects')
      return
    }
    sendError(res, 503, 'bridge_offline', err instanceof Error ? err.message : String(err))
    return
  }
  if (reply.ok === true && reply.result && typeof reply.result === 'object') {
    // Successful fork: seed the id→host mapping NOW (same pattern as
    // session-launch-v1.ts). The other v1 session endpoints resolve hosts
    // from the git-synced projection, which lags a fork by 1–3 minutes —
    // without the seed the phone's next stream/transcript/send calls 404 on
    // the session we just created.
    if (action === 'fork') {
      const result = reply.result as { sessionId?: unknown; host?: unknown }
      if (typeof result.sessionId === 'string' && result.sessionId) {
        const { seedLaunchedSession } = await import('../../core/sessions/launch-seed.js')
        const host = typeof result.host === 'string' ? result.host : ''
        seedLaunchedSession(result.sessionId, {
          // Same alias mapping as the projection: '' = primary → '__local__'.
          host: host === '' ? '__local__' : host,
        })
      }
    }
    res.status(successStatus).json(reply.result)
    return
  }
  const reason = String(reply.error ?? 'unknown')
  // Pre-session.control daemon: the allowlist rejection and the unknown-command
  // error both mean "this daemon predates the control relay" — it upgrades
  // automatically on the next primary-box reconnect, so tell the app that.
  if (reason.startsWith('unknown command') || reason.includes('not permitted over bridge')) {
    sendError(res, 400, 'session_control_needs_upgrade',
      'The primary box\'s daemon predates mobile session control — it upgrades automatically on the next reconnect')
    return
  }
  // "no primary server connected" = daemon alive but its walnut server is
  // down; nothing can answer. Same user remedy as bridge-down.
  if (reason.includes('no primary server connected')) {
    sendError(res, 503, 'bridge_offline', 'The primary box\'s server is not connected to its daemon')
    return
  }
  const errorKind = typeof reply.errorKind === 'string' ? reply.errorKind : 'bad_request'
  sendError(res, relayErrorStatus(errorKind), errorKind, reason)
}

/** Shared shape gate: bad sid → 400 without touching the store/bridge. */
function validSid(req: Request, res: Response): string | null {
  const sessionId = String(req.params.id ?? '')
  if (!SID_RE.test(sessionId)) {
    sendError(res, 400, 'bad_request', 'Invalid session id')
    return null
  }
  return sessionId
}

// GET /api/v1/sessions/:id/model-options — picker data for the mobile model
// sheet: selectable rows (live CLI catalog → host catalog → static registry),
// the active row id, and the record's current effort.
sessionControlV1Router.get('/sessions/:id/model-options', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = validSid(req, res)
    if (!sessionId) return
    if (CLOUD_MODE) {
      await relayControlAction(res, 'model-options', sessionId, undefined, 200)
      return
    }
    const { computeModelOptions, SessionControlError } = await import('../../core/sessions/session-controls.js')
    try {
      res.json(await computeModelOptions(sessionId))
    } catch (err) {
      if (err instanceof SessionControlError) {
        sendError(res, err.statusCode, v1ErrorCode(err.statusCode), err.message, err.extra)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/sessions/:id/model { model } — switch the session's model.
sessionControlV1Router.post('/sessions/:id/model', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = validSid(req, res)
    if (!sessionId) return
    const rawModel = (req.body ?? {}).model
    if (CLOUD_MODE) {
      await relayControlAction(res, 'model', sessionId, { model: rawModel }, 200)
      return
    }
    const { applySessionModelChange, SessionControlError } = await import('../../core/sessions/session-controls.js')
    try {
      res.json(await applySessionModelChange(sessionId, rawModel))
    } catch (err) {
      if (err instanceof SessionControlError) {
        sendError(res, err.statusCode, v1ErrorCode(err.statusCode), err.message, err.extra)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/sessions/:id/effort { effort } — switch reasoning effort.
sessionControlV1Router.post('/sessions/:id/effort', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = validSid(req, res)
    if (!sessionId) return
    const rawEffort = (req.body ?? {}).effort
    if (CLOUD_MODE) {
      await relayControlAction(res, 'effort', sessionId, { effort: rawEffort }, 200)
      return
    }
    const { applySessionEffortChange, SessionControlError } = await import('../../core/sessions/session-controls.js')
    try {
      res.json(await applySessionEffortChange(sessionId, rawEffort))
    } catch (err) {
      if (err instanceof SessionControlError) {
        sendError(res, err.statusCode, v1ErrorCode(err.statusCode), err.message, err.extra)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/sessions/:id/fork { create_child_task?, task_id?, message?, title? }
// → 201 { sessionId, taskId, title, status:'pending', sourceSessionId, … }.
// 201 means ACCEPTED, not spawned (same contract as POST /sessions): the fork
// record is pre-seeded so the returned sessionId immediately resolves on the
// transcript/stream/messages endpoints; the CLI spawn is async.
sessionControlV1Router.post('/sessions/:id/fork', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = validSid(req, res)
    if (!sessionId) return
    const body = (req.body ?? {}) as Record<string, unknown>
    const params = {
      ...(typeof body.task_id === 'string' ? { task_id: body.task_id } : {}),
      ...(body.create_child_task === true ? { create_child_task: true } : {}),
      ...(typeof body.child_title === 'string' ? { child_title: body.child_title } : {}),
      ...(typeof body.message === 'string' ? { message: body.message } : {}),
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(typeof body.model === 'string' ? { model: body.model } : {}),
    }
    if (CLOUD_MODE) {
      await relayControlAction(res, 'fork', sessionId, params, 201)
      return
    }
    const { forkSessionToTask, SessionControlError } = await import('../../core/sessions/session-controls.js')
    try {
      res.status(201).json(await forkSessionToTask(sessionId, params, 'api-v1'))
    } catch (err) {
      if (err instanceof SessionControlError) {
        sendError(res, err.statusCode, v1ErrorCode(err.statusCode), err.message, err.extra)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

/** HTTP status → frozen v1 error code (same vocabulary as session-launch-v1). */
function v1ErrorCode(status: number): string {
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status >= 500) return 'internal'
  return 'bad_request'
}

// Router-level error funnel — keeps unexpected failures in the frozen shape.
// Same form as apiV1Router's funnel: guard headersSent (a handler may fail
// after partially writing) and treat err as unknown.
sessionControlV1Router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log.web.error('api-v1 session control error', {
    error: err instanceof Error ? err.message : String(err),
  })
  if (res.headersSent) {
    res.end()
    return
  }
  sendError(res, 500, 'internal', 'Internal server error')
})
