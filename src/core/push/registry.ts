/**
 * The ONE owner of `config.push_tokens` — device registration, per-device
 * preferences, the foreground lease, and the status readout.
 *
 * WHY this is a core module rather than route code: the rows live in
 * `config.yaml`, which is MACHINE-LOCAL and permanently excluded from data sync
 * (see the CRITICAL_IGNORE_FILES rationale in integrations/git-sync.ts). A cloud
 * replica that answered `POST /api/push/register` locally therefore wrote the
 * phone's token onto a box that never sends, while the box that does send (the
 * primary, the only one holding the APNs key) held none. Pushes were
 * structurally impossible and nothing logged it. So: ONE owner (the primary),
 * ONE implementation, and a replica relays into it — see core/push/relay.ts for
 * the primary-side entry point and web/routes/push.ts for the replica hop.
 *
 * Every function here is safe to call from either the primary's own HTTP route
 * or the bridge relay, and each one is idempotent by token.
 */

import { getConfig, updatePushTokens } from '../config-manager.js'
import { log } from '../../logging/index.js'
import { apnsStatus } from './apns.js'
import { tokenKind, tokenPrefix } from './send.js'
import { ACTIVE_LEASE_MS, parseMode, type LetterPushMode } from './letter-push-policy.js'
import { LETTER_TYPES } from '../human-inbox/types.js'
import type { PushTokenEntry } from '../types.js'

/**
 * A caller-fixable registry error. Carries the HTTP status so both the local
 * route and the bridge relay report the same thing for the same input.
 */
export class PushRegistryError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, code: string, status: number) {
    super(message)
    this.name = 'PushRegistryError'
    this.code = code
    this.status = status
  }
}

/**
 * An APNs device token is 32+ bytes of hex; Expo's is a bracketed string. Bound
 * the length because this value is interpolated into an APNs request path.
 */
const APNS_TOKEN_RE = /^[0-9a-fA-F]{64,200}$/
const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{1,120}\]$/

function validPushToken(token: string): boolean {
  return APNS_TOKEN_RE.test(token) || EXPO_TOKEN_RE.test(token)
}

function cleanLetterTypes(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.filter(
    (t): t is string => typeof t === 'string' && (LETTER_TYPES as readonly string[]).includes(t),
  )
}

/**
 * Which box authenticated the device name on a row.
 *
 * `local` = paired with THIS box; `relay` = paired with a replica that forwarded
 * the registration. It exists because device names are only unique WITHIN a box
 * (see routes/auth.ts — a name is the pairing key there), and the relay merged
 * two independently minted name spaces onto one store. Without this field, a
 * phone named "iPhone" on the replica registering here would sweep away a
 * DIFFERENT phone also named "iPhone" that had paired with the primary directly:
 * that row is deleted and the second phone silently stops receiving letters.
 * Scoping the sweep by origin makes the collision produce two coexisting rows
 * (both still get pushed) instead of a silent deletion.
 */
export type PushTokenOrigin = 'local' | 'relay'

/** Absent = `local`: rows written before the relay existed came from this box. */
function parsePushOrigin(raw: unknown): PushTokenOrigin {
  return raw === 'relay' ? 'relay' : 'local'
}

export interface RegisterPushInput {
  token?: unknown
  platform?: unknown
  environment?: unknown
  mode?: unknown
  letterTypes?: unknown
  /**
   * The calling device's identity (its bearer-token name), or null for a
   * trusted-LAN request that carries none. On the relay path this is the name
   * the REPLICA authenticated, forwarded verbatim: provenance for row scoping,
   * never authorization (the bridge socket is the authenticated party). Keeping
   * it verbatim is what lets one phone own one row whether it registered
   * through the primary directly or through the replica.
   *
   * Verbatim is also why `origin` has to travel with it: the name alone is not
   * unique across boxes.
   */
  keyName?: string | null
  /** Which box authenticated `keyName`. Defaults to `local`. */
  origin?: unknown
}

export interface RegisterPushResult {
  ok: true
  kind: 'apns' | 'expo'
  mode: LetterPushMode
  /** False when the row was stored but this box has no APNs credential. */
  deliverable: boolean
}

/**
 * Register (or re-register) one device token. Idempotent: the row is upserted by
 * token, so a repeat registration replaces rather than duplicates.
 */
export async function registerPushToken(input: RegisterPushInput): Promise<RegisterPushResult> {
  const token = typeof input.token === 'string' ? input.token.trim() : ''
  if (!token) throw new PushRegistryError('Missing or invalid token', 'bad_request', 400)
  if (!validPushToken(token)) {
    // Refuse rather than store: an unusable token would fail on every push and
    // look like a broken sender forever.
    throw new PushRegistryError(
      'Token is not a valid APNs (hex) or Expo push token', 'bad_request', 400,
    )
  }
  const platform = input.platform
  if (platform !== 'ios' && platform !== 'android') {
    throw new PushRegistryError('Missing or invalid platform (ios/android)', 'bad_request', 400)
  }

  const identity = typeof input.keyName === 'string' && input.keyName ? input.keyName : null
  const keyName = identity ?? 'localhost'
  const origin = parsePushOrigin(input.origin)
  const kind = tokenKind({ token })
  const environment = input.environment === 'sandbox' ? 'sandbox' : 'production'

  let entry!: PushTokenEntry
  let swept = 0
  await updatePushTokens((tokens) => {
    const previous = tokens.find((t) => t.token === token)
    // Upsert by token, and drop any OTHER token previously registered by this
    // same device: APNs mints a fresh token on reinstall, and leaving the old one
    // behind wastes a send per letter until Apple's 410 prunes it.
    //
    // Two guards on that sweep, each one a way it deletes a LIVE phone's row:
    //  - an UNAUTHENTICATED (trusted-LAN) request carries no device identity, so
    //    every one of them would share the 'localhost' name and each new phone
    //    would delete the previous phone's row. Without an identity we can only
    //    key on the token itself.
    //  - a name is unique only within the box that minted it, and this store now
    //    holds names from two boxes (see PushTokenOrigin). Same name + different
    //    origin = a different phone, so it is left alone.
    const filtered = tokens.filter((t) => {
      if (t.token === token) return false
      if (identity === null) return true
      const sameDevice = t.key_name === keyName && parsePushOrigin(t.origin) === origin
      if (sameDevice) swept++
      return !sameDevice
    })
    entry = {
      token,
      platform,
      kind,
      ...(kind === 'apns' ? { environment } : {}),
      key_name: keyName,
      origin,
      registered_at: new Date().toISOString(),
      // Registration must not silently reset a mode the user already chose.
      mode: input.mode !== undefined ? parseMode(input.mode) : (previous?.mode ?? 'always'),
      ...(previous?.letter_types ? { letter_types: previous.letter_types } : {}),
    }
    const requestedTypes = cleanLetterTypes(input.letterTypes)
    if (requestedTypes && requestedTypes.length > 0) entry.letter_types = requestedTypes
    return [...filtered, entry]
  })

  const apns = await apnsStatus()
  log.notif.info('push: token registered', {
    keyName, origin, platform, kind, environment, mode: entry.mode,
    tokenPrefix: tokenPrefix(token),
    ...(swept > 0 ? { replacedRotatedTokens: swept } : {}),
    apnsConfigured: apns.configured,
    ...(apns.configured ? {} : { apnsReason: apns.reason }),
  })
  return {
    ok: true,
    kind,
    mode: parseMode(entry.mode),
    deliverable: kind === 'expo' || apns.configured,
  }
}

/** Remove one token. Idempotent — removing an absent token is a no-op success. */
export async function unregisterPushToken(rawToken: unknown): Promise<{ ok: true; removed: number }> {
  const token = typeof rawToken === 'string' ? rawToken.trim() : ''
  if (!token) throw new PushRegistryError('Missing token', 'bad_request', 400)
  let removed = 0
  await updatePushTokens((tokens) => {
    const filtered = tokens.filter((t) => t.token !== token)
    removed = tokens.length - filtered.length
    return removed === 0 ? null : filtered
  })
  log.notif.info('push: token unregistered', { tokenPrefix: tokenPrefix(token), removed })
  return { ok: true, removed }
}

export interface PreferencesResult {
  ok: true
  mode: LetterPushMode
  letterTypes?: string[]
}

/**
 * "Is this row the calling device's?" — the ONE predicate every scoped operation
 * uses. Name AND origin, because a name is unique only within the box that
 * minted it (see PushTokenOrigin).
 */
function ownedBy(entry: PushTokenEntry, device: string, origin: PushTokenOrigin): boolean {
  return entry.key_name === device && parsePushOrigin(entry.origin) === origin
}

/**
 * Set one device's notification mode (and optional letter-type filter).
 *
 * Scoped to the calling device: two phones can hold different modes, and neither
 * can change the other's.
 *
 * The 404 is load-bearing for the CLIENT, not just for honesty: "the box I am
 * paired to has no row for me" is exactly the signal an app needs to notice that
 * a token it believes it uploaded never landed here, and re-register.
 */
export async function setDevicePushPreferences(
  device: string | null,
  body: { mode?: unknown; letterTypes?: unknown },
  origin: PushTokenOrigin = 'local',
): Promise<PreferencesResult> {
  if (!device) {
    throw new PushRegistryError(
      'This endpoint requires a device Bearer token', 'bad_request', 400,
    )
  }
  const mode = parseMode(body.mode)
  const letterTypes = cleanLetterTypes(body.letterTypes)

  let found = 0
  await updatePushTokens((tokens) => {
    const next = tokens.map((t) => {
      if (!ownedBy(t, device, origin)) return t
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
    // Must not read as success: the setting would silently not apply, and the
    // client would keep believing this box knows about it.
    throw new PushRegistryError(
      'This device has no registered push token — register it again',
      'device_not_registered', 404,
    )
  }
  log.notif.info('push: preferences updated', { device, origin, mode, letterTypes })
  return { ok: true, mode, ...(letterTypes ? { letterTypes } : {}) }
}

/**
 * Record (or release) one device's "my app is on screen" lease.
 *
 * Only meaningful for `when-inactive`; in `always` mode the value is never read,
 * so the write is skipped entirely rather than churning config + its backup on
 * every foreground heartbeat.
 */
export async function reportDeviceActive(
  device: string | null,
  active: boolean,
  origin: PushTokenOrigin = 'local',
): Promise<{ ok: true; applied: boolean; leaseMs: number }> {
  if (!device) {
    throw new PushRegistryError(
      'This endpoint requires a device Bearer token', 'bad_request', 400,
    )
  }
  let mine = 0
  let applied = 0
  await updatePushTokens((tokens) => {
    const next = tokens.map((t) => {
      if (!ownedBy(t, device, origin)) return t
      mine++
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
    throw new PushRegistryError(
      'This device has no registered push token — register it again',
      'device_not_registered', 404,
    )
  }
  return { ok: true, applied: applied > 0, leaseMs: ACTIVE_LEASE_MS }
}

/**
 * Drop every push row belonging to a device whose pairing was REVOKED.
 *
 * Called from the device/API-key delete route. This is a privacy operation, not
 * housekeeping: a revoked or lost phone that keeps a row keeps receiving letter
 * subjects and up to 300 characters of preview on its lock screen, which is
 * exactly what "revoke this device" is supposed to stop.
 *
 * Atomic by construction (`updatePushTokens` runs the read and the write inside
 * the config write lock). The route it replaced used a plain read-then-`updateConfig`,
 * the same non-atomic shape `pruneDead` in letter-push.ts warns about: a
 * registration landing between that read and its write was silently reinstated,
 * or dropped, depending on which one won.
 */
export async function revokeDevicePushTokens(
  device: string,
  origin: PushTokenOrigin = 'local',
): Promise<{ removed: number }> {
  let removed = 0
  await updatePushTokens((tokens) => {
    const keep = tokens.filter((t) => !ownedBy(t, device, origin))
    removed = tokens.length - keep.length
    return removed === 0 ? null : keep
  })
  if (removed > 0) log.notif.info('push: tokens revoked with the device', { device, origin, removed })
  return { removed }
}

/**
 * The registration + credential readout. `registered but undeliverable` is the
 * state a missing APNs key produces, and it has to be visible rather than
 * looking like pushes that simply never arrive.
 */
export async function pushRegistrationStatus(
  device: string | null,
  origin: PushTokenOrigin = 'local',
): Promise<Record<string, unknown>> {
  const config = await getConfig()
  const tokens = config.push_tokens ?? []
  const apns = await apnsStatus()
  const mine = device ? tokens.find((t: PushTokenEntry) => ownedBy(t, device, origin)) : undefined
  return {
    registered: tokens.length > 0,
    // `thisDevice` absent while `registered` is true is the state a client should
    // act on: SOME phone is registered here, but not the one asking.
    registeredThisDevice: mine !== undefined,
    count: tokens.length,
    apns: {
      configured: apns.configured,
      environment: apns.environment,
      topic: apns.topic,
      ...(apns.reason ? { reason: apns.reason } : {}),
      ...(apns.lastError ? { lastError: apns.lastError } : {}),
    },
    ...(mine
      ? {
        thisDevice: {
          mode: parseMode(mine.mode),
          kind: tokenKind(mine),
          letterTypes: mine.letter_types,
        },
      }
      : {}),
    tokens: tokens.map((t: PushTokenEntry) => ({
      platform: t.platform,
      kind: tokenKind(t),
      key_name: t.key_name,
      // Which box authenticated `key_name` — two rows with the same name and
      // different origins are two different phones, not a duplicate.
      origin: parsePushOrigin(t.origin),
      registered_at: t.registered_at,
      mode: parseMode(t.mode),
      // Don't expose the full token — it's a send capability for this device.
      token_prefix: `${tokenPrefix(t.token)}...`,
    })),
  }
}

/** How many token rows this box holds locally (diagnostic; see relay.ts). */
export async function localTokenCount(): Promise<number> {
  try {
    return ((await getConfig()).push_tokens ?? []).length
  } catch {
    return 0
  }
}
