/**
 * The door credentials this leader issues to its own hosts (door-wire.ts, host-door.ts): one
 * `machine` record per host machine in this leader's auth.json (device-store.ts), named
 * `host-<machineId>`, `issuer: 'leader'`, bound to the host key it was issued to. The record keeps
 * only the key S both sides prove themselves with at the door (auth.json is leader data, sensitive,
 * mode 0600); S leaves this process once, to the host over its authenticated daemon link. There is
 * no bearer token: `tokenHash` stays empty (the store's schema needs the field; an empty hash
 * never matches any token, device-store.ts hashesEqual).
 *
 * A rotation moves the old key to `previous`, taken for PREVIOUS_GRACE_MS more, so a host that
 * dials with the key it held a moment ago still gets in. verifyDeviceToken never answers these
 * records (no other door, no REST route), and no pairing or owner rule touches them
 * (device-auth.ts goneWith, makeOwner).
 *
 * Drop (dropHostCredential): the record goes and every live door socket of that machine in this
 * process closes at once (onCredentialsRevoked). A drop from another process (the CLI) is heard at
 * the door's next recheck of its record, at most DOOR_RECHECK_MS later (host-door.ts). For a host
 * still in the config a drop is a rotation: the next check of its link issues it a new key.
 *
 * Revoke (revokeHostDoor): a ban of one host machine, under any of its keys. Its records keep no key and say who revoked
 * them and when (`revoked`), its sockets close the same way, and no key is minted for that host
 * again (HostDoorRevoked) until someone allows it (allowHostDoor): then its next link check issues
 * a fresh one. Both are kept in auth.json with the records, so a restart keeps the ban.
 */
import { notifyRevoked } from '../device-auth.js'
import { isHostCredentialRecord, newDeviceId, readRegistryAndRevoked, updateAuth, type DeviceRecord } from '../device-store.js'
import { doorKeyId, doorSecret } from './door-wire.js'
import { hostAliasesNow, isOwnMachine, machineRevokedNow, revokedAsIn, stickyAliasesOf, type RevokedRecord } from './revoked-hosts.js'

/** How long a replaced key is still taken after a rotation. */
export const PREVIOUS_GRACE_MS = 10 * 60_000
/** A credential older than this is rotated at the host's next link. */
export const ROTATE_AFTER_MS = 30 * 24 * 60 * 60_000
export const MACHINE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/

export function hostCredentialName(machineId: string): string {
  return `host-${machineId}`
}

export interface MintedHostCredential {
  /** S: sent to the host once over its daemon link; kept here in the record. */
  verifyKey: string
  /** The auth.json record now kept for it. */
  record: DeviceRecord
  issuedAt: string
}

/** The record of `machineId`'s door credential, or null. */
export async function hostCredentialOf(machineId: string): Promise<DeviceRecord | null> {
  const { devices } = await readRegistryAndRevoked()
  return devices.find((d) => isHostCredentialRecord(d) && d.machineId === machineId) ?? null
}

/** Every door credential this leader keeps. */
export async function hostCredentials(): Promise<DeviceRecord[]> {
  const { devices } = await readRegistryAndRevoked()
  return devices.filter((d) => isHostCredentialRecord(d))
}

/** Does `machineId`'s credential need issuing (none, or older than ROTATE_AFTER_MS)? */
export function credentialDue(rec: Pick<DeviceRecord, 'issuedAt'> | null, now = Date.now()): boolean {
  if (!rec?.issuedAt) return true
  const at = Date.parse(rec.issuedAt)
  return !Number.isFinite(at) || now - at >= ROTATE_AFTER_MS
}

/**
 * The door records that are `hostKey`'s: issued to it, to another key of the same daemon (its
 * aliases, revoked-hosts.ts hostAliasesNow), or banned with it (a key the ban named, or one judged
 * its alias since: revokedAs). One machine keeps one record, bound to the key it was first issued
 * to; a revoke or an allow under any of these names acts on that record. A record that matches only
 * by the machine id `hostKey`'s hello says is not here: that id is the host's own word, and a
 * revoke never drags another host's record in by it (N1 of the C7 review; machineOnlyRecordsIn).
 */
export function hostRecordsIn(devices: readonly DeviceRecord[], hostKey: string): DeviceRecord[] {
  const { aliases } = hostAliasesNow(hostKey)
  const bannedAs = revokedAsIn(revokedRecordsOf(devices), hostKey)
  const names = new Set([hostKey, ...aliases, ...(bannedAs ? [bannedAs] : [])])
  // A ban that named `hostKey` when it was made (its `keys`) holds that record for it too.
  const namedBy = (d: DeviceRecord) => !!d.revoked?.keys?.includes(hostKey)
  return devices.filter((d) => isHostCredentialRecord(d) && !!d.hostKey && (names.has(d.hostKey) || namedBy(d)))
}

/** Records of another key that `hostKey`'s hello claims the machine of (not its to revoke: said as `skipped`). */
export function machineOnlyRecordsIn(devices: readonly DeviceRecord[], hostKey: string): DeviceRecord[] {
  const { machine } = hostAliasesNow(hostKey)
  if (!machine) return []
  const mine = new Set(hostRecordsIn(devices, hostKey))
  return devices.filter((d) => isHostCredentialRecord(d) && d.machineId === machine && !mine.has(d))
}

/** The revoked door records, as the ban reads them (revoked-hosts.ts). */
export function revokedRecordsOf(devices: readonly DeviceRecord[]): RevokedRecord[] {
  return devices.filter((d) => isHostCredentialRecord(d) && d.revoked && d.hostKey)
    .map((d) => ({ hostKey: d.hostKey!, machineId: d.machineId ?? null, keys: d.revoked!.keys ?? [] }))
}

/** `hostKey`'s door was revoked, under any name of its machine: the time, who did it and the key it was revoked as (null: not revoked). */
export function revokedHostIn(devices: readonly DeviceRecord[], hostKey: string): { at: string; by: string; as: string } | null {
  const as = revokedAsIn(revokedRecordsOf(devices), hostKey)
  if (!as) return null
  const rec = devices.filter((d) => d.hostKey === as)
    .find((d) => isHostCredentialRecord(d) && d.revoked)
  return rec?.revoked ? { at: rec.revoked.at, by: rec.revoked.by, as } : null
}

/** Is `hostKey`'s door revoked now, under any name of its machine? */
export async function hostDoorRevoked(hostKey: string): Promise<{ at: string; by: string; as: string } | null> {
  return revokedHostIn((await readRegistryAndRevoked()).devices, hostKey)
}

export class HostDoorRevoked extends Error {
  constructor(readonly hostKey: string) {
    super(`the host ${hostKey}'s door was revoked; nothing is issued to it until it is allowed again`)
    this.name = 'HostDoorRevoked'
  }
}

export class HostKeyMismatch extends Error {
  constructor(readonly machineId: string, readonly heldBy: string, readonly askedBy: string) {
    super(`the machine's door credential belongs to the host ${heldBy}, not ${askedBy}; not issued`)
    this.name = 'HostKeyMismatch'
  }
}

/**
 * Mint (or rotate) `machineId`'s door credential for `hostKey`, under the auth.json lock: the issue
 * over a host's link (leader-issue.ts) and any other caller (the leader switch) take this one
 * function. One record per machine, bound to its host key: a record that names another host key
 * is never rotated by this one (HostKeyMismatch).
 */
export async function mintHostCredential(o: { machineId: string; walnutId: string; hostKey: string; now?: number }): Promise<MintedHostCredential> {
  if (!MACHINE_ID_RE.test(o.machineId)) throw new Error('not a machine id')
  if (!o.hostKey) throw new Error('no host key')
  const now = o.now ?? Date.now()
  const verifyKey = doorSecret()
  const issuedAt = new Date(now).toISOString()
  const name = hostCredentialName(o.machineId)
  const kept = await updateAuth((auth) => {
    const old = auth.devices.find((d) => d.name === name)
    if (old && !isHostCredentialRecord(old)) throw new Error(`${name} is another kind of record here; not replaced`)
    if (old?.hostKey && old.hostKey !== o.hostKey) throw new HostKeyMismatch(o.machineId, old.hostKey, o.hostKey)
    // Banned as its key, any name of it, or by the machine id it asks for (a key whose hello changed its id gets nothing: S1).
    if (old?.revoked || revokedHostIn(auth.devices, o.hostKey) || machineRevokedNow(o.machineId)
      || auth.devices.some((d) => isHostCredentialRecord(d) && d.revoked && d.machineId === o.machineId)) throw new HostDoorRevoked(o.hostKey)
    const record: DeviceRecord = {
      name, id: old?.id ?? newDeviceId(), tokenHash: '', createdAt: old?.createdAt ?? issuedAt, kind: 'machine', issuer: 'leader',
      machineId: o.machineId, walnutId: o.walnutId, hostKey: o.hostKey, verifyKey, issuedAt,
      ...(old?.verifyKey ? { previous: { verifyKey: old.verifyKey, until: new Date(now + PREVIOUS_GRACE_MS).toISOString() } } : {}),
      // Who last allowed it after a revoke stays on the record.
      ...(old?.allowed ? { allowed: old.allowed } : {}),
    }
    auth.devices = [...auth.devices.filter((d) => d !== old), record]
    return { persist: true, result: record }
  })
  return { verifyKey, record: kept, issuedAt }
}

export interface DoorKey { keyId: string; verifyKey: string; which: 'current' | 'previous' }

/** The keys a host of `rec` may prove itself with now: the current one, and the previous one within its grace. */
export function doorKeysOf(rec: DeviceRecord, now = Date.now()): DoorKey[] {
  const keys: DoorKey[] = []
  if (rec.revoked) return keys
  if (rec.verifyKey) keys.push({ keyId: doorKeyId(rec.verifyKey), verifyKey: rec.verifyKey, which: 'current' })
  if (rec.previous?.verifyKey && Date.parse(rec.previous.until) > now && rec.previous.verifyKey !== rec.verifyKey) {
    keys.push({ keyId: doorKeyId(rec.previous.verifyKey), verifyKey: rec.previous.verifyKey, which: 'previous' })
  }
  return keys
}

/**
 * Drop `machineId`'s door credential, and every live door socket of it in this process closes at
 * once. True when there was one. A revoked record stays (it holds no key, only the ban): checked
 * here, in the lock, so a revoke made after a caller listed the records is never lost.
 */
export async function dropHostCredential(machineId: string): Promise<boolean> {
  const name = hostCredentialName(machineId)
  const gone = await updateAuth((auth) => {
    const rec = auth.devices.find((d) => d.name === name && isHostCredentialRecord(d))
    if (!rec || rec.revoked) return { persist: false, result: false }
    auth.devices = auth.devices.filter((d) => d !== rec)
    return { persist: true, result: true }
  })
  if (gone) notifyRevoked([name])
  return gone
}

/**
 * Revoke `hostKey`'s door (the header): every record of that host keeps no key and says `by` and
 * when, and its door sockets in this process close at once. A host that has no record yet gets one
 * with no key for `machineId` (the machine its daemon link names), so the ban holds when it links.
 * `revoked`: false when there is nothing to hold it on (no record, no machine id); `closed`: the
 * records whose key was dropped now.
 */
export async function revokeHostDoor(hostKey: string, o: { by: string; machineId?: string | null; now?: number }): Promise<{ revoked: boolean; closed: string[]; skipped: string[] }> {
  if (!hostKey) throw new Error('no host key')
  const at = new Date(o.now ?? Date.now()).toISOString()
  const out = await updateAuth((auth) => {
    const none = { persist: false, result: { revoked: false, closed: [] as string[], names: [] as string[], skipped: [] as string[] } }
    // Its machine's record, under whichever of its names it was issued (hostRecordsIn).
    let mine = hostRecordsIn(auth.devices, hostKey)
    // A record whose only tie to this key is the machine id its hello claims: never banned by it (N1).
    const skipped = machineOnlyRecordsIn(auth.devices, hostKey).map((d) => d.hostKey ?? d.name)
    if (mine.length === 0 && o.machineId && MACHINE_ID_RE.test(o.machineId) && !isOwnMachine(o.machineId)) {
      const name = hostCredentialName(o.machineId)
      const held = auth.devices.find((d) => d.name === name)
      if (held) return { ...none, result: { ...none.result, skipped: isHostCredentialRecord(held) && held.hostKey ? [held.hostKey] : skipped } }
      const mark: DeviceRecord = { name, id: newDeviceId(), tokenHash: '', createdAt: at, kind: 'machine', issuer: 'leader', machineId: o.machineId, hostKey }
      auth.devices = [...auth.devices, mark]
      mine = [mark]
    }
    if (mine.length === 0) return { ...none, result: { ...none.result, skipped } }
    const closed: string[] = []
    for (const d of mine) {
      if (d.verifyKey || d.previous) closed.push(d.name)
      delete d.verifyKey
      delete d.previous
      delete d.issuedAt
      delete d.allowed
      // The machine's other config keys known now are the person's facts from here on (S1).
      const keys = new Set([...(d.revoked?.keys ?? []), hostKey, ...hostAliasesNow(hostKey).aliases, ...hostAliasesNow(d.hostKey!).aliases, ...stickyAliasesOf(d.hostKey!)])
      keys.delete(d.hostKey!)
      d.revoked = { ...(d.revoked ?? { at, by: o.by }), keys: [...keys].sort() }
    }
    return { persist: true, result: { revoked: true, closed, names: mine.map((d) => d.name), skipped } }
  })
  // Every record it banned: a socket still linked on a key a moment ago is closed too.
  if (out.revoked) notifyRevoked(out.names)
  return { revoked: out.revoked, closed: out.closed, skipped: out.skipped }
}

/**
 * The keys judged aliases of the ban on `hostKey`'s record since it was made (revoked-hosts.ts
 * stickyAliasesOf), written into it, so a restart keeps them banned. True when it wrote any.
 */
export async function keepBannedAliases(hostKey: string, keys: readonly string[]): Promise<boolean> {
  if (keys.length === 0) return false
  return updateAuth((auth) => {
    let wrote = false
    for (const d of auth.devices) {
      if (!isHostCredentialRecord(d) || d.hostKey !== hostKey || !d.revoked) continue
      const next = new Set([...(d.revoked.keys ?? []), ...keys.filter((k) => k && k !== hostKey)])
      if (next.size === (d.revoked.keys ?? []).length) continue
      d.revoked = { ...d.revoked, keys: [...next].sort() }
      wrote = true
    }
    return { persist: wrote, result: wrote }
  })
}

/** An allow under a key that is banned as another host's name: only that host's own key lifts it (R2-S1). */
export class HostBannedAs extends Error {
  constructor(readonly hostKey: string, readonly as: string) {
    super(`${hostKey} is banned as the revoked host ${as}: allow ${as} to lift it (POST /api/host-doors/${as}/allow)`)
    this.name = 'HostBannedAs'
  }
}

/**
 * Allow `hostKey` again after a revoke: its machine's marks go (`allowed` says by whom), and its next
 * link check issues it a fresh key. True when it was revoked. Only under the key the ban was made
 * as: a key banned as another host's name (an alias, a claimed machine id) throws HostBannedAs, so
 * allowing one box never lifts another's ban.
 */
export async function allowHostDoor(hostKey: string, o: { by: string; now?: number }): Promise<boolean> {
  const at = new Date(o.now ?? Date.now()).toISOString()
  return updateAuth((auth) => {
    const as = revokedAsIn(revokedRecordsOf(auth.devices), hostKey)
    if (as && as !== hostKey) throw new HostBannedAs(hostKey, as)
    const marked = hostRecordsIn(auth.devices, hostKey).filter((d) => d.revoked)
    for (const d of marked) { delete d.revoked; d.allowed = { at, by: o.by } }
    return { persist: marked.length > 0, result: marked.length > 0 }
  })
}
