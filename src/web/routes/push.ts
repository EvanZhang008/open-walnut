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
  setDevicePushPreferences,
  unregisterPushToken,
} from '../../core/push/registry.js'
import { pairingRefHolds, pairingRefOf, whilePairingHolds, type PairingRef } from '../../core/device-auth.js'
import { revokePushTokensForDevice, takeBackPushRegistration } from '../../core/push/device-revoke.js'
import { pushClaimOf, pushTokenSha } from '../../core/push/claims.js'
import { callPrimaryControl, type RelayFailure } from './v1-control-relay.js'
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
  answerRelayFailure(res, action, outcome.failure)
  return null
}

function answerRelayFailure(res: Response, action: SessionControlAction, failure: RelayFailure): void {
  if (failure.kind === 'bridge_offline') {
    log.notif.warn('push: relay to primary failed — bridge offline', { action, error: failure.message })
    sendPushError(res, 503, 'bridge_offline',
      'Your primary box is offline, so the push token could not be stored yet — it will be sent again', true)
    return
  }
  if (failure.kind === 'needs_upgrade') {
    log.notif.warn('push: primary predates the push relay', { action, error: failure.message })
    sendPushError(res, 503, 'primary_needs_upgrade',
      'The primary box predates push relay — it upgrades on its next deploy, and the token will be sent again then', true)
    return
  }
  log.notif.warn('push: relay to primary rejected', { action, status: failure.status, error: failure.message })
  sendPushError(res, failure.status, failure.code, failure.message)
}

// The revoke-a-device helper lives in core (core/push/device-revoke.ts): every
// revoke path, the CLI included, runs it through device-auth's revokePairing.
export { revokePushTokensForDevice }

/**
 * The pairing a request authenticated as, for a paired device's bearer token;
 * null for anything else (an API key, a trusted-LAN request with no token).
 * 'gone' = revoked since the auth middleware let it in.
 */
async function callerPairing(req: Request): Promise<PairingRef | 'gone' | null> {
  const name = (req as Request & { deviceName?: string }).deviceName
  const bearer = bearerOf(req)
  if (!name || !bearer) return null
  const ref = await pairingRefOf(bearer)
  return ref && ref.name === name ? ref : 'gone'
}

function bearerOf(req: Request): string | null {
  const header = req.headers.authorization
  return header?.startsWith('Bearer ') ? header.slice(7) : null
}

const unpaired = (res: Response) => sendPushError(res, 401, 'token_refused', 'This device was unpaired, so its push token was not kept')

/**
 * The Mac: check the pairing and write the row under the auth lock
 * (whilePairingHolds). A revoke holds that lock from its write-ahead until its
 * auth.json write and the revoke time it takes right after, so the row is
 * older than that cutoff and the revoke removes it, or the write sees the
 * pairing gone and never happens. Nothing to take back afterwards.
 */
async function registerOnThisBox(res: Response, params: Record<string, unknown>, pairing: PairingRef | null): Promise<void> {
  const write = async () => await registerPushToken({ ...params, origin: 'local' }) as unknown as Record<string, unknown>
  if (!pairing) {
    res.json(await write())
    return
  }
  const out = await whilePairingHolds(pairing, write)
  if (out === null) {
    sendPushError(res, 503, 'pairings_busy', 'This box is busy updating its pairings, so the push token was not stored yet. It will be sent again', true)
    return
  }
  if (out === 'gone') {
    log.notif.warn('push: the device was unpaired while it registered; nothing was stored', { device: pairing.name })
    unpaired(res)
    return
  }
  res.json(out.value)
}

/**
 * A companion relays the write to the primary, so it cannot hold its own lock
 * across it. Each relayed write carries the claim of the pairing that made it
 * (core/push/claims.ts), and whenever the write may have landed for a pairing
 * that is gone by now, that write is taken back on the primary (queued when the
 * primary cannot take it now):
 *  - the pairing went while the write was on its way, whether the primary's
 *    answer came back or was lost on the way (a timeout, a dropped link);
 *  - the pairing went between the auth check that let the request in and the
 *    check here. A retry with a token revoked before it arrived never gets
 *    here: the auth middleware refuses it.
 * The row stays when a pairing of the name that still holds has registered it
 * (the same phone, paired again under its name).
 */
async function registerThroughPrimary(
  req: Request, res: Response, params: Record<string, unknown>, pairing: PairingRef | 'gone' | null,
): Promise<void> {
  const name = (req as Request & { deviceName?: string }).deviceName
  const bearer = bearerOf(req)
  const claim = bearer ? pushClaimOf(bearer) : null
  const takeBack = async (device: string) => {
    if (!bearer || typeof params.token !== 'string' || !params.token) return
    await takeBackPushRegistration({ name: device, tokenSha: pushTokenSha(params.token) })
  }
  if (pairing === 'gone') {
    if (name) await takeBack(name)
    unpaired(res)
    return
  }
  await warnOrphanReplicaTokens()
  // The primary stamps `origin: 'relay'` itself (core/push/relay.ts): a
  // replica cannot be trusted to label its own rows, and the label is what
  // keeps two boxes' identically-named devices apart.
  const outcome = await callPrimaryControl('server.push.register', SERVER_RELAY_SID, { ...params, ...(pairing && claim ? { claim } : {}) })
  const mayHaveLanded = outcome.ok || (outcome.failure.kind === 'bridge_offline' && outcome.failure.notSent !== true)
  if (pairing && mayHaveLanded && !(await pairingRefHolds(pairing))) {
    log.notif.warn('push: the device was unpaired while it registered; its row is taken back', { device: pairing.name, answered: outcome.ok })
    await takeBack(pairing.name)
    unpaired(res)
    return
  }
  if (!outcome.ok) {
    answerRelayFailure(res, 'server.push.register', outcome.failure)
    return
  }
  res.json(outcome.result)
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
    // The pairing the bearer token authenticated as. A revoke can land while
    // the registration is on its way, after the auth middleware let it in, and
    // a row written for a revoked pairing would push letters to the revoked phone.
    const pairing = await callerPairing(req)
    if (CLOUD_MODE) {
      await registerThroughPrimary(req, res, params, pairing)
      return
    }
    if (pairing === 'gone') {
      unpaired(res)
      return
    }
    await registerOnThisBox(res, params, pairing)
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
