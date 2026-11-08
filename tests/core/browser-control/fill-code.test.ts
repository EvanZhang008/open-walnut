/**
 * `browser fill_code` (src/core/browser-control/fill-login.ts, what 'code'): the one-time code of
 * the login saved for the page, over a real vault in a temp dir with the browser and the approvals
 * faked. The code goes only to the extension, computed when it is filled, and never into the
 * agent's answer; the same approval, item and site rules as fill_login. Fake data only.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { derivePasswordKey, randomBytes, toB64 } from '../../../src/core/vault/crypto.js'
import { createItems, getItem, resetVaultForTest, setupVault, updateItem } from '../../../src/core/vault/store.js'
import { resetAgentStateForTest, type ApprovalCreator, type ApprovalWaiter } from '../../../src/core/vault/agent.js'
import { parseTotp, totpAt } from '../../../src/core/vault/totp.js'
import { _resetFillLoginForTesting, fillLogin, type FillDeps } from '../../../src/core/browser-control/fill-login.js'

// A made-up base32 seed, the one the other vault tests use.
const SEED = 'JBSWY3DPEHPK3PXP'
let dir = ''
let shopId = ''
let neverId = ''
let tabUrl = ''
let sent: Array<{ action: string; args: Record<string, unknown> }> = []
let n = 0
let approved = true

const create: ApprovalCreator = async () => ({ id: `apr-code-${++n}`, waitToken: 'tok', mode: 'tap', expiresAt: new Date(Date.now() + 600_000).toISOString() })
const approve: ApprovalWaiter = async () => (approved ? { status: 'approved', used: true, answeredBy: 'iPhone' } : { status: 'denied', used: true, answeredBy: 'iPhone' }) as never
const deps: FillDeps = {
  send: async (action, args) => {
    if (action === 'tabs') return { tabs: [{ id: 7, url: tabUrl, owner: 'task:t-code' }] }
    sent.push({ action, args })
    if (action === 'fill_code' || action === 'fill_login') return { filled: true }
    throw new Error(`unexpected ${action}`)
  },
  agents: async () => 'ask',
  createApproval: create,
  waitApproval: approve,
}
const input = (extra: Record<string, unknown> = {}) => ({ owner: 'task:t-code', tab: 7, waitMs: 0, what: 'code' as const, requester: { host: 'devbox', taskId: 't-code' }, ...extra })
const codeNow = async () => (await totpAt(parseTotp(SEED)!, Date.now())).code

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fill-code-'))
  resetVaultForTest(dir)
  const kdf = { name: 'PBKDF2-SHA256' as const, iterations: 600_000, salt: toB64(randomBytes(16)) }
  await setupVault({ passwordKey: toB64(await derivePasswordKey('a fake code master', kdf)), kdf, agentsWhileAway: false })
  ;[{ id: shopId }, , { id: neverId }] = await createItems([
    { type: 'login', title: 'Shop', username: 'a@example.test', password: 'shop-fake-Pass', totp: SEED, urls: ['https://shop.example.test'] },
    { type: 'login', title: 'Plain', username: 'p@example.test', password: 'plain-fake-Pass', urls: ['https://plain.example.test'] },
    { type: 'login', title: 'Bank', username: 'b@example.test', password: 'bank-fake-Pass', totp: SEED, urls: ['https://bank.example.test'], agentAccess: 'never' },
  ])
}, 60_000)

afterAll(() => {
  resetVaultForTest(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  resetAgentStateForTest()
  _resetFillLoginForTesting()
  sent = []
  approved = true
  tabUrl = 'https://shop.example.test/verify'
})

describe('fill_code', () => {
  it('asks the person, then hands only the extension the code of now; the answer never holds it', async () => {
    const first = await fillLogin(input(), deps)
    expect(first.status).toBe(202)
    expect(String(first.body.error)).toContain('one-time code')
    const r = await fillLogin(input({ request: String(first.body.request) }), deps)
    const code = await codeNow()
    expect(r).toMatchObject({ status: 200, body: { filled: true, fields: ['code'], item: { id: shopId } } })
    expect(JSON.stringify(r)).not.toContain(code)
    expect(sent).toEqual([{ action: 'fill_code', args: { tab: 7, url: tabUrl, code } }])
  })

  it('a login with no one-time code answers no_code and fills nothing', async () => {
    tabUrl = 'https://plain.example.test/verify'
    await expect(fillLogin(input(), deps)).rejects.toMatchObject({ code: 'no_code' })
    expect(sent).toEqual([])
  })

  it('an item never given to agents is refused, and so is a no from the person', async () => {
    tabUrl = 'https://bank.example.test/verify'
    await expect(fillLogin(input(), deps)).rejects.toBeTruthy()
    tabUrl = 'https://shop.example.test/verify'
    approved = false
    const first = await fillLogin(input(), deps)
    await expect(fillLogin(input({ request: String(first.body.request) }), deps)).rejects.toBeTruthy()
    expect(sent).toEqual([])
    expect(neverId).toBeTruthy()
  })

  it('a fill_login ask is not a fill_code ask, nor the other way round', async () => {
    const login = await fillLogin(input({ what: 'login' }), deps)
    await expect(fillLogin(input({ request: String(login.body.request) }), deps)).rejects.toMatchObject({ code: 'no_such_request' })
    const code = await fillLogin(input(), deps)
    await expect(fillLogin(input({ what: 'login', request: String(code.body.request) }), deps)).rejects.toMatchObject({ code: 'no_such_request' })
    expect(sent).toEqual([])
  })

  it('the tab moved to another origin, or the code was removed while the person was asked: nothing is filled', async () => {
    let first = await fillLogin(input(), deps)
    tabUrl = 'https://other.example.test/verify'
    await expect(fillLogin(input({ request: String(first.body.request) }), deps)).rejects.toMatchObject({ code: 'page_changed' })
    // The first yes left a grant for this task: ask afresh.
    resetAgentStateForTest()
    tabUrl = 'https://shop.example.test/verify'
    first = await fillLogin(input(), deps)
    expect(first.status).toBe(202)
    const item = await getItem(shopId)
    await updateItem(shopId, { ...item, totp: undefined })
    try {
      // Refused by the vault's release or by the fill's own check, whichever reads it first.
      await expect(fillLogin(input({ request: String(first.body.request) }), deps)).rejects.toBeTruthy()
    } finally {
      await updateItem(shopId, { ...item, totp: SEED })
    }
    expect(sent).toEqual([])
  })
})
