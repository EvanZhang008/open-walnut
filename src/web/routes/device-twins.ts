/**
 * The other box's copy of a pairing ("twin"): asked for, cached, and revoked.
 *
 *  - PRIMARY → companion over HTTP: `POST <cloud>/api/devices/adopt` (and
 *    `/unadopt`) with the Mac's own cloud credential, the one that already
 *    mints and lists devices there (devices.ts).
 *  - REPLICA → primary over the bridge: `server.devices.adopt` (and
 *    `server.devices.revoke-by-hash`), answered by core/devices/relay.ts.
 *
 * Everything here is best effort and never throws: a missing companion, an
 * offline bridge or an older build on the other side just means that route is
 * left out (logged at warn, once per 10 minutes per kind). Removing a copy is
 * retried while the other box is unreachable (every failure logged).
 *
 * Ordering matters for revokes. A revoke tombstones the hash at once, waits for
 * an adoption of it already in flight, and only then removes the twin; an
 * adoption that finds the tombstone afterwards removes its own result. Without
 * that, a routes call racing a revoke could re-create the twin after its
 * removal, and the revoked token would keep working on the other box.
 */

import crypto from 'node:crypto'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { listDeviceRecords, type DeviceRecord } from '../../core/device-auth.js'
import { ownsMachineCredentials } from '../../core/device-actor.js'
import { getCloudPairingEndpointAsync } from '../../core/pairing-targets.js'
import { wellFormedRoutes, type DeviceRoute } from '../../core/devices/routes.js'
import { callPrimaryControl } from './v1-control-relay.js'

const SERVER_RELAY_SID = '__server__'
const CLOUD_ADOPT_TIMEOUT_MS = 15_000
const PRIMARY_ADOPT_TIMEOUT_MS = 10_000
/** A companion's id does not change, and its copy of a pairing stays until revoked. */
const CLOUD_ADOPTION_TTL_MS = 10 * 60_000
/** The primary answers its LAN/tailnet routes too, and those move (DHCP, a tailnet going down). */
const PRIMARY_ADOPTION_TTL_MS = 60_000
const WARN_EVERY_MS = 10 * 60_000
const TOMBSTONE_TTL_MS = 60 * 60_000
/** A twin that could not be removed is tried again this often, this many times (in this process). */
const REMOVE_RETRY_MS = 60_000
const REMOVE_TRIES = 30

const INSTANCE_RE = /^[0-9a-f]{32}$/

// ── Throttled warnings ──────────────────────────────────────────────────────

const lastWarnAt = new Map<string, number>()
function warnThrottled(kind: string, message: string, fields: Record<string, unknown>): void {
  const now = Date.now()
  if (now - (lastWarnAt.get(kind) ?? 0) < WARN_EVERY_MS) return
  lastWarnAt.set(kind, now)
  log.web.warn(message, fields)
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── Ledger: cache, in-flight dedupe, revoke tombstones (keyed by token hash) ──

interface CloudTwin { origin: string; instance: string; name: string }

const cloudTwins = new Map<string, CloudTwin & { expiresAt: number }>()
const primaryTwins = new Map<string, { answer: PrimaryAnswer; expiresAt: number }>()

/** The Mac's own Tailscale state as `GET /api/v1/routes` forwards it (instance-routes-v1.ts). */
export interface TailscaleBrief {
  installed: boolean
  running: boolean
  dnsName?: string
}

/** What the primary answered to `server.devices.adopt`: its direct routes and its Tailscale state. */
export interface PrimaryAnswer {
  routes: DeviceRoute[]
  tailscale: TailscaleBrief | null
}

const NO_PRIMARY_ANSWER: PrimaryAnswer = { routes: [], tailscale: null }

/** `{installed, running, dnsName?}` from the primary, kept only when well formed. */
export function wellFormedTailscaleBrief(raw: unknown): TailscaleBrief | null {
  if (!raw || typeof raw !== 'object') return null
  const { installed, running, dnsName } = raw as Record<string, unknown>
  if (typeof installed !== 'boolean' || typeof running !== 'boolean') return null
  return { installed, running, ...(typeof dnsName === 'string' && dnsName && dnsName.length <= 253 ? { dnsName } : {}) }
}
const inFlight = new Map<string, Promise<unknown>>()
const tombstones = new Map<string, number>()

function isTombstoned(hash: string): boolean {
  const at = tombstones.get(hash)
  return at !== undefined && Date.now() - at < TOMBSTONE_TTL_MS
}

function tombstone(hash: string): void {
  const now = Date.now()
  for (const [h, at] of tombstones) if (now - at >= TOMBSTONE_TTL_MS) tombstones.delete(h)
  tombstones.set(hash, now)
}

function dedupe<T>(hash: string, run: () => Promise<T>): Promise<T> {
  const pending = inFlight.get(hash) as Promise<T> | undefined
  if (pending) return pending
  const p = run().finally(() => { inFlight.delete(hash) })
  inFlight.set(hash, p)
  return p
}

/** True when `hash` is the Mac's own credential on the companion: never copied, never removed by hash. */
function isOwnCloudCredential(hash: string, cloud: { token: string }): boolean {
  return crypto.createHash('sha256').update(cloud.token, 'utf-8').digest('hex') === hash
}

function adoptBody(record: DeviceRecord): Record<string, unknown> {
  return {
    name: record.name,
    ...(record.id ? { id: record.id } : {}),
    ...(record.platform ? { platform: record.platform } : {}),
    ...(record.info ? { info: record.info } : {}),
  }
}

// ── PRIMARY → companion ─────────────────────────────────────────────────────

async function postToCloud(
  cloud: { origin: string; token: string },
  path: '/api/devices/adopt' | '/api/devices/unadopt',
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${cloud.origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cloud.token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CLOUD_ADOPT_TIMEOUT_MS),
  })
}

/** True = done (removed, nothing there, or a build that never copies); false = try again. */
async function unadoptOnCloud(hash: string): Promise<boolean> {
  const cloud = await getCloudPairingEndpointAsync()
  if (!cloud || isOwnCloudCredential(hash, cloud)) return true
  try {
    const res = await postToCloud(cloud, '/api/devices/unadopt', { token_hash: hash })
    // An older companion has no such route, and so never held a copy.
    if (res.status === 404) return true
    if (!res.ok) {
      log.web.warn('devices: the cloud companion did not remove its copy of a revoked pairing', { status: res.status })
      return false
    }
    const body = await res.json().catch(() => ({})) as { name?: unknown }
    log.web.info('devices: cloud copy of a revoked pairing removed', { name: typeof body.name === 'string' ? body.name : null })
    return true
  } catch (err) {
    log.web.warn('devices: could not reach the cloud companion to remove a revoked pairing', { error: errorText(err) })
    return false
  }
}

/**
 * Make `record`'s token work on the cloud companion too. Returns the cloud
 * route's origin and the companion's instance id, or null (no companion, or
 * it did not adopt: an older build answers 404, a refusal 403).
 */
export async function adoptOnCloud(record: DeviceRecord): Promise<CloudTwin | null> {
  const cloud = await getCloudPairingEndpointAsync()
  if (!cloud || isOwnCloudCredential(record.tokenHash, cloud)) return null
  const hash = record.tokenHash
  const hit = cloudTwins.get(hash)
  if (hit && hit.origin === cloud.origin && Date.now() < hit.expiresAt) {
    return { origin: hit.origin, instance: hit.instance, name: hit.name }
  }
  return dedupe(hash, async (): Promise<CloudTwin | null> => {
    if (isTombstoned(hash)) return null
    let twin: CloudTwin
    try {
      const res = await postToCloud(cloud, '/api/devices/adopt', { ...adoptBody(record), token_hash: hash })
      if (!res.ok) {
        warnThrottled('cloud-adopt', 'devices: the cloud companion did not adopt a pairing; its route is left out', { status: res.status, name: record.name })
        return null
      }
      const body = await res.json().catch(() => ({})) as { name?: unknown; instance?: unknown }
      if (typeof body.instance !== 'string' || !INSTANCE_RE.test(body.instance)) {
        warnThrottled('cloud-adopt', 'devices: the cloud companion answered an adoption without an instance id', { name: record.name })
        return null
      }
      twin = { origin: cloud.origin, instance: body.instance, name: typeof body.name === 'string' ? body.name : record.name }
    } catch (err) {
      warnThrottled('cloud-adopt', 'devices: could not reach the cloud companion to adopt a pairing', { error: errorText(err), name: record.name })
      return null
    }
    if (isTombstoned(hash)) {
      // Revoked while this adoption was on the wire: take its result back.
      await removeTwin(hash)
      return null
    }
    cloudTwins.set(hash, { ...twin, expiresAt: Date.now() + CLOUD_ADOPTION_TTL_MS })
    return twin
  })
}

// ── REPLICA → primary ───────────────────────────────────────────────────────

/** Same contract as unadoptOnCloud. */
async function revokeOnPrimary(hash: string): Promise<boolean> {
  const outcome = await callPrimaryControl('server.devices.revoke-by-hash', SERVER_RELAY_SID, { tokenHash: hash }, PRIMARY_ADOPT_TIMEOUT_MS)
  if (!outcome.ok) {
    // A primary that predates the action never held a copy.
    if (outcome.failure.kind === 'needs_upgrade') return true
    log.web.warn('devices: could not remove the primary\'s copy of a revoked pairing', { kind: outcome.failure.kind, error: outcome.failure.message })
    return outcome.failure.kind === 'error' // a domain refusal will not change on retry
  }
  log.web.info('devices: primary copy of a revoked pairing removed', { name: typeof outcome.result.name === 'string' ? outcome.result.name : null })
  return true
}

/**
 * Make `record`'s token work on the primary too, and return the primary's
 * direct routes (LAN, tailnet) plus its Tailscale state. Empty when the bridge
 * is down, the primary predates the action, or `record` is the Mac itself.
 */
export async function adoptOnPrimary(record: DeviceRecord): Promise<PrimaryAnswer> {
  const hash = record.tokenHash
  // The pairing that owns this companion's machine credentials is the Mac itself.
  // (Ownership compares records by identity, so look it up in the same read.)
  const devices = await listDeviceRecords()
  const self = devices.find((d) => d.tokenHash === hash)
  if (self && ownsMachineCredentials(devices, self)) return NO_PRIMARY_ANSWER
  const hit = primaryTwins.get(hash)
  if (hit && Date.now() < hit.expiresAt) return hit.answer
  return dedupe(hash, async (): Promise<PrimaryAnswer> => {
    if (isTombstoned(hash)) return NO_PRIMARY_ANSWER
    const outcome = await callPrimaryControl('server.devices.adopt', SERVER_RELAY_SID, {
      ...adoptBody(record), tokenHash: hash,
    }, PRIMARY_ADOPT_TIMEOUT_MS)
    if (!outcome.ok) {
      warnThrottled('primary-adopt', 'devices: the primary did not adopt a pairing; its routes are left out', { kind: outcome.failure.kind, error: outcome.failure.message })
      return NO_PRIMARY_ANSWER
    }
    if (isTombstoned(hash)) {
      await removeTwin(hash)
      return NO_PRIMARY_ANSWER
    }
    const answer: PrimaryAnswer = {
      routes: wellFormedRoutes(outcome.result.routes, ['lan', 'tailnet']),
      tailscale: wellFormedTailscaleBrief(outcome.result.tailscale),
    }
    primaryTwins.set(hash, { answer, expiresAt: Date.now() + PRIMARY_ADOPTION_TTL_MS })
    return answer
  })
}

// ── Revoke ──────────────────────────────────────────────────────────────────

const retryTimers = new Set<NodeJS.Timeout>()
let removeRetryMs = REMOVE_RETRY_MS

/**
 * Remove the other box's copy, and keep trying while it is unreachable: until
 * it goes, the revoked token still works there. In-process only, so a restart
 * in between leaves the copy (said in the log line of each failed try).
 */
async function removeTwin(hash: string, attempt = 1): Promise<void> {
  const done = CLOUD_MODE ? await revokeOnPrimary(hash) : await unadoptOnCloud(hash)
  if (done || attempt >= REMOVE_TRIES) return
  const timer = setTimeout(() => {
    retryTimers.delete(timer)
    void removeTwin(hash, attempt + 1).catch(() => {})
  }, removeRetryMs)
  timer.unref?.()
  retryTimers.add(timer)
}

/**
 * A pairing was revoked or re-paired on this box: remove its copy on the other
 * one. Never throws and never blocks the caller's own revoke (callers do not
 * await it on the request path).
 */
export async function revokeAdoptionTwin(tokenHash: string): Promise<void> {
  tombstone(tokenHash)
  try {
    await inFlight.get(tokenHash)?.catch(() => {})
    cloudTwins.delete(tokenHash)
    primaryTwins.delete(tokenHash)
    await removeTwin(tokenHash)
  } catch (err) {
    log.web.warn('devices: removing the other box\'s copy of a pairing failed', { error: errorText(err) })
  }
}

/**
 * One try at removing the other box's copy, for a caller that cannot retry on a
 * timer: `walnut device revoke` exits right after, and the revoke queue
 * (core/devices/revoke-queue.ts) runs its own clock. True = done (removed,
 * nothing there, or the other box will never hold one); false = try again.
 */
export async function removeTwinOnce(tokenHash: string): Promise<boolean> {
  try {
    return CLOUD_MODE ? await revokeOnPrimary(tokenHash) : await unadoptOnCloud(tokenHash)
  } catch (err) {
    log.web.warn('devices: removing the other box\'s copy of a pairing failed', { error: errorText(err) })
    return false
  }
}

/** Test seam: forget every cached twin, in-flight call, tombstone, retry and warning clock. */
export function _resetDeviceTwinsForTesting(opts: { retryMs?: number } = {}): void {
  for (const t of retryTimers) clearTimeout(t)
  retryTimers.clear()
  removeRetryMs = opts.retryMs ?? REMOVE_RETRY_MS
  cloudTwins.clear()
  primaryTwins.clear()
  inFlight.clear()
  tombstones.clear()
  lastWarnAt.clear()
}
