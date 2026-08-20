/**
 * /api/v1 session launch endpoints (additive) — create a NEW Claude Code
 * session from mobile, with the same host/path semantics as the web Quick
 * Start launcher.
 *
 *   GET  /sessions/launch-options → { hosts, dirs } — where can a session run
 *        (the primary box + every enabled config.hosts entry) and which paths
 *        the user launches from (frequent-dirs store, same source + scoring
 *        as the web launcher's suggestions).
 *   POST /sessions { cwd, host?, message?, taskId?, model?, mode? }
 *        → 201 { sessionId, taskId, title }
 *
 * Creation reuses quickStartSession() — the exact task-create/reuse →
 * SESSION_START → session-runner chain the web launcher uses — so a mobile
 * launch spawns the CLI locally or via the chosen host's SSH daemon with
 * identical semantics. `taskId` links the new session to an existing task
 * (retry-mode: archives that task's error/stopped sessions to free the slot).
 * Validation + creation live in core/sessions/mobile-launch.ts (shared with
 * the bridge relay below).
 *
 * 201 means ACCEPTED, not spawned: quickStartSession returns right after the
 * SESSION_START bus emit; the CLI spawn is async in session-runner. A bad
 * remote host or a cwd typo surfaces as session `error` status later, not as
 * an HTTP failure here — the record is pre-seeded so the returned sessionId
 * immediately resolves on the transcript/stream/messages endpoints.
 *
 * Cloud companion (REPLICA): the session RECORD lives on the primary box, so
 * both endpoints RELAY through the primary's daemon bridge — the narrow
 * `session.launch` command (allowlisted in the daemon twins) forwards the
 * request as a `launch-request` event to the daemon's connected walnut
 * server, which runs the exact same mobile-launch core and replies. Failure
 * ladder mirrors image.save: pre-session.launch daemon → 400
 * session_launch_needs_upgrade (self-heals on the next primary reconnect);
 * no live bridge / primary down → 503 bridge_offline; validation errors from
 * the primary surface verbatim with their original 4xx code.
 *
 * Frozen-contract note: everything here is additive (docs/reference/api-v1.md).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import {
  computeLaunchOptions,
  launchErrorCode,
  performMobileLaunch,
  validateMobileLaunchBody,
} from '../../core/sessions/mobile-launch.js'
import { QuickStartError } from '../../core/sessions/quick-start.js'
import { log } from '../../logging/index.js'

export const sessionLaunchV1Router = Router()

// Same frozen error shape as api-v1.ts / session-stream-v1.ts.
function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } })
}

// ── Cloud relay: phone → cloud → bridge(__local__) → daemon → primary ───────
//
// The bridge hop always targets the PRIMARY's daemon ('__local__') regardless
// of which host the SESSION will run on — the primary's server handles the
// host exactly like a local request (SESSION_START → session-runner → that
// host's daemon).

const PRIMARY_BRIDGE_ALIAS = '__local__'
// Launch does task-store writes + bus emits on the primary; give it headroom
// over the 15s bridge default. Options is a pair of file reads — default is fine.
const LAUNCH_RELAY_TIMEOUT_MS = 30_000

/** errorKind from the relay reply → frozen v1 HTTP status. */
function relayErrorStatus(errorKind: string): number {
  if (errorKind === 'not_found') return 404
  if (errorKind === 'conflict') return 409
  if (errorKind === 'internal') return 500
  return 400
}

/**
 * Drive one launch-relay action over the bridge and translate the reply into
 * the frozen v1 response. Never throws — every failure is a precise HTTP error.
 */
async function relayLaunchAction(
  res: Response,
  action: 'options' | 'launch',
  params: Record<string, unknown> | undefined,
  successStatus: number,
): Promise<void> {
  const { bridgeRequest, BridgeOfflineError } = await import('../ws/bridge-registry.js')
  let reply: Record<string, unknown>
  try {
    reply = await bridgeRequest(
      PRIMARY_BRIDGE_ALIAS,
      'session.launch',
      { action, ...(params !== undefined ? { params } : {}) },
      action === 'launch' ? LAUNCH_RELAY_TIMEOUT_MS : undefined,
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
    // Successful launch: seed the id→host mapping NOW. The other v1 session
    // endpoints resolve hosts from the git-synced projection, which lags a
    // launch by 1–3 minutes — without the seed the phone's very next
    // stream/transcript/send calls 404 on the session we just created
    // (2026-08-07 incident: every message "Not sent — tap to retry").
    if (action === 'launch') {
      const sessionId = (reply.result as { sessionId?: unknown }).sessionId
      if (typeof sessionId === 'string' && sessionId) {
        const { seedLaunchedSession } = await import('../../core/sessions/launch-seed.js')
        const host = typeof params?.host === 'string' ? params.host : ''
        seedLaunchedSession(sessionId, {
          // Same alias mapping as the projection: '' = primary → '__local__'.
          host: host === '' ? '__local__' : host,
          ...(typeof params?.cwd === 'string' ? { cwd: params.cwd } : {}),
          ...(typeof params?.model === 'string' ? { model: params.model } : {}),
        })
      }
    }
    res.status(successStatus).json(reply.result)
    return
  }
  const reason = String(reply.error ?? 'unknown')
  // Pre-session.launch daemon: the allowlist rejection and the unknown-command
  // error both mean "this daemon predates launch relay" — it upgrades
  // automatically on the next primary-box reconnect, so tell the app that.
  if (reason.startsWith('unknown command') || reason.includes('not permitted over bridge')) {
    sendError(res, 400, 'session_launch_needs_upgrade',
      'The primary box\'s daemon predates mobile session launch — it upgrades automatically on the next reconnect')
    return
  }
  // "no primary server connected" = daemon alive but its walnut server is
  // down; record creation is impossible. Same user remedy as bridge-down.
  if (reason.includes('no primary server connected')) {
    sendError(res, 503, 'bridge_offline', 'Your primary box (Mac) is offline — it must be up to create sessions')
    return
  }
  const errorKind = typeof reply.errorKind === 'string' ? reply.errorKind : 'bad_request'
  sendError(res, relayErrorStatus(errorKind), errorKind, reason)
}

// GET /api/v1/sessions/launch-options — hosts + suggested working dirs for
// the mobile New Session sheet (computed on the primary; relayed on cloud).
sessionLaunchV1Router.get('/sessions/launch-options', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (CLOUD_MODE) {
      await relayLaunchAction(res, 'options', undefined, 200)
      return
    }
    res.json(await computeLaunchOptions())
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/sessions — create a session. Validates the body shape, then
// delegates to the shared mobile-launch core (directly on the primary;
// through the bridge relay on cloud). Returns 201 with the pre-assigned
// session id so the app can open the conversation view immediately (the
// record is pre-seeded before the spawn).
sessionLaunchV1Router.post('/sessions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Shape validation runs HERE on both boxes: on cloud it fast-fails junk
    // without a bridge round trip (the primary re-validates anyway — the
    // relay crosses a semi-trusted box, so its checks are the real gate).
    let input
    try {
      input = validateMobileLaunchBody(req.body)
    } catch (err) {
      if (err instanceof QuickStartError) {
        sendError(res, err.statusCode, launchErrorCode(err.statusCode), err.message)
        return
      }
      throw err
    }

    if (CLOUD_MODE) {
      await relayLaunchAction(res, 'launch', (req.body ?? {}) as Record<string, unknown>, 201)
      return
    }

    try {
      const result = await performMobileLaunch(input, 'mobile-launch')
      res.status(201).json(result)
    } catch (err) {
      if (err instanceof QuickStartError) {
        sendError(res, err.statusCode, launchErrorCode(err.statusCode), err.message)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// Router-level error funnel — keeps unexpected failures in the frozen shape.
// Same form as apiV1Router's funnel: guard headersSent (a handler may fail
// after partially writing) and treat err as unknown.
sessionLaunchV1Router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log.web.error('api-v1 session launch error', {
    error: err instanceof Error ? err.message : String(err),
  })
  if (res.headersSent) {
    res.end()
    return
  }
  sendError(res, 500, 'internal', 'Internal server error')
})
