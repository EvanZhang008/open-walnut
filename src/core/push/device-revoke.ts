/**
 * A pairing was revoked: drop that device's push rows, wherever they live.
 *
 * A revoked or lost phone whose row survives keeps receiving letter subjects and
 * up to 300 characters of preview on its lock screen, and the row lives on the
 * PRIMARY, so the box handling the revoke is often not the box holding the row.
 *
 * Callers do not call this directly. Every revoke goes through `revokePairing`
 * in core/device-auth.ts (the console route, `walnut device revoke`, a twin
 * revoked by hash, a re-pair by someone other than the device), and that is the
 * one place that runs it, so no revoke path can forget. `DELETE
 * /api/auth/keys/:name` calls it for an API key, which is not a pairing.
 *
 * Never throws and never fails the revoke: the pairing itself is already gone
 * (the device's token no longer authenticates), so a bridge outage must not
 * leave the device paired. A part that can land later (the bridge is down, the
 * primary predates the action, or this is the `walnut device revoke` process,
 * which has no bridge at all) goes to the revoke queue
 * (core/devices/revoke-queue.ts), which the running server finishes. The sender
 * also checks each row at send time (paired-rows.ts).
 *
 * `takeBackPushRegistration` is the companion's undo of one relayed write, for
 * a pairing that went while the write was on its way (web/routes/push.ts).
 */

import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { revokeDevicePushTokens, takeBackPushToken } from './registry.js'
import { pushClaimOfPairingHash } from './claims.js'

/** Relay actions ignore sessionId; the same placeholder as the other server relays. */
const SERVER_RELAY_SID = '__server__'

export interface PushRevokeOutcome {
  /** Rows removed here and, on a replica, on the primary. */
  removed: number
  /** True when the primary confirmed its part (replica only). */
  relayed: boolean
  /** Why some rows may still push, when they may. */
  pending?: string
  /** The pending part can still land: a transport failure, not a refusal. */
  retry?: boolean
  /** The pending part was queued for the server to finish (core/devices/revoke-queue.ts). */
  queued?: boolean
  /**
   * Which part is pending: `here` = this box's own rows (its config write
   * failed), `primary` = the primary's rows (not reached, or refused), `both`.
   */
  pendingWhere?: 'here' | 'primary' | 'both'
}

/**
 * `queue: false` is the revoke queue's own retry: it keeps its entry on a
 * failure instead of writing a second one.
 *
 * `revokedAt` (ISO, this box's clock; default now) is when the pairing went.
 * Only rows registered before it are removed, here and on the primary: when a
 * queued step runs late, the name may have been paired again meanwhile, and
 * the new pairing's rows are not the revoked phone's.
 */
export async function revokePushTokensForDevice(
  name: string,
  opts: { queue?: boolean; revokedAt?: string } = {},
): Promise<PushRevokeOutcome> {
  const parsed = opts.revokedAt !== undefined ? Date.parse(opts.revokedAt) : NaN
  const revokedAtMs = Number.isFinite(parsed) ? parsed : Date.now()
  const outcome = await revokeOnce(name, revokedAtMs)
  if (!outcome.pending || !outcome.retry || opts.queue === false) return outcome
  const { enqueueRevokeStep } = await import('../devices/revoke-queue.js')
  return { ...outcome, queued: (await enqueueRevokeStep({ step: 'push', name, revokedAt: new Date(revokedAtMs).toISOString() })) !== null }
}

async function revokeOnce(name: string, revokedAtMs: number): Promise<PushRevokeOutcome> {
  // Local rows first, on every box. On the primary these are the device's own
  // rows; on a replica they can only be orphans from before the relay existed,
  // and a revoke is exactly the right moment to stop carrying them.
  let removed = 0
  let localFailure: string | undefined
  try {
    removed = (await revokeDevicePushTokens(name, 'local', { registeredBefore: revokedAtMs })).removed
  } catch (err) {
    // A swallowed write failure answered `removed: 0` with no `pending`, the same
    // as "that device had no rows", while the row survived and kept pushing.
    localFailure = err instanceof Error ? err.message : String(err)
    log.notif.warn('push: local token revoke failed, this device may still receive letters', {
      device: name, error: localFailure,
    })
  }
  if (!CLOUD_MODE) {
    return { removed, relayed: false, ...(localFailure ? { pending: localFailure, retry: true, pendingWhere: 'here' } : {}) }
  }

  const { callPrimaryControl } = await import('../../web/routes/v1-control-relay.js')
  // An age rather than a time: the primary judges its rows on its own clock.
  const outcome = await callPrimaryControl('server.push.revoke-device', SERVER_RELAY_SID, {
    keyName: name, revokedMsAgo: Math.max(0, Date.now() - revokedAtMs),
  })
  if (outcome.ok) {
    const relayedRemoved = typeof outcome.result.removed === 'number' ? outcome.result.removed : 0
    log.notif.info('push: relayed device revoke to the primary', { device: name, removed: relayedRemoved })
    return {
      removed: removed + relayedRemoved, relayed: true,
      ...(localFailure ? { pending: localFailure, retry: true, pendingWhere: 'here' } : {}),
    }
  }
  // The device is unpaired but its phone may still buzz until this lands. Say so.
  log.notif.warn('push: could not revoke this device\'s tokens on the primary, it may still receive letters', {
    device: name, reason: outcome.failure.message, kind: outcome.failure.kind,
  })
  return {
    removed, relayed: false,
    pending: localFailure ? `${localFailure}; ${outcome.failure.message}` : outcome.failure.message,
    // A refusal (`error`) answers the same way every time; an outage or an older primary does not.
    retry: !!localFailure || outcome.failure.kind !== 'error',
    pendingWhere: localFailure ? 'both' : 'primary',
  }
}

/** One relayed registration to undo: whose row, which token (its sha256). */
export interface PushTakeBack {
  name: string
  tokenSha: string
}

/**
 * Undo a registration the companion relayed for a pairing that went while it
 * was on its way (web/routes/push.ts, core/push/claims.ts). The row stays only
 * when a pairing of the name that still holds here has its claim on it; the
 * live pairings are read on every try, so a queued take-back judges by the
 * pairings of when it runs. Never throws. When the primary cannot take it now
 * (an outage, an older primary), it is queued for the server to finish, unless
 * `queue: false` (the queue's own retry).
 */
export async function takeBackPushRegistration(
  t: PushTakeBack,
  opts: { queue?: boolean } = {},
): Promise<PushRevokeOutcome> {
  const outcome = await takeBackOnce(t)
  if (!outcome.pending || !outcome.retry || opts.queue === false) return outcome
  const { enqueueRevokeStep } = await import('../devices/revoke-queue.js')
  return { ...outcome, queued: (await enqueueRevokeStep({ step: 'takeback', name: t.name, tokenSha: t.tokenSha })) !== null }
}

/** The claims of `name`'s pairings that authenticate here right now (none when it has none). */
async function liveClaimsOf(name: string): Promise<string[]> {
  const { livePairingHashesOf } = await import('../device-auth.js')
  return (await livePairingHashesOf(name)).map(pushClaimOfPairingHash)
}

async function takeBackOnce(t: PushTakeBack): Promise<PushRevokeOutcome> {
  const liveClaims = await liveClaimsOf(t.name)
  if (!CLOUD_MODE) {
    // The rows are here (a take-back queued before this box stopped being a companion).
    try {
      return { removed: (await takeBackPushToken(t.name, t.tokenSha, liveClaims)).removed, relayed: false }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.notif.warn('push: could not take back a registration here', { device: t.name, error: message })
      return { removed: 0, relayed: false, pending: message, retry: true, pendingWhere: 'here' }
    }
  }
  const { callPrimaryControl } = await import('../../web/routes/v1-control-relay.js')
  const outcome = await callPrimaryControl('server.push.take-back', SERVER_RELAY_SID, {
    keyName: t.name, tokenSha: t.tokenSha, liveClaims,
  })
  if (outcome.ok) {
    const removed = typeof outcome.result.removed === 'number' ? outcome.result.removed : 0
    log.notif.info('push: took back a relayed registration on the primary', { device: t.name, removed })
    return { removed, relayed: true }
  }
  log.notif.warn('push: could not take back a relayed registration on the primary, the device may still receive letters', {
    device: t.name, reason: outcome.failure.message, kind: outcome.failure.kind,
  })
  return {
    removed: 0, relayed: false, pending: outcome.failure.message,
    retry: outcome.failure.kind !== 'error', pendingWhere: 'primary',
  }
}
