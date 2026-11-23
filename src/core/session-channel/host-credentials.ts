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
 * Revoke: the record goes and every live door socket of that machine in this process closes at
 * once (onCredentialsRevoked). A revoke from another process (the CLI) is heard at the door's next
 * recheck of its record, at most DOOR_RECHECK_MS later (host-door.ts).
 */
import { notifyRevoked } from '../device-auth.js'
import { isHostCredentialRecord, newDeviceId, readRegistryAndRevoked, updateAuth, type DeviceRecord } from '../device-store.js'
import { doorKeyId, doorSecret } from './door-wire.js'

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
    const record: DeviceRecord = {
      name, id: old?.id ?? newDeviceId(), tokenHash: '', createdAt: old?.createdAt ?? issuedAt, kind: 'machine', issuer: 'leader',
      machineId: o.machineId, walnutId: o.walnutId, hostKey: o.hostKey, verifyKey, issuedAt,
      ...(old?.verifyKey ? { previous: { verifyKey: old.verifyKey, until: new Date(now + PREVIOUS_GRACE_MS).toISOString() } } : {}),
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
  if (rec.verifyKey) keys.push({ keyId: doorKeyId(rec.verifyKey), verifyKey: rec.verifyKey, which: 'current' })
  if (rec.previous?.verifyKey && Date.parse(rec.previous.until) > now && rec.previous.verifyKey !== rec.verifyKey) {
    keys.push({ keyId: doorKeyId(rec.previous.verifyKey), verifyKey: rec.previous.verifyKey, which: 'previous' })
  }
  return keys
}

/**
 * Drop `machineId`'s door credential, and every live door socket of it in this process closes at
 * once. True when there was one.
 */
export async function dropHostCredential(machineId: string): Promise<boolean> {
  const name = hostCredentialName(machineId)
  const gone = await updateAuth((auth) => {
    const rec = auth.devices.find((d) => d.name === name && isHostCredentialRecord(d))
    if (!rec) return { persist: false, result: false }
    auth.devices = auth.devices.filter((d) => d !== rec)
    return { persist: true, result: true }
  })
  if (gone) notifyRevoked([name])
  return gone
}
