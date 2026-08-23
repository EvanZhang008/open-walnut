/**
 * Shared /api/v1 cloud-relay plumbing — one implementation of the
 * phone → cloud → bridge(__local__) → daemon → primary `session.control`
 * round trip, used by the Wave-1 v1 routers (session-lifecycle-v1.ts,
 * search-memory-v1.ts). session-control-v1.ts predates this module and keeps
 * its own copy (it adds a fork-specific success hook); fold it in when next
 * touched.
 *
 * The bridge hop always targets the PRIMARY's daemon ('__local__') regardless
 * of which host a session runs on — the primary's server owns the records and
 * reaches every host's CLI exactly like a local request would. The daemon
 * forwards the `action` string opaquely (allowlist gates the command name,
 * not actions), so new actions need no daemon protocol change; an old PRIMARY
 * answers "Unknown control action" → mapped to the needs_upgrade ladder.
 */

import type { Response } from 'express'
import type { SessionControlAction } from '../../core/sessions/session-controls.js'

/** Frozen v1 error shape: { error: { code, message } }. */
export function sendV1Error(res: Response, status: number, code: string, message: string, extra?: Record<string, unknown>): void {
  res.status(status).json({ error: { code, message }, ...(extra ?? {}) })
}

/** HTTP status → frozen v1 error code (same vocabulary as session-launch-v1). */
export function v1ErrorCode(status: number): string {
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status >= 500) return 'internal'
  return 'bad_request'
}

const PRIMARY_BRIDGE_ALIAS = '__local__'
// History/changes may read remote JSONL over SSH; terminate may wait out a
// graceful ACP stop. 30s matches the established control-relay budget.
const CONTROL_RELAY_TIMEOUT_MS = 30_000

/** errorKind from the relay reply → frozen v1 HTTP status. */
function relayErrorStatus(errorKind: string): number {
  if (errorKind === 'not_found') return 404
  if (errorKind === 'method_not_allowed') return 405
  if (errorKind === 'conflict') return 409
  if (errorKind === 'payload_too_large') return 413
  if (errorKind === 'headers_too_large') return 431
  if (errorKind === 'internal') return 500
  if (errorKind === 'bad_gateway') return 502
  if (errorKind === 'unavailable') return 503
  if (errorKind === 'gateway_timeout') return 504
  return 400
}

/**
 * Drive one control-relay action over the bridge and return the raw reply, or
 * null after answering a bridge-offline error. Callers that need to reshape a
 * successful result (e.g. workflow's 204-on-null) use this; everyone else
 * uses relayControlAction below.
 */
export async function driveControlRelay(
  res: Response,
  action: SessionControlAction,
  sessionId: string,
  params: Record<string, unknown> | undefined,
): Promise<Record<string, unknown> | null> {
  const { bridgeRequest, BridgeOfflineError } = await import('../ws/bridge-registry.js')
  try {
    return await bridgeRequest(
      PRIMARY_BRIDGE_ALIAS,
      'session.control',
      { action, sessionId, ...(params !== undefined ? { params } : {}) },
      CONTROL_RELAY_TIMEOUT_MS,
    )
  } catch (err) {
    if (err instanceof BridgeOfflineError) {
      sendV1Error(res, 503, 'bridge_offline', 'No live bridge to the primary box — try again when it reconnects')
      return null
    }
    sendV1Error(res, 503, 'bridge_offline', err instanceof Error ? err.message : String(err))
    return null
  }
}

/**
 * Why a relay reply failed, in the ONE vocabulary every caller branches on.
 *
 *   needs_upgrade  — the primary (or its daemon) predates this action. Self-heals
 *                    on the next primary deploy/reconnect; a caller with a legacy
 *                    delivery lane should use it (see core/task-queue.ts).
 *   bridge_offline — daemon reachable but its walnut server isn't; retry later.
 *   error          — the action ran and failed for a domain reason.
 */
export type RelayFailure =
  | { kind: 'needs_upgrade'; message: string }
  | { kind: 'bridge_offline'; message: string }
  | { kind: 'error'; status: number; code: string; message: string }

/** Classify a failed relay reply. Single source of the needs_upgrade ladder —
 *  shared by the HTTP responder below and the non-HTTP callPrimaryControl(). */
export function classifyRelayReply(reply: Record<string, unknown>): RelayFailure {
  const reason = String(reply.error ?? 'unknown')
  // Pre-session.control daemon OR a primary server that predates this action —
  // both self-heal on the next primary upgrade/reconnect.
  if (
    reason.startsWith('unknown command')
    || reason.includes('not permitted over bridge')
    || reason.startsWith('Unknown control action')
  ) {
    return {
      kind: 'needs_upgrade',
      message: 'The primary box predates this mobile action — it upgrades automatically on the next deploy/reconnect',
    }
  }
  // "no primary server connected" = daemon alive but its walnut server is
  // down; nothing can answer. Same user remedy as bridge-down. Name the
  // PRIMARY explicitly: during the 2026-08-20 incident the user read this
  // family of errors as "clouddev is unreachable" when clouddev was fine and
  // the Mac was the missing hop.
  if (reason.includes('no primary server connected')) {
    return { kind: 'bridge_offline', message: 'Your primary box (Mac) is offline — the session\'s host is fine; retrying automatically' }
  }
  const errorKind = typeof reply.errorKind === 'string' ? reply.errorKind : 'bad_request'
  // Domain error codes (e.g. terminate's 'cron_owner') ride the relay so the
  // phone sees the same v1 code the local path produces.
  const errorCode = typeof reply.errorCode === 'string' && reply.errorCode ? reply.errorCode : errorKind
  return { kind: 'error', status: relayErrorStatus(errorKind), code: errorCode, message: reason }
}

/**
 * Map a failed relay reply onto the frozen v1 error response (needs_upgrade
 * ladder / bridge-down / verbatim error passthrough).
 */
export function sendRelayReplyError(res: Response, reply: Record<string, unknown>): void {
  const failure = classifyRelayReply(reply)
  if (failure.kind === 'needs_upgrade') {
    sendV1Error(res, 400, 'session_control_needs_upgrade', failure.message)
    return
  }
  if (failure.kind === 'bridge_offline') {
    sendV1Error(res, 503, 'bridge_offline', failure.message)
    return
  }
  sendV1Error(res, failure.status, failure.code, failure.message)
}

/**
 * Same round trip as driveControlRelay but WITHOUT an HTTP response — for
 * background callers (no `res` to answer). Never throws: a dead bridge, a
 * timeout and a domain error all come back as a classified RelayFailure so the
 * caller can pick its own fallback lane.
 */
export async function callPrimaryControl(
  action: SessionControlAction,
  sessionId: string,
  params: Record<string, unknown> | undefined,
  timeoutMs = CONTROL_RELAY_TIMEOUT_MS,
): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; failure: RelayFailure }> {
  const { bridgeRequest } = await import('../ws/bridge-registry.js')
  let reply: Record<string, unknown>
  try {
    reply = await bridgeRequest(
      PRIMARY_BRIDGE_ALIAS,
      'session.control',
      { action, sessionId, ...(params !== undefined ? { params } : {}) },
      timeoutMs,
    )
  } catch (err) {
    // BridgeOfflineError (no socket) and a request timeout are the same story
    // for a background caller: nothing was delivered, retry later.
    return {
      ok: false,
      failure: { kind: 'bridge_offline', message: err instanceof Error ? err.message : String(err) },
    }
  }
  if (reply.ok === true && reply.result && typeof reply.result === 'object') {
    return { ok: true, result: reply.result as Record<string, unknown> }
  }
  return { ok: false, failure: classifyRelayReply(reply) }
}

/**
 * Drive one control-relay action over the bridge and translate the reply into
 * the frozen v1 response. Never throws — every failure is a precise HTTP error.
 */
export async function relayControlAction(
  res: Response,
  action: SessionControlAction,
  sessionId: string,
  params: Record<string, unknown> | undefined,
  successStatus: number,
): Promise<void> {
  const reply = await driveControlRelay(res, action, sessionId, params)
  if (!reply) return
  if (reply.ok === true && reply.result && typeof reply.result === 'object') {
    res.status(successStatus).json(reply.result)
    return
  }
  sendRelayReplyError(res, reply)
}
