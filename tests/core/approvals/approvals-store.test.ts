/**
 * Approvals (src/core/approvals/): an approval binds to its digest, is answered once, read
 * once by its asker, needs a device signature for a biometric Approve, and expires. Device
 * keys: only a device app adds one, and it signs at once; nothing else adds one or asks the person.
 * Signatures are made here with a software P-256 key in the same DER form CryptoKit gives.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-approvals-store'))

import { WALNUT_HOME } from '../../../src/constants.js'
import {
  answerApproval, cancelApproval, consumeApproval, createApproval, getApproval, listApprovals, sweepExpired, waitApproval, ApprovalError,
  _resetApprovalTimersForTesting, APPROVAL_PENDING_MAX,
} from '../../../src/core/approvals/store.js'
import { answerMessage, approvalDigest, canonicalText, keyIdOf, verifySignature } from '../../../src/core/approvals/digest.js'
import { activeKey, applyKeyApproval, enrollKey, listKeys, removeKey } from '../../../src/core/approvals/keys.js'
import { _setFenceDepsForTest } from '../../../src/core/approvals/biometric-fence.js'

function softKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const sign = (msg: string) => crypto.sign('sha256', Buffer.from(msg, 'utf8'), { key: privateKey, dsaEncoding: 'der' }).toString('base64')
  return { spki, id: keyIdOf(spki), sign }
}

const requester = { host: 'build-box' }
const lookup = (id: string) => activeKey(id)

/** A key signs a moment later than everything so far (answerApproval's route touches it: routes/approvals-v1.ts). */
async function touchKeyLater(id: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 5))
  const { touchKey } = await import('../../../src/core/approvals/keys.js')
  await touchKey(id)
}

/**
 * What a Walnut before 2026-11-18 left for a key it did not take at once: a pending row in keys.json
 * and its "Let … sign your approvals" ask (Walnut makes neither now, so the test writes the files).
 */
async function legacyPending(k: { id: string; spki: string }, name: string, kind: 'iphone' | 'mac-app', createdAt = new Date().toISOString()) {
  const path = await import('node:path')
  const label = kind === 'iphone' ? 'iPhone' : 'Mac app'
  const { approval } = await createApproval({ what: `Let "${name}" (${label}) sign your approvals`, mode: 'biometric', requester: { host: 'this Mac' } })
  const keysPath = path.join(WALNUT_HOME, 'approvals', 'keys.json')
  const keys = JSON.parse(await fs.readFile(keysPath, 'utf8').catch(() => '{"version":1,"keys":[]}')) as { keys: unknown[] }
  keys.keys.push({ id: k.id, name, kind, publicKey: k.spki, createdAt, status: 'pending', enrollApprovalId: approval.id })
  await fs.writeFile(keysPath, JSON.stringify(keys))
  const asksPath = path.join(WALNUT_HOME, 'approvals', 'approvals.json')
  const asks = JSON.parse(await fs.readFile(asksPath, 'utf8')) as { approvals: Array<{ id: string; enrollsKey?: string }> }
  asks.approvals.find((a) => a.id === approval.id)!.enrollsKey = k.id
  await fs.writeFile(asksPath, JSON.stringify(asks))
  return approval
}

beforeEach(async () => {
  _resetApprovalTimersForTesting()
  // The person is at hand (biometric-fence.ts; its own tests vary this).
  _setFenceDepsForTest({ activity: async () => ({ lastSeenAt: Date.now(), streaming: false }) })
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

async function rejects(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(() => null, (e) => e)
  expect(err, `expected ${code}`).toBeInstanceOf(ApprovalError)
  expect((err as ApprovalError).code).toBe(code)
}

describe('digest', () => {
  it('binds every field, and free text cannot forge a line', () => {
    const base = { id: 'apr-x', mode: 'tap' as const, createdAt: 'a', expiresAt: 'b', host: 'h', what: 'Deploy', detail: 'v1' }
    const d = approvalDigest(base)
    expect(approvalDigest({ ...base, what: 'Deploy!' })).not.toBe(d)
    expect(approvalDigest({ ...base, detail: 'v2' })).not.toBe(d)
    expect(approvalDigest({ ...base, mode: 'biometric' })).not.toBe(d)
    // A newline in `what` stays inside its base64 field.
    expect(canonicalText({ ...base, what: 'x\nmode=biometric' }).split('\n')).toHaveLength(9)
    expect(approvalDigest({ ...base, what: '\u90e8\u7f72 \u2705' })).toMatch(/^[0-9a-f]{64}$/)
  })

  it('verifies a DER P-256 signature over the answer, and only that answer', () => {
    const k = softKey()
    const sig = k.sign(answerMessage('ab'.repeat(32), 'approve'))
    expect(verifySignature(k.spki, answerMessage('ab'.repeat(32), 'approve'), sig)).toBe(true)
    expect(verifySignature(k.spki, answerMessage('ab'.repeat(32), 'deny'), sig)).toBe(false)
    expect(verifySignature(k.spki, answerMessage('cd'.repeat(32), 'approve'), sig)).toBe(false)
    expect(verifySignature('not-a-key', 'x', sig)).toBe(false)
  })
})

describe('tap approvals', () => {
  it('waits, takes one answer, and lets the asker read it once', async () => {
    const { approval, waitToken } = await createApproval({ what: 'Deploy  to\nprod', mode: 'tap', requester })
    expect(approval.what).toBe('Deploy to prod')
    expect(approval.digest).toMatch(/^[0-9a-f]{64}$/)
    expect((await listApprovals()).map((a) => a.id)).toEqual([approval.id])

    const pending = await waitApproval(approval.id, waitToken, 0)
    expect(pending.approval.status).toBe('pending')
    await rejects(waitApproval(approval.id, 'wrong', 0), 'bad_token')

    const waiting = waitApproval(approval.id, waitToken, 5_000)
    const answered = await answerApproval(approval.id, { decision: 'approve', device: { name: 'Web console', kind: 'web' } }, lookup)
    expect(answered.status).toBe('approved')
    expect(answered.answer).toMatchObject({ decision: 'approve', mode: 'tap', device: { name: 'Web console', kind: 'web' } })
    const read = await waiting
    expect(read.used).toBe(true)
    expect(read.approval.status).toBe('approved')

    // A retry right away (its response lost) gets the same answer; a later read is a second use.
    const again = await waitApproval(approval.id, waitToken, 0)
    expect(again).toMatchObject({ used: false, approval: { status: 'approved' } })
    vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ['Date'] })
    try {
      await rejects(waitApproval(approval.id, waitToken, 0), 'approval_used')
    } finally {
      vi.useRealTimers()
    }
    await rejects(answerApproval(approval.id, { decision: 'deny', device: { name: 'x', kind: 'web' } }, lookup), 'already_approved')
    expect(await listApprovals()).toEqual([])
    expect((await listApprovals({ status: 'all' }))[0].answer?.decision).toBe('approve')
  })

  it('a deny is final, and the record keeps who answered', async () => {
    const { approval, waitToken } = await createApproval({ what: 'Rotate key', mode: 'tap', requester })
    await answerApproval(approval.id, { decision: 'deny', device: { name: 'iPhone', kind: 'iphone' } }, lookup)
    const r = await waitApproval(approval.id, waitToken, 0)
    expect(r.approval.status).toBe('denied')
    expect(r.approval.answer?.device.name).toBe('iPhone')
  })

  it('expires at its deadline and can be withdrawn by its asker only', async () => {
    const a = await createApproval({ what: 'A', mode: 'tap', requester, timeoutMs: 10_000 })
    const b = await createApproval({ what: 'B', mode: 'tap', requester })
    vi.useFakeTimers({ now: Date.now() + 11_000, toFake: ['Date'] })
    try {
      expect(await sweepExpired()).toBe(1)
      expect((await getApproval(a.approval.id))?.status).toBe('expired')
      await rejects(answerApproval(a.approval.id, { decision: 'approve', device: { name: 'x', kind: 'web' } }, lookup), 'already_expired')
    } finally {
      vi.useRealTimers()
    }
    await rejects(cancelApproval(b.approval.id, 'nope', 'x'), 'bad_token')
    expect((await cancelApproval(b.approval.id, b.waitToken, 'Ctrl-C')).status).toBe('canceled')
    expect((await waitApproval(b.approval.id, b.waitToken, 0)).approval.status).toBe('canceled')
  })

  it('refuses an empty or oversized ask', async () => {
    await rejects(createApproval({ what: '   ', mode: 'tap', requester }), 'bad_request')
    await rejects(createApproval({ what: 'x'.repeat(301), mode: 'tap', requester }), 'bad_request')
  })
})

describe('biometric approvals and device keys', () => {
  it('the first key is active, Approve needs its signature over this digest, Deny does not', async () => {
    const phone = softKey()
    const first = await enrollKey({ publicKey: phone.spki, name: 'Test\u2019s iPhone', kind: 'iphone', fromDeviceApp: true })
    expect(first.key.status).toBe('active')
    expect(first.enrollment).toBeUndefined()

    const { approval, waitToken } = await createApproval({ what: 'Publish release', mode: 'biometric', requester })
    await rejects(answerApproval(approval.id, { decision: 'approve', device: { name: 'Web', kind: 'web' } }, lookup), 'biometric_required')

    const other = await createApproval({ what: 'Other', mode: 'biometric', requester })
    // A signature made for another approval does not fit this one.
    await rejects(answerApproval(approval.id, {
      decision: 'approve', keyId: phone.id, signature: phone.sign(answerMessage(other.approval.digest, 'approve')), device: { name: 'x', kind: 'iphone' },
    }, lookup), 'bad_signature')
    // Nor one by an unknown key.
    const stranger = softKey()
    await rejects(answerApproval(approval.id, {
      decision: 'approve', keyId: stranger.id, signature: stranger.sign(answerMessage(approval.digest, 'approve')), device: { name: 'x', kind: 'iphone' },
    }, lookup), 'bad_signature')

    const ok = await answerApproval(approval.id, {
      decision: 'approve', keyId: phone.id, signature: phone.sign(answerMessage(approval.digest, 'approve')), device: { name: 'ignored', kind: 'web' },
    }, lookup)
    expect(ok.answer).toMatchObject({ mode: 'biometric', keyId: phone.id, device: { id: phone.id, name: 'Test\u2019s iPhone', kind: 'iphone' } })
    expect((await waitApproval(approval.id, waitToken, 0)).used).toBe(true)

    const denied = await answerApproval(other.approval.id, { decision: 'deny', device: { name: 'Web', kind: 'web' } }, lookup)
    expect(denied.status).toBe('denied')
  })

  it('a key from anything but its device app adds no device and asks nothing, first or later (2026-11-18)', async () => {
    // The person's screen showed "Let … (Mac app) sign your approvals" for a key a test's copy of the
    // app sent: a later key with no proof became an ask. Now it is refused, whatever came before it.
    const phone = softKey()
    const mac = softKey()
    await enrollKey({ publicKey: phone.spki, name: 'iPhone', kind: 'iphone', fromDeviceApp: true })
    await rejects(enrollKey({ publicKey: mac.spki, name: 'Mac', kind: 'mac-app' }), 'first_key_from_phone')
    await rejects(enrollKey({ publicKey: mac.spki, name: 'Mac', kind: 'mac-app', fromDeviceApp: false }), 'first_key_from_phone')
    await rejects(enrollKey({ publicKey: mac.spki, name: 'iPhone', kind: 'iphone' }), 'first_key_from_phone')
    expect((await listKeys()).map((k) => k.id)).toEqual([phone.id])
    expect(await listApprovals({ status: 'all' })).toEqual([])
  })

  it('no input to enrollKey ever opens an approval, whatever keys.json holds (the whole class)', async () => {
    // Every kind, every proof, against every state a key can be in: none of them asks the person.
    const kinds = ['iphone', 'mac-app'] as const
    const proofs = [true, false, undefined]
    const states = ['none', 'active', 'pending', 'retired', 'same-name-active'] as const
    let tried = 0
    for (const kind of kinds) {
      for (const fromDeviceApp of proofs) {
        for (const state of states) {
          await fs.rm(WALNUT_HOME, { recursive: true, force: true })
          const k = softKey()
          const anchor = softKey()
          await enrollKey({ publicKey: anchor.spki, name: 'Anchor', kind: 'iphone', fromDeviceApp: true })
          if (state === 'active') await enrollKey({ publicKey: k.spki, name: 'Desk', kind, fromDeviceApp: true })
          if (state === 'pending') await legacyPending(k, 'Desk', kind)
          if (state === 'retired') {
            await enrollKey({ publicKey: k.spki, name: 'Desk', kind: 'mac-app', fromDeviceApp: true })
            await enrollKey({ publicKey: softKey().spki, name: 'Desk', kind: 'mac-app', fromDeviceApp: true })
          }
          if (state === 'same-name-active') await enrollKey({ publicKey: softKey().spki, name: 'Desk', kind, fromDeviceApp: true })
          const before = (await listApprovals({ status: 'all' })).map((a) => a.id)
          await enrollKey({ publicKey: k.spki, name: 'Desk', kind, fromDeviceApp }).catch(() => undefined)
          const opened = (await listApprovals({ status: 'all' })).filter((a) => !before.includes(a.id))
          expect(opened, `${kind} fromDeviceApp=${fromDeviceApp} on ${state}`).toEqual([])
          expect((await listKeys()).filter((x) => x.id === k.id && x.status === 'pending' && state !== 'pending'),
            `${kind} fromDeviceApp=${fromDeviceApp} on ${state} left a pending key`).toEqual([])
          tried++
        }
      }
    }
    expect(tried).toBe(kinds.length * proofs.length * states.length)
  })

  it('a later key from a device app the person set up signs at once, with no ask (2026-11-12)', async () => {
    const mac = softKey()
    const phone = softKey()
    const phone2 = softKey()
    await enrollKey({ publicKey: mac.spki, name: 'Mac', kind: 'mac-app', fromDeviceApp: true })
    // The paired iPhone (its device token): active now, nothing for another device to approve.
    const second = await enrollKey({ publicKey: phone.spki, name: 'iPhone', kind: 'iphone', fromDeviceApp: true })
    expect(second.key.status).toBe('active')
    // A second Mac app, with its own proof, too.
    const thirdMac = softKey()
    expect((await enrollKey({ publicKey: thirdMac.spki, name: 'Mac 2', kind: 'mac-app', fromDeviceApp: true })).key.status).toBe('active')
    expect((await listApprovals({ status: 'pending' })).filter((x) => x.enrollsKey)).toHaveLength(0)
    // A key an older Walnut left pending: refused while nothing proves it, then it signs once its app
    // asks again, and its ask is withdrawn.
    const left = await legacyPending(phone2, 'Old iPhone', 'iphone')
    await rejects(enrollKey({ publicKey: phone2.spki, name: 'Old iPhone', kind: 'iphone' }), 'first_key_from_phone')
    expect((await getApproval(left.id))?.status).toBe('pending')
    const again = await enrollKey({ publicKey: phone2.spki, name: 'Old iPhone', kind: 'iphone', fromDeviceApp: true })
    expect(again.key.status).toBe('active')
    expect((await getApproval(left.id))?.status).toBe('canceled')
    expect((await listKeys()).every((k) => k.status === 'active')).toBe(true)
  })

  it('a device that enrolls a newer key from its own app retires its earlier ones, active or pending, with their asks (2026-11-12)', async () => {
    // The Mac app made a new key at every enrollment (ApprovalBridge.swift, before it kept its key): each one
    // stayed, and a pending one from a replaced key left a "Let … sign" card nobody could answer.
    const oldMac = softKey()
    const phone = softKey()
    const strayMac = softKey()
    const newMac = softKey()
    await enrollKey({ publicKey: oldMac.spki, name: 'Studio', kind: 'mac-app', fromDeviceApp: true })
    await enrollKey({ publicKey: phone.spki, name: 'Studio', kind: 'iphone', fromDeviceApp: true })
    const stray = await legacyPending(strayMac, 'Studio', 'mac-app')
    const fresh = await enrollKey({ publicKey: newMac.spki, name: 'Studio', kind: 'mac-app', fromDeviceApp: true })
    expect(fresh.key.status).toBe('active')
    // The same device's older active key is retired (its row stays, naming what replaced it, for a
    // verifier that pinned it), its pending one goes; another kind with the same name stays.
    const active = (await listKeys()).filter((k) => k.status === 'active').map((k) => k.id).sort()
    expect(active).toEqual([newMac.id, phone.id].sort())
    expect((await listKeys()).find((k) => k.id === oldMac.id)).toMatchObject({ status: 'retired', replacedBy: newMac.id })
    expect((await listKeys()).some((k) => k.id === strayMac.id)).toBe(false)
    expect((await getApproval(stray.id))?.status).toBe('canceled')
    expect((await listApprovals({ status: 'pending' })).filter((x) => x.enrollsKey)).toHaveLength(0)
    // A phone never retires another phone of the same name (many are called "iPhone").
    const phone2 = softKey()
    await enrollKey({ publicKey: phone2.spki, name: 'Studio', kind: 'iphone', fromDeviceApp: true })
    expect((await listKeys()).filter((k) => k.kind === 'iphone')).toHaveLength(2)
    // A request with no app proof never retires anything (it is refused: nothing added, nothing asked).
    const other = softKey()
    await rejects(enrollKey({ publicKey: other.spki, name: 'Studio', kind: 'mac-app' }), 'first_key_from_phone')
    expect((await listKeys()).find((k) => k.id === newMac.id)?.status).toBe('active')
    // A retired key never signs, and comes back only from its own app (which keeps its key now).
    await expect(enrollKey({ publicKey: oldMac.spki, name: 'Studio', kind: 'mac-app' })).rejects.toMatchObject({ code: 'key_retired' })
    const back = await enrollKey({ publicKey: oldMac.spki, name: 'Studio', kind: 'mac-app', fromDeviceApp: true })
    expect(back.key.status).toBe('active')
    expect((await listKeys()).find((k) => k.id === newMac.id)).toMatchObject({ status: 'retired', replacedBy: oldMac.id })
  })

  it('a Mac that enrolls the same key again keeps its id: nothing is retired (the Git gate pins it)', async () => {
    const mac = softKey()
    await enrollKey({ publicKey: mac.spki, name: 'Desk', kind: 'mac-app', fromDeviceApp: true })
    await enrollKey({ publicKey: mac.spki, name: 'Desk', kind: 'mac-app', fromDeviceApp: true })
    const rows = (await listKeys()).filter((k) => k.name === 'Desk')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: mac.id, status: 'active' })
  })

  it('on boot, keys an older Walnut kept for a Mac that enrolled a newer one go, with their asks (the 2026-11-12 keys.json)', async () => {
    const { retireReplacedMacKeys } = await import('../../../src/core/approvals/keys.js')
    const { WALNUT_HOME } = await import('../../../src/constants.js')
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const phone = softKey()
    const a = softKey(); const b = softKey(); const c = softKey(); const later = softKey()
    await enrollKey({ publicKey: phone.spki, name: 'iPhone', kind: 'iphone', fromDeviceApp: true })
    const asked = await legacyPending(b, 'Studio', 'mac-app', '2026-11-12T00:00:00.000Z')
    // The shape production held: an old active key, a pending one, then the current active key.
    const file = path.join(WALNUT_HOME, 'approvals', 'keys.json')
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { keys: Array<Record<string, unknown>> }
    raw.keys.push(
      { id: a.id, name: 'Studio', kind: 'mac-app', publicKey: a.spki, createdAt: '2026-11-11T23:28:42.093Z', status: 'active', activatedAt: '2026-11-11T23:28:42.093Z' },
      { id: c.id, name: 'Studio', kind: 'mac-app', publicKey: c.spki, createdAt: '2099-11-12T13:14:05.333Z', status: 'active', activatedAt: '2099-11-12T13:14:05.333Z' },
      { id: later.id, name: 'Studio', kind: 'mac-app', publicKey: later.spki, createdAt: '2099-11-13T00:00:00.000Z', status: 'pending' },
    )
    await fs.writeFile(file, JSON.stringify(raw))
    expect(await retireReplacedMacKeys()).toBe(2)
    expect((await listKeys()).filter((k) => k.status !== 'retired').map((k) => k.id).sort()).toEqual([phone.id, c.id, later.id].sort())
    expect((await listKeys()).find((k) => k.id === a.id)).toMatchObject({ status: 'retired', replacedBy: c.id })
    expect((await getApproval(asked.id))?.status).toBe('canceled')
    expect(await retireReplacedMacKeys()).toBe(0)
  })

  it('on boot, every "Let … sign your approvals" an older Walnut left is withdrawn with its key, and the signing devices stay (2026-11-18)', async () => {
    // The 2026-11-18 keys.json: the Mac app's key and two iPhones sign; a test's copy of the app,
    // started twice with a fresh home, left two pending keys of the same Mac with an ask each.
    const { withdrawPendingEnrollments } = await import('../../../src/core/approvals/keys.js')
    const mac = softKey(); const phoneA = softKey(); const phoneB = softKey(); const copy1 = softKey(); const copy2 = softKey()
    await enrollKey({ publicKey: mac.spki, name: 'a1b2c3d4e5f6', kind: 'mac-app', fromDeviceApp: true })
    await enrollKey({ publicKey: phoneA.spki, name: 'iPhone', kind: 'iphone', fromDeviceApp: true })
    await enrollKey({ publicKey: phoneB.spki, name: 'iPhone', kind: 'iphone', fromDeviceApp: true })
    const ask1 = await legacyPending(copy1, 'a1b2c3d4e5f6', 'mac-app', '2099-11-18T19:21:32.922Z')
    const ask2 = await legacyPending(copy2, 'a1b2c3d4e5f6', 'mac-app', '2099-11-18T19:33:19.000Z')
    // An ask whose key row is gone already (an older Walnut wrote them in two steps) goes too.
    const orphan = await legacyPending(softKey(), 'Studio', 'iphone')
    const keysPath = (await import('node:path')).join(WALNUT_HOME, 'approvals', 'keys.json')
    const raw = JSON.parse(await fs.readFile(keysPath, 'utf8')) as { keys: Array<{ enrollApprovalId?: string }> }
    raw.keys = raw.keys.filter((k) => k.enrollApprovalId !== orphan.id)
    await fs.writeFile(keysPath, JSON.stringify(raw))
    const other = await createApproval({ what: 'Deploy', mode: 'tap', requester })

    // What boot runs, in order (store.ts initApprovals).
    const { retireReplacedMacKeys } = await import('../../../src/core/approvals/keys.js')
    await retireReplacedMacKeys()
    expect(await withdrawPendingEnrollments()).toBe(3)
    for (const a of [ask1, ask2, orphan]) expect((await getApproval(a.id))?.status).toBe('canceled')
    expect((await getApproval(other.approval.id))?.status).toBe('pending')
    expect((await listKeys()).map((k) => `${k.id} ${k.status}`).sort()).toEqual([mac.id, phoneA.id, phoneB.id].map((id) => `${id} active`).sort())
    expect(await withdrawPendingEnrollments()).toBe(0)
  })

  it('on boot, the Mac\'s own key that a copy\'s asked-in key took the place of signs again, and the copy\'s key goes (2026-11-18)', async () => {
    // Production that evening: the person approved "Let … (Mac app) sign your approvals" with the
    // Mac's own Touch ID; the copy's key, newer, became active, and the next boot retired the Mac's own.
    const { restoreMacKeysTakenByAsks, retireReplacedMacKeys, withdrawPendingEnrollments } = await import('../../../src/core/approvals/keys.js')
    const mac = softKey(); const phone = softKey(); const copy = softKey()
    await enrollKey({ publicKey: mac.spki, name: 'a1b2c3d4e5f6', kind: 'mac-app', fromDeviceApp: true })
    // An iPhone an old ask let in (signed with the Mac's key) stays: it took nobody's place.
    const phoneAsk = await legacyPending(phone, 'iPhone', 'iphone')
    await applyKeyApproval(await answerApproval(phoneAsk.id, {
      decision: 'approve', keyId: mac.id, signature: mac.sign(answerMessage(phoneAsk.digest, 'approve')), device: { name: 'Mac', kind: 'mac-app' },
    }, lookup))
    await new Promise((r) => setTimeout(r, 5))
    const copyAsk = await legacyPending(copy, 'a1b2c3d4e5f6', 'mac-app')
    await new Promise((r) => setTimeout(r, 5))
    await applyKeyApproval(await answerApproval(copyAsk.id, {
      decision: 'approve', keyId: mac.id, signature: mac.sign(answerMessage(copyAsk.digest, 'approve')), device: { name: 'Mac', kind: 'mac-app' },
    }, lookup))
    await touchKeyLater(mac.id)
    expect(await retireReplacedMacKeys()).toBe(1)
    expect((await listKeys()).find((k) => k.id === mac.id)).toMatchObject({ status: 'retired', replacedBy: copy.id })

    // The boot of this version, in order (store.ts initApprovals).
    expect(await retireReplacedMacKeys()).toBe(0)
    expect(await restoreMacKeysTakenByAsks()).toBe(1)
    expect(await withdrawPendingEnrollments()).toBe(0)
    const keys = await listKeys()
    expect(keys.map((k) => `${k.id} ${k.status}`).sort()).toEqual([`${mac.id} active`, `${phone.id} active`, `${copy.id} retired`].sort())
    expect(keys.find((k) => k.id === mac.id)?.replacedBy).toBeUndefined()
    // The copy's row leads back to the Mac's key, for a verifier that had followed it there.
    expect(keys.find((k) => k.id === copy.id)?.replacedBy).toBe(mac.id)
    expect(await restoreMacKeysTakenByAsks()).toBe(0)
    expect(await retireReplacedMacKeys()).toBe(0)
  })

  it('the whole boot gives it back the same way when the older Walnut never restarted after the approval', async () => {
    // The copy's key active and the Mac's own still active: the boot's own retire comes first, then the repair.
    const mac = softKey(); const copy = softKey()
    await enrollKey({ publicKey: mac.spki, name: 'Studio', kind: 'mac-app', fromDeviceApp: true })
    const ask = await legacyPending(copy, 'Studio', 'mac-app')
    await new Promise((r) => setTimeout(r, 5))
    await applyKeyApproval(await answerApproval(ask.id, {
      decision: 'approve', keyId: mac.id, signature: mac.sign(answerMessage(ask.digest, 'approve')), device: { name: 'Mac', kind: 'mac-app' },
    }, lookup))
    await touchKeyLater(mac.id)
    expect((await listKeys()).map((k) => k.status)).toEqual(['active', 'active'])
    const { initApprovals } = await import('../../../src/core/approvals/store.js')
    await initApprovals()
    const keys = await listKeys()
    expect(keys.find((k) => k.id === mac.id)?.status).toBe('active')
    expect(keys.find((k) => k.id === copy.id)).toMatchObject({ status: 'retired', replacedBy: mac.id })
    _resetApprovalTimersForTesting()
  })

  it('a Mac that stopped signing with its old key after a newer one came keeps the newer one (it may be the app\'s own)', async () => {
    const { restoreMacKeysTakenByAsks, retireReplacedMacKeys } = await import('../../../src/core/approvals/keys.js')
    const old = softKey(); const phone = softKey(); const fresh = softKey()
    await enrollKey({ publicKey: old.spki, name: 'Studio', kind: 'mac-app', fromDeviceApp: true })
    await enrollKey({ publicKey: phone.spki, name: 'iPhone', kind: 'iphone', fromDeviceApp: true })
    await touchKeyLater(old.id)
    await new Promise((r) => setTimeout(r, 5))
    // The app made a new key (an older app did, at every enrollment); the phone let it in.
    const ask = await legacyPending(fresh, 'Studio', 'mac-app')
    await applyKeyApproval(await answerApproval(ask.id, {
      decision: 'approve', keyId: phone.id, signature: phone.sign(answerMessage(ask.digest, 'approve')), device: { name: 'iPhone', kind: 'iphone' },
    }, lookup))
    expect(await retireReplacedMacKeys()).toBe(1)
    expect(await restoreMacKeysTakenByAsks()).toBe(0)
    expect((await listKeys()).find((k) => k.id === fresh.id)?.status).toBe('active')
    expect((await listKeys()).find((k) => k.id === old.id)?.status).toBe('retired')
  })

  it('nothing in Walnut opens an approval that enrolls a key (the whole class)', async () => {
    // createApproval takes no `enrollsKey`, so only a record an older Walnut wrote carries one. This
    // fails when any source file sets it again, in any form.
    const fsSync = await import('node:fs')
    const path = await import('node:path')
    const root = path.resolve(__dirname, '../../../src')
    const setters: string[] = []
    const walk = (dir: string) => {
      for (const e of fsSync.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) { walk(full); continue }
        if (!/\.tsx?$/.test(e.name)) continue
        const text = fsSync.readFileSync(full, 'utf8')
        // `enrollsKey: x`, `enrollsKey = x`, `['enrollsKey']`, a shorthand `{ enrollsKey }`: anything but a read or a type.
        if (/\benrollsKey\s*[:=](?!=)/.test(text.replace(/\benrollsKey\?:/g, '')) || /\[\s*['"]enrollsKey['"]\s*\]\s*=(?!=)/.test(text) || /[{,]\s*enrollsKey\s*[,}]/.test(text)) {
          setters.push(path.relative(root, full))
        }
      }
    }
    walk(root)
    expect(setters).toEqual([])
    const store = fsSync.readFileSync(path.join(root, 'core/approvals/store.ts'), 'utf8')
    const input = /export interface CreateInput \{[\s\S]*?\n\}/.exec(store)?.[0] ?? ''
    expect(input).toContain('requester: ApprovalRequester')
    expect(input).not.toMatch(/^\s*enrollsKey\b\s*\??:/m)
  })

  it('only keys.ts writes the device keys, and only enrollKey adds one (where a device retires its earlier keys)', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const root = path.resolve(__dirname, '../../../src')
    const writers: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full)
        else if (/\.tsx?$/.test(e.name) && /updateJsonFile<ApprovalKeysFile>/.test(fs.readFileSync(full, 'utf8'))) writers.push(path.relative(root, full))
      }
    }
    walk(root)
    expect(writers).toEqual(['core/approvals/keys.ts'])
    const src = fs.readFileSync(path.join(root, 'core/approvals/keys.ts'), 'utf8')
    expect(src.match(/file\.keys\.push\(/g)).toHaveLength(1)
  })

  it('an older Walnut\'s enrollment answered before the boot sweep: a deny drops its pending key', async () => {
    const phone = softKey()
    const mac = softKey()
    await enrollKey({ publicKey: phone.spki, name: 'iPhone', kind: 'iphone', fromDeviceApp: true })
    const asked = await legacyPending(mac, 'Mac', 'mac-app')
    const denied = await answerApproval(asked.id, { decision: 'deny', device: { name: 'iPhone', kind: 'iphone' } }, lookup)
    await applyKeyApproval(denied)
    expect((await listKeys()).map((k) => k.id)).toEqual([phone.id])
  })

  it('the last active key is never removed through Walnut', async () => {
    const phone = softKey()
    const mac = softKey()
    await enrollKey({ publicKey: phone.spki, name: 'iPhone', kind: 'iphone', fromDeviceApp: true })
    await rejects(removeKey(phone.id), 'last_key')
    const asked = await legacyPending(mac, 'Mac', 'mac-app')
    await removeKey(mac.id)
    expect((await getApproval(asked.id))?.status).toBe('canceled')
    await rejects(removeKey('ak-none'), 'not_found')
    await rejects(enrollKey({ publicKey: 'AAAA', name: 'x', kind: 'iphone' }), 'bad_key')
  })

  it('the first key comes only from a device app itself (fromDeviceApp), never from a plain request', async () => {
    const agent = softKey()
    await rejects(enrollKey({ publicKey: agent.spki, name: 'Mac', kind: 'mac-app' }), 'first_key_from_phone')
    await rejects(enrollKey({ publicKey: agent.spki, name: 'iPhone', kind: 'iphone' }), 'first_key_from_phone')
    expect(await listKeys()).toEqual([])
  })

  it('two enrollments of one new key at once (the app\'s launch and a foreground refresh) add one key and ask nothing', async () => {
    const phone = softKey()
    const mac = softKey()
    await enrollKey({ publicKey: phone.spki, name: 'iPhone', kind: 'iphone', fromDeviceApp: true })
    const [a, b] = await Promise.all([
      enrollKey({ publicKey: mac.spki, name: 'Mac', kind: 'mac-app', fromDeviceApp: true }),
      enrollKey({ publicKey: mac.spki, name: 'Mac', kind: 'mac-app', fromDeviceApp: true }),
    ])
    expect([a.key.status, b.key.status]).toEqual(['active', 'active'])
    expect((await listKeys()).filter((k) => k.id === mac.id)).toHaveLength(1)
    expect(await listApprovals({ status: 'all' })).toEqual([])
  })
})

describe('the name a person reads for a device (device-name.ts)', () => {
  it('a generated id reads as the kind of device; a real name stays', async () => {
    const { deviceLabel, machineMadeName } = await import('../../../src/core/approvals/device-name.js')
    for (const id of ['a1b2c3d4e5f6', 'A1B2C3D4E5F6', '3f2a-91bc-77de', '6f1c9a2e-2b7d-4c55-9d1e-0a1b2c3d4e5f']) expect(machineMadeName(id), id).toBe(true)
    for (const name of ['Studio', 'Evan’s MacBook Pro', 'iPhone', 'deadbeef', 'cafe', 'Mac-2', 'abc123', 'Desk 12345678',
      '2024-11-18', '10.0.0.12', '12345678', 'fe80::1']) expect(machineMadeName(name), name).toBe(false)
    expect(deviceLabel('a1b2c3d4e5f6', 'mac-app')).toBe('Mac')
    expect(deviceLabel('a1b2c3d4e5f6', 'iphone')).toBe('iPhone')
    expect(deviceLabel('', 'web')).toBe('Web console')
    expect(deviceLabel('  Studio  ', 'mac-app')).toBe('Studio')
    expect(deviceLabel(undefined, 'other')).toBe('a device')
  })

  it('an answer signed by a key named by a generated id says "Mac", and so does an older record', async () => {
    const mac = softKey()
    await enrollKey({ publicKey: mac.spki, name: 'a1b2c3d4e5f6', kind: 'mac-app', fromDeviceApp: true })
    const { approval } = await createApproval({ what: 'Publish', mode: 'biometric', requester })
    const ok = await answerApproval(approval.id, {
      decision: 'approve', keyId: mac.id, signature: mac.sign(answerMessage(approval.digest, 'approve')), device: { name: 'a1b2c3d4e5f6', kind: 'mac-app' },
    }, lookup)
    expect(ok.answer?.device).toMatchObject({ id: mac.id, name: 'Mac', kind: 'mac-app' })
    // A record an older Walnut wrote with the raw name reads the same.
    const path = await import('node:path')
    const asksPath = path.join(WALNUT_HOME, 'approvals', 'approvals.json')
    const asks = JSON.parse(await fs.readFile(asksPath, 'utf8')) as { approvals: Array<{ id: string; answer?: { device: { name: string } } }> }
    asks.approvals.find((a) => a.id === approval.id)!.answer!.device.name = 'a1b2c3d4e5f6'
    await fs.writeFile(asksPath, JSON.stringify(asks))
    expect((await getApproval(approval.id))?.answer?.device.name).toBe('a1b2c3d4e5f6')
    expect((await listApprovals({ status: 'all' })).find((a) => a.id === approval.id)?.answer?.device.name).toBe('Mac')
    expect(JSON.stringify(await listApprovals({ status: 'all' }))).not.toContain('a1b2c3d4e5f6')
    // An older Walnut's ask in the history, once withdrawn, says "Mac" in its title too.
    const { withdrawPendingEnrollments } = await import('../../../src/core/approvals/keys.js')
    const old = await legacyPending(softKey(), 'a1b2c3d4e5f6', 'mac-app')
    expect((await listApprovals()).find((a) => a.id === old.id)?.what).toBe('Let "a1b2c3d4e5f6" (Mac app) sign your approvals')
    await withdrawPendingEnrollments()
    expect((await listApprovals({ status: 'all' })).find((a) => a.id === old.id)?.what).toBe('Let "Mac" (Mac app) sign your approvals')
    expect(JSON.stringify(await listApprovals({ status: 'all' }))).not.toContain('a1b2c3d4e5f6')
    // keys.json keeps the name the Mac sent (its keys are matched by it); the view reads "Mac".
    const { keyView } = await import('../../../src/core/approvals/keys.js')
    expect((await listKeys())[0]!.name).toBe('a1b2c3d4e5f6')
    expect(keyView((await listKeys())[0]!).name).toBe('Mac')
  })
})

describe('strict single-use approvals', () => {
  const owner = { host: 'build-box', taskId: 'task-1', sessionId: 'session-1' }
  const fields = {
    repo: '/work/repo', remote: 'ssh://example.com/private/repo', localRef: 'refs/heads/scratch',
    sha: 'ab'.repeat(20), remoteRef: 'refs/heads/scratch', argv: ['git', 'push', 'origin', 'scratch'],
    session: owner.sessionId, task: owner.taskId, nonce: '0123456789abcdef'.repeat(4),
  }
  const detail = JSON.stringify(fields)
  async function signed() {
    const key = softKey()
    await enrollKey({ publicKey: key.spki, name: 'Test phone', kind: 'iphone', fromDeviceApp: true })
    const made = await createApproval({ what: 'Allow one Git push?', mode: 'biometric', requester: owner,
      detail, singleUse: true, signingKeyId: key.id, timeoutMs: 300_000 })
    await answerApproval(made.approval.id, { decision: 'approve', device: { name: 'Test phone', kind: 'iphone' },
      keyId: key.id, signature: key.sign(answerMessage(made.approval.digest, 'approve')) }, lookup)
    return { ...made, key, input: { token: made.waitToken, digest: made.approval.digest, detail, requester: owner } }
  }

  it('wait reads without spending, then concurrent consumers get exactly one use with no grace', async () => {
    const a = await signed()
    for (let i = 0; i < 2; i++) expect(await waitApproval(a.approval.id, a.waitToken, 0)).toMatchObject({ used: false, approval: { status: 'approved' } })
    expect((await getApproval(a.approval.id))?.consumedAt).toBeUndefined()
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => consumeApproval(a.approval.id, a.input, lookup)))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    for (const r of results) if (r.status === 'rejected') expect(r.reason.code).toBe('approval_used')
    expect((await getApproval(a.approval.id))?.consumedAt).toBeTruthy()
    await rejects(consumeApproval(a.approval.id, a.input, lookup), 'approval_used')
  })

  it.each(Object.keys(fields))('rejects a changed %s before consuming', async (field) => {
    const a = await signed()
    const changed = JSON.stringify({ ...fields, [field]: 'different' })
    await rejects(consumeApproval(a.approval.id, { ...a.input, detail: changed }, lookup), 'changed')
    expect((await getApproval(a.approval.id))?.consumedAt).toBeUndefined()
    expect((await consumeApproval(a.approval.id, a.input, lookup)).used).toBe(true)
  })

  it.each(['sessionId', 'taskId', 'host'])('rejects another %s even with the wait token', async (field) => {
    const a = await signed()
    await rejects(consumeApproval(a.approval.id, { ...a.input, requester: { ...owner, [field]: 'other' } }, lookup), 'wrong_asker')
    await rejects(consumeApproval(a.approval.id, { ...a.input, token: 'wrong' }, lookup), 'bad_token')
    await rejects(consumeApproval(a.approval.id, { ...a.input, digest: '00'.repeat(32) }, lookup), 'changed')
  })

  it('a set of keys (signingKeyIds): any one of them signs it, no other key, and the set is in the signed envelope', async () => {
    const mac = softKey()
    const phone = softKey()
    const stranger = softKey()
    for (const [k, kind] of [[mac, 'mac-app'], [phone, 'iphone'], [stranger, 'iphone']] as const) {
      await enrollKey({ publicKey: k.spki, name: kind, kind, fromDeviceApp: true })
    }
    const ids = [mac.id, phone.id].sort()
    const make = () => createApproval({ what: 'Push one commit?', mode: 'biometric', requester: owner,
      detail, singleUse: true, signingKeyIds: [phone.id, mac.id, phone.id], timeoutMs: 300_000 })
    const made = await make()
    expect(made.approval.signingKeyIds).toEqual(ids)
    expect(made.approval.signingKeyId).toBeUndefined()
    const env = JSON.parse(made.approval.detail!)
    expect(env.signingKeyIds).toEqual(ids)
    expect(env.signingKeyId).toBeUndefined()
    // A key outside the set is refused, even an active one.
    await rejects(answerApproval(made.approval.id, { decision: 'approve', device: { name: 'x', kind: 'iphone' },
      keyId: stranger.id, signature: stranger.sign(answerMessage(made.approval.digest, 'approve')) }, lookup), 'biometric_required')
    // The phone signs it; consume spends it once.
    const ok = await answerApproval(made.approval.id, { decision: 'approve', device: { name: 'x', kind: 'iphone' },
      keyId: phone.id, signature: phone.sign(answerMessage(made.approval.digest, 'approve')) }, lookup)
    expect(ok.answer?.keyId).toBe(phone.id)
    const input = { token: made.waitToken, digest: made.approval.digest, detail, requester: owner }
    expect((await consumeApproval(made.approval.id, input, lookup)).used).toBe(true)
    // The Mac signs another one just as well.
    const two = await make()
    await answerApproval(two.approval.id, { decision: 'approve', device: { name: 'x', kind: 'mac-app' },
      keyId: mac.id, signature: mac.sign(answerMessage(two.approval.digest, 'approve')) }, lookup)
    expect((await consumeApproval(two.approval.id, { ...input, token: two.waitToken, digest: two.approval.digest }, lookup)).used).toBe(true)
    // A set of one key is not a set.
    await rejects(createApproval({ what: 'x', mode: 'biometric', requester: owner, detail, singleUse: true, signingKeyIds: [mac.id, mac.id], timeoutMs: 300_000 }), 'bad_request')
  })

  it('refuses an approved record after expiry, not just an unanswered one', async () => {
    const a = await signed()
    vi.useFakeTimers({ now: Date.now() + 300_001, toFake: ['Date'] })
    try { await rejects(consumeApproval(a.approval.id, a.input, lookup), 'approval_expired') }
    finally { vi.useRealTimers() }
    expect((await getApproval(a.approval.id))?.consumedAt).toBeUndefined()
  })

  it('defaults to five minutes and signs the caller, fresh nonce and exact Unicode context', async () => {
    const key = softKey()
    const base = { what: 'One step', mode: 'biometric' as const, singleUse: true, signingKeyId: key.id, requester: owner }
    const context = 'Line one\n"quoted" \\ path ' + String.fromCodePoint(0x4e2d, 0x6587)
    const a = await createApproval({ ...base, detail: context })
    // One pending Face ID ask per account (biometric-fence.ts): the first is withdrawn before the second.
    await cancelApproval(a.approval.id, a.waitToken, 'test')
    // Advance only the clock: the stubbed person acts after the recorded withdrawal.
    const afterCancel = Date.now() + 1
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(afterCancel)
    let b: Awaited<ReturnType<typeof createApproval>>
    try { b = await createApproval({ ...base, detail: context }) }
    finally { vi.useRealTimers() }
    expect(Date.parse(a.approval.expiresAt) - Date.parse(a.approval.createdAt)).toBe(300_000)
    const envelope = JSON.parse(a.approval.detail!)
    expect(envelope).toMatchObject({ version: 'walnut-single-use-v1', ...owner, signingKeyId: key.id, context })
    expect(envelope.nonce).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.parse(b.approval.detail!).nonce).not.toBe(envelope.nonce)
    await rejects(createApproval({ ...base, detail: '\ud800' }), 'bad_request')
    await rejects(createApproval({ ...base, detail: '\n'.repeat(20_000) + 'x' }), 'bad_request')
  })

  it('rechecks signatures and the device, refusing a forged record or a revoked device', async () => {
    const a = await signed()
    await rejects(consumeApproval(a.approval.id, a.input, async () => undefined), 'bad_signature')
    await rejects(consumeApproval(a.approval.id, a.input, async (id) => ({ id, publicKey: softKey().spki, name: 'Wrong', kind: 'mac-app' })), 'bad_signature')
    const file = `${WALNUT_HOME}/approvals/approvals.json`
    const data = JSON.parse(await fs.readFile(file, 'utf8'))
    data.approvals[0].answer.signature = 'AAAA'
    await fs.writeFile(file, JSON.stringify(data))
    await rejects(consumeApproval(a.approval.id, a.input, lookup), 'bad_signature')
  })

  it('never accepts tap, a proven unsigned answer, a different device, or a long lifetime', async () => {
    const key = softKey(), other = softKey()
    const getKey = async (id: string) => ({ id, name: 'Test', kind: 'mac-app' as const, publicKey: id === key.id ? key.spki : other.spki })
    const base = { what: 'Git restore', requester: owner, detail, singleUse: true, signingKeyId: key.id, timeoutMs: 300_000 }
    await rejects(createApproval({ ...base, mode: 'tap' }), 'strict_approval_required')
    await rejects(createApproval({ ...base, mode: 'biometric', downgraded: 'No device' }), 'strict_approval_required')
    await rejects(createApproval({ ...base, mode: 'biometric', timeoutMs: 300_001 }), 'strict_approval_required')
    const a = await createApproval({ ...base, mode: 'biometric' })
    await rejects(answerApproval(a.approval.id, { decision: 'approve', proven: true, device: { name: 'Web', kind: 'web' } }, getKey), 'biometric_required')
    await rejects(answerApproval(a.approval.id, { decision: 'approve', keyId: other.id,
      signature: other.sign(answerMessage(a.approval.digest, 'approve')), device: { name: 'Other', kind: 'mac-app' } }, getKey), 'biometric_required')
    const denied = await answerApproval(a.approval.id, { decision: 'deny', device: { name: 'Web', kind: 'web' } }, getKey)
    expect(denied.status).toBe('denied')
    await rejects(consumeApproval(a.approval.id, { token: a.waitToken, digest: a.approval.digest, detail, requester: owner }, getKey), 'not_approved')
  })
})

describe('what an asker cannot do to the person', () => {
  it('a lone surrogate is made well formed, so every decoder reads the list', async () => {
    const { approval } = await createApproval({ what: 'Bad \ud800 text', detail: 'tail \udc00', mode: 'tap', requester: { host: 'h\ud801' } })
    expect(approval.what).toBe('Bad \ufffd text')
    expect(approval.detail).toBe('tail \ufffd')
    expect(approval.requester.host).toBe('h\ufffd')
    expect(() => JSON.parse(JSON.stringify(approval))).not.toThrow()
    expect(JSON.stringify(approval)).not.toMatch(/\\ud8/i)
  })

  it('past the pending cap a new ask is refused, and a test run counts on its own', async () => {
    for (let i = 0; i < APPROVAL_PENDING_MAX; i++) await createApproval({ what: `Ask ${i}`, mode: 'tap', requester })
    await rejects(createApproval({ what: 'One more', mode: 'tap', requester }), 'too_many_pending')
    await createApproval({ what: 'A test run ask', mode: 'tap', requester, testRun: 'cap-test' })
  })
})
