/**
 * The devices that can sign approvals: WALNUT_HOME/approvals/keys.json.
 *
 * Each key is a P-256 key made in a device's Secure Enclave that signs only after Face ID
 * or Touch ID (the iPhone app, the Mac app); Walnut holds only the public half.
 *
 * Who may add one:
 *  - a device app the person set up signs at once, first key or not (`fromDeviceApp`): the iPhone
 *    app over a request that carries its paired device token (a QR pairing, never a browser's or
 *    the extension's sign-in: routes/approvals-v1.ts isPairedPhoneApp), or the Mac app's own signed process
 *    (mac-app-proof.ts), which enrolls its Touch ID key when it starts. So each device's first
 *    approval is one Face ID or Touch ID with nothing to set up and nothing to approve elsewhere
 *    (2026-11-11, the user: "it must just work"; 2026-11-12, of a "Let iPhone sign your approvals"
 *    card on his phone: "我都已经连接了，为什么还要问我？"). Face ID or Touch ID is still asked at
 *    every real approval, by the device itself.
 *  - any other request (no device token, no Mac app proof) adds no first key, and a later one
 *    stays pending until an active key approves it, through a biometric approval Walnut itself
 *    asks ("Let <device> sign your approvals"), so such a key can never vouch for itself.
 * Known limit: a process of this account can make a device token (devices.ts) and so add a key of
 * its own; the first key had that limit before, now every key has it. A key left pending re-enrolls
 * from its app (ApprovalCenter.swift, approvals-store.ts), which activates it. An approval bound to one
 * key (`signingKeyId`, the Git gate's pinned Mac key) still takes only that key's signature.
 * Removing a key needs no approval while another active key remains (it only takes trust
 * away). The last active key is never removed through Walnut, since the next key would then
 * be trusted on first use again: a person who lost that phone deletes keys.json by hand.
 */

import os from 'node:os'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { readJsonFile, updateJsonFile } from '../../utils/fs.js'
import { bus } from '../event-bus.js'
import { log } from '../../logging/index.js'
import { keyIdOf, parsePublicKey } from './digest.js'
import { ApprovalError, cancelInternal, createApproval } from './store.js'
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

export const FIRST_KEY_MESSAGE = 'A device that signs approvals is the Walnut Mac app (Touch ID) or your iPhone (Face ID), '
  + 'added by the app itself: open it, and for the iPhone while it reaches this computer directly (the same network or your '
  + 'tailnet, not through the cloud companion).'

// One enrollment at a time: a key and its enrollment approval are written in two steps, and two
// concurrent calls for one new key (the app's launch and foreground refreshes) must make one ask.
let enrollChain: Promise<unknown> = Promise.resolve()

export interface EnrollResult {
  key: ApprovalKey
  /** Present while the key waits for an active key to approve it. */
  enrollment?: ApprovalView
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
  let needsEnrollment = false
  let activated = false
  let withdraw: string | undefined
  await updateJsonFile<ApprovalKeysFile>(keysFile(), EMPTY, (file) => {
    const now = new Date().toISOString()
    const existing = file.keys.find((k) => k.id === id)
    if (existing) {
      // A key left pending (asked before this rule, or from a request without proof) signs at
      // once when its device app asks again; its enrollment ask is withdrawn below.
      if (existing.status === 'pending' && input.fromDeviceApp && existing.kind === input.kind) {
        withdraw = existing.enrollApprovalId
        existing.status = 'active'; existing.activatedAt = now; delete existing.enrollApprovalId
        activated = true
      }
      key = existing; needsEnrollment = existing.status === 'pending' && !existing.enrollApprovalId; return file
    }
    const anyActive = file.keys.some((k) => k.status === 'active')
    if (!anyActive && !input.fromDeviceApp) return file
    const trusted = !!input.fromDeviceApp || !anyActive
    key = { id, name, kind: input.kind, publicKey: input.publicKey, createdAt: now, status: trusted ? 'active' : 'pending', ...(trusted ? { activatedAt: now } : {}) }
    file.keys.push(key)
    needsEnrollment = !trusted
    activated = trusted
    return file
  })
  if (!key) throw new ApprovalError(403, 'first_key_from_phone', FIRST_KEY_MESSAGE)
  if (withdraw) await cancelInternal(withdraw, 'the device signs now: it was set up from its own app').catch(() => undefined)
  if (key.status === 'active') {
    if (activated) changed()
    log.web.info('approval key active', { keyId: id, kind: key.kind, name: key.name })
    return { key }
  }
  // Pending: an existing pending key keeps its open enrollment approval.
  if (!needsEnrollment && key.enrollApprovalId) {
    const { getApproval, viewOf } = await import('./store.js')
    const open = await getApproval(key.enrollApprovalId)
    if (open && open.status === 'pending') return { key, enrollment: viewOf(open) }
  }
  const { approval } = await createApproval({
    what: `Let "${key.name}" (${key.kind === 'iphone' ? 'iPhone' : 'Mac app'}) sign your approvals`,
    detail: `A new device asked to sign Walnut approvals with Face ID or Touch ID.\nKey ${key.id}.\nApprove only if you just set this device up yourself.`,
    mode: 'biometric', outsideSwitch: true,
    timeoutMs: 24 * 60 * 60_000,
    requester: { host: os.hostname() || 'this computer' },
    enrollsKey: key.id,
  })
  await updateJsonFile<ApprovalKeysFile>(keysFile(), EMPTY, (file) => {
    const k = file.keys.find((x) => x.id === id)
    if (k) k.enrollApprovalId = approval.id
    return file
  })
  changed()
  log.web.info('approval key pending', { keyId: id, kind: key.kind, enrollApprovalId: approval.id })
  return { key: { ...key, enrollApprovalId: approval.id }, enrollment: approval }
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
