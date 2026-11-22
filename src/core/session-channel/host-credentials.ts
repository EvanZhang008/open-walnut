/**
 * The door credentials this leader issues to its own hosts (door-wire.ts, host-door.ts): one
 * `machine` record per host machine in this leader's auth.json (device-store.ts), named
 * `host-<machineId>`, `issuer: 'leader'`. The record keeps the token's sha256 and the verify key S
 * (the leader proves itself with it at the door; auth.json is leader data, sensitive, mode 0600);
 * the plaintext token leaves this process once, to the host over its authenticated link, and is
 * never kept or logged here.
 *
 * A rotation moves the old hash and key to `previous`, taken for PREVIOUS_GRACE_MS more, so a
 * host that dials with the token it held a moment ago still gets in (and gets the proof that
 * belongs to that token). verifyDeviceToken never answers these records (no other door, no REST
 * route), and no pairing or owner rule touches them (device-auth.ts goneWith, makeOwner).
 *
 * Revoke: the record goes (its hashes tombstoned) and every live door socket of that machine in
 * this process closes at once (onCredentialsRevoked). A revoke from another process (the CLI) is
 * heard at the door's next recheck of its record, at most DOOR_RECHECK_MS later (host-door.ts).
 */
import { notifyRevoked } from '../device-auth.js'
import { hashesEqual, isHostCredentialRecord, newDeviceId, readRegistryAndRevoked, sha256Hex, tombstone, updateAuth, type DeviceRecord } from '../device-store.js'
import { doorSecret } from './door-wire.js'

/** How long a replaced token and key are still taken after a rotation. */
export const PREVIOUS_GRACE_MS = 10 * 60_000
/** A credential older than this is rotated at the host's next link. */
export const ROTATE_AFTER_MS = 30 * 24 * 60 * 60_000
const MACHINE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/

export function hostCredentialName(machineId: string): string {
  return `host-${machineId}`
}

export interface MintedHostCredential {
  /** The plaintext token: sent to the host once, never stored here. */
  token: string
  verifyKey: string
  /** The auth.json record now kept for it (the token's hash, never the token). */
  record: DeviceRecord
  issuedAt: string
}

/** The record of `machineId`'s door credential, or null. */
export async function hostCredentialOf(machineId: string): Promise<DeviceRecord | null> {
  const { devices } = await readRegistryAndRevoked()
  return devices.find((d) => isHostCredentialRecord(d) && d.machineId === machineId) ?? null
}

/** Does `machineId`'s credential need issuing (none, or older than ROTATE_AFTER_MS)? */
export function credentialDue(rec: Pick<DeviceRecord, 'issuedAt'> | null, now = Date.now()): boolean {
  if (!rec?.issuedAt) return true
  const at = Date.parse(rec.issuedAt)
  return !Number.isFinite(at) || now - at >= ROTATE_AFTER_MS
}

/**
 * Mint (or rotate) `machineId`'s door credential, under the auth.json lock: the issue over a host's
 * link (leader-issue.ts) and any other caller (the leader switch) take this one function. The
 * token it returns is the only copy: hand it to the host, then drop it.
 */
export async function mintHostCredential(o: { machineId: string; walnutId: string; hostKey: string; now?: number }): Promise<MintedHostCredential> {
  if (!MACHINE_ID_RE.test(o.machineId)) throw new Error('not a machine id')
  const now = o.now ?? Date.now()
  const token = doorSecret()
  const verifyKey = doorSecret()
  const issuedAt = new Date(now).toISOString()
  const name = hostCredentialName(o.machineId)
  const kept = await updateAuth((auth) => {
    const old = auth.devices.find((d) => d.name === name)
    if (old && !isHostCredentialRecord(old)) throw new Error(`${name} is another kind of record here; not replaced`)
    const record: DeviceRecord = {
      name, id: old?.id ?? newDeviceId(), tokenHash: sha256Hex(token), createdAt: old?.createdAt ?? issuedAt, kind: 'machine', issuer: 'leader',
      machineId: o.machineId, walnutId: o.walnutId, hostKey: o.hostKey, verifyKey, issuedAt,
      ...(old?.verifyKey ? { previous: { tokenHash: old.tokenHash, verifyKey: old.verifyKey, until: new Date(now + PREVIOUS_GRACE_MS).toISOString() } } : {}),
    }
    auth.devices = [...auth.devices.filter((d) => d !== old), record]
    return { persist: true, result: record }
  })
  return { token, verifyKey, record: kept, issuedAt }
}

export interface DoorCredentialMatch {
  record: DeviceRecord
  /** The verify key that belongs to the token presented: the previous one for the previous token. */
  verifyKey: string
  which: 'current' | 'previous'
}

/**
 * The host credential `token` is, or null. Every record and both of its hashes are compared (no
 * early exit, constant time each); a previous token counts only until its `until`; a hash revoked
 * here never counts.
 */
export function matchDoorToken(devices: readonly DeviceRecord[], revoked: ReadonlySet<string>, token: string, now = Date.now()): DoorCredentialMatch | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > 256) return null
  const hash = sha256Hex(token)
  let found: DoorCredentialMatch | null = null
  for (const d of devices) {
    if (!isHostCredentialRecord(d) || !d.verifyKey || !d.machineId) continue
    const cur = hashesEqual(hash, d.tokenHash)
    const prev = !!d.previous && hashesEqual(hash, d.previous.tokenHash) && Date.parse(d.previous.until) > now
    if (cur) found = { record: d, verifyKey: d.verifyKey, which: 'current' }
    else if (prev) found = { record: d, verifyKey: d.previous!.verifyKey, which: 'previous' }
  }
  if (found && revoked.has(hash)) return null
  return found
}

/** matchDoorToken over this leader's auth.json now. */
export async function verifyHostCredential(token: string, now = Date.now()): Promise<DoorCredentialMatch | null> {
  const { devices, revoked } = await readRegistryAndRevoked()
  return matchDoorToken(devices, revoked, token, now)
}

/**
 * Drop `machineId`'s door credential: its hashes are tombstoned in the same write, and every live
 * door socket of it in this process closes at once. True when there was one.
 */
export async function dropHostCredential(machineId: string): Promise<boolean> {
  const name = hostCredentialName(machineId)
  const gone = await updateAuth((auth) => {
    const rec = auth.devices.find((d) => d.name === name && isHostCredentialRecord(d))
    if (!rec) return { persist: false, result: false }
    auth.devices = auth.devices.filter((d) => d !== rec)
    tombstone(auth, [rec.tokenHash, ...(rec.previous ? [rec.previous.tokenHash] : [])])
    return { persist: true, result: true }
  })
  if (gone) notifyRevoked([name])
  return gone
}
