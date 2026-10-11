/**
 * The pairings on this box as the push code and the revoke queue read them:
 * which names and token hashes can authenticate, which hashes were revoked
 * here, and whether one request's pairing still holds. Read-only, and async,
 * never a sync read on the event loop. Writes go through device-auth.ts; the
 * file and its lock live in device-store.ts.
 */

import { FileLockTimeoutError } from '../utils/file-lock.js'
import { hashesEqual, readAuthForCheck, readRegistryAndRevoked, sha256Hex, withAuthLock, type AuthFile, type DeviceRecord } from './device-store.js'

export interface PairedDevices {
  /** Every name a pairing here can authenticate as. */
  names: Set<string>
  /** Every pairing's token hash. */
  hashes: Set<string>
  /** The token hashes revoked here (AuthFile.revokedHashes). */
  revoked: Set<string>
  /**
   * `auth` = auth.json itself. `backup` = its sidecar, read because auth.json
   * could not be (missing, unreadable, corrupt): good enough to judge by, never
   * to delete by, since it can lag the real file.
   */
  from: 'auth' | 'backup'
}

/**
 * The pairings on this box, for the push sender's send-time check
 * (core/push/paired-rows.ts) and the revoke queue (core/devices/revoke-queue.ts).
 *
 * auth.json first; when it cannot be read or parsed, auth.json.bak. Null only
 * when neither can: loading reads that as zero devices, and a caller judging
 * rows must not, or one bad read would silence every phone.
 */
export async function readPairedDevices(): Promise<PairedDevices | null> {
  const of = (auth: AuthFile, from: PairedDevices['from']): PairedDevices => ({
    names: new Set(auth.devices.map((d) => d.name)), hashes: new Set(auth.devices.map((d) => d.tokenHash)),
    revoked: new Set(auth.revokedHashes ?? []), from,
  })
  const read = await readAuthForCheck()
  return read ? of(read.auth, read.from) : null
}

/**
 * Run `fn` holding the auth lock, with the pairings as auth.json has them then
 * (readPairedDevices), for the revoke queue's drain: every revoke holds this
 * lock from its write-ahead to its auth.json write, so under it no revoke is
 * between the two. Waits at most `waitMs` for the lock; null = busy, try later
 * (the holder may be the very revoke the caller is judging).
 */
export async function withPairingsLocked<R>(
  fn: (paired: PairedDevices | null) => Promise<R>,
  waitMs: number,
): Promise<{ value: R } | null> {
  try {
    return { value: await withAuthLock(async () => fn(await readPairedDevices()), { timeoutMs: waitMs }) }
  } catch (err) {
    if (err instanceof FileLockTimeoutError) return null
    throw err
  }
}

/** Which pairing a request's token authenticated as, in a form that survives the device rotating its own token. */
export interface PairingRef {
  name: string
  /** The pairing's id (a self-rotation keeps it). */
  id?: string
  tokenHash: string
}

/** The pairing `token` authenticates as right now, or null (unknown or revoked). */
export async function pairingRefOf(token: string): Promise<PairingRef | null> {
  const { devices, revoked } = await readRegistryAndRevoked()
  const hash = sha256Hex(token)
  if (revoked.has(hash)) return null
  const d = devices.find((x) => x.kind !== 'machine' && hashesEqual(hash, x.tokenHash))
  return d ? { name: d.name, ...(d.id ? { id: d.id } : {}), tokenHash: d.tokenHash } : null
}

function refHoldsIn(devices: readonly DeviceRecord[], revoked: ReadonlySet<string>, ref: PairingRef): boolean {
  return devices.some((d) => d.name === ref.name && !revoked.has(d.tokenHash)
    && (ref.id !== undefined ? d.id === ref.id : d.tokenHash === ref.tokenHash))
}

/** Is that pairing still here (the same one, or the device's own rotation of it)? */
export async function pairingRefHolds(ref: PairingRef): Promise<boolean> {
  const { devices, revoked } = await readRegistryAndRevoked()
  return refHoldsIn(devices, revoked, ref)
}

/** The token hashes of `name`'s pairings that authenticate right now (no machine credentials, nothing revoked). */
export async function livePairingHashesOf(name: string): Promise<string[]> {
  const { devices, revoked } = await readRegistryAndRevoked()
  return devices.filter((d) => d.name === name && d.kind !== 'machine' && !revoked.has(d.tokenHash)).map((d) => d.tokenHash)
}

/**
 * Run `fn` only if `ref` still holds, inside the auth lock, so no revoke of it
 * lands while `fn` runs. A revoke holds this lock from its write-ahead to its
 * auth.json write and the revoke time it takes right after, so what `fn`
 * writes is older than that cutoff, or `fn` sees the pairing gone and never
 * runs. 'gone' = not run; null = the lock stayed busy (the default wait).
 */
export async function whilePairingHolds<R>(ref: PairingRef, fn: () => Promise<R>): Promise<{ value: R } | 'gone' | null> {
  try {
    return await withAuthLock(async () => {
      const { devices, revoked } = await readRegistryAndRevoked()
      return refHoldsIn(devices, revoked, ref) ? { value: await fn() } : 'gone' as const
    })
  } catch (err) {
    if (err instanceof FileLockTimeoutError) return null
    throw err
  }
}
