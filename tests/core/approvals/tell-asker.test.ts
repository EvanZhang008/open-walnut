/**
 * The session that asked hears the answer (src/core/approvals/tell-asker.ts; 2026-11-07, the
 * user: "I approved the approval request but the source session didn't get notified, it should
 * get notified"). His case: a session asked with the approval_request op, ended its turn, and
 * nothing told it when he tapped Approve 76 minutes later. Every way a decision is made (Approve
 * or Deny in the web notice, a Touch ID or Face ID signature, the clock running out) tells the
 * asking session once, unless a waiting `walnut approve` read the decision itself; a withdrawal
 * tells no one. The ratchet at the end fails on a new place in the store that ends an approval
 * without announcing it, since announce() is where the asker is told.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-approvals-tell-asker'))

const sent: Array<{ sid: string; text: string; opts: Record<string, unknown> }> = []
vi.mock('../../../src/core/session-message-queue.js', () => ({
  sendMessageToSession: vi.fn(async (sid: string, text: string, opts: Record<string, unknown>) => { sent.push({ sid, text, opts }) }),
}))
const phases: Record<string, string> = {}
vi.mock('../../../src/core/task-manager.js', () => ({
  getTask: vi.fn(async (id: string) => ({ id, phase: phases[id] ?? 'WAITING' })),
}))
vi.mock('../../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: vi.fn(async (sid: string) => (sid === 'sess-asker' ? { claudeSessionId: 'sess-asker', taskId: 'task-asker' } : null)),
  getSessionsForTask: vi.fn(async (taskId: string) => (taskId === 'task-replaced' ? [{ claudeSessionId: 'sess-new', taskId, process_status: 'idle' }] : [])),
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { answerApproval, cancelApproval, createApproval, getApproval, noteAskerRead, sweepExpired, waitApproval, _resetApprovalTimersForTesting } from '../../../src/core/approvals/store.js'
import { answerMessage, keyIdOf } from '../../../src/core/approvals/digest.js'
import { activeKey, enrollKey } from '../../../src/core/approvals/keys.js'
import { _resetToldForTesting, askerNoticeFor, rearmAskerNotices, tellAsker } from '../../../src/core/approvals/tell-asker.js'

const requester = { host: 'clouddev', sessionId: 'sess-asker', taskId: 'task-asker', command: 'git push origin main' }
const lookup = (id: string) => activeKey(id)

beforeEach(async () => {
  _resetApprovalTimersForTesting()
  _resetToldForTesting(0)
  sent.length = 0
  for (const k of Object.keys(phases)) delete phases[k]
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

async function toldOnce(sid: string, outcome: string): Promise<string> {
  await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0), { timeout: 3_000 })
  await new Promise((r) => setTimeout(r, 50))
  expect(sent).toHaveLength(1)
  expect(sent[0].sid).toBe(sid)
  expect(sent[0].text).toContain(`outcome="${outcome}"`)
  // A Walnut notice about its own request (it reaches Main and a VP with the org off too); an
  // answer ends a wait parked on it, an expiry only interrupts one.
  expect(sent[0].opts.source).toBe('walnut-notify')
  expect(sent[0].opts.endsWait).toBe(outcome === 'expired' ? undefined : true)
  return sent[0].text
}

describe('the asking session hears the decision', () => {
  it('a tap Approve in the web notice or on the phone', async () => {
    const { approval } = await createApproval({ what: 'Push the release', mode: 'tap', requester })
    await answerApproval(approval.id, { decision: 'approve', device: { name: 'MacBook', kind: 'mac-app' } }, lookup)
    const text = await toldOnce('sess-asker', 'approved')
    expect(text).toContain(approval.id)
    // The result and what was asked lead the note, so its folded preview reads as the answer.
    expect(text).toMatch(/\n?Approved: "Push the release"/)
    expect(text).toContain('git push origin main')
  })

  it('a Deny', async () => {
    const { approval } = await createApproval({ what: 'Push the release', mode: 'tap', requester })
    await answerApproval(approval.id, { decision: 'deny', device: { name: 'iPhone', kind: 'iphone' } }, lookup)
    expect(await toldOnce('sess-asker', 'denied')).toContain('Do not take that step')
  })

  it('a Touch ID or Face ID signature', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    await enrollKey({ publicKey: spki, name: 'Mac', kind: 'mac-app', firstAllowed: true })
    const { approval } = await createApproval({ what: 'Publish', mode: 'biometric', requester })
    const signature = crypto.sign('sha256', Buffer.from(answerMessage(approval.digest, 'approve'), 'utf8'), { key: privateKey, dsaEncoding: 'der' }).toString('base64')
    await answerApproval(approval.id, { decision: 'approve', keyId: keyIdOf(spki), signature, device: { name: 'Mac', kind: 'mac-app' } }, lookup)
    expect(await toldOnce('sess-asker', 'approved')).toContain('Touch ID')
  })

  it('the clock running out', async () => {
    const { approval } = await createApproval({ what: 'Push', mode: 'tap', requester, timeoutMs: 10_000 })
    vi.useFakeTimers({ now: Date.now() + 11_000, toFake: ['Date'] })
    try { expect(await sweepExpired()).toBe(1) } finally { vi.useRealTimers() }
    expect(await toldOnce('sess-asker', 'expired')).toContain(approval.id)
  })

  it('the task\'s live session when the asking one is gone', async () => {
    const { approval } = await createApproval({ what: 'Push', mode: 'tap', requester: { host: 'h', sessionId: 'sess-gone', taskId: 'task-replaced' } })
    await answerApproval(approval.id, { decision: 'approve', device: { name: 'Mac', kind: 'mac-app' } }, lookup)
    await toldOnce('sess-new', 'approved')
  })
})

describe('nobody is told twice, or about their own withdrawal', () => {
  it('a waiting `walnut approve` that read the decision itself', async () => {
    _resetToldForTesting(300)
    const { approval, waitToken } = await createApproval({ what: 'Push', mode: 'tap', requester })
    const waiting = waitApproval(approval.id, waitToken, 5_000)
    await answerApproval(approval.id, { decision: 'approve', device: { name: 'Mac', kind: 'mac-app' } }, lookup)
    expect((await waiting).approval.status).toBe('approved')
    await new Promise((r) => setTimeout(r, 600))
    expect(sent).toHaveLength(0)
  })

  it('an expiry the waiting command read itself', async () => {
    _resetToldForTesting(300)
    const { approval, waitToken } = await createApproval({ what: 'Push', mode: 'tap', requester, timeoutMs: 10_000 })
    vi.useFakeTimers({ now: Date.now() + 11_000, toFake: ['Date'] })
    try {
      expect(await sweepExpired()).toBe(1)
      expect((await waitApproval(approval.id, waitToken, 0)).approval.status).toBe('expired')
    } finally { vi.useRealTimers() }
    await new Promise((r) => setTimeout(r, 600))
    expect(sent).toHaveLength(0)
  })

  it('a browser step that held for its answer and got it in the same call', async () => {
    _resetToldForTesting(300)
    const { approval } = await createApproval({ what: 'Buy it', mode: 'tap', requester })
    await answerApproval(approval.id, { decision: 'approve', device: { name: 'Mac', kind: 'mac-app' } }, lookup)
    await noteAskerRead(approval.id) // outward-asks.ts answerOutward / browser-v1.ts siteGate
    await new Promise((r) => setTimeout(r, 600))
    expect(sent).toHaveLength(0)
  })

  it('a closed task: its session is not woken', async () => {
    phases['task-asker'] = 'COMPLETE'
    _resetToldForTesting(60_000)
    const { approval } = await createApproval({ what: 'Push', mode: 'tap', requester })
    await answerApproval(approval.id, { decision: 'deny', device: { name: 'Mac', kind: 'mac-app' } }, lookup)
    expect(await tellAsker(approval.id)).toBe('none')
    expect(sent).toHaveLength(0)
  })

  it('once: a second attempt finds it told', async () => {
    _resetToldForTesting(60_000)
    const { approval } = await createApproval({ what: 'Push', mode: 'tap', requester })
    await answerApproval(approval.id, { decision: 'approve', device: { name: 'Mac', kind: 'mac-app' } }, lookup)
    expect(await tellAsker(approval.id)).toBe('told')
    expect(await tellAsker(approval.id)).toBe('read')
    expect(sent).toHaveLength(1)
    expect((await getApproval(approval.id))?.askerToldAt).toBeTruthy()
  })

  it('a restart inside the grace: the boot re-arms it', async () => {
    _resetToldForTesting(60_000)
    const { approval } = await createApproval({ what: 'Push', mode: 'tap', requester })
    await answerApproval(approval.id, { decision: 'approve', device: { name: 'Mac', kind: 'mac-app' } }, lookup)
    _resetToldForTesting(0) // the restart: the timer is gone
    rearmAskerNotices([(await getApproval(approval.id))!])
    await toldOnce('sess-asker', 'approved')
  })

  it('a withdrawal by the asker', async () => {
    const { approval, waitToken } = await createApproval({ what: 'Push', mode: 'tap', requester })
    await cancelApproval(approval.id, waitToken, 'the script was stopped')
    await new Promise((r) => setTimeout(r, 200))
    expect(sent).toHaveLength(0)
  })

  it('an approval with no session or task behind it (a person\'s own script)', () => {
    expect(askerNoticeFor({ id: 'apr-1', what: 'x', status: 'approved', requester: { host: 'mac' } })).toBeNull()
  })
})

describe('every decision in the store reaches announce()', () => {
  it('no function ends an approval without announcing what it changed', () => {
    const src = readFileSync('src/core/approvals/store.ts', 'utf8')
    const fns = src.split(/\n(?=export async function |async function |function )/)
    const enders = fns.filter((f) => /\.status = (?:'(?:expired|approved|denied|canceled)'|input\.decision)/.test(f) || /\.status = input\.decision === /.test(f))
    // settleClock only marks; its callers announce what it returns.
    const named = enders.map((f) => /function (\w+)/.exec(f)?.[1]).sort()
    expect(named).toEqual(['answerApproval', 'cancelInternal', 'settleClock'])
    for (const f of enders.filter((x) => !/function settleClock/.test(x))) expect(f, /function (\w+)/.exec(f)?.[1]).toMatch(/announce\(/)
    // settleClock marks the overdue ones expired: whoever calls it announces what it returns,
    // never drops it (a bare call left an approval expired with no one told).
    expect(src).not.toMatch(/^\s*settleClock\(file/m)
    for (const f of fns.filter((x) => /= settleClock\(file/.test(x))) expect(f, /function (\w+)/.exec(f)?.[1]).toMatch(/announce\((?:changed|settled|\[\.\.\.settled|out \? \[\.\.\.settled)/)
    expect(src).toMatch(/tellAskerLater\(rec\)/)
  })
})
