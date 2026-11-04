/**
 * `browser fill_login` with several logins saved for the page (src/core/browser-control/fill-login.ts):
 * the refusal names every choice (id, name, username) in its words, since a shell sees only the
 * message, and lists them as data too. Fake data only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { derivePasswordKey, randomBytes, toB64 } from '../../../src/core/vault/crypto.js'
import { createItems, resetVaultForTest, setupVault } from '../../../src/core/vault/store.js'
import { resetAgentStateForTest } from '../../../src/core/vault/agent.js'
import { _resetFillLoginForTesting, fillLogin, type FillDeps } from '../../../src/core/browser-control/fill-login.js'
import { BrowserError } from '../../../src/core/browser-control/hub.js'

let dir = ''
const ids: string[] = []
const deps: FillDeps = {
  send: async (action) => {
    if (action === 'tabs') return { tabs: [{ id: 3, url: 'https://shop.example.test/login', owner: 'task:t-choices' }] }
    throw new Error(`unexpected ${action}`)
  },
  agents: async () => 'ask',
  createApproval: async () => { throw new Error('no ask expected') },
  waitApproval: async () => { throw new Error('no wait expected') },
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fill-choices-'))
  resetVaultForTest(dir)
  const kdf = { name: 'PBKDF2-SHA256' as const, iterations: 600_000, salt: toB64(randomBytes(16)) }
  await setupVault({ passwordKey: toB64(await derivePasswordKey('a fake choices master', kdf)), kdf, agentsWhileAway: false })
  const made = await createItems([
    { type: 'login', title: 'Shop', username: 'a@example.test', password: 'fake-one', urls: ['https://shop.example.test'] },
    { type: 'login', title: 'Shop (work)', username: 'b@example.test', password: 'fake-two', urls: ['https://shop.example.test'] },
  ])
  ids.push(...made.map((m) => m.id))
  resetAgentStateForTest()
  _resetFillLoginForTesting()
}, 60_000)

afterAll(() => {
  resetVaultForTest(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('fill_login with several logins for the page', () => {
  it('names each choice in the message and lists them', async () => {
    const err = await fillLogin({ owner: 'task:t-choices', tab: 3, waitMs: 0, requester: { host: 'devbox', taskId: 't-choices' } }, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BrowserError)
    const e = err as BrowserError
    expect(e.code).toBe('which_login')
    for (const [i, id] of ids.entries()) expect(e.message).toContain(`${id} "${['Shop', 'Shop (work)'][i]}" (${['a@example.test', 'b@example.test'][i]})`)
    expect((e.extra.logins as Array<{ id: string }>).map((l) => l.id).sort()).toEqual([...ids].sort())
  })
})

describe('fill_login with a login saved only for another part of the site', () => {
  const at = (url: string): FillDeps => ({ ...deps, send: async (action) => {
    if (action === 'tabs') return { tabs: [{ id: 4, url, owner: 'task:t-choices' }] }
    throw new Error(`unexpected ${action}`)
  } })
  let sibling = ''
  beforeAll(async () => {
    const [made] = await createItems([{ type: 'login', title: 'Account center', username: 'c@example.test', password: 'fake-three', urls: ['https://accounts.other-shop.test'] }])
    sibling = made.id
  })

  it('says it is saved for another part of the site and that a base rule makes it count', async () => {
    const err = await fillLogin({ owner: 'task:t-choices', tab: 4, waitMs: 0, requester: { host: 'devbox', taskId: 't-choices' } }, at('https://help.other-shop.test/sign-in')).catch((e: unknown) => e) as BrowserError
    expect(err).toBeInstanceOf(BrowserError)
    expect(err.code).toBe('no_login')
    expect(err.message).toContain('No login is saved for help.other-shop.test itself')
    expect(err.message).toContain(`${sibling} "Account center" (saved for accounts.other-shop.test)`)
    expect(err.message).toContain('match rule is "base"')
    expect(err.message).not.toContain('add one')
    expect(err.extra.otherPart).toEqual([{ id: sibling, title: 'Account center', host: 'accounts.other-shop.test' }])
  })

  it('a site with nothing saved anywhere still asks for one', async () => {
    const err = await fillLogin({ owner: 'task:t-choices', tab: 4, waitMs: 0, requester: { host: 'devbox', taskId: 't-choices' } }, at('https://nothing.invalid-test.example/')).catch((e: unknown) => e) as BrowserError
    expect(err.code).toBe('no_login')
    expect(err.message).toContain('Ask the person to add one in Passwords')
  })
})
