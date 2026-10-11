/**
 * Who may change a device record (auth.json), decided on the records
 * themselves, inside the auth.json lock (device-auth.ts calls it there).
 *
 * The caller is an ACTOR, never a name: a name can be re-paired, and a rule
 * keyed on it handed whoever re-paired the name everything the name held
 * (2026-09-29: a phone rotated the Mac's pairing, then acted as the Mac).
 *  - `local`: this machine itself, the `walnut device` CLI (it edits auth.json
 *    directly), or a loopback request on the primary made for a caller on this
 *    Mac (its console, a local client, a self-call for a session on this Mac);
 *  - `token`: a paired device, by the bearer token it presented; matched
 *    against the records in constant time;
 *  - `apiKey`: a config.yaml API key, which is no device at all;
 *  - `onBehalfOf`: a loopback self-call this server made for a caller off this
 *    Mac (a session on another exec host, a paired client), by the class its
 *    x-walnut-origin names (src/lib/caller-origin.ts). It carries no
 *    credential of that caller, so it is never this Mac and never a device:
 *    it pairs, re-pairs and removes nothing, and makes no API key.
 *
 * The rules:
 *  - removing or re-pairing an EXISTING device is for that device itself (its
 *    own token), this machine itself, and the device with the owner's rights
 *    (hasOwnerRights): on a cloud companion its OWNER, the Mac it belongs to
 *    (device-store.ts `owner`, recorded from a proof, never from a self-report
 *    or from which record is oldest); where none is recorded, and always on
 *    the Mac, the device that owns the machine credentials there, the rule of
 *    the builds before owners were recorded. Everyone else hears 403
 *    DEVICE_CHANGE_REFUSED;
 *  - pairing a new device is for any paired device but a phone (a phone pairs
 *    from the Mac), and never for an API key (2026-10-03: a phone made a key,
 *    and the key paired a device that was not recorded as a phone);
 *  - having this Mac act on its cloud companion (its own token there) is for
 *    this machine itself only (cloudRelayDecision);
 *  - API keys are made and removed by this machine itself, or on a companion by
 *    the device with the owner's rights (apiKeyDecision); a key belongs to the
 *    device that made it and stops working when that device's pairing goes.
 */

import { isPhoneRecord, recordForToken, tokenMatchesHash, type CompanionOwner, type DeviceRecord, type DeviceRegistry } from './device-store.js'

export { isPhoneRecord, newDeviceId, platformFromInfo, recordForToken, type DevicePlatform } from './device-store.js'

/** Request header carrying the companion's first `bridge-local` token, as proof of being the Mac that holds it. */
export const MACHINE_PROOF_HEADER = 'x-walnut-machine-proof'

/** The Mac's own machine credential: its local daemon's. */
export const PRIMARY_MACHINE_CREDENTIAL = 'bridge-local'

export type DeviceActor = { local: true } | { token: string } | { apiKey: string } | { onBehalfOf: string }

/** This machine itself: the `walnut device` CLI, or the primary's loopback console. */
export const LOCAL_ACTOR: DeviceActor = { local: true }

export type DeviceChange = 'rotate' | 'revoke' | 'create'

export type DeviceRefusalCode =
  | 'device_change_refused' | 'phone_cannot_pair' | 'api_key_cannot_pair' | 'not_a_device' | 'api_keys_refused'

/** A refused change to a device record. The routes answer `status` with `{ error, code }`. */
export class DeviceChangeRefused extends Error {
  constructor(public status: 400 | 403, public code: DeviceRefusalCode, message: string) {
    super(message)
    this.name = 'DeviceChangeRefused'
  }
}

/*
 * Every refusal is one plain sentence for the person who sees it. A sentence
 * that ends in a command has no period, so the command copies cleanly.
 */
const PHONE_CANNOT_PAIR = 'Pair new devices from the Mac, in Settings › Phones & Cloud, not from a phone.'
const API_KEY_CANNOT_PAIR = 'An API key cannot pair, re-pair or remove devices.'

/** Said to a self-call made for a caller off this Mac that asks to pair a new device. */
export const SELF_CALL_CANNOT_PAIR = 'Only this Mac itself can pair new devices, in Settings › Phones & Cloud on this Mac.'

/** The sentence a caller hears when it may not remove or re-pair `name`. */
export function deviceChangeRefusal(name: string, cloudMode: boolean): string {
  return cloudMode
    ? `Only ${name} itself or the Mac this cloud companion belongs to can remove or re-pair ${name}.`
    : `Only ${name} itself or this Mac can remove or re-pair ${name}.`
}

/** Said when a paired caller asks to add, re-pair or remove a computer's connection (a machine credential). */
export function machineTargetRefusal(name: string, cloudMode: boolean): string {
  return cloudMode
    ? `Only the Mac this cloud companion belongs to can add or remove ${name}.`
    : `Only this Mac itself can add or remove ${name}.`
}

/** Said when a re-pair names a computer's connection, which has no QR code to show. */
export function notADeviceRefusal(name: string): string {
  return `${name} is a computer's connection to this server, not a device you can re-pair.`
}

/**
 * The recorded owner's record, while it is still paired (device-store.ts
 * `owner`). A phone is never one: an owner recorded before its first report
 * said a phone counts as none.
 */
export function ownerRecord(reg: DeviceRegistry): DeviceRecord | undefined {
  const id = reg.owner?.id
  return id ? reg.devices.find((d) => d.kind !== 'machine' && !isPhoneRecord(d) && d.id === id) : undefined
}

/** The paired device that owns machine credential `cred`, while it is still paired. */
export function liveOwnerOf(cred: DeviceRecord, devices: readonly DeviceRecord[]): DeviceRecord | undefined {
  if (cred.kind !== 'machine' || !cred.ownerId) return undefined
  return devices.find((d) => d.kind !== 'machine' && d.id !== undefined && d.id === cred.ownerId)
}

/** Does `device` own any of the machine credentials here? */
export function ownsMachineCredentials(devices: readonly DeviceRecord[], device: DeviceRecord): boolean {
  return device.kind !== 'machine' && devices.some((d) => d.kind === 'machine' && liveOwnerOf(d, devices) === device)
}

/**
 * Does `device` hold the owner's rights here (re-pair and remove others, make
 * API keys, keep its pairing when a twin is removed by hash)? On a cloud
 * companion with an owner recorded: that owner. Where none is recorded, and
 * always on the Mac (an owner is a companion's notion): the device that owns
 * machine credentials here, as builds from before owners were recorded decided.
 * Never a phone, whatever the file says.
 */
export function hasOwnerRights(reg: DeviceRegistry, device: DeviceRecord, cloudMode: boolean): boolean {
  if (device.kind === 'machine' || isPhoneRecord(device)) return false
  const recorded = cloudMode ? ownerRecord(reg) : undefined
  return recorded ? recorded === device : ownsMachineCredentials(reg.devices, device)
}

/** The device with the owner's rights on a companion (hasOwnerRights), for display: the Mac it belongs to. */
export function companionOwnerRecord(reg: DeviceRegistry): DeviceRecord | undefined {
  return ownerRecord(reg) ?? reg.devices.find((d) => !isPhoneRecord(d) && ownsMachineCredentials(reg.devices, d))
}

/**
 * Does `proof` make `me` the owner? It does when it is the token of a
 * `bridge-local` minted before ownership was recorded (no ownerId): only the
 * Mac whose own daemon dialed with it ever held it. It counts only while no
 * owner is recorded and no other device owns machine credentials here (the
 * rule of the builds before, which adopted the unowned credentials with it).
 * Another credential's token proves nothing (a remote host's daemon holds its
 * own), and a phone is never made an owner. Returns the new owner, or null.
 */
export function proofClaim(reg: DeviceRegistry, me: DeviceRecord | undefined, proof: string | undefined): CompanionOwner | null {
  if (!proof || !me?.id || me.kind === 'machine' || isPhoneRecord(me)) return null
  if (ownerRecord(reg)) return null
  if (reg.devices.some((d) => d.kind === 'machine' && liveOwnerOf(d, reg.devices) !== undefined && liveOwnerOf(d, reg.devices) !== me)) return null
  const local = reg.devices.find((d) => d.kind === 'machine' && d.name === PRIMARY_MACHINE_CREDENTIAL && liveOwnerOf(d, reg.devices) === undefined)
  return local && tokenMatchesHash(proof, local.tokenHash) ? { id: me.id, via: 'proof' } : null
}

export type DeviceChangeDecision =
  | { ok: true; by: 'local' | 'self' | 'owner' | 'new' }
  | { ok: false; refusal: DeviceChangeRefused }

const refuse = (status: 400 | 403, code: DeviceRefusalCode, message: string): DeviceChangeDecision =>
  ({ ok: false, refusal: new DeviceChangeRefused(status, code, message) })

/**
 * May `actor` make `change` to the record named `name`? `create` asks about a
 * name that has no record yet. A paired caller never reaches a machine
 * credential here (machine-credentials.ts decides those on a companion; on the
 * Mac they are this machine's own).
 */
export function deviceChangeDecision(
  reg: DeviceRegistry,
  actor: DeviceActor,
  change: DeviceChange,
  name: string,
  cloudMode: boolean,
): DeviceChangeDecision {
  if ('local' in actor) return { ok: true, by: 'local' }
  if ('apiKey' in actor) return refuse(403, 'api_key_cannot_pair', API_KEY_CANNOT_PAIR)
  // A self-call for a caller off this Mac: whoever it acts for showed no credential.
  if ('onBehalfOf' in actor) {
    return change === 'create'
      ? refuse(403, 'device_change_refused', SELF_CALL_CANNOT_PAIR)
      : refuse(403, 'device_change_refused', deviceChangeRefusal(name, cloudMode))
  }
  const me = recordForToken(reg.devices, actor.token)
  const target = reg.devices.find((d) => d.name === name)
  if (target?.kind === 'machine') return refuse(403, 'device_change_refused', machineTargetRefusal(name, cloudMode))
  if (me && me.kind !== 'machine' && change === 'create') {
    return isPhoneRecord(me) ? refuse(403, 'phone_cannot_pair', PHONE_CANNOT_PAIR) : { ok: true, by: 'new' }
  }
  if (me && target && me === target) return { ok: true, by: 'self' }
  if (me && target && hasOwnerRights(reg, me, cloudMode)) return { ok: true, by: 'owner' }
  return refuse(403, 'device_change_refused', deviceChangeRefusal(name, cloudMode))
}

/** Said to a caller that asked this Mac to change devices on its cloud companion. */
export const CLOUD_RELAY_REFUSAL = 'Only this Mac itself can pair or remove devices on the cloud companion, in Settings › Phones & Cloud on this Mac.'

/**
 * May `actor` have THIS Mac act on its cloud companion (the relay behind
 * `target: 'cloud'`, a cloud removal, the cloud half of the device list)? The
 * relay presents the Mac's own companion token, so whoever uses it has the
 * Mac's standing there: the owner, who may re-pair or remove any device. Only
 * this Mac itself may lend that (2026-10-02: a phone paired on this Mac,
 * reaching it through a tunnel, minted companion tokens, re-paired another Mac
 * into a phone and removed devices there, all refused when the same phone asked
 * the companion directly). A phone hears the refusal it hears for a local
 * pairing.
 */
export function cloudRelayDecision(
  devices: readonly DeviceRecord[],
  actor: DeviceActor,
  change: DeviceChange | 'list',
): DeviceChangeDecision {
  if ('local' in actor) return { ok: true, by: 'local' }
  const me = 'token' in actor ? recordForToken(devices, actor.token) : undefined
  if (change === 'create' && me && isPhoneRecord(me)) return refuse(403, 'phone_cannot_pair', PHONE_CANNOT_PAIR)
  return refuse(403, 'device_change_refused', CLOUD_RELAY_REFUSAL)
}

export type ApiKeyDecision = { ok: true; deviceId?: string } | { ok: false; refusal: DeviceChangeRefused }

/**
 * May `actor` create or remove API keys? A key reaches everything its maker's
 * token reaches outside device management, so only a caller that already holds
 * all of that may make one: this machine itself (an unbound key, like one the
 * operator writes into config.yaml), and on a cloud companion its owner (a key
 * bound to the owner's id, device-auth.ts apiKeyMaker). Never a phone, another
 * device, or a key.
 */
export function apiKeyDecision(reg: DeviceRegistry, actor: DeviceActor, cloudMode: boolean): ApiKeyDecision {
  if ('local' in actor) return { ok: true }
  const me = 'token' in actor ? recordForToken(reg.devices, actor.token) : undefined
  if (cloudMode && me?.id && !isPhoneRecord(me) && hasOwnerRights(reg, me, cloudMode)) return { ok: true, deviceId: me.id }
  const sentence = cloudMode
    ? 'Only the Mac this cloud companion belongs to can create or remove API keys.'
    : 'Only this Mac itself can create or remove API keys.'
  return { ok: false, refusal: new DeviceChangeRefused(403, 'api_keys_refused', sentence) }
}
