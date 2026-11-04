/**
 * Agent grants over a real vault in a temp dir (src/core/vault/agent-grants.ts, agent.ts): the
 * grant lengths (once, 1 h, 48 h, forever), revoking one by its id, Lock all ending all, the
 * audit entries (use, approver, session), and keeping grants across a restart only while the
 * machine key is on. Approvals are faked. Fake data only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { derivePasswordKey, randomBytes, toB64 } from '../../../src/core/vault/crypto.js'
import { createItems, resetVaultForTest, setupVault } from '../../../src/core/vault/store.js'
import {
  agentUse, agentWait, endAllGrants, listGrants, resetAgentStateForTest, revokeGrant,
  type AgentRequester, type ApprovalCreator, type ApprovalWaiter,
} from '../../../src/core/vault/agent.js'
import { flushGrants, resetGrantsForTest } from '../../../src/core/vault/agent-grants.js'
import { readAgentLog } from '../../../src/core/vault/agent-log.js'
import { openSide, updateSide } from '../../../src/core/vault/state.js'
import { resetPolicyForTest } from '../../../src/core/vault/policy.js'

const task: AgentRequester = { host: 'devbox', taskId: 't-9', taskTitle: 'Rotate the keys', sessionId: 's-9' }
let n = 0
const create: ApprovalCreator = async () => ({ id: `apr-${++n}`, waitToken: 'tok', mode: 'tap', expiresAt: new Date(Date.now() + 600_000).toISOString() })
const approve: ApprovalWaiter = async () => ({ status: 'approved', used: true, answeredBy: 'iPhone, with Face ID or Touch ID' })

let dir = ''

async function freshVault(machineKey: boolean): Promise<void> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-vault-grants-'))
  resetVaultForTest(dir)
  resetPolicyForTest()
  resetAgentStateForTest()
  const kdf = { name: 'PBKDF2-SHA256' as const, iterations: 600_000, salt: toB64(randomBytes(16)) }
  await setupVault({ passwordKey: toB64(await derivePasswordKey('a fake grants master', kdf)), kdf, agentsWhileAway: machineKey })
  await createItems([{ type: 'login', title: 'Registry', username: 'ci@example.test', password: 'reg-fake-Pass-1', urls: ['registry.example.test'] }])
}

async function approveOnce(grantMs: number, extra: Partial<Parameters<typeof agentUse>[0]> = {}) {
  const r = await agentUse({ item: 'Registry', purpose: 'push the image', requester: task, agents: 'ask', grantMs, ...extra }, create)
  if (r.status !== 'pending') throw new Error(`expected pending, got ${r.status}`)
  return agentWait(r.requestId, r.waitToken, 0, 'ask', approve)
}

const again = () => agentUse({ item: 'Registry', purpose: 'push the image', requester: task, agents: 'ask' }, create)

afterEach(() => {
  vi.useRealTimers()
  resetVaultForTest(null)
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
})

describe('grant lengths', () => {
  beforeEach(async () => { await freshVault(false) }, 60_000)

  it('once: the approval lets that one use through, no grant', async () => {
    const w = await approveOnce(0)
    expect(w.status).toBe('released')
    expect(listGrants()).toEqual([])
    expect((await again()).status).toBe('pending')
  })

  it('1 hour: released without asking until it runs out', async () => {
    const w = await approveOnce(3_600_000)
    expect(w).toMatchObject({ status: 'released', grantedUntil: expect.any(String) })
    expect(await again()).toMatchObject({ status: 'released', via: 'grant' })
    vi.useFakeTimers({ now: Date.now() + 3_600_000 + 1_000, toFake: ['Date'] })
    expect((await again()).status).toBe('pending')
  })

  it('forever: no end, until the person revokes it in Agent Activity', async () => {
    const w = await approveOnce(-1)
    expect(w).toMatchObject({ status: 'released', grantedUntil: null })
    vi.useFakeTimers({ now: Date.now() + 365 * 86_400_000, toFake: ['Date'] })
    expect(await again()).toMatchObject({ status: 'released', via: 'grant', grantedUntil: null })
    const [g] = listGrants()
    expect(g).toMatchObject({ until: null, itemTitle: 'Registry', taskTitle: 'Rotate the keys', sessionId: 's-9', approvedBy: 'iPhone, with Face ID or Touch ID', fields: ['password'] })
    expect(await revokeGrant(g.id)).toMatchObject({ id: g.id })
    expect(await revokeGrant(g.id)).toBeNull()
    expect((await again()).status).toBe('pending')
    const log = await readAgentLog(10)
    expect(log.find((e) => e.kind === 'revoked')).toMatchObject({ itemTitle: 'Registry', taskTitle: 'Rotate the keys' })
  })

  it('the agent may ask for less: scope once gives no grant whatever the length', async () => {
    await approveOnce(172_800_000, { scope: 'once' })
    expect(listGrants()).toEqual([])
  })

  it('Lock all ends every grant', async () => {
    await approveOnce(172_800_000)
    expect(listGrants()).toHaveLength(1)
    expect(endAllGrants().grants).toBe(1)
    expect(listGrants()).toEqual([])
    expect((await again()).status).toBe('pending')
  })

  it('every use is in the log with how it was used, who approved it and the session', async () => {
    await approveOnce(172_800_000, { use: 'env', requester: { ...task, command: 'docker push' } })
    expect(await agentUse({ item: 'Registry', purpose: 'push the image', requester: task, agents: 'ask', use: 'env' }, create)).toMatchObject({ status: 'released', via: 'grant' })
    const log = await readAgentLog(10)
    expect(log[0]).toMatchObject({ kind: 'released', via: 'grant', use: 'env', sessionId: 's-9' })
    expect(log[1]).toMatchObject({ kind: 'released', via: 'approval', use: 'env', approvedBy: 'iPhone, with Face ID or Touch ID', command: 'docker push' })
    expect(log[2]).toMatchObject({ kind: 'asked', use: 'env' })
    expect(JSON.stringify(log)).not.toContain('reg-fake-Pass-1')
  })

  it('a reveal under Any is given at once, and logged as shown', async () => {
    const r = await agentUse({ item: 'Registry', purpose: 'type it into the form', requester: task, agents: 'allow', use: 'reveal' }, create)
    expect(r).toMatchObject({ status: 'released', via: 'allow', values: { password: 'reg-fake-Pass-1' } })
    expect((await readAgentLog(1))[0]).toMatchObject({ kind: 'released', use: 'reveal', via: 'allow' })
  })
})

describe('grants across a restart', () => {
  it('kept while the machine key is on (the vault reopens by itself)', async () => {
    await freshVault(true)
    await approveOnce(172_800_000)
    await flushGrants()
    resetGrantsForTest() // a new process: memory empty, the sealed file still there
    expect(await again()).toMatchObject({ status: 'released', via: 'grant' })
    // Lock all writes the empty list before anything can close the vault.
    endAllGrants()
    await flushGrants()
    resetGrantsForTest()
    expect((await again()).status).toBe('pending')
  }, 60_000)

  it('a kept grant an older Walnut wrote (no use) reads fill: it never reveals', async () => {
    await freshVault(true)
    await approveOnce(172_800_000)
    await flushGrants()
    // Rewrite the kept record as an older Walnut had it: no use.
    await updateSide<Array<Record<string, unknown>>>('agent-grants.json', (cur) => (cur ?? []).map(({ use: _u, ...g }) => g))
    resetGrantsForTest()
    expect((await again()).status).toBe('pending')
    expect(listGrants()).toEqual([expect.objectContaining({ use: 'fill' })])
    expect(await agentUse({ item: 'Registry', purpose: 'push the image', requester: task, agents: 'ask', use: 'fill' }, create)).toMatchObject({ status: 'released', via: 'grant' })
  }, 60_000)

  it('not kept with the machine key off: a restart ends them', async () => {
    await freshVault(false)
    await approveOnce(172_800_000)
    await flushGrants()
    resetGrantsForTest()
    expect((await again()).status).toBe('pending')
    // The sealed file holds no grant either.
    expect(await openSide('agent-grants.json')).toEqual([])
  }, 60_000)
})
