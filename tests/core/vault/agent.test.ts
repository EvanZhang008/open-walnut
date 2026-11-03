/**
 * Agents and the vault (src/core/vault/agent.ts) over a real vault in a temp dir, with the
 * person's approvals faked: the policy matrix (switch x item access x sensitive), one approval
 * for one use, a task grant, the denial pause, the rate limit, fields, ambiguity, and the
 * sealed agent log and policy. Fake data only.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { derivePasswordKey, randomBytes, toB64 } from '../../../src/core/vault/crypto.js'
import { createItems, resetVaultForTest, setupVault, VaultError } from '../../../src/core/vault/store.js'
import {
  agentItems, agentUse, agentWait, endAllGrants, resetAgentStateForTest, DENY_MAX, RELEASE_MAX,
  type AgentRequester, type ApprovalCreator, type ApprovalWaiter,
} from '../../../src/core/vault/agent.js'
import { readAgentLog } from '../../../src/core/vault/agent-log.js'
import { readPolicy, writePolicy } from '../../../src/core/vault/policy.js'

let dir = ''
const ids: Record<string, string> = {}
const task: AgentRequester = { host: 'devbox', taskId: 't-1', taskTitle: 'Fix the deploy' }
const script: AgentRequester = { host: 'devbox', command: 'deploy.sh' }

type Answer = 'approved' | 'denied' | 'pending' | 'expired'
let nextAnswer: Answer = 'approved'
let asked: Array<{ what: string; detail: string; biometric: boolean }> = []
let consumed = new Set<string>()
const create: ApprovalCreator = async (input) => {
  asked.push({ what: input.what, detail: input.detail, biometric: input.biometric })
  return { id: `apr-${asked.length}`, waitToken: 'tok', mode: input.biometric ? 'biometric' : 'tap', expiresAt: new Date(Date.now() + 600_000).toISOString() }
}
const waiter: ApprovalWaiter = async (id) => {
  const used = !consumed.has(id)
  consumed.add(id)
  return { status: nextAnswer, used, answeredBy: 'iPhone' }
}

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return 'ok' } catch (err) { return err instanceof VaultError ? err.code : String(err) }
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-vault-agent-'))
  resetVaultForTest(dir)
  const kdf = { name: 'PBKDF2-SHA256' as const, iterations: 600_000, salt: toB64(randomBytes(16)) }
  await setupVault({ passwordKey: toB64(await derivePasswordKey('a fake test master', kdf)), kdf, agentsWhileAway: false })
  const made = await createItems([
    { type: 'login', title: 'GitHub', username: 'bot@example.test', password: 'gh-fake-Pass-1', urls: ['github.com'], totp: 'JBSWY3DPEHPK3PXP' },
    { type: 'api_key', title: 'Stripe test key', password: 'sk_test_fake_0000', envName: 'STRIPE_API_KEY', agentAccess: 'allow' },
    { type: 'login', title: 'Bank', password: 'bank-fake-Pass', urls: ['bank.example.test'], agentAccess: 'never' },
    { type: 'login', title: 'Payroll', password: 'pay-fake-Pass', urls: ['payroll.example.test'], agentAccess: 'allow', sensitive: true },
    { type: 'login', title: 'Shop A', username: 'a@example.test', password: 'shop-a-fake', urls: ['shop.example.test'] },
    { type: 'login', title: 'Shop B', username: 'b@example.test', password: 'shop-b-fake', urls: ['shop.example.test'] },
    { type: 'login', title: 'Twin', username: 'twin-ok@example.test', password: 'twin-ok-fake', urls: ['twin.example.test'] },
    { type: 'login', title: 'Twin', username: 'twin-kept@example.test', password: 'twin-kept-fake', urls: ['twin.example.test'], agentAccess: 'never' },
  ])
  for (const m of made) ids[m.title] = m.id
}, 60_000)

afterAll(() => {
  resetVaultForTest(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  resetAgentStateForTest()
  asked = []
  consumed = new Set()
  nextAnswer = 'approved'
})

describe('what an agent sees', () => {
  it('lists items except the ones kept from agents, with no secret', async () => {
    const items = await agentItems({ agents: 'ask' })
    expect(items.map((i) => i.title).sort()).toEqual(['GitHub', 'Payroll', 'Shop A', 'Shop B', 'Stripe test key', 'Twin'])
    const text = JSON.stringify(items)
    for (const secret of ['gh-fake-Pass-1', 'sk_test_fake_0000', 'JBSWY3DPEHPK3PXP', 'bank-fake-Pass']) expect(text).not.toContain(secret)
    expect(items.find((i) => i.title === 'GitHub')).toMatchObject({ fields: ['password', 'username', 'totp'], access: 'ask', sites: ['github.com'] })
    expect((await agentItems({ agents: 'ask', site: 'https://github.com/login' })).map((i) => i.title)).toEqual(['GitHub'])
    expect((await agentItems({ agents: 'ask', query: 'stripe' })).map((i) => i.envName)).toEqual(['STRIPE_API_KEY'])
    expect(await code(agentItems({ agents: 'off' }))).toBe('agents_off')
  })
})

describe('the policy', () => {
  const use = (item: string, agents: 'off' | 'ask' | 'allow' = 'ask', extra: Partial<Parameters<typeof agentUse>[0]> = {}) =>
    agentUse({ item, purpose: 'run the nightly test deploy', requester: task, agents, ...extra }, create)

  it('releases an item that allows agents at once, by id, name, env var or site', async () => {
    for (const ref of [ids['Stripe test key'], 'stripe test key', 'STRIPE_API_KEY']) {
      const r = await use(ref)
      expect(r).toMatchObject({ status: 'released', via: 'allow', values: { password: 'sk_test_fake_0000' } })
    }
    expect(asked).toHaveLength(0)
  })

  it('asks the person for an item set to ask, and one approval lets one use through', async () => {
    const r = await use('github.com', 'ask', { fields: ['username', 'totp'] })
    expect(r.status).toBe('pending')
    if (r.status !== 'pending') return
    expect(asked[0].what).toBe('GitHub username, totp: run the nightly test deploy')
    expect(asked[0].detail).toContain('Task: Fix the deploy')
    expect(asked[0].detail).toContain('Why: run the nightly test deploy')
    expect(asked[0].detail).toContain('Host: devbox')
    const w = await agentWait(r.requestId, r.waitToken, 0, 'ask', waiter)
    expect(w).toMatchObject({ status: 'released', via: 'approval', values: { username: 'bot@example.test' } })
    if (w.status === 'released') expect(w.values.totp).toMatch(/^\d{6}$/)
    // The next use asks again.
    expect((await use('GitHub')).status).toBe('pending')
  })

  it('a task grant lets this task use the item for an hour without asking, and Lock all ends it', async () => {
    const r = await use('GitHub', 'ask', { scope: 'task' })
    if (r.status !== 'pending') throw new Error('expected pending')
    const w = await agentWait(r.requestId, r.waitToken, 0, 'ask', waiter)
    expect(w).toMatchObject({ status: 'released', grantedUntil: expect.any(String) })
    expect(await use('GitHub')).toMatchObject({ status: 'released', via: 'grant' })
    // Another asker holds no grant.
    expect((await agentUse({ item: 'GitHub', purpose: 'another script', requester: script, agents: 'ask' }, create)).status).toBe('pending')
    expect(endAllGrants().grants).toBe(1)
    expect((await use('GitHub')).status).toBe('pending')
  })

  it('a grant covers the fields approved and the session that asked, nothing more', async () => {
    const inSession = { ...task, sessionId: 's-1' }
    const r = await agentUse({ item: 'GitHub', fields: ['username'], purpose: 'read the bot name', scope: 'task', requester: inSession, agents: 'ask' }, create)
    if (r.status !== 'pending') throw new Error('expected pending')
    await agentWait(r.requestId, r.waitToken, 0, 'ask', waiter)
    expect(await agentUse({ item: 'GitHub', fields: ['username'], purpose: 'read the bot name', requester: inSession, agents: 'ask' }, create)).toMatchObject({ status: 'released', via: 'grant' })
    // Another field, or the same task in another session, asks again.
    expect((await agentUse({ item: 'GitHub', fields: ['password'], purpose: 'sign in as the bot', requester: inSession, agents: 'ask' }, create)).status).toBe('pending')
    expect((await agentUse({ item: 'GitHub', fields: ['username'], purpose: 'read the bot name', requester: { ...task, sessionId: 's-2' }, agents: 'ask' }, create)).status).toBe('pending')
  })

  it('an approval that comes back after Lock all gives nothing', async () => {
    const r = await use('GitHub')
    if (r.status !== 'pending') throw new Error('expected pending')
    let answer!: () => void
    const slowWaiter: ApprovalWaiter = () => new Promise((res) => { answer = () => res({ status: 'approved', used: true }) })
    const w = code(agentWait(r.requestId, r.waitToken, 12_000, 'ask', slowWaiter))
    await new Promise((res) => setTimeout(res, 5))
    endAllGrants()
    answer()
    expect(await w).toBe('withdrawn')
  })

  it('two waits on one approval release once', async () => {
    const r = await use('GitHub')
    if (r.status !== 'pending') throw new Error('expected pending')
    const [a, b] = await Promise.all([agentWait(r.requestId, r.waitToken, 0, 'ask', waiter), agentWait(r.requestId, r.waitToken, 0, 'ask', waiter)])
    expect(a.status).toBe('released')
    expect(b.status).toBe('released')
    const log = await readAgentLog(5)
    expect(log.filter((e) => e.kind === 'released' && e.approvalId === r.requestId)).toHaveLength(1)
  })

  it('drops asks nobody waits on once their approval ran out, so they stop counting', async () => {
    const { vi } = await import('vitest')
    for (let i = 0; i < 3; i++) expect((await use('GitHub')).status).toBe('pending')
    expect(await code(use('GitHub'))).toBe('too_many_asks')
    vi.useFakeTimers({ now: Date.now() + 12 * 60_000, toFake: ['Date'] })
    try {
      expect((await use('GitHub')).status).toBe('pending')
    } finally {
      vi.useRealTimers()
    }
  })

  it('an item kept from agents never makes an allowed one ambiguous, and its name is never listed', async () => {
    const r = await use('Twin', 'allow')
    expect(r).toMatchObject({ status: 'released', values: { password: 'twin-ok-fake' } })
    expect(await code(use('Bank'))).toBe('agent_never')
  })

  it('a script asking for a task grant gets one use only (a grant needs a task)', async () => {
    const r = await agentUse({ item: 'GitHub', purpose: 'a script asks', scope: 'task', requester: script, agents: 'ask' }, create)
    if (r.status !== 'pending') throw new Error('expected pending')
    expect(asked[0].detail).toContain('For: this one use')
  })

  it('never gives an item kept from agents, whatever the switch', async () => {
    expect(await code(use('Bank'))).toBe('agent_never')
    expect(await code(use('Bank', 'allow'))).toBe('agent_never')
  })

  it('a sensitive item always asks, with Face ID or Touch ID, even when it allows agents', async () => {
    const r = await use('Payroll', 'allow')
    expect(r.status).toBe('pending')
    expect(asked[0].biometric).toBe(true)
  })

  it('the switch: off refuses everything, allow releases items set to ask', async () => {
    expect(await code(use('Stripe test key', 'off'))).toBe('agents_off')
    expect(await use('GitHub', 'allow')).toMatchObject({ status: 'released', via: 'allow' })
  })

  it('a denial is a refusal, and after three the task pauses', async () => {
    nextAnswer = 'denied'
    for (let i = 0; i < DENY_MAX; i++) {
      const r = await use('GitHub')
      if (r.status !== 'pending') throw new Error('expected pending')
      expect(await code(agentWait(r.requestId, r.waitToken, 0, 'ask', waiter))).toBe('denied')
    }
    expect(await code(use('GitHub'))).toBe('agent_paused')
    // An item that allows agents is not an ask, so it is not paused.
    expect((await use('Stripe test key')).status).toBe('released')
  })

  it('an approval the person did not answer in time releases nothing', async () => {
    nextAnswer = 'expired'
    const r = await use('GitHub')
    if (r.status !== 'pending') throw new Error('expected pending')
    expect(await agentWait(r.requestId, r.waitToken, 0, 'ask', waiter)).toEqual({ status: 'expired' })
    expect(await code(agentWait(r.requestId, r.waitToken, 0, 'ask', waiter))).toBe('not_found')
  })

  it('caps releases per task, and pending asks', async () => {
    for (let i = 0; i < RELEASE_MAX; i++) await use('Stripe test key')
    expect(await code(use('Stripe test key'))).toBe('agent_rate')
    resetAgentStateForTest()
    for (let i = 0; i < 3; i++) expect((await use('GitHub')).status).toBe('pending')
    expect(await code(use('GitHub'))).toBe('too_many_asks')
  })

  it('needs a purpose, a field the item has, and one item', async () => {
    expect(await code(use('GitHub', 'ask', { purpose: 'x' }))).toBe('purpose_required')
    expect(await code(use('GitHub', 'ask', { fields: ['card_number'] }))).toBe('no_such_field')
    expect(await code(use('shop.example.test'))).toBe('ambiguous')
    expect(await code(use('nothing.example.test'))).toBe('not_found')
    expect(asked).toHaveLength(0)
  })
})

describe('the log and the switch, sealed', () => {
  it('logs every outcome with no secret value, sealed on disk', async () => {
    await agentUse({ item: 'Stripe test key', purpose: 'log probe purpose', requester: task, agents: 'ask' }, create)
    await code(agentUse({ item: 'Bank', purpose: 'log probe purpose', requester: task, agents: 'ask' }, create))
    const log = await readAgentLog(10)
    expect(log[0]).toMatchObject({ kind: 'refused', reason: 'agent_never', itemTitle: 'Bank', taskTitle: 'Fix the deploy' })
    expect(log[1]).toMatchObject({ kind: 'released', via: 'allow', itemTitle: 'Stripe test key', purpose: 'log probe purpose' })
    expect(JSON.stringify(log)).not.toContain('sk_test_fake_0000')
    const raw = fs.readFileSync(path.join(dir, 'agent-log.json'), 'utf8')
    expect(raw).not.toContain('log probe purpose')
    expect(raw).not.toContain('Stripe')
  })

  it('keeps the switch sealed beside the vault, reading ask when it is missing or tampered with', async () => {
    expect(await readPolicy()).toEqual({ agents: 'ask' })
    await writePolicy({ agents: 'allow' })
    expect(await readPolicy()).toEqual({ agents: 'allow' })
    const file = path.join(dir, 'policy.json')
    const body = JSON.parse(fs.readFileSync(file, 'utf8'))
    body.data.ct = Buffer.from('tampered').toString('base64')
    fs.writeFileSync(file, JSON.stringify(body))
    expect(await readPolicy()).toEqual({ agents: 'ask' })
  })
})
