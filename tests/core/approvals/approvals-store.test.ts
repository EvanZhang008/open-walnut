/**
 * Approvals (src/core/approvals/): an approval binds to its digest, is answered once with a tap from
 * any device the person is signed in on, read once by its asker, and expires (2026-11-21, the user:
 * no signing key; a signed-in device approves). A single-use one is spent once, by its own session,
 * before its deadline. A record an older Walnut wrote (Face ID, pinned keys, a vault guard) is
 * answered the same way, and its asks about device keys are withdrawn at boot.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-approvals-store'))

import { WALNUT_HOME } from '../../../src/constants.js'
import {
  answerApproval, cancelApproval, consumeApproval, createApproval, getApproval, listApprovals, sweepExpired, waitApproval, ApprovalError,
  withdrawDeviceKeyAsks, _resetApprovalTimersForTesting, APPROVAL_PENDING_MAX,
} from '../../../src/core/approvals/store.js'
import { approvalDigest, canonicalText } from '../../../src/core/approvals/digest.js'
import { _setFenceDepsForTest } from '../../../src/core/approvals/single-use-fence.js'

const requester = { host: 'build-box' }
const phone = { name: 'Test’s iPhone', kind: 'iphone' as const }
const web = { name: 'Web console', kind: 'web' as const }
const mac = { name: 'Studio', kind: 'mac-app' as const }

const asksPath = () => path.join(WALNUT_HOME, 'approvals', 'approvals.json')

/** Rewrites approvals.json as an older Walnut left it: `edit` changes the records in place. */
async function asOlderWalnutWrote(edit: (approvals: Array<Record<string, unknown>>) => void): Promise<void> {
  const file = JSON.parse(await fs.readFile(asksPath(), 'utf8')) as { approvals: Array<Record<string, unknown>> }
  edit(file.approvals)
  await fs.writeFile(asksPath(), JSON.stringify(file))
}

beforeEach(async () => {
  _resetApprovalTimersForTesting()
  // The person is at hand (single-use-fence.ts; its own tests vary this).
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
    expect(approvalDigest({ ...base, what: '部署 ✅' })).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('a tap on any signed-in device', () => {
  it('waits, takes one answer, and lets the asker read it once', async () => {
    const { approval, waitToken } = await createApproval({ what: 'Deploy  to\nprod', requester })
    expect(approval.what).toBe('Deploy to prod')
    expect(approval.mode).toBe('tap')
    expect(approval.digest).toMatch(/^[0-9a-f]{64}$/)
    expect((await listApprovals()).map((a) => a.id)).toEqual([approval.id])

    const pending = await waitApproval(approval.id, waitToken, 0)
    expect(pending.approval.status).toBe('pending')
    await rejects(waitApproval(approval.id, 'wrong', 0), 'bad_token')

    const waiting = waitApproval(approval.id, waitToken, 5_000)
    const answered = await answerApproval(approval.id, { decision: 'approve', digest: approval.digest, device: web })
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
    await rejects(answerApproval(approval.id, { decision: 'deny', device: web }), 'already_approved')
    expect(await listApprovals()).toEqual([])
    expect((await listApprovals({ status: 'all' }))[0].answer?.decision).toBe('approve')
  })

  it('the phone, the Mac app and the web console each approve with a tap, and the record names which', async () => {
    for (const device of [phone, mac, web]) {
      const { approval } = await createApproval({ what: `Publish from ${device.kind}`, requester })
      const ok = await answerApproval(approval.id, { decision: 'approve', digest: approval.digest, device })
      expect(ok.answer).toMatchObject({ decision: 'approve', mode: 'tap', device })
    }
  })

  it('a deny is final, and the record keeps who answered', async () => {
    const { approval, waitToken } = await createApproval({ what: 'Rotate key', requester })
    await answerApproval(approval.id, { decision: 'deny', device: phone })
    const r = await waitApproval(approval.id, waitToken, 0)
    expect(r.approval.status).toBe('denied')
    expect(r.approval.answer?.device.name).toBe(phone.name)
  })

  it('an answer for a request the device did not show is refused, and the request stays open', async () => {
    const one = await createApproval({ what: 'Push to main', requester })
    const other = await createApproval({ what: 'Push to a branch', requester })
    await rejects(answerApproval(one.approval.id, { decision: 'approve', digest: other.approval.digest, device: phone }), 'changed')
    await rejects(answerApproval(one.approval.id, { decision: 'approve', digest: '00'.repeat(32), device: phone }), 'changed')
    expect((await getApproval(one.approval.id))?.status).toBe('pending')
    // An older client sends no digest: its tap still counts (the server's record is the one it read).
    expect((await answerApproval(one.approval.id, { decision: 'approve', device: phone })).status).toBe('approved')
  })

  it('an expired approval cannot be approved, and only its asker withdraws one', async () => {
    const a = await createApproval({ what: 'A', requester, timeoutMs: 10_000 })
    const b = await createApproval({ what: 'B', requester })
    vi.useFakeTimers({ now: Date.now() + 11_000, toFake: ['Date'] })
    try {
      // Expired at the answer itself, before any sweep ran.
      await rejects(answerApproval(a.approval.id, { decision: 'approve', digest: a.approval.digest, device: phone }), 'already_expired')
      expect((await getApproval(a.approval.id))?.status).toBe('expired')
      expect(await sweepExpired()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
    await rejects(cancelApproval(b.approval.id, 'nope', 'x'), 'bad_token')
    expect((await cancelApproval(b.approval.id, b.waitToken, 'Ctrl-C')).status).toBe('canceled')
    expect((await waitApproval(b.approval.id, b.waitToken, 0)).approval.status).toBe('canceled')
    await rejects(answerApproval(b.approval.id, { decision: 'approve', device: phone }), 'already_canceled')
  })

  it('refuses an empty or oversized ask', async () => {
    await rejects(createApproval({ what: '   ', requester }), 'bad_request')
    await rejects(createApproval({ what: 'x'.repeat(301), requester }), 'bad_request')
  })
})

describe('what an older Walnut left', () => {
  it('a Face ID record pinned to device keys, and a vault ask behind an unlock, are approved with a tap', async () => {
    const pinned = await createApproval({ what: 'Push commit 064b9ef to origin addon-test-1', requester })
    const vault = await createApproval({ what: 'Let an agent use the GitHub login', requester })
    // As an older Walnut wrote them: Face ID, two pinned keys (neither the phone's), a vault guard.
    await asOlderWalnutWrote((approvals) => {
      for (const a of approvals) {
        if (a.id === pinned.approval.id) Object.assign(a, { mode: 'biometric', signingKeyIds: ['ak-dcb776df2641b2ff', 'ak-e71d5e306b094f97'] })
        if (a.id === vault.approval.id) Object.assign(a, { mode: 'biometric', guard: 'vault-sensitive', downgraded: 'No device signs approvals yet' })
        // Its digest was made with the mode it had.
        a.digest = approvalDigest({ ...(a as never), mode: a.mode as 'biometric', host: (a.requester as { host: string }).host })
      }
    })
    for (const id of [pinned.approval.id, vault.approval.id]) {
      const rec = await getApproval(id)
      const ok = await answerApproval(id, { decision: 'approve', digest: rec!.digest, device: phone })
      expect(ok.status).toBe('approved')
      expect(ok.answer).toMatchObject({ mode: 'tap', device: phone })
    }
  })

  it('at boot, an ask to add or remove a device key or to turn approvals off with a signature is withdrawn', async () => {
    const enroll = await createApproval({ what: 'Let "Test phone" (iPhone) sign your approvals', requester: { host: 'this Mac' } })
    const remove = await createApproval({ what: 'Remove "Old Mac" from the devices that sign', requester: { host: 'this Mac' } })
    const off = await createApproval({ what: 'Turn approvals off', requester: { host: 'this Mac' } })
    const plain = await createApproval({ what: 'Deploy', requester })
    await asOlderWalnutWrote((approvals) => {
      for (const a of approvals) {
        if (a.id === enroll.approval.id) a.enrollsKey = 'ak-test-phone'
        if (a.id === remove.approval.id) a.removesKey = 'ak-old-mac'
        if (a.id === off.approval.id) a.turnsAskMeOff = true
      }
    })
    expect(await withdrawDeviceKeyAsks()).toBe(3)
    for (const id of [enroll.approval.id, remove.approval.id, off.approval.id]) {
      const rec = await getApproval(id)
      expect(rec?.status).toBe('canceled')
      expect(rec?.canceledReason).toMatch(/any device you are signed in on approves/)
    }
    expect((await getApproval(plain.approval.id))?.status).toBe('pending')
    // Run again (every boot): nothing more to withdraw.
    expect(await withdrawDeviceKeyAsks()).toBe(0)
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

  it('an answer from a device named by a generated id says "Mac", and so does an older record', async () => {
    const { approval } = await createApproval({ what: 'Publish', requester })
    const ok = await answerApproval(approval.id, { decision: 'approve', device: { name: 'a1b2c3d4e5f6', kind: 'mac-app' } })
    expect(ok.answer?.device).toMatchObject({ name: 'Mac', kind: 'mac-app' })
    // A record an older Walnut wrote with the raw name reads the same.
    await asOlderWalnutWrote((approvals) => { (approvals.find((a) => a.id === approval.id)!.answer as { device: { name: string } }).device.name = 'a1b2c3d4e5f6' })
    expect((await getApproval(approval.id))?.answer?.device.name).toBe('a1b2c3d4e5f6')
    expect((await listApprovals({ status: 'all' })).find((a) => a.id === approval.id)?.answer?.device.name).toBe('Mac')
    expect(JSON.stringify(await listApprovals({ status: 'all' }))).not.toContain('a1b2c3d4e5f6')
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
  async function approved(device: { name: string; kind: 'iphone' | 'mac-app' | 'web' } = phone) {
    const made = await createApproval({ what: 'Allow one Git push?', requester: owner, detail, singleUse: true, timeoutMs: 300_000 })
    await answerApproval(made.approval.id, { decision: 'approve', digest: made.approval.digest, device })
    return { ...made, input: { token: made.waitToken, digest: made.approval.digest, detail, requester: owner } }
  }

  it('a tap on any signed-in device approves it; wait reads without spending, then exactly one use with no grace', async () => {
    for (const device of [phone, mac, web]) {
      const a = await approved(device)
      for (let i = 0; i < 2; i++) expect(await waitApproval(a.approval.id, a.waitToken, 0)).toMatchObject({ used: false, approval: { status: 'approved' } })
      expect((await getApproval(a.approval.id))?.consumedAt).toBeUndefined()
      const results = await Promise.allSettled(Array.from({ length: 5 }, () => consumeApproval(a.approval.id, a.input)))
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      for (const r of results) if (r.status === 'rejected') expect(r.reason.code).toBe('approval_used')
      expect((await getApproval(a.approval.id))?.consumedAt).toBeTruthy()
      await rejects(consumeApproval(a.approval.id, a.input), 'approval_used')
    }
  })

  it.each(Object.keys(fields))('rejects a changed %s before consuming', async (field) => {
    const a = await approved()
    const changed = JSON.stringify({ ...fields, [field]: 'different' })
    await rejects(consumeApproval(a.approval.id, { ...a.input, detail: changed }), 'changed')
    expect((await getApproval(a.approval.id))?.consumedAt).toBeUndefined()
    expect((await consumeApproval(a.approval.id, a.input)).used).toBe(true)
  })

  it.each(['sessionId', 'taskId', 'host'])('rejects another %s even with the wait token', async (field) => {
    const a = await approved()
    await rejects(consumeApproval(a.approval.id, { ...a.input, requester: { ...owner, [field]: 'other' } }), 'wrong_asker')
    await rejects(consumeApproval(a.approval.id, { ...a.input, token: 'wrong' }), 'bad_token')
    await rejects(consumeApproval(a.approval.id, { ...a.input, digest: '00'.repeat(32) }), 'changed')
  })

  it('refuses an approved record after expiry, not just an unanswered one', async () => {
    const a = await approved()
    vi.useFakeTimers({ now: Date.now() + 300_001, toFake: ['Date'] })
    try { await rejects(consumeApproval(a.approval.id, a.input), 'approval_expired') }
    finally { vi.useRealTimers() }
    expect((await getApproval(a.approval.id))?.consumedAt).toBeUndefined()
  })

  it('defaults to five minutes and binds the caller, a fresh nonce and the exact Unicode context', async () => {
    const base = { what: 'One step', singleUse: true, requester: owner }
    const context = 'Line one\n"quoted" \\ path ' + String.fromCodePoint(0x4e2d, 0x6587)
    const a = await createApproval({ ...base, detail: context })
    // One pending single-use ask per account (single-use-fence.ts): the first is withdrawn before the second.
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
    expect(envelope).toMatchObject({ version: 'walnut-single-use-v1', ...owner, context })
    expect(envelope.signingKeyId).toBeUndefined()
    expect(envelope.signingKeyIds).toBeUndefined()
    expect(envelope.nonce).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.parse(b.approval.detail!).nonce).not.toBe(envelope.nonce)
    await rejects(createApproval({ ...base, detail: '\ud800' }), 'bad_request')
    await rejects(createApproval({ ...base, detail: '\n'.repeat(20_000) + 'x' }), 'bad_request')
  })

  it('never takes a session-less ask, a long lifetime, a deny, or the switch\'s own go-ahead as approved', async () => {
    const base = { what: 'Git restore', requester: owner, detail, singleUse: true, timeoutMs: 300_000 }
    await rejects(createApproval({ ...base, requester: { host: 'build-box' } }), 'strict_approval_required')
    await rejects(createApproval({ ...base, requester: { ...owner, taskId: undefined } }), 'strict_approval_required')
    await rejects(createApproval({ ...base, timeoutMs: 300_001 }), 'strict_approval_required')
    await rejects(createApproval({ ...base, unasked: 'browserOutward' }), 'bad_request')
    const a = await createApproval(base)
    const denied = await answerApproval(a.approval.id, { decision: 'deny', device: web })
    expect(denied.status).toBe('denied')
    await rejects(consumeApproval(a.approval.id, { token: a.waitToken, digest: a.approval.digest, detail, requester: owner }), 'not_approved')
    // A record that says the switch approved it (no person) is never spent.
    const b = await createApproval(base)
    await asOlderWalnutWrote((approvals) => {
      const r = approvals.find((x) => x.id === b.approval.id)!
      r.status = 'approved'
      r.answer = { decision: 'approve', at: new Date().toISOString(), mode: 'tap', device: { name: 'Approvals off', kind: 'setting' } }
    })
    await rejects(consumeApproval(b.approval.id, { token: b.waitToken, digest: b.approval.digest, detail, requester: owner }), 'not_approved')
  })
})

describe('what an asker cannot do to the person', () => {
  it('a lone surrogate is made well formed, so every decoder reads the list', async () => {
    const { approval } = await createApproval({ what: 'Bad \ud800 text', detail: 'tail \udc00', requester: { host: 'h\ud801' } })
    expect(approval.what).toBe('Bad � text')
    expect(approval.detail).toBe('tail �')
    expect(approval.requester.host).toBe('h�')
    expect(() => JSON.parse(JSON.stringify(approval))).not.toThrow()
    expect(JSON.stringify(approval)).not.toMatch(/\\ud8/i)
  })

  it('past the pending cap a new ask is refused, and a test run counts on its own', async () => {
    for (let i = 0; i < APPROVAL_PENDING_MAX; i++) await createApproval({ what: `Ask ${i}`, requester })
    await rejects(createApproval({ what: 'One more', requester }), 'too_many_pending')
    await createApproval({ what: 'A test run ask', requester, testRun: 'cap-test' })
  })
})
