/**
 * Machine credentials on the companion (device records of kind 'machine', the
 * `bridge-*` tokens the daemons of the Mac's computers dial /bridge with): who
 * may make, replace, remove and adopt them. They are the companion's owner's,
 * the Mac it belongs to:
 *  - the caller is the paired device its bearer token authenticates as, never
 *    a name, and an API key is no device;
 *  - with an owner recorded (device-store.ts `owner`: the setup claim, the box
 *    operator, a bridge-local proof, or the first mint below), only the owner
 *    may. A phone hears 403, a computer that is not the owner 409
 *    `other_mac_connected` (OTHER_MAC_CONNECTED, or OTHER_COMPUTER_CONNECTED
 *    when the owner said it is a computer that is not a Mac), any other device
 *    409 with the owner-only sentence;
 *  - with none recorded (a companion from before owners were recorded, or its
 *    owner was unpaired), the rules of the builds before, unchanged: while a
 *    device owns a machine credential here, no other device may (409
 *    OTHER_MAC_CONNECTED); credentials from before ownership was recorded
 *    belong to the Mac whose daemon holds the unowned `bridge-local`, proved by
 *    its token (MACHINE_PROOF_HEADER); with nothing owned and no such
 *    `bridge-local`, the first paired device that is not a phone may. Whoever
 *    MINTS is recorded as the owner then ('mint'; a revoke or an adopt records
 *    none, only a proof does, 'proof'), never guessed from which record is
 *    oldest;
 *  - removing the owner's pairing removes its machine credentials and the
 *    unowned ones (device-auth.ts), and so does the operator naming another owner;
 *  - each credential names the companion tunnel daemon that serves it
 *    (`daemonKey`): the owner's own, or the unkeyed one the credentials from
 *    before ownership was recorded used.
 *
 * Every check runs inside the auth.json lock together with the write, so two
 * Macs asking at once cannot both win.
 */

import { liveOwnerOf, ownerRecord, proofClaim, recordForToken, type DeviceActor } from './device-actor.js'
import { newMachineRecord, notifyRevoked } from './device-auth.js'
import {
  daemonKeyFor, isMacReport, isPhoneRecord, platformFromInfo, readRegistry, updateAuth,
  type CompanionOwner, type DeviceRecord, type DeviceRegistry, type LockedAuth,
} from './device-store.js'
import { PRIMARY_MACHINE_CREDENTIAL } from './device-actor.js'
import { log } from '../logging/index.js'

export { MACHINE_PROOF_HEADER, PRIMARY_MACHINE_CREDENTIAL } from './device-actor.js'

/** The sentence a second Mac hears. */
export const OTHER_MAC_CONNECTED = 'Another Mac is connected to this cloud companion. Disconnect it there first.'
/** The same, when the owner's own report says a computer that is not a Mac (its words are kept true). */
export const OTHER_COMPUTER_CONNECTED = 'Another computer is connected to this cloud companion. Disconnect it there first.'
const OWNER_ONLY = 'Only the Mac this cloud companion belongs to can connect computers to it.'
const NOT_MACHINE = 'That name already belongs to a paired device.'

export type MachineCredentialAction = 'mint' | 'replace' | 'revoke' | 'adopt'

export type MachineRefusalCode =
  | 'machine_needs_device' | 'phone_cannot_mint' | 'other_mac_connected' | 'not_companion_owner' | 'not_machine'

type Refusal = { ok: false; status: 400 | 403 | 409; code: MachineRefusalCode; error: string }

export type MachineCredentialDecision =
  /** `adopt`: the unowned credentials this act makes `me`'s; `record`: the owner it records (none recorded yet). */
  | { ok: true; me: DeviceRecord; adopt: DeviceRecord[]; record: CompanionOwner | null }
  | Refusal

export class MachineCredentialRefused extends Error {
  constructor(public status: 400 | 403 | 409, public code: MachineRefusalCode, message: string) {
    super(message)
    this.name = 'MachineCredentialRefused'
  }
}

const OTHER_MAC: Refusal = { ok: false, status: 409, code: 'other_mac_connected', error: OTHER_MAC_CONNECTED }

/**
 * What a computer hears when `owner` has the companion. The code is the same
 * either way (the Mac's bridge treats it as "belongs to another"); the
 * sentence says a Mac unless the owner's own report says another computer.
 */
function otherOwnerRefusal(owner: DeviceRecord): Refusal {
  return owner.platform === 'other' && platformFromInfo(owner.info) === 'other' && !isMacReport(owner.info)
    ? { ok: false, status: 409, code: 'other_mac_connected', error: OTHER_COMPUTER_CONNECTED }
    : OTHER_MAC
}

/**
 * The rules above, pure. `by` is the caller, `proof` the unowned bridge-local's
 * token it presents.
 */
export function machineCredentialDecision(
  reg: DeviceRegistry,
  input: { by: DeviceActor; name: string; action: MachineCredentialAction; proof?: string },
): MachineCredentialDecision {
  const me = 'token' in input.by ? recordForToken(reg.devices, input.by.token) : undefined
  if (!me || me.kind === 'machine' || !me.id) return { ok: false, status: 403, code: 'machine_needs_device', error: OWNER_ONLY }
  if (isPhoneRecord(me)) return { ok: false, status: 403, code: 'phone_cannot_mint', error: OWNER_ONLY }
  const existing = reg.devices.find((d) => d.name === input.name)
  const notMachine: Refusal = { ok: false, status: 400, code: 'not_machine', error: NOT_MACHINE }
  const legacy = reg.devices.filter((d) => d.kind === 'machine' && liveOwnerOf(d, reg.devices) === undefined)
  const recorded = ownerRecord(reg)
  if (recorded) {
    if (recorded !== me) {
      // A computer (by its own word, which decides nothing but these words) hears
      // that another Mac has the companion; a device that never said what it is,
      // the plain rule.
      return me.platform === 'other' ? otherOwnerRefusal(recorded) : { ok: false, status: 409, code: 'not_companion_owner', error: OWNER_ONLY }
    }
    if (existing && existing.kind !== 'machine') return notMachine
    return { ok: true, me, adopt: legacy, record: null }
  }
  // No owner recorded: the rules of the builds before owners were recorded.
  const owners = new Set<DeviceRecord>()
  for (const d of reg.devices) {
    const o = d.kind === 'machine' ? liveOwnerOf(d, reg.devices) : undefined
    if (o) owners.add(o)
  }
  const otherOwner = [...owners].find((o) => o !== me)
  if (otherOwner) return otherOwnerRefusal(otherOwner)
  if (existing && existing.kind !== 'machine') return notMachine
  // Only a mint records an owner here: a revoke or an adopt is allowed by the
  // same rules and records none (cloud-sync.md, "A companion belongs to one Mac").
  const minting = input.action === 'mint' || input.action === 'replace'
  const minted: CompanionOwner | null = minting ? { id: me.id, via: 'mint' } : null
  if (owners.has(me)) return { ok: true, me, adopt: legacy, record: minted }
  // Nothing is owned yet. The unowned bridge-local, if there is one, is the
  // first Mac's: only its token lets a device act (and makes all of them its).
  const legacyLocal = legacy.find((d) => d.name === PRIMARY_MACHINE_CREDENTIAL)
  if (legacyLocal) {
    const claim = proofClaim(reg, me, input.proof)
    return claim ? { ok: true, me, adopt: legacy, record: claim } : OTHER_MAC
  }
  // No bridge-local left to prove with: adopting needs something to adopt.
  if (input.action === 'adopt') return OTHER_MAC
  // First come: the first paired device that is not a phone to mint, recorded as the owner now.
  return { ok: true, me, adopt: [], record: minted }
}

/**
 * Apply a decision before its write: record the owner it names, make the
 * unowned credentials `me`'s (they keep their daemon, and `me` records that
 * daemon as its own: the bridge-local's, the unkeyed one), so a credential it
 * mints later lands there. Returns the record of `me` inside `auth`.
 */
function applyDecision(auth: LockedAuth, decision: Extract<MachineCredentialDecision, { ok: true }>): DeviceRecord {
  const me = auth.devices.find((d) => d === decision.me)!
  if (decision.record) auth.owner = decision.record
  if (decision.adopt.length > 0) {
    const local = decision.adopt.find((d) => d.name === PRIMARY_MACHINE_CREDENTIAL)
    for (const d of decision.adopt) d.ownerId = me.id
    if (!me.tunnelDaemon) me.tunnelDaemon = local?.daemonKey ? { key: local.daemonKey } : {}
  }
  return me
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
  const out = await updateAuth((auth) => {
    const decision = machineCredentialDecision(auth, { by: opts.by, name, action: opts.replace ? 'replace' : 'mint', proof: opts.proof })
    if (!decision.ok) refuse(decision)
    const existing = auth.devices.find((d) => d.name === name)
    // Nothing is written for a name that is taken (the builds before wrote nothing either).
    if (existing && !opts.replace) return { persist: false, result: null }
    const me = applyDecision(auth, decision)
    // A first mint with nothing adopted takes this Mac's own daemon; the
    // record says so, so a later mint after a revoke lands on it again.
    if (!me.tunnelDaemon) me.tunnelDaemon = { key: me.id }
    // A rotation keeps the daemon that serves the credential (its sessions).
    const { record, token } = newMachineRecord(name, me.id!, existing ? existing.daemonKey : daemonKeyFor(me))
    auth.devices = [...auth.devices.filter((d) => d.name !== name), record]
    return { persist: true, result: { name, token, createdAt: record.createdAt, replaced: existing !== undefined, owner: me.name, recorded: decision.record?.via ?? null } }
  })
  if (!out) throw new Error(`Device "${name}" already exists`)
  if (out.replaced) notifyRevoked([name])
  log.web.info('device-auth: machine credential minted', { name, owner: out.owner, replaced: out.replaced, ...(out.recorded ? { ownerRecorded: out.recorded } : {}) })
  return { name: out.name, token: out.token, createdAt: out.createdAt, replaced: out.replaced }
}

/** Revoke machine credential `name` for the caller. False when there is none. */
export async function revokeMachineCredential(
  name: string,
  opts: { by: DeviceActor; proof?: string },
): Promise<boolean> {
  const removed = await updateAuth((auth) => {
    if (!auth.devices.some((d) => d.name === name)) return { persist: false, result: null }
    const decision = machineCredentialDecision(auth, { by: opts.by, name, action: 'revoke', proof: opts.proof })
    if (!decision.ok) refuse(decision)
    const me = applyDecision(auth, decision)
    auth.devices = auth.devices.filter((d) => d.name !== name)
    return { persist: true, result: me.name }
  })
  if (removed === null) return false
  notifyRevoked([name])
  log.web.info('device-auth: machine credential revoked', { name, by: removed })
  return true
}

/**
 * Become the owner of the credentials from before ownership was recorded,
 * proving it with the unowned bridge-local's token: the Mac's first contact
 * with such a companion (it sends it once per start,
 * src/integrations/cloud-bridge-config.ts). No token changes. 'adopted' = this
 * act made them the caller's, 'owned' = nothing to adopt, 'missing' = no
 * credential of that name.
 */
export async function adoptMachineCredential(
  name: string,
  opts: { by: DeviceActor; proof?: string },
): Promise<'adopted' | 'owned' | 'missing'> {
  const outcome = await updateAuth((auth) => {
    const existing = auth.devices.find((d) => d.name === name)
    if (!existing) return { persist: false, result: 'missing' as const }
    const decision = machineCredentialDecision(auth, { by: opts.by, name, action: 'adopt', proof: opts.proof })
    if (!decision.ok) refuse(decision)
    if (!decision.adopt.includes(existing)) return { persist: false, result: 'owned' as const }
    applyDecision(auth, decision)
    return { persist: true, result: 'adopted' as const }
  })
  if (outcome === 'adopted') log.web.info('device-auth: machine credentials adopted', { name })
  return outcome
}

/**
 * Which tunnel daemon serves machine credential `name` (undefined: the unkeyed
 * one, used by a credential from before ownership was recorded, and by none).
 */
export async function machineCredentialDaemonKey(name: string): Promise<string | undefined> {
  const d = (await readRegistry()).devices.find((r) => r.name === name)
  return d?.kind === 'machine' ? d.daemonKey : undefined
}
