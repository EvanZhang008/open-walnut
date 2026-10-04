/**
 * Machine credentials on the companion (device records of kind 'machine', the
 * `bridge-*` tokens daemons dial /bridge and /daemon-tunnel with): who may
 * mint, replace, revoke and adopt them.
 *
 * One companion serves one Mac, as the /bridge model always assumed; these
 * rules make that explicit instead of first come, first served:
 *  - the caller is the paired device its bearer token authenticates as
 *    (device-actor.ts), never a name, and ownership is recorded by that
 *    device's immutable id (`ownerId`), so re-pairing a name inherits nothing;
 *  - only a paired device mints one: never an API key, never a phone (a device
 *    recorded as one at its claim, device-auth.ts setDeviceInfo);
 *  - while any device owns a machine credential here, no other device mints,
 *    replaces, revokes or adopts one. It hears 409 OTHER_MAC_CONNECTED;
 *  - credentials from before ownership was recorded (no owner, or an owner
 *    whose pairing is gone) belong to the Mac that minted them. The proof is
 *    the token of the legacy `bridge-local` itself (MACHINE_PROOF_HEADER),
 *    which only that Mac's own daemon ever held; the token of any other
 *    credential proves nothing, since a remote host's daemon holds its own.
 *    The first successful act with that proof adopts all of them, and the
 *    Mac's tunnel daemon stays the unkeyed one they always used;
 *  - revoking the owner's pairing (device-auth.ts revokeDevice) takes its
 *    machine credentials with it, and the unowned ones. That is how a
 *    companion passes to another Mac: on purpose, and the Mac that loses it
 *    sees its own sync stop, not a silent takeover.
 *
 * Every check runs inside the auth.json lock together with the write, so two
 * Macs minting at once cannot both win.
 */

import {
  listDeviceRecords, mutateDeviceRecords, newMachineRecord, notifyRevoked, tokenMatchesHash, type DeviceRecord,
} from './device-auth.js'
import { isPhoneRecord, liveOwnerOf, recordForToken, type DeviceActor } from './device-actor.js'
import { log } from '../logging/index.js'
import { CLOUD_BOX_OTHER_MAC_SENTENCE } from './hosts/cloud-box-host.js'

/** The sentence a second Mac hears (its host card says it too, cloud-box-host.ts). */
export const OTHER_MAC_CONNECTED = CLOUD_BOX_OTHER_MAC_SENTENCE
const PHONE_CANNOT = 'A phone cannot mint or revoke a machine credential.'
const NEEDS_DEVICE = "A machine credential is minted with a paired Mac's own device token."
const NOT_MACHINE = 'That name belongs to a paired device, not a machine credential.'

/** Request header carrying the legacy `bridge-local` token, as proof of being the Mac that holds it. */
export const MACHINE_PROOF_HEADER = 'x-walnut-machine-proof'

/** The Mac's own machine credential: its local daemon's, and the only key to /daemon-tunnel. */
export const PRIMARY_MACHINE_CREDENTIAL = 'bridge-local'

export type MachineCredentialAction = 'mint' | 'replace' | 'revoke' | 'adopt'

type Refusal = { ok: false; status: 400 | 403 | 409; code: 'machine_needs_device' | 'phone_cannot_mint' | 'other_mac_connected' | 'not_machine'; error: string }

export type MachineCredentialDecision =
  | { ok: true; me: DeviceRecord; adopt: DeviceRecord[] }
  | Refusal

export class MachineCredentialRefused extends Error {
  constructor(public status: 400 | 403 | 409, public code: string, message: string) {
    super(message)
    this.name = 'MachineCredentialRefused'
  }
}

const OTHER_MAC: Refusal = { ok: false, status: 409, code: 'other_mac_connected', error: OTHER_MAC_CONNECTED }

/**
 * The rules above, pure. `by` is the caller, `proof` the legacy bridge-local
 * token it presents. `adopt` lists the unowned credentials this act makes the
 * caller's (its proof was good).
 */
export function machineCredentialDecision(
  devices: DeviceRecord[],
  input: { by: DeviceActor; name: string; action: MachineCredentialAction; proof?: string },
): MachineCredentialDecision {
  const me = 'token' in input.by ? recordForToken(devices, input.by.token) : undefined
  if (!me || me.kind === 'machine' || !me.id) return { ok: false, status: 403, code: 'machine_needs_device', error: NEEDS_DEVICE }
  if (isPhoneRecord(me)) return { ok: false, status: 403, code: 'phone_cannot_mint', error: PHONE_CANNOT }
  const owners = new Set<DeviceRecord>()
  const legacy: DeviceRecord[] = []
  for (const d of devices) {
    if (d.kind !== 'machine') continue
    const owner = liveOwnerOf(d, devices)
    if (owner) owners.add(owner)
    else legacy.push(d)
  }
  if ([...owners].some((o) => o !== me)) return OTHER_MAC
  const existing = devices.find((d) => d.name === input.name)
  if (existing && existing.kind !== 'machine') return { ok: false, status: 400, code: 'not_machine', error: NOT_MACHINE }
  if (owners.has(me)) return { ok: true, me, adopt: legacy }
  // Nothing is owned yet. The legacy bridge-local, if there is one, is the
  // first Mac's: only its token lets a device act (and makes all of them its).
  const legacyLocal = legacy.find((d) => d.name === PRIMARY_MACHINE_CREDENTIAL)
  if (legacyLocal) {
    return input.proof && tokenMatchesHash(input.proof, legacyLocal.tokenHash) ? { ok: true, me, adopt: legacy } : OTHER_MAC
  }
  // No bridge-local left to prove with: adopting needs something to adopt.
  if (input.action === 'adopt') return OTHER_MAC
  return { ok: true, me, adopt: [] }
}

/** The tunnel daemon key a new credential of `me` gets: the one it adopted, else its own id. */
function daemonKeyFor(me: DeviceRecord): string | undefined {
  return me.tunnelDaemon ? me.tunnelDaemon.key : me.id
}

/**
 * Apply a decision's adoption: the unowned credentials become `me`'s and keep
 * their daemon, and `me` records that daemon as its own (the legacy
 * bridge-local's, the unkeyed one), so a credential it mints later lands there.
 */
function adoptInto(devices: DeviceRecord[], me: DeviceRecord, adopt: DeviceRecord[]): DeviceRecord[] {
  if (adopt.length === 0) return devices
  const local = adopt.find((d) => d.name === PRIMARY_MACHINE_CREDENTIAL)
  return devices.map((d) => {
    if (adopt.includes(d)) return { ...d, ownerId: me.id }
    if (d === me && !me.tunnelDaemon) return { ...d, tunnelDaemon: local?.daemonKey ? { key: local.daemonKey } : {} }
    return d
  })
}

function refuse(d: Refusal): never {
  throw new MachineCredentialRefused(d.status, d.code, d.error)
}

/**
 * Mint `name` for the caller. An existing credential of that name answers
 * "already exists" (400) unless `replace`, which rotates it (the old token
 * stops working, and its open sockets are told).
 */
export async function mintMachineCredential(
  name: string,
  opts: { by: DeviceActor; replace?: boolean; proof?: string },
): Promise<{ name: string; token: string; createdAt: string; replaced: boolean }> {
  const out = await mutateDeviceRecords((devices) => {
    const decision = machineCredentialDecision(devices, { by: opts.by, name, action: opts.replace ? 'replace' : 'mint', proof: opts.proof })
    if (!decision.ok) refuse(decision)
    const existing = devices.find((d) => d.name === name)
    if (existing && !opts.replace) throw new Error(`Device "${name}" already exists`)
    const adopted = adoptInto(devices, decision.me, decision.adopt)
    const me = adopted.find((d) => d.id === decision.me.id)!
    // A first mint with nothing adopted takes this Mac's own daemon; the
    // record says so, so a later mint after a revoke lands on it again.
    const withKey = me.tunnelDaemon ? adopted : adopted.map((d) => (d === me ? { ...d, tunnelDaemon: { key: me.id } } : d))
    // A rotation keeps the daemon that serves the credential (its sessions).
    const daemonKey = existing ? existing.daemonKey : daemonKeyFor(me)
    const { record, token } = newMachineRecord(name, me.id!, daemonKey)
    return {
      devices: [...withKey.filter((d) => d.name !== name), record],
      result: { name, token, createdAt: record.createdAt, replaced: existing !== undefined, owner: me.name },
    }
  })
  if (out.replaced) notifyRevoked([name])
  log.web.info('device-auth: machine credential minted', { name, owner: out.owner, replaced: out.replaced })
  return { name: out.name, token: out.token, createdAt: out.createdAt, replaced: out.replaced }
}

/** Revoke machine credential `name` for the caller. False when there is none. */
export async function revokeMachineCredential(
  name: string,
  opts: { by: DeviceActor; proof?: string },
): Promise<boolean> {
  const removed = await mutateDeviceRecords((devices) => {
    if (!devices.some((d) => d.name === name)) return { result: null }
    const decision = machineCredentialDecision(devices, { by: opts.by, name, action: 'revoke', proof: opts.proof })
    if (!decision.ok) refuse(decision)
    const adopted = adoptInto(devices, decision.me, decision.adopt)
    return { devices: adopted.filter((d) => d.name !== name), result: decision.me.name }
  })
  if (removed === null) return false
  notifyRevoked([name])
  log.web.info('device-auth: machine credential revoked', { name, by: removed })
  return true
}

/**
 * Become the owner of the credentials from before ownership was recorded,
 * proving it with the legacy bridge-local token. The Mac does this once per
 * start, so a lost token cache later re-mints as the owner instead of hitting
 * OTHER_MAC_CONNECTED. No token and no daemon changes. 'owned' = already the
 * caller's, 'missing' = no credential of that name.
 */
export async function adoptMachineCredential(
  name: string,
  opts: { by: DeviceActor; proof?: string },
): Promise<'adopted' | 'owned' | 'missing'> {
  const outcome = await mutateDeviceRecords((devices) => {
    const existing = devices.find((d) => d.name === name)
    if (!existing) return { result: 'missing' as const }
    const decision = machineCredentialDecision(devices, { by: opts.by, name, action: 'adopt', proof: opts.proof })
    if (!decision.ok) refuse(decision)
    if (decision.adopt.length === 0 || !decision.adopt.includes(existing)) return { result: 'owned' as const }
    return { devices: adoptInto(devices, decision.me, decision.adopt), result: 'adopted' as const }
  })
  if (outcome === 'adopted') log.web.info('device-auth: machine credentials adopted', { name })
  return outcome
}

/**
 * Which tunnel daemon serves machine credential `name` (undefined: the unkeyed
 * one, used by a credential from before ownership was recorded, and by none).
 */
export async function machineCredentialDaemonKey(name: string): Promise<string | undefined> {
  const d = (await listDeviceRecords()).find((r) => r.name === name)
  return d?.kind === 'machine' ? d.daemonKey : undefined
}
