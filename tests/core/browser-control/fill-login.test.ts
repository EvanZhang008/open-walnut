/**
 * `browser fill_login` site checks (src/core/browser-control/fill-login.ts) over a real vault in a
 * temp dir with the browser and the approvals faked: after an approval the tab must be on the
 * origin the ask named (not only the same site), and right before the fill the item's own sites
 * must still match the page. Fake data only.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { derivePasswordKey, randomBytes, toB64 } from '../../../src/core/vault/crypto.js'
import { createItems, getItem, resetVaultForTest, setupVault, updateItem } from '../../../src/core/vault/store.js'
import { resetAgentStateForTest, type ApprovalCreator, type ApprovalWaiter } from '../../../src/core/vault/agent.js'
import { _resetFillLoginForTesting, fillLogin, type FillDeps } from '../../../src/core/browser-control/fill-login.js'

let dir = ''
let shopId = ''
let tabUrl = ''
let fills: Array<Record<string, unknown>> = []
let n = 0

const create: ApprovalCreator = async () => ({ id: `apr-fill-${++n}`, waitToken: 'tok', mode: 'tap', expiresAt: new Date(Date.now() + 600_000).toISOString() })
const approve: ApprovalWaiter = async () => ({ status: 'approved', used: true, answeredBy: 'iPhone' })
const deps: FillDeps = {
  send: async (action, args) => {
    if (action === 'tabs') return { tabs: [{ id: 7, url: tabUrl, owner: 'task:t-fill' }] }
    if (action === 'fill_login') { fills.push(args); return { filled: true } }
    throw new Error(`unexpected ${action}`)
  },
  agents: async () => 'ask',
  createApproval: create,
  waitApproval: approve,
}
const input = (extra: Record<string, unknown> = {}) => ({ owner: 'task:t-fill', tab: 7, waitMs: 0, requester: { host: 'devbox', taskId: 't-fill' }, ...extra })

async function askAndApprove(): Promise<string> {
  const first = await fillLogin(input(), deps)
  expect(first.status).toBe(202)
  return String(first.body.request)
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fill-login-'))
  resetVaultForTest(dir)
  const kdf = { name: 'PBKDF2-SHA256' as const, iterations: 600_000, salt: toB64(randomBytes(16)) }
  await setupVault({ passwordKey: toB64(await derivePasswordKey('a fake fill master', kdf)), kdf, agentsWhileAway: false })
  ;[{ id: shopId }] = await createItems([{ type: 'login', title: 'Shop', username: 'a@example.test', password: 'shop-fake-Pass', urls: ['https://shop.example.test'] }])
}, 60_000)

afterAll(() => {
  resetVaultForTest(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  resetAgentStateForTest()
  _resetFillLoginForTesting()
  fills = []
  tabUrl = 'https://shop.example.test/login'
})

describe('fill_login after an approval', () => {
  it('fills on the origin the ask named', async () => {
    const request = await askAndApprove()
    const r = await fillLogin(input({ request }), deps)
    expect(r).toMatchObject({ status: 200, body: { filled: true, item: { id: shopId } } })
    expect(fills).toHaveLength(1)
  })

  it('refuses a tab now on another origin of the same site (another host, or plain http)', async () => {
    for (const moved of ['https://other.example.test/login', 'http://shop.example.test/login', 'https://shop.example.test:8443/login']) {
      _resetFillLoginForTesting()
      resetAgentStateForTest()
      tabUrl = 'https://shop.example.test/login'
      const request = await askAndApprove()
      tabUrl = moved
      await expect(fillLogin(input({ request }), deps)).rejects.toMatchObject({ code: 'page_changed' })
    }
    expect(fills).toEqual([])
  })

  it('checks the item\'s own sites again right before the fill (edited while the person was asked)', async () => {
    const request = await askAndApprove()
    const item = await getItem(shopId)
    await updateItem(shopId, { ...item, urls: ['https://elsewhere-shop.test'] })
    try {
      await expect(fillLogin(input({ request }), deps)).rejects.toMatchObject({ code: 'other_site' })
      expect(fills).toEqual([])
    } finally {
      await updateItem(shopId, { ...item, urls: ['https://shop.example.test'] })
    }
  })
})
