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
 */

import { Router } from 'express'
import { getConfig, updatePushTokens } from '../../core/config-manager.js'
import { log } from '../../logging/index.js'
import { apnsStatus } from '../../core/push/apns.js'
import { tokenKind } from '../../core/push/send.js'
import { ACTIVE_LEASE_MS, parseMode } from '../../core/push/letter-push-policy.js'
import { LETTER_TYPES } from '../../core/human-inbox/types.js'
import type { PushTokenEntry } from '../../core/types.js'

export const pushRouter = Router()

/**
 * An APNs device token is 32+ bytes of hex; Expo's is a bracketed string. Bound
 * the length because this value is interpolated into an APNs request path.
 */
const APNS_TOKEN_RE = /^[0-9a-fA-F]{64,200}$/
const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{1,120}\]$/

function validToken(token: string): boolean {
  return APNS_TOKEN_RE.test(token) || EXPO_TOKEN_RE.test(token)
}

/** The caller's device identity, or null for a trusted-LAN request with none. */
function deviceOf(req: { deviceName?: string; apiKeyName?: string }): string | null {
  return req.deviceName ?? req.apiKeyName ?? null
}

// POST /api/push/register — register a device push token
pushRouter.post('/register', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as {
      token?: string
      platform?: string
      environment?: string
      mode?: string
      letterTypes?: unknown
    }
    const token = typeof body.token === 'string' ? body.token.trim() : ''

    if (!token) {
      res.status(400).json({ error: 'Missing or invalid token' })
      return
    }
    if (!validToken(token)) {
      // Refuse rather than store: an unusable token would fail on every push
      // and look like a broken sender forever.
      res.status(400).json({ error: 'Token is not a valid APNs (hex) or Expo push token' })
      return
    }
    if (!body.platform || !['ios', 'android'].includes(body.platform)) {
      res.status(400).json({ error: 'Missing or invalid platform (ios/android)' })
      return
    }

    const identity = deviceOf(req as never)
    const keyName = identity ?? 'localhost'
    const kind = tokenKind({ token })
    const environment = body.environment === 'sandbox' ? 'sandbox' : 'production'

    let entry!: PushTokenEntry
    await updatePushTokens((tokens) => {
      const previous = tokens.find((t) => t.token === token)
      // Upsert by token, and drop any OTHER token previously registered by this
      // same device: APNs mints a fresh token on reinstall, and leaving the old
      // one behind means every push also goes to a dead token forever.
      //
      // That same-device sweep is skipped for an UNAUTHENTICATED (trusted-LAN)
      // request: those carry no device identity, so every one of them would
      // share the 'localhost' name and each new phone would delete the previous
      // phone's row. Without an identity we can only key on the token itself.
      const filtered = tokens.filter((t) => (
        t.token !== token && !(identity !== null && t.key_name === keyName)
      ))
      entry = {
        token,
        platform: body.platform as 'ios' | 'android',
        kind,
        ...(kind === 'apns' ? { environment } : {}),
        key_name: keyName,
        registered_at: new Date().toISOString(),
        // Registration must not silently reset a mode the user already chose.
        mode: body.mode !== undefined ? parseMode(body.mode) : (previous?.mode ?? 'always'),
        ...(previous?.letter_types ? { letter_types: previous.letter_types } : {}),
      }
      if (Array.isArray(body.letterTypes)) {
        const clean = body.letterTypes.filter(
          (t): t is string => typeof t === 'string' && (LETTER_TYPES as readonly string[]).includes(t),
        )
        if (clean.length > 0) entry.letter_types = clean
      }
      return [...filtered, entry]
    })
    log.notif.info('push: token registered', {
      keyName, platform: body.platform, kind, environment, mode: entry.mode,
      tokenPrefix: token.slice(0, 12),
    })
    // Report the credential state back so the app can tell the user "registered,
    // but the server has no APNs key yet" instead of waiting for silence.
    const apns = await apnsStatus()
    res.json({ ok: true, kind, mode: entry.mode, deliverable: kind === 'expo' || apns.configured })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/push/register — unregister a push token
pushRouter.delete('/register', async (req, res, next) => {
  try {
    const { token } = (req.body ?? {}) as { token?: string }
    if (!token) {
      res.status(400).json({ error: 'Missing token' })
      return
    }
    await updatePushTokens((tokens) => {
      const filtered = tokens.filter((t) => t.token !== token)
      return filtered.length === tokens.length ? null : filtered
    })
    log.notif.info('push: token unregistered', { tokenPrefix: token.slice(0, 12) })
    res.json({ ok: true })
  } catch (err) {
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
    const device = deviceOf(req as never)
    if (!device) {
      res.status(400).json({ error: 'This endpoint requires a device Bearer token' })
      return
    }
    const mode = parseMode(body.mode)
    let letterTypes: string[] | undefined
    if (Array.isArray(body.letterTypes)) {
      letterTypes = body.letterTypes.filter(
        (t): t is string => typeof t === 'string' && (LETTER_TYPES as readonly string[]).includes(t),
      )
    }

    let found = 0
    await updatePushTokens((tokens) => {
      const next = tokens.map((t) => {
        if (t.key_name !== device) return t
        found++
        const copy: PushTokenEntry = { ...t, mode }
        if (letterTypes !== undefined) {
          if (letterTypes.length > 0) copy.letter_types = letterTypes
          else delete copy.letter_types
        }
        return copy
      })
      return found === 0 ? null : next
    })
    if (found === 0) {
      // Not an error the user can act on from the app's side, but it must not
      // read as success — the setting would silently not apply.
      res.status(404).json({ error: 'This device has no registered push token' })
      return
    }
    log.notif.info('push: preferences updated', { device, mode, letterTypes })
    res.json({ ok: true, mode, ...(letterTypes ? { letterTypes } : {}) })
  } catch (err) {
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
    const device = deviceOf(req as never)
    if (!device) {
      res.status(400).json({ error: 'This endpoint requires a device Bearer token' })
      return
    }
    const active = body.active !== false
    let mine = 0
    let applied = 0
    await updatePushTokens((tokens) => {
      const next = tokens.map((t) => {
        if (t.key_name !== device) return t
        mine++
        // Only devices actually using the Slack-style mode need this written at
        // all. In `always` mode the value is never read, so skip the write and
        // the backup churn a foreground heartbeat would otherwise cause.
        if (parseMode(t.mode) !== 'when-inactive') return t
        applied++
        const copy: PushTokenEntry = { ...t }
        if (active) copy.active_at = Date.now()
        else delete copy.active_at
        return copy
      })
      return applied === 0 ? null : next
    })
    if (mine === 0) {
      res.status(404).json({ error: 'This device has no registered push token' })
      return
    }
    res.json({ ok: true, applied: applied > 0, leaseMs: ACTIVE_LEASE_MS })
  } catch (err) {
    next(err)
  }
})

// GET /api/push/status — registration + credential status
pushRouter.get('/status', async (req, res, next) => {
  try {
    const config = await getConfig()
    const tokens = config.push_tokens ?? []
    const apns = await apnsStatus()
    const device = deviceOf(req as never)
    const mine = tokens.find((t: PushTokenEntry) => t.key_name === device)
    res.json({
      registered: tokens.length > 0,
      count: tokens.length,
      // The whole point of surfacing this: "registered but undeliverable" is the
      // state a missing APNs key produces, and it must be visible rather than
      // looking like pushes that just never arrive.
      apns: {
        configured: apns.configured,
        environment: apns.environment,
        topic: apns.topic,
        ...(apns.reason ? { reason: apns.reason } : {}),
        ...(apns.lastError ? { lastError: apns.lastError } : {}),
      },
      ...(mine ? { thisDevice: { mode: parseMode(mine.mode), kind: tokenKind(mine), letterTypes: mine.letter_types } } : {}),
      tokens: tokens.map((t: PushTokenEntry) => ({
        platform: t.platform,
        kind: tokenKind(t),
        key_name: t.key_name,
        registered_at: t.registered_at,
        mode: parseMode(t.mode),
        // Don't expose the full token — it's a send capability for this device.
        token_prefix: t.token.slice(0, 12) + '...',
      })),
    })
  } catch (err) {
    next(err)
  }
})
