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
  if (errorKind === 'conflict') return 409
  if (errorKind === 'internal') return 500
  if (errorKind === 'bad_gateway') return 502
  return 400
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
      sendV1Error(res, 503, 'bridge_offline', 'No live bridge to the primary box — try again when it reconnects')
      return
    }
    sendV1Error(res, 503, 'bridge_offline', err instanceof Error ? err.message : String(err))
    return
  }
  if (reply.ok === true && reply.result && typeof reply.result === 'object') {
    res.status(successStatus).json(reply.result)
    return
  }
  const reason = String(reply.error ?? 'unknown')
  // Pre-session.control daemon OR a primary server that predates this action —
  // both self-heal on the next primary upgrade/reconnect.
  if (
    reason.startsWith('unknown command')
    || reason.includes('not permitted over bridge')
    || reason.startsWith('Unknown control action')
  ) {
    sendV1Error(res, 400, 'session_control_needs_upgrade',
      'The primary box predates this mobile action — it upgrades automatically on the next deploy/reconnect')
    return
  }
  // "no primary server connected" = daemon alive but its walnut server is
  // down; nothing can answer. Same user remedy as bridge-down.
  if (reason.includes('no primary server connected')) {
    sendV1Error(res, 503, 'bridge_offline', 'The primary box\'s server is not connected to its daemon')
    return
  }
  const errorKind = typeof reply.errorKind === 'string' ? reply.errorKind : 'bad_request'
  // Domain error codes (e.g. terminate's 'cron_owner') ride the relay so the
  // phone sees the same v1 code the local path produces.
  const errorCode = typeof reply.errorCode === 'string' && reply.errorCode ? reply.errorCode : errorKind
  sendV1Error(res, relayErrorStatus(errorKind), errorCode, reason)
}
