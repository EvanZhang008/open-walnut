/**
 * Who may change a device record (auth.json), decided on the records
 * themselves, inside the auth.json lock (device-auth.ts calls it there).
 *
 * The caller is an ACTOR, never a name: a name can be re-paired, and a rule
 * keyed on it handed whoever re-paired the name everything the name held
 * (2026-09-29: a phone rotated the Mac's pairing, then minted the Mac's machine
 * credential as it and landed on the Mac's sessions).
 *  - `local`: this machine itself, the `walnut device` CLI (it edits auth.json
 *    directly), or the primary's own console over loopback;
 *  - `token`: a paired device, by the bearer token it presented; matched
 *    against the records in constant time;
 *  - `apiKey`: a config.yaml API key, which is no device at all.
 *
 * The rules:
 *  - removing or re-pairing an EXISTING device is for that device itself (its
 *    own token), the Mac that owns this companion's machine credentials, or a
 *    local caller. Everyone else hears 403 DEVICE_CHANGE_REFUSED;
 *  - a phone never pairs another device: a new record starts without a
 *    recorded platform, and pairing one would launder the phone into a device
 *    the machine credential rules do not know as a phone.
 *
 * A device's `platform` is recorded once, at its first self-report (its claim,
 * see setDeviceInfo) and never changes after; `id` is minted at pairing and
 * kept only by a rotation the device makes itself. Ownership of machine
 * credentials is keyed by that id (machine-credentials.ts).
 */

import crypto from 'node:crypto'
import type { DeviceRecord, DeviceSelfInfo } from './device-auth.js'

export type DeviceActor = { local: true } | { token: string } | { apiKey: string }

/** This machine itself: the `walnut device` CLI, or the primary's loopback console. */
export const LOCAL_ACTOR: DeviceActor = { local: true }

export type DevicePlatform = 'ios' | 'other'

export type DeviceChange = 'rotate' | 'revoke' | 'create'

/** A refused change to a device record. The routes answer `status` with `{ error, code }`. */
export class DeviceChangeRefused extends Error {
  constructor(public status: 403, public code: 'device_change_refused' | 'phone_cannot_pair', message: string) {
    super(message)
    this.name = 'DeviceChangeRefused'
  }
}

const PHONE_CANNOT_PAIR = 'A phone cannot pair other devices. Pair it from the Mac, in Settings › Phones & Cloud.'

/** The sentence a caller hears when it may not remove or re-pair `name`. */
export function deviceChangeRefusal(name: string, cloudMode: boolean): string {
  return cloudMode
    ? `Only ${name} itself or the Mac this companion serves can remove or re-pair ${name}. On the companion, \`walnut device revoke ${name}\` works too.`
    : `Only ${name} itself or this Mac can remove or re-pair ${name}.`
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf-8').digest('hex')
}

function hashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex')
  const bufB = Buffer.from(b, 'hex')
  if (bufA.length !== 32 || bufB.length !== 32) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

/** The record `token` authenticates as. Every record is compared (no early exit). */
export function recordForToken(devices: readonly DeviceRecord[], token: string): DeviceRecord | undefined {
  const hash = sha256Hex(token)
  let found: DeviceRecord | undefined
  for (const d of devices) if (hashesEqual(hash, d.tokenHash)) found = d
  return found
}

/** A fresh device id: minted once, at pairing. */
export function newDeviceId(): string {
  return `d${crypto.randomBytes(8).toString('hex')}`
}

/** What a self-report says about the platform; undefined when it says nothing. */
export function platformFromInfo(info: DeviceSelfInfo | undefined): DevicePlatform | undefined {
  const model = info?.model ?? ''
  const os = info?.os ?? ''
  if (/^(iPhone|iPad|iPod)/.test(model) || /^(iOS|iPadOS)\b/i.test(os)) return 'ios'
  return model || os ? 'other' : undefined
}

/** A device recorded as a phone (at its claim; a later self-report never changes it). */
export function isPhoneRecord(d: Pick<DeviceRecord, 'platform'>): boolean {
  return d.platform === 'ios'
}

/** The paired device that owns machine credential `cred`, while it is still paired. */
export function liveOwnerOf(cred: DeviceRecord, devices: readonly DeviceRecord[]): DeviceRecord | undefined {
  if (cred.kind !== 'machine' || !cred.ownerId) return undefined
  return devices.find((d) => d.kind !== 'machine' && d.id !== undefined && d.id === cred.ownerId)
}

/** Does `device` own any of this companion's machine credentials? */
export function ownsMachineCredentials(devices: readonly DeviceRecord[], device: DeviceRecord): boolean {
  return device.kind !== 'machine' && devices.some((d) => d.kind === 'machine' && liveOwnerOf(d, devices) === device)
}

export type DeviceChangeDecision =
  | { ok: true; by: 'local' | 'self' | 'owner' | 'new' }
  | { ok: false; refusal: DeviceChangeRefused }

/**
 * May `actor` make `change` to the record named `name`? `create` asks about a
 * name that has no record yet. Machine credentials are not decided here
 * (machine-credentials.ts); only a local caller removes one through this path.
 */
export function deviceChangeDecision(
  devices: readonly DeviceRecord[],
  actor: DeviceActor,
  change: DeviceChange,
  name: string,
  cloudMode: boolean,
): DeviceChangeDecision {
  const me = 'token' in actor ? recordForToken(devices, actor.token) : undefined
  if (change === 'create') {
    if (me && isPhoneRecord(me)) return { ok: false, refusal: new DeviceChangeRefused(403, 'phone_cannot_pair', PHONE_CANNOT_PAIR) }
    return { ok: true, by: 'new' }
  }
  if ('local' in actor) return { ok: true, by: 'local' }
  const target = devices.find((d) => d.name === name)
  if (me && target && me === target && me.kind !== 'machine') return { ok: true, by: 'self' }
  if (me && target && target.kind !== 'machine' && ownsMachineCredentials(devices, me)) return { ok: true, by: 'owner' }
  return { ok: false, refusal: new DeviceChangeRefused(403, 'device_change_refused', deviceChangeRefusal(name, cloudMode)) }
}
