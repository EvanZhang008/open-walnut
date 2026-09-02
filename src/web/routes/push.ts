/**
 * Push notification registration + per-device notification preferences.
 *
 * POST   /api/push/register     register a device token (APNs or legacy Expo)
 * DELETE /api/push/register     unregister a token
 * GET    /api/push/status       registration + credential status (honest about gaps)
 * POST   /api/push/preferences  set this device's mode / muted letter types
 * POST   /api/push/active       "this app is in the foreground" (a short lease)
 *
 * Every route identifies the device by its BEARER TOKEN (`req.deviceName`, set
 * by authMiddleware), never by a name in the body — otherwise any paired device
 * could rewrite another's preferences or mute its notifications.
 *
 * REPLICA: every route here relays to the primary over `server.push.*`.
 * The rows live in `config.yaml` (machine-local, never synced) and the sender +
 * APNs key live on the primary, so a replica that answered locally stored the
 * phone's token on the one box that can never push — which is exactly the bug
 * this relay fixes. There is no local write on a cloud box at all: one owner
 * (the primary), one store, and a truthful 503 when the bridge is down so the
 * app retries instead of believing a token was accepted.
 */

import { Router, type Request, type Response } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import {
  PushRegistryError,
  localTokenCount,
  pushRegistrationStatus,
  registerPushToken,
  reportDeviceActive,
  revokeDevicePushTokens,
  setDevicePushPreferences,
  unregisterPushToken,
} from '../../core/push/registry.js'
import { callPrimaryControl } from './v1-control-relay.js'
import type { SessionControlAction } from '../../core/sessions/session-controls.js'

export const pushRouter = Router()

/** Relay actions ignore sessionId; pass the same placeholder as human-inbox. */
const SERVER_RELAY_SID = '__server__'

/** The caller's device identity, or null for a trusted-LAN request with none. */
function deviceOf(req: Request): string | null {
  const r = req as Request & { deviceName?: string; apiKeyName?: string }
  return r.deviceName ?? r.apiKeyName ?? null
}

/**
 * Errors answer the standard `{ error: { code, message } }` envelope.
 *
 * These routes predate the frozen v1 contract in their PATH, but the envelope is
 * what every client can actually read: the iOS transport decodes exactly this
 * shape for any non-2xx and otherwise degrades to a generic `http_error`, which
 * throws away the reason. The codes matter to behavior, not just to humans:
 * `device_not_registered` tells an app its token never landed on the box it is
 * paired to, and `retry` says out loud that nothing was stored and the request
 * should be made again.
 */
function sendPushError(
  res: Response, status: number, code: string, message: string, retry = false,
): void {
  res.status(status).json({ error: { code, message }, ...(retry ? { retry: true } : {}) })
}

function reportRegistryError(res: Response, err: unknown): boolean {
  if (!(err instanceof PushRegistryError)) return false
  sendPushError(res, err.status, err.code, err.message)
  return true
}

/**
 * Warn ONCE per process when a replica still carries token rows written by the
 * pre-relay code. They are inert now (this box never sends and never writes
 * them), but leaving them unmentioned is how the split-brain hid for so long.
 */
let warnedOrphans = false
async function warnOrphanReplicaTokens(): Promise<void> {
  if (warnedOrphans) return
  warnedOrphans = true
  const count = await localTokenCount()
  if (count === 0) return
  log.notif.warn('push: replica holds orphan token rows — the primary owns registrations now', {
    count,
    hint: 'delete push_tokens from this box\'s config.yaml; nothing reads them here',
  })
}

/** Test seam for the once-per-process orphan warning. */
export function resetPushRouteWarningsForTests(): void { warnedOrphans = false }

/**
 * Forward one push route to the primary. Returns the primary's result, or null
 * after having answered an honest error.
 *
 * Failure mapping, all chosen so the phone RETRIES rather than recording a
 * success it never got (iOS only remembers a token as uploaded on a 2xx —
 * ios-native/Walnut/Core/PushRegistration.swift):
 *   - bridge down / primary's server down → 503 + retry
 *   - primary predates the action (needs_upgrade) → 503 + retry; it self-heals
 *     on the primary's next deploy, so it is a wait, not a client bug
 *   - domain error (bad token, unknown device) → the primary's own status
 */
async function relayToPrimary(
  res: Response,
  action: SessionControlAction,
  params: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  await warnOrphanReplicaTokens()
  const outcome = await callPrimaryControl(action, SERVER_RELAY_SID, params)
  if (outcome.ok) return outcome.result
  const failure = outcome.failure
  if (failure.kind === 'bridge_offline') {
    log.notif.warn('push: relay to primary failed — bridge offline', { action, error: failure.message })
    sendPushError(res, 503, 'bridge_offline',
      'Your primary box is offline, so the push token could not be stored yet — it will be sent again', true)
    return null
  }
  if (failure.kind === 'needs_upgrade') {
    log.notif.warn('push: primary predates the push relay', { action, error: failure.message })
    sendPushError(res, 503, 'primary_needs_upgrade',
      'The primary box predates push relay — it upgrades on its next deploy, and the token will be sent again then', true)
    return null
  }
  log.notif.warn('push: relay to primary rejected', { action, status: failure.status, error: failure.message })
  sendPushError(res, failure.status, failure.code, failure.message)
  return null
}

/**
 * A pairing was revoked — drop that device's push rows, wherever they live.
 *
 * Called by BOTH revoke routes (`DELETE /api/devices/:name` and
 * `DELETE /api/auth/keys/:name`), which is the point: this is a privacy
 * operation. A revoked or lost phone whose row survives keeps receiving letter
 * subjects and up to 300 characters of preview on its lock screen, and the row
 * now lives on the PRIMARY, so the box handling the revoke is usually not the box
 * holding the row.
 *
 * Never throws and never fails the revoke: the pairing itself is already gone
 * (the device's token no longer authenticates), so a bridge outage must not leave
 * the device paired. It reports `pending` instead, loudly, so the console and the
 * log say the pushes may not have stopped yet.
 */
export async function revokePushTokensForDevice(
  name: string,
): Promise<{ removed: number; relayed: boolean; pending?: string }> {
  // Local rows first, on every box. On the primary these are the device's own
  // rows; on a replica they can only be orphans from before the relay existed,
  // and a revoke is exactly the right moment to stop carrying them.
  let removed = 0
  let localFailure: string | undefined
  try {
    removed = (await revokeDevicePushTokens(name, 'local')).removed
  } catch (err) {
    // A swallowed write failure here answered `removed: 0` with no `pending` —
    // byte-identical to "that device had no rows" while the row survived and kept
    // pushing. Reporting fine while nothing happened is the whole failure mode
    // this file exists to remove, so the failure travels with the result.
    localFailure = err instanceof Error ? err.message : String(err)
    log.notif.warn('push: local token revoke failed — this device may still receive letters', {
      device: name, error: localFailure,
    })
  }
  if (!CLOUD_MODE) {
    return { removed, relayed: false, ...(localFailure ? { pending: localFailure } : {}) }
  }

  const outcome = await callPrimaryControl('server.push.revoke-device', SERVER_RELAY_SID, { keyName: name })
  if (outcome.ok) {
    const relayedRemoved = typeof outcome.result.removed === 'number' ? outcome.result.removed : 0
    log.notif.info('push: relayed device revoke to the primary', { device: name, removed: relayedRemoved })
    return { removed: removed + relayedRemoved, relayed: true }
  }
  // The device is unpaired but its phone may still buzz until this lands. Say so.
  log.notif.warn('push: could not revoke this device\'s tokens on the primary — it may still receive letters', {
    device: name, reason: outcome.failure.message, kind: outcome.failure.kind,
  })
  return { removed, relayed: false, pending: outcome.failure.message }
}

// POST /api/push/register — register a device push token
pushRouter.post('/register', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const params = {
      token: typeof body.token === 'string' ? body.token.trim() : body.token,
      platform: body.platform,
      environment: body.environment,
      ...(body.mode !== undefined ? { mode: body.mode } : {}),
      ...(body.letterTypes !== undefined ? { letterTypes: body.letterTypes } : {}),
      keyName: deviceOf(req),
    }
    if (CLOUD_MODE) {
      // The primary stamps `origin: 'relay'` itself (core/push/relay.ts) — a
      // replica cannot be trusted to label its own rows, and the label is what
      // keeps two boxes' identically-named devices apart.
      const result = await relayToPrimary(res, 'server.push.register', params)
      if (result) res.json(result)
      return
    }
    res.json(await registerPushToken({ ...params, origin: 'local' }))
  } catch (err) {
    if (reportRegistryError(res, err)) return
    next(err)
  }
})

// DELETE /api/push/register — unregister a push token
pushRouter.delete('/register', async (req, res, next) => {
  try {
    const { token } = (req.body ?? {}) as { token?: unknown }
    if (CLOUD_MODE) {
      const result = await relayToPrimary(res, 'server.push.unregister', { token })
      if (result) res.json({ ok: true })
      return
    }
    await unregisterPushToken(token)
    res.json({ ok: true })
  } catch (err) {
    if (reportRegistryError(res, err)) return
    next(err)
  }
})

/**
 * POST /api/push/preferences — this device's notification mode.
 *
 * `{ mode: 'always' | 'when-inactive', letterTypes?: string[] }`. Scoped to the
 * calling device by its bearer token: two phones can hold different modes, and
 * neither can change the other's.
 */
pushRouter.post('/preferences', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as { mode?: unknown; letterTypes?: unknown }
    const device = deviceOf(req)
    if (CLOUD_MODE) {
      const result = await relayToPrimary(res, 'server.push.preferences', {
        mode: body.mode,
        ...(body.letterTypes !== undefined ? { letterTypes: body.letterTypes } : {}),
        keyName: device,
      })
      if (result) res.json(result)
      return
    }
    res.json(await setDevicePushPreferences(device, body))
  } catch (err) {
    if (reportRegistryError(res, err)) return
    next(err)
  }
})

/**
 * POST /api/push/active — "my app is on screen right now".
 *
 * Only meaningful for `when-inactive`; the app reports it while foregrounded and
 * the server treats it as a short LEASE (see letter-push-policy.ts), so a phone
 * that is force-quit or loses the network decays back to receiving pushes rather
 * than muting itself forever. `{ active: false }` releases the lease immediately
 * on backgrounding, so the very next letter buzzes.
 *
 * Deliberately cheap and best-effort: it writes a timestamp, and in `always`
 * mode (the default) it changes nothing at all.
 */
pushRouter.post('/active', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as { active?: unknown }
    const active = body.active !== false
    const device = deviceOf(req)
    if (CLOUD_MODE) {
      const result = await relayToPrimary(res, 'server.push.active', { active, keyName: device })
      if (result) res.json(result)
      return
    }
    res.json(await reportDeviceActive(device, active))
  } catch (err) {
    if (reportRegistryError(res, err)) return
    next(err)
  }
})

// GET /api/push/status — registration + credential status
pushRouter.get('/status', async (req, res, next) => {
  try {
    const device = deviceOf(req)
    if (CLOUD_MODE) {
      // Relayed, not answered locally: this box's own (empty, or orphaned) rows
      // would report "not registered" about a phone that IS registered on the
      // primary — the exact lie that made the split-brain invisible.
      const result = await relayToPrimary(res, 'server.push.status', { keyName: device })
      if (result) res.json({ ...result, via: 'primary' })
      return
    }
    res.json(await pushRegistrationStatus(device))
  } catch (err) {
    if (reportRegistryError(res, err)) return
    next(err)
  }
})
