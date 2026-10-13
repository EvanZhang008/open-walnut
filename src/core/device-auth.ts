/**
 * Device-token authentication: pairing, re-pairing, removing and verifying the
 * devices in auth.json (device-store.ts holds the file; device-claim.ts the
 * first-boot claim). Plaintext tokens are shown exactly once (CLI
 * `walnut device add` output / the console's QR / the claim response) and are
 * never persisted or logged anywhere else.
 *
 * Two kinds of entry point, so a route can never borrow the operator's power by
 * leaving an argument out:
 *  - the operator's (`walnut device` CLI on this machine, the setup claim):
 *    createDevice, revokePairing (revokeDevice), setCompanionOwner. No caller,
 *    no rules;
 *  - a caller's (every route): createDeviceAs, rotateDevice, revokePairingAs
 *    (revokeDeviceAs), apiKeyMaker. The caller `by` is required, and
 *    device-actor.ts decides inside the same locked write. A ratchet keeps
 *    src/web on these (tests/core/device-caller-explicit-ratchet.test.ts).
 *
 * Every revoke and every re-pairing by someone else ends the old pairing the
 * same way: its token is recorded as revoked (device-store.ts tombstone), and
 * its push rows and its copy on the other box go too (devices/revoke-parts.ts).
 */

import { CLOUD_MODE } from '../constants.js'
import { log } from '../logging/index.js'
import {
  DeviceChangeRefused, apiKeyDecision, deviceChangeDecision, liveOwnerOf, machineTargetRefusal, notADeviceRefusal, ownerRecord,
  ownsMachineCredentials, proofClaim, type DeviceActor,
} from './device-actor.js'
import { resetClaimForTesting } from './device-claim.js'
import {
  cleanSelfInfo, freshRecord, isPhoneRecord, ownByProof, platformFromInfo, readRegistry, readRegistryAndRevoked, recordForToken, resetInstanceIdForTesting,
  sha256Hex, tombstone, updateAuth, validateDeviceName,
  type DeviceRecord, type DeviceRegistry, type DeviceSelfInfo, type LockedAuth,
} from './device-store.js'
import {
  dropRevokeIntent, finishRevoke, pairingsOf, stampRevokeTime, trackRevokeWork, writeRevokeIntent,
  type RevokePlan, type TwinRemoval,
} from './devices/revoke-parts.js'
import type { PushRevokeOutcome } from './push/device-revoke.js'

export type { CompanionOwner, DeviceRecord, DeviceRegistry, DeviceSelfInfo, OwnerVia } from './device-store.js'
export { tokenMatchesHash } from './device-store.js'
export { getInstanceId, validateDeviceName } from './device-store.js'
export { claimInstance, getSetupTokenIfUnclaimed, isClaimed, printSetupTokenBanner } from './device-claim.js'
export { _settleRevokeWorkForTesting, type TwinRemoval } from './devices/revoke-parts.js'
export {
  livePairingHashesOf, pairingRefHolds, pairingRefOf, readPairedDevices, whilePairingHolds, withPairingsLocked,
  type PairedDevices, type PairingRef,
} from './device-pairings.js'

/** Public device info — never includes hashes. */
export interface DeviceInfo {
  name: string
  createdAt: string
  lastUsedAt?: string
  /** 'machine' = daemon bridge credential, not a user device (never QR-paired). */
  kind?: 'machine'
  /** Self-reported model/OS/app — absent until the client reports once. */
  info?: DeviceSelfInfo
  /** Set when this row is the other box's pairing, copied here (the console shows it once). */
  adoptedFrom?: 'cloud' | 'primary'
}

/** Persist lastUsedAt at most once per device per this window (avoid write amplification). */
const LAST_USED_WRITE_THROTTLE_MS = 60_000
// Per-device throttle for lastUsedAt disk writes.
const lastUsedWriteAt = new Map<string, number>()

/** The proof a caller presented makes it the owner (device-actor.ts proofClaim): record that first. */
function applyProof(auth: LockedAuth, by: DeviceActor, proof: string | undefined): void {
  // An owner is a companion's notion: on the Mac the rules stay those of the builds before.
  if (!CLOUD_MODE || !proof || !('token' in by)) return
  const claim = proofClaim(auth, recordForToken(auth.devices, by.token), proof)
  if (claim) ownByProof(auth, claim)
}

/**
 * The records that go when `target` does: itself, and when it owns machine
 * credentials here, those and the unowned ones from before ownership was
 * recorded (one companion serves one Mac, so they were its too, and leaving
 * them would keep the next Mac out). The rule of the builds before owners were
 * recorded, on both boxes. Reads only: removeGone takes them out.
 */
function goneWith(auth: LockedAuth, target: DeviceRecord): DeviceRecord[] {
  const devices = auth.devices
  const owner = ownsMachineCredentials(devices, target)
  return devices.filter((d) => d === target
    || (owner && d.kind === 'machine' && (liveOwnerOf(d, devices) === target || liveOwnerOf(d, devices) === undefined)))
}

/**
 * Take `gone` (goneWith) out of `auth` and record their tokens as revoked, in
 * the same write. A recorded owner among them is no owner any more. Returns
 * the names gone.
 */
function removeGone(auth: LockedAuth, gone: readonly DeviceRecord[]): string[] {
  // Before the filter: ownerRecord looks the owner up among the records left.
  const owner = ownerRecord(auth)
  auth.devices = auth.devices.filter((d) => !gone.includes(d))
  if (owner && gone.includes(owner)) auth.owner = null
  tombstone(auth, gone.map((d) => d.tokenHash))
  return gone.map((d) => d.name)
}

/**
 * Make `target` the owner (the operator's word): the companion passes to it,
 * and the connections of whoever had it go (their sync stops, which is how
 * they learn), along with any from before owners were recorded.
 */
function makeOwner(auth: LockedAuth, target: DeviceRecord): string[] {
  if (target.kind === 'machine') throw new Error(`${target.name} is a computer's connection, not a paired device.`)
  if (isPhoneRecord(target)) throw new Error(`${target.name} is a phone; the owner is the Mac this cloud companion belongs to.`)
  const gone = auth.devices.filter((d) => d.kind === 'machine' && d.ownerId !== target.id)
  auth.devices = auth.devices.filter((d) => !gone.includes(d))
  auth.owner = { id: target.id!, via: 'operator' }
  return gone.map((d) => d.name)
}

/**
 * The operator pairs a device (`walnut device add`). Returns the plaintext
 * token ONCE: it is never stored or shown again. 128-bit random, 32 hex chars.
 * `owner`: it is the Mac this cloud companion belongs to from now on.
 */
export async function createDevice(
  name: string,
  opts?: { kind?: 'machine'; owner?: boolean },
): Promise<{ name: string; token: string; createdAt: string }> {
  validateDeviceName(name)
  return updateAuth((auth) => {
    if (auth.devices.some((d) => d.name === name)) {
      throw new Error(`Device "${name}" already exists`)
    }
    const { record, token } = freshRecord(name, opts?.kind)
    auth.devices.push(record)
    const gone = opts?.owner ? makeOwner(auth, record) : []
    log.web.info('device-auth: device created', { name, kind: opts?.kind ?? 'device', ...(opts?.owner ? { owner: true, removedCredentials: gone } : {}) })
    return { persist: true, result: { created: { name, token, createdAt: record.createdAt }, gone } }
  }).then(({ created, gone }) => {
    notifyRevoked(gone)
    return created
  })
}

/**
 * Pair a new device for the caller `by` (a route): device-actor.ts decides. A
 * machine credential this way is this machine's own (on a companion they go
 * through machine-credentials.ts).
 */
export async function createDeviceAs(
  name: string,
  opts: { by: DeviceActor; kind?: 'machine' },
): Promise<{ name: string; token: string; createdAt: string }> {
  validateDeviceName(name)
  return updateAuth((auth) => {
    if (auth.devices.some((d) => d.name === name)) {
      throw new Error(`Device "${name}" already exists`)
    }
    if (opts.kind === 'machine' && !('local' in opts.by)) {
      throw new DeviceChangeRefused(403, 'device_change_refused', machineTargetRefusal(name, CLOUD_MODE))
    }
    const decision = deviceChangeDecision(auth, opts.by, 'create', name, CLOUD_MODE)
    if (!decision.ok) throw decision.refusal
    const { record, token } = freshRecord(name, opts.kind)
    auth.devices.push(record)
    log.web.info('device-auth: device created', { name, kind: opts.kind ?? 'device', by: decision.by })
    return { persist: true, result: { name, token, createdAt: record.createdAt } }
  })
}

/**
 * "Show a new QR" for `name`, asked by `by`: a new token, the old one stops
 * working. A device rotating its OWN token stays the same device (id,
 * platform, being the owner). A rotation by anyone else allowed to (the owner,
 * this machine itself) is a new pairing of the name: a new id, and whatever the
 * old pairing was goes as with a revoke. No record yet: a plain pairing.
 * `proof` = the caller's bridge-local proof (device-actor.ts proofClaim).
 */
export async function rotateDevice(
  name: string,
  opts: { by: DeviceActor; proof?: string },
): Promise<{ name: string; token: string; createdAt: string; replaced: boolean }> {
  validateDeviceName(name)
  const intent: { plan: RevokePlan | null } = { plan: null }
  const out = await updateAuth(async (auth) => {
    applyProof(auth, opts.by, opts.proof)
    const target = auth.devices.find((d) => d.name === name)
    const decision = deviceChangeDecision(auth, opts.by, target ? 'rotate' : 'create', name, CLOUD_MODE)
    if (!decision.ok) throw decision.refusal
    if (target?.kind === 'machine') throw new DeviceChangeRefused(400, 'not_a_device', notADeviceRefusal(name))
    const fresh = freshRecord(name)
    // The old token's copy on the other box must stop working too, whoever rotates.
    const oldTwins = target ? pairingsOf(auth.devices, [target]).map((d) => d.tokenHash) : []
    if (target && decision.by === 'self') {
      intent.plan = await writeRevokeIntent([], oldTwins)
      tombstone(auth, [target.tokenHash])
      target.tokenHash = fresh.record.tokenHash
      delete target.lastUsedAt
      return { persist: true, result: { name, token: fresh.token, createdAt: target.createdAt, replaced: true, gone: [name], by: decision.by } }
    }
    const goneRecords = target ? goneWith(auth, target) : []
    intent.plan = await writeRevokeIntent(pairingsOf(auth.devices, goneRecords), oldTwins)
    const gone = removeGone(auth, goneRecords)
    auth.devices.push(fresh.record)
    return { persist: true, result: { name, token: fresh.token, createdAt: fresh.record.createdAt, replaced: !!target, gone, by: decision.by } }
  }, () => stampRevokeTime(intent), () => dropRevokeIntent(intent))
  for (const n of out.gone) lastUsedWriteAt.delete(n)
  notifyRevoked(out.gone)
  log.web.info('device-auth: device rotated', { name, by: out.by, replaced: out.replaced, ...(out.gone.length > 1 ? { removedCredentials: out.gone.filter((n) => n !== name) } : {}) })
  // A re-pair by anyone but the device itself ends the old pairing, so its phone
  // stops getting pushes like any revoked one, and the old token's copy goes.
  // Not awaited: the new QR must not wait on a relay to the primary (up to 30 s
  // on the companion). Nothing is lost by not waiting: every part is in the
  // revoke queue already, and the push part removes only rows registered before
  // the revoke, so the new pairing's own rows are safe whenever it runs.
  const plan = intent.plan
  if (plan && (plan.push.length > 0 || plan.twins.length > 0)) trackRevokeWork(finishRevoke(plan, `device ${name} rotated`))
  return { name: out.name, token: out.token, createdAt: out.createdAt, replaced: out.replaced }
}

/**
 * Verify a Bearer token against the device list (constant-time hash compare).
 * On success, updates the device's lastUsedAt — throttled to at most one disk
 * write per device per minute.
 */
export async function verifyDeviceToken(token: string, opts: { touch?: boolean } = {}): Promise<{ name: string; kind?: 'machine'; bridgeScope?: 'status-only' } | null> {
  if (!token || typeof token !== 'string') return null
  const { devices, revoked } = await readRegistryAndRevoked()
  const matched = recordForToken(devices, token)
  if (!matched) return null
  // A token revoked here never authenticates again, even if a record of it came back.
  if (revoked.has(sha256Hex(token))) {
    log.web.warn('device-auth: a revoked token was presented, and its record is back; refused', { name: matched.name })
    return null
  }

  const now = Date.now()
  const lastWrite = lastUsedWriteAt.get(matched.name) ?? 0
  if (opts.touch !== false && now - lastWrite >= LAST_USED_WRITE_THROTTLE_MS) {
    lastUsedWriteAt.set(matched.name, now)
    const name = matched.name
    // Best-effort — a failed lastUsedAt write must never fail auth. Locked RMW
    // on a FRESH read: persisting the snapshot loaded above could revert a
    // concurrent CLI device add/revoke (auth.json has two writer processes).
    try {
      await updateAuth((fresh) => {
        const device = fresh.devices.find((d) => d.name === name)
        if (!device) return { persist: false, result: undefined }
        device.lastUsedAt = new Date(now).toISOString()
        return { persist: true, result: undefined }
      })
    } catch (err) {
      log.web.warn('device-auth: failed to persist lastUsedAt', {
        name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return matched.kind ? { name: matched.name, kind: matched.kind, ...(matched.bridgeScope === 'status-only' ? { bridgeScope: matched.bridgeScope } : {}) } : { name: matched.name }
}

export interface RevokeOptions {
  /** Only this pairing of the name, never one that replaced it meanwhile. */
  tokenHash?: string
  /**
   * The revoke came FROM the other box's copy of this pairing (a revoke by hash,
   * device-adoption.ts): that box already removed its own, so asking it again
   * would only bounce the request back.
   */
  fromTwin?: boolean
}

export interface DeviceRevokeOutcome {
  revoked: boolean
  /** What happened to the revoked devices' push rows; null when nothing was revoked. */
  push: PushRevokeOutcome | null
  /** What happened to the other box's copy of the pairing; null when there is none to remove. */
  twin: TwinRemoval | null
}

/**
 * The one revoke path, and it owns everything a revoke has to stop: the
 * device's push rows (wherever they live) and the other box's copy of the
 * pairing (or the revoked token keeps working there, and the phone can
 * register for pushes again through it). The operator's revoke, a caller's
 * revoke, a twin revoked by hash and anything added later all come through
 * here, so none of them can forget either. (The CLI used to revoke only the
 * pairing, so a lost phone kept getting letter subjects on its lock screen.)
 * Both parts are written to the revoke queue (core/devices/revoke-queue.ts)
 * before the pairing leaves auth.json, so a kill at any point leaves them for
 * the server. They run before this returns; an entry whose part finished is
 * cleared, and what could not finish stays queued for the server.
 * `decide` runs inside the locked write once the record is found, and throws
 * a refusal (nothing written).
 */
async function revokeWith(name: string, opts: RevokeOptions, decide: (auth: LockedAuth) => void): Promise<DeviceRevokeOutcome> {
  const intent: { plan: RevokePlan | null } = { plan: null }
  const removed = await updateAuth(async (auth) => {
    const target = auth.devices.find((d) => d.name === name && (opts.tokenHash === undefined || d.tokenHash === opts.tokenHash))
    if (!target) return { persist: false, result: [] as string[] }
    decide(auth)
    const gone = goneWith(auth, target)
    const pairings = pairingsOf(auth.devices, gone)
    intent.plan = await writeRevokeIntent(pairings, opts.fromTwin ? [] : pairings.map((d) => d.tokenHash))
    return { persist: true, result: removeGone(auth, gone) }
  }, () => stampRevokeTime(intent), () => dropRevokeIntent(intent))
  if (!removed.includes(name) || !intent.plan) return { revoked: false, push: null, twin: null }
  for (const n of removed) lastUsedWriteAt.delete(n)
  notifyRevoked(removed)
  const { push, twin } = await finishRevoke(intent.plan, `device ${name} revoked`)
  const pushOut = push ?? { removed: 0, relayed: false }
  log.web.info('device-auth: device revoked', {
    name, ...(removed.length > 1 ? { removedCredentials: removed.filter((n) => n !== name) } : {}),
    pushTokensRevoked: pushOut.removed,
    ...(pushOut.pending ? { pushRevokePending: pushOut.pending, pushRevokeQueued: !!pushOut.queued } : {}),
    ...(twin ? { twin } : {}),
  })
  return { revoked: true, push: pushOut, twin }
}

/**
 * The operator removes a device (`walnut device revoke`, and a twin revoked by
 * hash, device-adoption.ts), with the outcome. Removing the owner removes
 * every machine credential with it (goneWith): that Mac is disconnected from
 * this companion, and the operator names the next owner with `walnut device owner`.
 */
export async function revokePairing(name: string, opts: RevokeOptions = {}): Promise<DeviceRevokeOutcome> {
  return revokeWith(name, opts, () => {})
}

/** `revokePairing`, true if the device existed. */
export async function revokeDevice(name: string, opts: RevokeOptions = {}): Promise<boolean> {
  return (await revokePairing(name, opts)).revoked
}

/**
 * Remove a device for the caller `by` (a route), with the outcome: a paired
 * device may remove only itself, unless it is the companion's owner. `proof`
 * as in rotateDevice.
 */
export async function revokePairingAs(name: string, opts: { by: DeviceActor; proof?: string }): Promise<DeviceRevokeOutcome> {
  return revokeWith(name, {}, (auth) => {
    applyProof(auth, opts.by, opts.proof)
    const decision = deviceChangeDecision(auth, opts.by, 'revoke', name, CLOUD_MODE)
    if (!decision.ok) throw decision.refusal
  })
}

/** `revokePairingAs`, true if the device existed. */
export async function revokeDeviceAs(name: string, opts: { by: DeviceActor; proof?: string }): Promise<boolean> {
  return (await revokePairingAs(name, opts)).revoked
}

/**
 * The operator names the Mac this cloud companion belongs to (`walnut device
 * owner <name>`): after a setup claim on another machine, or when the old
 * owner's pairing was removed. Returns the machine credentials that went, and
 * `changed: false` when the operator had already named `name` and there is
 * nothing of anyone else's to remove (then nothing is written).
 */
export async function setCompanionOwner(name: string): Promise<{ removedCredentials: string[]; changed: boolean }> {
  const out = await updateAuth((auth) => {
    const target = auth.devices.find((d) => d.name === name)
    if (!target) throw new Error(`Device "${name}" not found.`)
    // Already the owner by the operator's word, and every machine credential its
    // own: the write would change nothing, so there is none. (An owner recorded
    // another way is recorded again as the operator's: that is a change.)
    if (target.kind !== 'machine' && ownerRecord(auth) === target && auth.owner?.via === 'operator'
      && auth.devices.every((d) => d.kind !== 'machine' || d.ownerId === target.id)) {
      return { persist: false, result: { gone: [] as string[], changed: false } }
    }
    return { persist: true, result: { gone: makeOwner(auth, target), changed: true } }
  })
  if (!out.changed) return { removedCredentials: [], changed: false }
  notifyRevoked(out.gone)
  log.web.info('device-auth: companion owner named', { name, removedCredentials: out.gone })
  return { removedCredentials: out.gone, changed: true }
}

/**
 * May `by` create or remove API keys (device-actor.ts apiKeyDecision)? Decided
 * in a locked write, so the id a new key is bound to is on disk before the key
 * is. Returns that id (none = an unbound key, made by this machine itself).
 */
export async function apiKeyMaker(by: DeviceActor): Promise<{ deviceId?: string }> {
  return updateAuth((auth) => {
    const decision = apiKeyDecision(auth, by, CLOUD_MODE)
    if (!decision.ok) throw decision.refusal
    return { persist: false, result: decision.deviceId ? { deviceId: decision.deviceId } : {} }
  })
}

/** Is `id` a paired device right now (an API key bound to it still works)? */
export async function isPairedDeviceId(id: string): Promise<boolean> {
  return (await readRegistry()).devices.some((d) => d.kind !== 'machine' && d.id === id)
}

/** A fresh machine credential and its plaintext token (returned once, never stored), for machine-credentials.ts. */
export function newMachineRecord(name: string, ownerId: string, daemonKey: string | undefined): { record: DeviceRecord; token: string } {
  validateDeviceName(name)
  const { record, token } = freshRecord(name, 'machine')
  return { token, record: { ...record, ownerId, ...(daemonKey ? { daemonKey } : {}) } }
}

type RevokeListener = (names: string[]) => void
const revokeListeners = new Set<RevokeListener>()

/**
 * Hear every credential this process revokes (a device and the machine
 * credentials that went with it), so a socket opened with one can be closed at
 * once. A revoke by the `walnut device` CLI (another process) is not heard:
 * holders re-verify on their own clock as well.
 */
export function onCredentialsRevoked(listener: RevokeListener): () => void {
  revokeListeners.add(listener)
  return () => { revokeListeners.delete(listener) }
}

export function notifyRevoked(names: string[]): void {
  if (names.length === 0) return
  for (const l of revokeListeners) {
    try { l(names) } catch { /* a listener must never fail a revoke */ }
  }
}

/** List devices — never exposes token hashes. */
export async function listDevices(): Promise<DeviceInfo[]> {
  return (await readRegistry()).devices.map(({ name, createdAt, lastUsedAt, kind, info, adoptedFrom }) => ({ name, createdAt, lastUsedAt, kind, info, ...(adoptedFrom ? { adoptedFrom } : {}) }))
}

/**
 * Record a paired client's self-reported identity. Called on every client
 * launch, so it doubles as the backfill path for devices paired before the
 * reporting build existed. Returns false when the device is unknown.
 *
 * Values are clamped and the timestamp is stamped server-side — a client must
 * not be able to bloat auth.json or forge a report time.
 *
 * `who` is the report's bearer token (`{ token }`), matched inside the locked
 * write: a report in flight while its name is re-paired then finds no record
 * instead of landing on the new pairing. A bare name is for local tools and
 * tests only; a request always passes its token.
 */
export async function setDeviceInfo(who: string | { token: string }, info: DeviceSelfInfo): Promise<boolean> {
  const next = cleanSelfInfo(info)
  let name = typeof who === 'string' ? who : ''
  const outcome = await updateAuth((auth) => {
    const device = typeof who === 'string' ? auth.devices.find((d) => d.name === who) : recordForToken(auth.devices, who.token)
    if (!device) return { persist: false, result: 'unknown' as const }
    name = device.name
    // The first report is the device's word for what it is, and the platform it
    // says is kept for good: no later report (a cleared one, a Mac model sent by
    // a phone) changes it. It decides wording, that a phone pairs nothing and
    // that a phone owns nothing; it never makes a device the owner. The report
    // itself is display only.
    const claimed = !device.platform && device.kind !== 'machine' ? platformFromInfo(next) : undefined
    if (claimed) device.platform = claimed
    // A phone is never the owner: one recorded before it said what it is goes now.
    if (claimed === 'ios' && auth.owner?.id === device.id) auth.owner = null
    // Don't churn the file when nothing meaningful changed — clients report on
    // every launch, and each auth.json write also rewrites the .bak sidecar.
    const prev = device.info
    if (prev
      && prev.model === next.model && prev.os === next.os
      && prev.deviceName === next.deviceName && prev.appVersion === next.appVersion) {
      return { persist: claimed !== undefined, result: 'unchanged' as const }
    }
    device.info = next
    return { persist: true, result: 'updated' as const }
  })
  if (outcome === 'unknown') return false
  if (outcome === 'updated') {
    log.web.info('device-auth: device info reported', {
      name, model: next.model, os: next.os, appVersion: next.appVersion,
    })
  }
  return true
}

/**
 * Full records INCLUDING token hashes. Internal use only — callers must never
 * send these to a client. Used to recognize a credential we already hold (e.g.
 * "which record did this bearer token match?").
 */
export async function listDeviceRecords(): Promise<DeviceRecord[]> {
  return [...(await readRegistry()).devices]
}

/** The records and the companion's owner, for a rule that needs both. */
export async function readDeviceRegistry(): Promise<DeviceRegistry> {
  return readRegistry()
}

/**
 * One locked read-modify-write of the records, for device-adoption.ts and
 * machine-credentials.ts. `mutate` sees the records and the owner as they are
 * inside the lock (decide there), and `revoked`, the token hashes revoked here,
 * which must never come back. It returns the new records, or none to leave
 * the file alone.
 */
export async function mutateDeviceRecords<R>(
  mutate: (devices: DeviceRecord[], reg: DeviceRegistry, revoked: ReadonlySet<string>) => { devices?: DeviceRecord[]; result: R },
): Promise<R> {
  return updateAuth((auth) => {
    const { devices, result } = mutate(auth.devices, { devices: auth.devices, owner: auth.owner }, new Set(auth.revokedHashes ?? []))
    if (devices) auth.devices = devices
    return { persist: devices !== undefined, result }
  })
}

/** Test-only: clear module-level state (setup token + write throttle). */
export function _resetDeviceAuthForTesting(): void {
  resetClaimForTesting()
  lastUsedWriteAt.clear()
  resetInstanceIdForTesting()
}
