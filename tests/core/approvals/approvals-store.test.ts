/**
 * Approvals (src/core/approvals/): an approval binds to its digest, is answered once, read
 * once by its asker, needs a device signature for a biometric Approve, and expires. Device
 * keys: the first is trusted on first use, a later one waits for an active key's approval.
 * Signatures are made here with a software P-256 key in the same DER form CryptoKit gives.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-approvals-store'))

import { WALNUT_HOME } from '../../../src/constants.js'
import {
  answerApproval, cancelApproval, createApproval, getApproval, listApprovals, sweepExpired, waitApproval, ApprovalError,
  _resetApprovalTimersForTesting, APPROVAL_PENDING_MAX,
} from '../../../src/core/approvals/store.js'
import { answerMessage, approvalDigest, canonicalText, keyIdOf, verifySignature } from '../../../src/core/approvals/digest.js'
import { activeKey, applyKeyApproval, enrollKey, listKeys, removeKey } from '../../../src/core/approvals/keys.js'

function softKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const sign = (msg: string) => crypto.sign('sha256', Buffer.from(msg, 'utf8'), { key: privateKey, dsaEncoding: 'der' }).toString('base64')
  return { spki, id: keyIdOf(spki), sign }
}

const requester = { host: 'build-box' }
const lookup = (id: string) => activeKey(id)

beforeEach(async () => {
  _resetApprovalTimersForTesting()
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
    const first = await enrollKey({ publicKey: phone.spki, name: 'Test\u2019s iPhone', kind: 'iphone', firstAllowed: true })
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

  it('a second key waits until an active key signs its enrollment, and cannot sign for itself', async () => {
    const phone = softKey()
    const mac = softKey()
    await enrollKey({ publicKey: phone.spki, name: 'iPhone', kind: 'iphone', firstAllowed: true })
    const second = await enrollKey({ publicKey: mac.spki, name: 'Mac', kind: 'mac-app' })
    expect(second.key.status).toBe('pending')
    const enrollment = second.enrollment!
    expect(enrollment).toMatchObject({ mode: 'biometric', enrollsKey: mac.id })
    // Enrolling again returns the same open request, not a second one.
    expect((await enrollKey({ publicKey: mac.spki, name: 'Mac', kind: 'mac-app' })).enrollment?.id).toBe(enrollment.id)

    await rejects(answerApproval(enrollment.id, {
      decision: 'approve', keyId: mac.id, signature: mac.sign(answerMessage(enrollment.digest, 'approve')), device: { name: 'Mac', kind: 'mac-app' },
    }, lookup), 'bad_signature')

    const approved = await answerApproval(enrollment.id, {
      decision: 'approve', keyId: phone.id, signature: phone.sign(answerMessage(enrollment.digest, 'approve')), device: { name: 'iPhone', kind: 'iphone' },
    }, lookup)
    await applyKeyApproval(approved)
    expect((await listKeys()).find((k) => k.id === mac.id)?.status).toBe('active')
  })

  it('a denied enrollment drops the pending key', async () => {
    const phone = softKey()
    const mac = softKey()
    await enrollKey({ publicKey: phone.spki, name: 'iPhone', kind: 'iphone', firstAllowed: true })
    const second = await enrollKey({ publicKey: mac.spki, name: 'Mac', kind: 'mac-app' })
    const denied = await answerApproval(second.enrollment!.id, { decision: 'deny', device: { name: 'iPhone', kind: 'iphone' } }, lookup)
    await applyKeyApproval(denied)
    expect((await listKeys()).map((k) => k.id)).toEqual([phone.id])
  })

  it('the last active key is never removed through Walnut', async () => {
    const phone = softKey()
    const mac = softKey()
    await enrollKey({ publicKey: phone.spki, name: 'iPhone', kind: 'iphone', firstAllowed: true })
    await rejects(removeKey(phone.id), 'last_key')
    const second = await enrollKey({ publicKey: mac.spki, name: 'Mac', kind: 'mac-app' })
    await removeKey(mac.id)
    expect((await getApproval(second.enrollment!.id))?.status).toBe('canceled')
    await rejects(removeKey('ak-none'), 'not_found')
    await rejects(enrollKey({ publicKey: 'AAAA', name: 'x', kind: 'iphone' }), 'bad_key')
  })

  it('the first key comes only from the paired iPhone app, never from a request on this computer', async () => {
    const agent = softKey()
    await rejects(enrollKey({ publicKey: agent.spki, name: 'Mac', kind: 'mac-app' }), 'first_key_from_phone')
    await rejects(enrollKey({ publicKey: agent.spki, name: 'iPhone', kind: 'iphone' }), 'first_key_from_phone')
    expect(await listKeys()).toEqual([])
  })

  it('two enrollments of one new key at once make one ask', async () => {
    const phone = softKey()
    const mac = softKey()
    await enrollKey({ publicKey: phone.spki, name: 'iPhone', kind: 'iphone', firstAllowed: true })
    const [a, b] = await Promise.all([
      enrollKey({ publicKey: mac.spki, name: 'Mac', kind: 'mac-app' }),
      enrollKey({ publicKey: mac.spki, name: 'Mac', kind: 'mac-app' }),
    ])
    expect(a.enrollment?.id).toBeTruthy()
    expect(b.enrollment?.id).toBe(a.enrollment?.id)
    const open = (await listApprovals({ status: 'pending' })).filter((x) => x.enrollsKey === mac.id)
    expect(open).toHaveLength(1)
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
