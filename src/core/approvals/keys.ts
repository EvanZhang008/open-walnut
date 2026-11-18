/**
 * The devices that can sign approvals: WALNUT_HOME/approvals/keys.json.
 *
 * Each key is a P-256 key made in a device's Secure Enclave that signs only after Face ID
 * or Touch ID (the iPhone app, the Mac app); Walnut holds only the public half.
 *
 * Who may add one:
 *  - a device app the person set up signs at once, first key or not (`fromDeviceApp`): the iPhone
 *    app over a request that carries its paired device token (a QR pairing, never a browser's or
 *    the extension's sign-in: phone-app.ts), directly or carried by the cloud companion, which
 *    names the paired phone it checked (v1-forward/forwarded-device.ts); or
 *    the Mac app's own signed process (mac-app-proof.ts) running in the account's own home folder
 *    (ApprovalBridge.swift), which enrolls its Touch ID key when it starts. So each device's first
 *    approval is one Face ID or Touch ID with nothing to set up and nothing to approve elsewhere
 *    (2026-11-11, the user: "it must just work"; 2026-11-12, of a "Let iPhone sign your approvals"
 *    card on his phone: "我都已经连接了，为什么还要问我？"). Face ID or Touch ID is still asked at
 *    every real approval, by the device itself.
 *  - any other request (no device token, no Mac app proof, a copy of the Mac app started in another
 *    home folder) adds no key and asks the person nothing: it is refused. Walnut asked "Let <device>
 *    sign your approvals" for those before, and that card reached the person for a test's copy of
 *    the app (2026-11-18, the user: "I said mac and ios alreayc cna apporve, but why this"); a key
 *    still pending from then, and its ask, are withdrawn on boot (withdrawPendingEnrollments), and
 *    a Mac's own key that a key such an ask let in took the place of signs again (restoreMacKeysTakenByAsks).
 * Known limit: a process of this account can make a device token (devices.ts) and so add a key of
 * its own; the first key had that limit before, now every key has it. An approval bound to one
 * key (`signingKeyId`, the Git gate's pinned Mac key) still takes only that key's signature.
 * Removing a key needs no approval while another active key remains (it only takes trust
 * away). The last active key is never removed through Walnut, since the next key would then
 * be trusted on first use again: a person who lost that phone deletes keys.json by hand.
 */

import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { readJsonFile, updateJsonFile } from '../../utils/fs.js'
import { bus } from '../event-bus.js'
import { log } from '../../logging/index.js'
import { keyIdOf, parsePublicKey } from './digest.js'
import { deviceLabel } from './device-name.js'
import { ApprovalError, cancelInternal } from './store.js'
import type { ApprovalKey, ApprovalKeysFile, ApprovalView } from './types.js'

export const APPROVAL_KEYS_CHANGED = 'approval-keys:changed'

function keysFile(): string {
  return path.join(WALNUT_HOME, 'approvals', 'keys.json')
}
const EMPTY: ApprovalKeysFile = { version: 1, keys: [] }

export async function listKeys(): Promise<ApprovalKey[]> {
  return (await readJsonFile<ApprovalKeysFile>(keysFile(), EMPTY)).keys
}

export async function activeKeys(): Promise<ApprovalKey[]> {
  return (await listKeys()).filter((k) => k.status === 'active')
}

export async function activeKey(id: string): Promise<ApprovalKey | undefined> {
  return (await activeKeys()).find((k) => k.id === id)
}

/** A key as every reader gets it: no ask id, and the name a person reads (device-name.ts). */
export function keyView(k: ApprovalKey): Omit<ApprovalKey, 'enrollApprovalId'> {
  const { enrollApprovalId: _e, ...rest } = k
  return { ...rest, name: deviceLabel(k.name, k.kind) }
}

function changed(): void {
  bus.emit(APPROVAL_KEYS_CHANGED, {}, ['web-ui'], { source: 'approvals' })
}

export interface EnrollInput {
  publicKey: string
  name: string
  kind: 'iphone' | 'mac-app'
  /** The request came from a device app the person set up (a paired iPhone's token, the Mac app's proof): see the header. */
  fromDeviceApp?: boolean
}

/** Why a key was not added, in the words its own device shows (the iPhone shows it on its approval sheet). */
export const REFUSED_KEY_MESSAGE: Record<EnrollInput['kind'], string> = {
  'mac-app': 'Walnut adds this Mac as a device that signs approvals only from the Walnut Mac app itself, running in your '
    + 'own account. This request could not be shown to be that (a script, a browser, a copy of the app started with another '
    + 'home folder, or an app built before this check: update the Walnut Mac app), so nothing was added and nothing is asked.',
  iphone: 'Walnut adds an iPhone as a device that signs approvals only from your paired iPhone app. This request could not '
    + 'be shown to be that (a browser\'s sign-in, or a cloud companion not updated yet: open the app once on the same network '
    + 'as your computer), so nothing was added and nothing is asked.',
}

// One enrollment at a time: a key and its enrollment approval are written in two steps, and two
// concurrent calls for one new key (the app's launch and foreground refreshes) must make one ask.
let enrollChain: Promise<unknown> = Promise.resolve()

export interface EnrollResult {
  key: ApprovalKey
}

export function enrollKey(input: EnrollInput): Promise<EnrollResult> {
  const run = enrollChain.then(() => enrollOne(input))
  enrollChain = run.catch(() => undefined)
  return run
}

async function enrollOne(input: EnrollInput): Promise<EnrollResult> {
  if (!parsePublicKey(input.publicKey)) throw new ApprovalError(400, 'bad_key', 'publicKey must be a base64 DER P-256 public key.')
  if (input.kind !== 'iphone' && input.kind !== 'mac-app') throw new ApprovalError(400, 'bad_request', 'kind is iphone or mac-app.')
  const name = (input.name || '').replace(/\s+/g, ' ').trim().slice(0, 80) || (input.kind === 'iphone' ? 'iPhone' : 'Mac')
  const id = keyIdOf(input.publicKey)
  let key: ApprovalKey | undefined
  let activated = false
  let withdraw: string | undefined
  let retired: ApprovalKey[] = []
  await updateJsonFile<ApprovalKeysFile>(keysFile(), EMPTY, (file) => {
    const now = new Date().toISOString()
    const existing = file.keys.find((k) => k.id === id)
    if (existing?.status === 'retired') {
      // A key this Mac had before, sent again from its own app (it keeps its key now:
      // ApprovalBridge.swift): it signs again, and what replaced it is retired below.
      if (!input.fromDeviceApp || existing.kind !== input.kind) { key = existing; return file }
      existing.status = 'active'; existing.activatedAt = now; delete existing.retiredAt; delete existing.replacedBy
      key = existing; activated = true; return file
    }
    if (existing) {
      // A key an older Walnut left pending signs at once when its device app asks again; its
      // enrollment ask is withdrawn below. From anything else it stays as it is and is refused.
      if (existing.status === 'pending' && input.fromDeviceApp && existing.kind === input.kind) {
        withdraw = existing.enrollApprovalId
        existing.status = 'active'; existing.activatedAt = now; delete existing.enrollApprovalId
        activated = true
      }
      key = existing; return file
    }
    // Only a device app the person set up adds a key (see the header): anything else adds none.
    if (!input.fromDeviceApp) return file
    key = { id, name, kind: input.kind, publicKey: input.publicKey, createdAt: now, status: 'active', activatedAt: now }
    file.keys.push(key)
    activated = true
    return file
  })
  // The Mac app keeps its key while the one on disk still needs Touch ID, and makes a new one only
  // when it does not (ApprovalBridge.swift); then the key it had before is one it can no longer sign
  // with: the same Mac (its name) asking from its own app retires its earlier keys, active or pending, with their
  // "Let … sign" asks (2026-11-12: the Mac app's keys piled up, and a pending one from a replaced
  // key left a card nobody could answer). The iPhone app keeps its key and enrolls the same one
  // again, and many phones share the default name "iPhone", so phones are left alone. Known limit:
  // two Macs with the same name read as one, so each takes the other's place when it enrolls.
  if (key && key.status === 'active' && input.fromDeviceApp && key.kind === 'mac-app') {
    const keep = key
    await updateJsonFile<ApprovalKeysFile>(keysFile(), EMPTY, (file) => {
      retired = file.keys.filter((k) => k.id !== keep.id && k.kind === keep.kind && k.name === keep.name && k.status !== 'retired')
      retire(file, retired, keep)
      return file
    })
    await afterRetire(retired, keep)
  }
  if (key?.status === 'retired') throw new ApprovalError(409, 'key_retired', 'This key was replaced by a newer one from the same Mac; only that Mac\'s own app can bring it back.')
  if (withdraw) await cancelInternal(withdraw, 'the device signs now: it was set up from its own app').catch(() => undefined)
  // Never an ask: a key that does not sign now (none added, or one an older Walnut left pending) is refused.
  if (!key || key.status !== 'active') {
    log.web.info('approval key refused: not from a device app', { keyId: id, kind: input.kind, ...(key ? { status: key.status } : {}) })
    throw new ApprovalError(403, 'first_key_from_phone', REFUSED_KEY_MESSAGE[input.kind])
  }
  if (activated) changed()
  log.web.info('approval key active', { keyId: id, kind: key.kind, name: key.name })
  return { key }
}

/**
 * On boot: every key an older Walnut left pending goes, and every "Let … sign your approvals" ask
 * still open is withdrawn. Walnut no longer asks that (see the header), so no such card stays on the
 * person's screen; the device's own app adds its key at once the next time it opens. Returns how
 * many asks it withdrew.
 */
export async function withdrawPendingEnrollments(): Promise<number> {
  let dropped: ApprovalKey[] = []
  await updateJsonFile<ApprovalKeysFile>(keysFile(), EMPTY, (file) => {
    dropped = file.keys.filter((k) => k.status === 'pending')
    if (dropped.length) file.keys = file.keys.filter((k) => k.status !== 'pending')
    return file
  })
  const { listApprovals } = await import('./store.js')
  const open = (await listApprovals({ status: 'pending' })).filter((a) => a.enrollsKey)
  for (const a of open) {
    await cancelInternal(a.id, 'Walnut no longer asks to let a device sign: your own devices sign at once').catch(() => undefined)
  }
  if (dropped.length || open.length) {
    changed()
    log.web.info('approvals: withdrew the asks to let a device sign', {
      asks: open.map((a) => a.id), keys: dropped.map((k) => ({ id: k.id, kind: k.kind })),
    })
  }
  return open.length
}

/**
 * On boot, after retireReplacedMacKeys: undo what the old "Let … sign your approvals" ask let happen
 * (2026-11-18). A test's copy of the Mac app, started in another home folder, made a key of its own
 * and sent it; the person approved the card with the Mac's own Touch ID, and that key, newer than
 * the Mac app's own, then retired it (retireReplacedMacKeys), so the person's Mac signed no more.
 * A Mac key that still signed after the newer key appeared is the one the Mac app holds, and the
 * newer one, let in only by an ask and never signing since, is another program's: it is retired in
 * turn, replaced by the Mac's own key, which signs again (a verifier that followed the first key to
 * the newer one is led back; the row stays, so a second Mac of the same name can bring its key back
 * from its own app). Only keys an approved enrollment ask let in are ever retired here, and Walnut
 * makes no such ask now (enrollKey), so this repairs data an older Walnut wrote and nothing else.
 * Returns how many keys it gave back.
 */
export async function restoreMacKeysTakenByAsks(): Promise<number> {
  const { listApprovals } = await import('./store.js')
  const askedIn = new Set((await listApprovals({ status: 'all', limit: 1_000 }))
    .filter((a) => a.enrollsKey && a.status === 'approved').map((a) => a.enrollsKey!))
  if (!askedIn.size) return 0
  const at = (s?: string) => Date.parse(s ?? '') || 0
  const restored: Array<{ id: string; retired: string }> = []
  await updateJsonFile<ApprovalKeysFile>(keysFile(), EMPTY, (file) => {
    for (const k of [...file.keys]) {
      if (k.kind !== 'mac-app' || k.status !== 'retired' || !k.replacedBy || askedIn.has(k.id)) continue
      const n = file.keys.find((x) => x.id === k.replacedBy)
      if (!n || n.kind !== 'mac-app' || n.name !== k.name || n.status !== 'active' || !askedIn.has(n.id)) continue
      // The Mac kept signing with its own key after the newer one came, and the newer one never signed since.
      if (at(k.lastUsedAt) <= at(n.createdAt) || at(n.lastUsedAt) > at(k.lastUsedAt)) continue
      k.status = 'active'; k.activatedAt = new Date().toISOString(); delete k.retiredAt; delete k.replacedBy
      retire(file, [n], k)
      restored.push({ id: k.id, retired: n.id })
    }
    return file
  })
  if (restored.length) {
    changed()
    log.web.info('approval keys: the Mac\'s own key signs again; a key an ask let in had taken its place', { restored })
  }
  return restored.length
}

/** Called when an approval is decided: an approved enrollment activates its key, an approved removal removes one. */
export async function applyKeyApproval(approval: ApprovalView): Promise<void> {
  if (approval.status === 'approved' && approval.answer?.mode === 'biometric') {
    if (approval.enrollsKey) {
      await updateJsonFile<ApprovalKeysFile>(keysFile(), EMPTY, (file) => {
        const k = file.keys.find((x) => x.id === approval.enrollsKey)
        if (k && k.status === 'pending') { k.status = 'active'; k.activatedAt = new Date().toISOString(); delete k.enrollApprovalId }
        return file
      })
      changed()
    }
  }
  if (approval.enrollsKey && (approval.status === 'denied' || approval.status === 'expired' || approval.status === 'canceled')) {
    await updateJsonFile<ApprovalKeysFile>(keysFile(), EMPTY, (file) => {
      file.keys = file.keys.filter((x) => !(x.id === approval.enrollsKey && x.status === 'pending'))
      return file
    })
    changed()
  }
}

export async function touchKey(id: string): Promise<void> {
  await updateJsonFile<ApprovalKeysFile>(keysFile(), EMPTY, (file) => {
    const k = file.keys.find((x) => x.id === id)
    if (k) k.lastUsedAt = new Date().toISOString()
    return file
  })
}

/** Remove one key. The last active key is refused: see the header. */
export async function removeKey(id: string): Promise<void> {
  let refused = false
  let found = false
  let enrollId: string | undefined
  await updateJsonFile<ApprovalKeysFile>(keysFile(), EMPTY, (file) => {
    const k = file.keys.find((x) => x.id === id)
    if (!k) return file
    found = true
    const othersActive = file.keys.some((x) => x.id !== id && x.status === 'active')
    if (k.status === 'active' && !othersActive) { refused = true; return file }
    enrollId = k.enrollApprovalId
    file.keys = file.keys.filter((x) => x.id !== id)
    return file
  })
  if (!found) throw new ApprovalError(404, 'not_found', 'No such device key.')
  if (refused) {
    throw new ApprovalError(409, 'last_key', 'This is the last device that signs approvals, so Walnut keeps it: with none, the next device would be trusted on first use. If that phone is lost, delete approvals/keys.json in the Walnut data folder by hand.')
  }
  if (enrollId) await cancelInternal(enrollId, 'the device was removed').catch(() => undefined)
  changed()
}

/**
 * On boot: the same rule for keys an older Walnut kept. Per Mac (name), the key it enrolled last
 * that is active stays; its earlier keys, active or pending, go with their asks. A pending key
 * newer than that one is left to withdrawPendingEnrollments, which runs next.
 */
export async function retireReplacedMacKeys(): Promise<number> {
  let retired: ApprovalKey[] = []
  await updateJsonFile<ApprovalKeysFile>(keysFile(), EMPTY, (file) => {
    const at = (k: ApprovalKey) => Date.parse(k.createdAt) || 0
    const newest = new Map<string, ApprovalKey>()
    for (const k of file.keys) {
      if (k.kind !== 'mac-app' || k.status !== 'active') continue
      const cur = newest.get(k.name)
      if (!cur || at(k) > at(cur)) newest.set(k.name, k)
    }
    retired = file.keys.filter((k) => {
      const keep = k.kind === 'mac-app' && k.status !== 'retired' ? newest.get(k.name) : undefined
      return !!keep && k.id !== keep.id && at(k) <= at(keep)
    })
    for (const k of retired) retire(file, [k], newest.get(k.name)!)
    return file
  })
  await afterRetire(retired)
  return retired.length
}

/** How many retired rows are kept (the newest), so a verifier can follow a few re-enrollments back. */
const RETIRED_KEEP = 20

/** Mark keys retired in place, replaced by `keep`: a pending one (it never signed) goes. */
function retire(file: ApprovalKeysFile, keys: ApprovalKey[], keep: ApprovalKey): void {
  if (!keys.length) return
  const now = new Date().toISOString()
  file.keys = file.keys.filter((k) => !(keys.includes(k) && k.status === 'pending'))
  for (const k of keys) {
    if (k.status !== 'active') continue
    k.status = 'retired'; k.retiredAt = now; k.replacedBy = keep.id
  }
  const old = file.keys.filter((k) => k.status === 'retired').sort((a, b) => (b.retiredAt ?? '').localeCompare(a.retiredAt ?? ''))
  if (old.length > RETIRED_KEEP) { const drop = new Set(old.slice(RETIRED_KEEP)); file.keys = file.keys.filter((k) => !drop.has(k)) }
}

async function afterRetire(retired: ApprovalKey[], keep?: ApprovalKey): Promise<void> {
  if (!retired.length) return
  for (const old of retired) {
    if (old.enrollApprovalId) await cancelInternal(old.enrollApprovalId, 'this Mac enrolled a newer key from its own app').catch(() => undefined)
  }
  log.web.info('approval keys retired: the same Mac enrolled a newer key', {
    ...(keep ? { keyId: keep.id, name: keep.name } : {}), retired: retired.map((k) => ({ id: k.id, name: k.name, status: k.status })),
  })
  changed()
}
