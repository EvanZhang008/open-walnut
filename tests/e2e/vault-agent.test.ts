/**
 * Agents and the vault on a real server (src/web/routes/vault-agent-v1.ts): an agent lists
 * what it may ask for, gets an item that allows agents at once, waits for a person's real
 * approval (approvals-v1.ts) for one that asks, is refused on a denial, a `never` item and a
 * test run, sees no list and must ask under the switch off; Lock all withdraws a waiting ask and closes the vault; the person
 * reads the sealed log. Fake data only; the vault lives in the test's own data home.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fsp from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-vault-agent-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { derivePasswordKey, randomBytes, toB64, type KdfParams } from '../../src/core/vault/crypto.js'
import { resetVaultForTest } from '../../src/core/vault/store.js'
import { resetSessionsForTest } from '../../src/core/vault/sessions.js'
import { resetAgentStateForTest } from '../../src/core/vault/agent.js'

let base = ''
let session = ''
let pwKey = ''
const kdf: KdfParams = { name: 'PBKDF2-SHA256', iterations: 600_000, salt: toB64(randomBytes(16)) }
const AGENT = { 'x-walnut-caller-kind': 'automation' }
const ids: Record<string, string> = {}

async function http(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(p.startsWith('/api/') ? `${base}${p}` : `${base}/api/v1${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => ({})) as Record<string, any> }
}
const person = (method: string, p: string, body?: unknown) => http(method, p, body, { 'x-walnut-vault-session': session })
const agent = (method: string, p: string, body?: unknown) => http(method, p, body, AGENT)

beforeAll(async () => {
  process.env.WALNUT_TEST_RUN_MARK = '1'
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  resetVaultForTest(null)
  resetSessionsForTest()
  resetAgentStateForTest()
  pwKey = toB64(await derivePasswordKey('a fake agent test master', kdf))
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  session = (await http('POST', '/vault/setup', { passwordKey: pwKey, kdf, client: 'test' })).body.session.token
  for (const item of [
    { type: 'api_key', title: 'Stripe test key', password: 'sk_test_fake_0000', envName: 'STRIPE_API_KEY', agentAccess: 'allow' },
    { type: 'login', title: 'Git host', username: 'bot@example.test', password: 'git-fake-Pass-1', urls: ['git.example.test'] },
    { type: 'login', title: 'Bank', password: 'bank-fake-Pass', urls: ['bank.example.test'], agentAccess: 'never' },
    { type: 'login', title: 'Payroll', password: 'pay-fake-Pass', urls: ['payroll.example.test'], sensitive: true },
  ]) ids[item.title] = (await person('POST', '/vault/items', { item })).body.item.id
  // This file walks the Ask switch with one-use approvals; the Any default and grant lengths
  // are in vault-agent-modes.test.ts.
  expect((await person('PUT', '/vault/agent/policy', { agents: 'ask', grantMs: 0 })).body).toMatchObject({ agents: 'ask', grantMs: 0 })
}, 120_000)

afterAll(async () => {
  await stopServer()
  delete process.env.WALNUT_TEST_RUN_MARK
})

async function ask(item = 'Git host') {
  const r = await agent('POST', '/vault/agent/use', { item, purpose: 'merge the test pull request', command: 'git push' })
  expect(r.body.status).toBe('pending')
  return r.body as { requestId: string; waitToken: string }
}

describe('an agent and the vault', () => {
  it('lists what it may ask for, without secrets and without the items kept from agents', async () => {
    const r = await agent('GET', '/vault/agent/items')
    expect(r.status).toBe(200)
    expect(r.body.items.map((i: { title: string }) => i.title).sort()).toEqual(['Git host', 'Payroll', 'Stripe test key'])
    expect(JSON.stringify(r.body)).not.toMatch(/sk_test_fake|git-fake-Pass|bank-fake/)
    expect((await person('GET', '/vault/agent/policy')).body).toMatchObject({ agents: 'ask', grants: [] })
  })

  it('gets an item that allows agents at once', async () => {
    const r = await agent('POST', '/vault/agent/use', { item: 'STRIPE_API_KEY', purpose: 'run the billing test suite' })
    expect(r.body).toMatchObject({ status: 'released', via: 'allow', values: { password: 'sk_test_fake_0000' } })
  })

  it('waits for the person to approve on a device, then gets it; a retry right after reads the same', async () => {
    const p = await ask()
    const list = await http('GET', '/approvals')
    const card = list.body.approvals.find((a: { id: string }) => a.id === p.requestId)
    expect(card.what).toContain('Git host')
    expect(card.detail).toContain('Why: merge the test pull request')
    expect(card.detail).toContain('Command: git push')
    expect((await agent('POST', `/vault/agent/use/${p.requestId}/wait`, { token: p.waitToken, wait_ms: 0 })).body.status).toBe('pending')
    expect(card.mode).toBe('tap')
    // An agent cannot answer its own ask: not as an automation, not from its session.
    expect((await agent('POST', `/approvals/${p.requestId}/answer`, { decision: 'approve' })).body.code).toBe('human_only')
    expect((await http('POST', `/approvals/${p.requestId}/answer`, { decision: 'approve' }, { 'x-walnut-caller-sid': 'sess-vault-agent' })).body.code).toBe('human_only')
    expect((await agent('POST', `/vault/agent/use/${p.requestId}/wait`, { token: p.waitToken, wait_ms: 0 })).body.status).toBe('pending')
    // The person's tap in their window, Passwords unlocked there or not.
    expect((await http('POST', `/approvals/${p.requestId}/answer`, { decision: 'approve', digest: card.digest, device: { name: 'Web console', kind: 'web' } })).status).toBe(200)
    const w = await agent('POST', `/vault/agent/use/${p.requestId}/wait`, { token: p.waitToken, wait_ms: 0 })
    expect(w.body).toMatchObject({ status: 'released', via: 'approval', values: { password: 'git-fake-Pass-1' } })
    expect((await agent('POST', `/vault/agent/use/${p.requestId}/wait`, { token: p.waitToken, wait_ms: 0 })).body.status).toBe('released')
    expect((await agent('POST', `/vault/agent/use/${p.requestId}/wait`, { token: 'not-the-token', wait_ms: 0 })).status).toBe(403)
  })

  it('a denial is a refusal', async () => {
    const p = await ask()
    await http('POST', `/approvals/${p.requestId}/answer`, { decision: 'deny' })
    const w = await agent('POST', `/vault/agent/use/${p.requestId}/wait`, { token: p.waitToken, wait_ms: 0 })
    expect(w.status).toBe(403)
    expect(w.body.code).toBe('denied')
  })

  it('withdrawing an ask takes it off the person\'s devices', async () => {
    const p = await ask()
    expect((await agent('POST', `/vault/agent/use/${p.requestId}/cancel`, { token: p.waitToken })).status).toBe(200)
    expect((await http('GET', `/approvals/${p.requestId}`)).body.approval.status).toBe('canceled')
  })

  it('never gives an item kept from agents, lists nothing and asks for each item with the switch off, and only a person moves the switch', async () => {
    expect((await agent('POST', '/vault/agent/use', { item: 'Bank', purpose: 'check the balance' })).body.code).toBe('agent_never')
    expect((await http('PUT', '/vault/agent/policy', { agents: 'allow' }, { ...AGENT, 'x-walnut-vault-session': session })).body.code).toBe('human_only')
    // A plain approval (walnut approve) is not guarded: a tap answers it as before.
    const plain = await http('POST', '/approvals', { what: 'restart the test service' })
    expect(plain.body.approval.guard).toBeUndefined()
    expect((await http('POST', `/approvals/${plain.body.approval.id}/answer`, { decision: 'approve' })).status).toBe(200)
    expect((await person('PUT', '/vault/agent/policy', { agents: 'off' })).body.agents).toBe('off')
    // Off: no list, and even an item that allows agents waits for the person.
    const off = await agent('POST', '/vault/agent/use', { item: 'STRIPE_API_KEY', purpose: 'run the billing test suite' })
    expect(off.body.status).toBe('pending')
    await agent('POST', `/vault/agent/use/${off.body.requestId}/cancel`, { token: off.body.waitToken })
    expect((await agent('GET', '/vault/agent/items')).body).toMatchObject({ items: [], off: true })
    expect((await agent('POST', '/vault/agent/use', { item: 'Bank', purpose: 'check the balance' })).body.code).toBe('agent_never')
    expect((await person('PUT', '/vault/agent/policy', { agents: 'allow' })).body.agents).toBe('allow')
    expect((await agent('POST', '/vault/agent/use', { item: 'Git host', purpose: 'merge the test pull request' })).body).toMatchObject({ status: 'released', via: 'allow' })
    expect((await person('PUT', '/vault/agent/policy', { agents: 'ask' })).body.agents).toBe('ask')
  })

  it('an op call reads the refusal code the route answers (the flat {error, code} shape)', async () => {
    await import('../../src/ops/index.js')
    const { executeOp } = await import('../../src/ops/executor.js')
    const r = await executeOp('password_use', { item: 'Bank', purpose: 'check the balance' }, { apiBase: `${base}/api/v1`, origin: '__local__', sender: 'vault-test' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/^Walnut API error \(agent_never\): /)
  })

  it('refuses a test run', async () => {
    const r = await http('POST', '/vault/agent/use', { item: 'Git host', purpose: 'a test run probe' }, { ...AGENT, 'x-walnut-test-run': 'probe' })
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('test_run')
  })

  it('Lock all withdraws a waiting ask and, with agents-while-away off, closes the vault to agents', async () => {
    const p = await ask()
    expect((await person('POST', '/vault/lock', { all: true })).status).toBe(200)
    expect((await http('GET', `/approvals/${p.requestId}`)).body.approval.status).toBe('canceled')
    const r = await agent('POST', '/vault/agent/use', { item: 'STRIPE_API_KEY', purpose: 'run the billing test suite' })
    expect(r.status).toBe(423)
    expect(r.body.code).toBe('vault_locked')
  })

  it('an agent polling the locked vault gets the same 423 each time, and only the first is a warn line', async () => {
    // 2026-11-26: a trigger's check asked password_list every 2 minutes all night while the vault
    // stayed locked, one warn line each, until the log-spike alarm rang (src/web/routes/vault-answer.ts).
    const first = await agent('GET', '/vault/agent/items')
    expect(first.status).toBe(423)
    expect(first.body.code).toBe('vault_locked')
    expect(first.headers.get('x-walnut-repeat-answer')).toBeNull()
    const again = await agent('GET', '/vault/agent/items')
    expect(again.status).toBe(423)
    expect(again.body.code).toBe('vault_locked')
    expect(again.headers.get('x-walnut-repeat-answer')).toBe('1')
    // Each route counts on its own: the case above already got this refusal from /vault/agent/use once.
    const use = await agent('POST', '/vault/agent/use', { item: 'STRIPE_API_KEY', purpose: 'run the billing test suite' })
    expect(use.status).toBe(423)
    expect(use.headers.get('x-walnut-repeat-answer')).toBe('1')
  })

  it('the person reads the log of every use, sealed, with no secret in it', async () => {
    session = (await http('POST', '/vault/unlock', { passwordKey: pwKey })).body.session.token
    expect((await agent('GET', '/vault/agent/log')).body.code).toBe('human_only')
    const log = (await person('GET', '/vault/agent/log')).body.entries as Array<{ kind: string; reason?: string; itemTitle?: string }>
    const kinds = log.map((e) => `${e.kind}${e.reason ? `:${e.reason}` : ''}`)
    expect(kinds).toEqual(expect.arrayContaining(['released', 'asked', 'denied', 'refused:agent_never', 'listed']))
    expect(JSON.stringify(log)).not.toMatch(/sk_test_fake|git-fake-Pass/)
  })

  it('a sensitive item too: a tap on any device the person is signed in on releases it, never the agent\'s own call', async () => {
    const s = await ask('Payroll')
    const rec = (await http('GET', `/approvals/${s.requestId}`)).body.approval
    expect(rec.mode).toBe('tap')
    expect((await agent('POST', `/approvals/${s.requestId}/answer`, { decision: 'approve' })).body.code).toBe('human_only')
    expect((await agent('POST', `/vault/agent/use/${s.requestId}/wait`, { token: s.waitToken, wait_ms: 0 })).body.status).toBe('pending')
    const paired = await http('POST', '/api/devices', { name: 'vault-agent-e2e-phone' }, {})
    expect(paired.status).toBe(201)
    const tap = await http('POST', `/approvals/${s.requestId}/answer`, { decision: 'approve', digest: rec.digest, device: { name: 'Test iPhone', kind: 'iphone' } }, { authorization: `Bearer ${paired.body.token}` })
    expect(tap.status).toBe(200)
    expect(tap.body.approval.answer).toMatchObject({ decision: 'approve', mode: 'tap', device: { kind: 'iphone' } })
    expect((await agent('POST', `/vault/agent/use/${s.requestId}/wait`, { token: s.waitToken, wait_ms: 0 })).body.values).toEqual({ password: 'pay-fake-Pass' })
  })
})
