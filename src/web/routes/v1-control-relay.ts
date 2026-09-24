/**
 * Shared /api/v1 cloud-relay plumbing — one implementation of the
 * phone → cloud → bridge(__local__) → daemon → primary `session.control`
 * round trip, used by the Wave-1 v1 routers (session-lifecycle-v1.ts,
 * search-memory-v1.ts). session-control-v1.ts predates this module: it rides
 * driveControlRelay for the hop and keeps its own reply translation (the fork
 * success hook that seeds the new session's host, and its own error ladder).
 *
 * The bridge hop always targets the PRIMARY's daemon ('__local__') regardless
 * of which host a session runs on — the primary's server owns the records and
 * reaches every host's CLI exactly like a local request would. The daemon
 * forwards the `action` string opaquely (allowlist gates the command name,
 * not actions), so new actions need no daemon protocol change; an old PRIMARY
 * answers "Unknown control action" → mapped to the needs_upgrade ladder.
 *
 * Both entry points (driveControlRelay for HTTP, callPrimaryControl for
 * everything else) share sendControlToPrimary, which rides out a short bridge
 * redial hole BEFORE the one delivery attempt. See DEFAULT_BRIDGE_BLIP_GRACE_MS.
 */

import type { Response } from 'express'
import type { SessionControlAction } from '../../core/sessions/session-controls.js'
import { log } from '../../logging/index.js'
import { bridgeOfflineMessage } from './bridge-offline-copy.js'

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

/**
 * How long a relay waits for a MISSING primary bridge to come back before it
 * answers bridge_offline. Measured on a replica: the primary's bridge closes and
 * redials about 46 times a day, each hole 1.0 to 1.5s. Every relayed request that
 * landed in one failed instantly, and a single miss on the phone's engine read
 * left its model picker wrong for hours. 5s covers a few redial attempts.
 * `WALNUT_BRIDGE_BLIP_GRACE_MS` overrides it; 0 restores the instant failure.
 *
 * Safe for EVERY action, writes included, because the wait happens before
 * anything is sent: BridgeOfflineError is raised only when there is no socket to
 * write to, so the primary provably never saw the request and the send after the
 * wait is its first and only delivery. A failure AFTER a send (a timeout, a
 * socket that dropped with the request in flight) is ambiguous, since the primary
 * may already be running it, and is never retried.
 */
export const DEFAULT_BRIDGE_BLIP_GRACE_MS = 5_000

/**
 * Only a RECENT loss is worth waiting for. Same measured split as
 * BRIDGE_FLAP_FRESHNESS_MS in session-launch-v1.ts: routine redial holes are 0 to
 * 3s, the long ones (a Mac asleep with the lid shut) last many minutes. A loss
 * older than this, or one this process never saw (a replica that just started),
 * keeps its instant 503 instead of getting the same answer 5s later, which would
 * also hold every background drain and phone poll for the whole grace.
 */
const BRIDGE_BLIP_FRESHNESS_MS = 30_000

/** The configured blip grace in ms, read per call so an env change applies live. */
export function bridgeBlipGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WALNUT_BRIDGE_BLIP_GRACE_MS?.trim()
  if (!raw) return DEFAULT_BRIDGE_BLIP_GRACE_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_BRIDGE_BLIP_GRACE_MS
}

type BridgeRegistry = typeof import('../ws/bridge-registry.js')

/**
 * Registry reads that must never change an outcome. Reading an export that a
 * mocked ESM module never defined THROWS in vitest (the module is a proxy), and
 * a real registry that cannot answer means "behave as before": no duration, no
 * wait. Hence try/catch rather than optional chaining.
 */
function isBridgeOffline(registry: BridgeRegistry, err: unknown): boolean {
  try { return err instanceof registry.BridgeOfflineError } catch { return false }
}

function readLossClock(registry: BridgeRegistry): number | null {
  try { return registry.lastBridgeLossAt(PRIMARY_BRIDGE_ALIAS) } catch { return null }
}

async function waitForPrimaryBridge(registry: BridgeRegistry, graceMs: number): Promise<boolean> {
  try { return await registry.waitForBridge(PRIMARY_BRIDGE_ALIAS, graceMs) } catch { return false }
}

/** One `session.control` delivery to the primary, after riding out a blip. */
type PrimaryControlSend =
  | { ok: true; reply: Record<string, unknown> }
  | {
    ok: false
    error: unknown
    /** The failure was BridgeOfflineError: nothing reached a socket. */
    offline: boolean
    /** Latest bridge loss (epoch ms), read only on the offline path. */
    lastLossAt: number | null
    /** The grace spent waiting for a reconnect that never came (0 = no wait). */
    waitedMs: number
  }

async function sendControlToPrimary(
  action: SessionControlAction,
  sessionId: string,
  params: Record<string, unknown> | undefined,
  timeoutMs: number,
): Promise<PrimaryControlSend> {
  const registry = await import('../ws/bridge-registry.js')
  const payload = { action, sessionId, ...(params !== undefined ? { params } : {}) }
  const startedAt = Date.now()
  const send = (budgetMs: number): Promise<Record<string, unknown>> =>
    registry.bridgeRequest(PRIMARY_BRIDGE_ALIAS, 'session.control', payload, budgetMs)

  try {
    return { ok: true, reply: await send(timeoutMs) }
  } catch (err) {
    if (!isBridgeOffline(registry, err)) {
      return { ok: false, error: err, offline: false, lastLossAt: null, waitedMs: 0 }
    }
    const lastLossAt = readLossClock(registry)
    const freshLoss = lastLossAt !== null && Date.now() - lastLossAt <= BRIDGE_BLIP_FRESHNESS_MS
    // The grace comes OUT of the caller's budget and never takes more than half
    // of it, so the send after a reconnect still has real time and the whole call
    // stays inside the deadline the caller sized its own timeout for.
    const graceMs = freshLoss ? Math.min(bridgeBlipGraceMs(), Math.floor(timeoutMs / 2)) : 0
    if (graceMs <= 0) return { ok: false, error: err, offline: true, lastLossAt, waitedMs: 0 }

    const reconnected = await waitForPrimaryBridge(registry, graceMs)
    log.web.info('control relay: primary bridge missing, waited for a redial', {
      action, sessionId, reconnected, graceMs, elapsedMs: Date.now() - startedAt,
    })
    if (!reconnected) return { ok: false, error: err, offline: true, lastLossAt, waitedMs: graceMs }

    const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt))
    try {
      return { ok: true, reply: await send(remainingMs) }
    } catch (sendErr) {
      // Final either way. A link that came back and is already gone again sent
      // nothing, but that is an outage rather than a blip, so it gets an answer
      // instead of a second wait; any other failure happened after the send.
      const offline = isBridgeOffline(registry, sendErr)
      return {
        ok: false, error: sendErr, offline,
        lastLossAt: offline ? readLossClock(registry) : null, waitedMs: 0,
      }
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

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
  timeoutMs = CONTROL_RELAY_TIMEOUT_MS,
): Promise<Record<string, unknown> | null> {
  const sent = await sendControlToPrimary(action, sessionId, params, timeoutMs)
  if (sent.ok) return sent.reply
  if (sent.offline) {
    // Same sentence as session-launch-v1.ts. The duration is strictly diagnostic
    // (an unreadable loss clock means the plain wording, never a different
    // status), and waitedMs is non-zero only when a wait really happened.
    sendV1Error(res, 503, 'bridge_offline', bridgeOfflineMessage(sent.lastLossAt, sent.waitedMs))
    return null
  }
  // Sent, then failed (timeout, socket dropped mid-request): ambiguous, so it is
  // reported verbatim and never retried.
  sendV1Error(res, 503, 'bridge_offline', errorText(sent.error))
  return null
}

/**
 * Why a relay reply failed, in the ONE vocabulary every caller branches on.
 *
 *   needs_upgrade:  the primary (or its daemon) predates this action. Self-heals
 *                   on the next primary deploy/reconnect; a caller with a legacy
 *                   delivery lane should use it (see core/task-queue.ts).
 *   bridge_offline: the primary could not be reached (no bridge, a relay timeout,
 *                   or a daemon whose walnut server is down); retry later.
 *                   `notSent` says whether the request provably never ran.
 *   error:          the action ran and failed for a domain reason.
 */
export type RelayFailure =
  | { kind: 'needs_upgrade'; message: string }
  | {
    kind: 'bridge_offline'
    message: string
    /**
     * true: provably never delivered, so the primary did not run the action and
     * a caller may run or re-send it without risking a duplicate. Set for no
     * live bridge (still none after the blip grace) and for a daemon answering
     * "no primary server connected" (it had nobody to forward to).
     * false or absent: the request went out and then failed (a timeout, a socket
     * that dropped mid-request), so the primary MAY have started it.
     */
    notSent?: boolean
  }
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
    // The daemon answers this before forwarding anything (it found no server to
    // forward to), so the action did not run: notSent.
    return {
      kind: 'bridge_offline',
      message: 'Your primary box (Mac) is offline — the session\'s host is fine; retrying automatically',
      notSent: true,
    }
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
 * caller can pick its own fallback lane. The whole call, blip grace included,
 * stays inside `timeoutMs`.
 */
export async function callPrimaryControl(
  action: SessionControlAction,
  sessionId: string,
  params: Record<string, unknown> | undefined,
  timeoutMs = CONTROL_RELAY_TIMEOUT_MS,
): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; failure: RelayFailure }> {
  const sent = await sendControlToPrimary(action, sessionId, params, timeoutMs)
  if (!sent.ok) {
    // No bridge and a request timeout share the kind (both mean "retry later"),
    // but only the first proves nothing ran; notSent is how a caller tells them
    // apart. The message stays the raw transport error, as before.
    return {
      ok: false,
      failure: { kind: 'bridge_offline', message: errorText(sent.error), notSent: sent.offline },
    }
  }
  const reply = sent.reply
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
