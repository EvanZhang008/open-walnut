/**
 * `browser fill_login` / `fill_code` while Walnut Passwords is locked (fill-from-bitwarden.ts): the
 * login comes from the person's Bitwarden, run by Walnut itself (bw faked through child-run.ts), and
 * goes to the extension alone. A real vault in a temp dir, locked; the browser, the config and the
 * approvals switch faked. Fake data only.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { derivePasswordKey, randomBytes, toB64 } from '../../../src/core/vault/crypto.js'
import { closeVault, createItems, resetVaultForTest, setupVault, unlockVault } from '../../../src/core/vault/store.js'
import { resetAgentStateForTest, type AgentsSwitch } from '../../../src/core/vault/agent.js'
import { setVaultRunnerForTest } from '../../../src/core/vault/child-run.js'
import { _resetFillLoginForTesting, fillLogin, type FillDeps } from '../../../src/core/browser-control/fill-login.js'

const fake = vi.hoisted(() => ({ sources: ['bitwarden'] as string[] | undefined, askMe: false, note: vi.fn() }))
vi.mock('../../../src/core/config-manager.js', async (orig) => ({
  ...(await orig<object>()),
  getConfig: async () => ({ passwords: fake.sources ? { sources: fake.sources } : {} }),
}))
vi.mock('../../../src/core/approvals/ask-me.js', async (orig) => ({ ...(await orig<object>()), asksPerson: async () => fake.askMe }))
vi.mock('../../../src/core/browser-control/agent-actions.js', () => ({ noteAgentAction: fake.note }))

const SEED = 'JBSWY3DPEHPK3PXP'
const bwItem = (id: string, name: string, username: string, password: string, uri: string, extra: Record<string, unknown> = {}) =>
  ({ id, type: 1, name, login: { username, password, uris: [{ uri }], ...(extra.totp ? { totp: extra.totp } : {}) }, ...(extra.reprompt ? { reprompt: 1 } : {}) })

let dir = ''
let pwKey = ''
let tabUrl = 'https://idp.example.test/signin'
let bwItems: unknown[] = []
let bwCalls: string[][] = []
let sent: Array<{ action: string; args: Record<string, unknown> }> = []
let agents: AgentsSwitch = 'ask'

const deps: FillDeps = {
  send: async (action, args) => {
    if (action === 'tabs') return { tabs: [{ id: 7, url: tabUrl, owner: 'task:t-bw' }] }
    sent.push({ action, args })
    return { filled: true }
  },
  agents: async () => agents,
  createApproval: async () => { throw new Error('no approval is asked for a Bitwarden fill') },
  waitApproval: async () => { throw new Error('no approval is waited for') },
}
const input = (extra: Record<string, unknown> = {}) => ({ owner: 'task:t-bw', tab: 7, waitMs: 0, requester: { host: 'devbox', taskId: 't-bw' }, ...extra })

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fill-bw-'))
  resetVaultForTest(dir)
  const kdf = { name: 'PBKDF2-SHA256' as const, iterations: 600_000, salt: toB64(randomBytes(16)) }
  pwKey = toB64(await derivePasswordKey('a fake bw fill master', kdf))
  await setupVault({ passwordKey: pwKey, kdf, agentsWhileAway: false })
  await createItems([{ type: 'login', title: 'Vault idp', username: 'vault@example.test', password: 'vault-fake-Pass', urls: ['https://idp.example.test'], agentAccess: 'allow' }])
}, 60_000)

afterAll(() => {
  resetVaultForTest(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  resetAgentStateForTest()
  _resetFillLoginForTesting()
  closeVault()
  fake.sources = ['bitwarden']
  fake.askMe = false
  agents = 'ask'
  tabUrl = 'https://idp.example.test/signin'
  bwCalls = []
  sent = []
  bwItems = [bwItem('bw-1', 'Idp', 'pat@example.test', 'Bw-Fake-Pass-1', 'https://idp.example.test')]
  process.env.BW_SESSION = 'fake-bw-session'
  setVaultRunnerForTest(async (_cmd, args) => {
    bwCalls.push(args)
    if (args[0] === 'list') return { code: 0, stdout: JSON.stringify(bwItems), stderr: '', timedOut: false }
    return { code: 1, stdout: '', stderr: 'unexpected', timedOut: false }
  })
})

afterEach(() => { setVaultRunnerForTest(null); delete process.env.BW_SESSION })

describe('fill_login while Walnut Passwords is locked', () => {
  it('fills the page\'s Bitwarden login into the extension, and the agent hears no secret', async () => {
    const out = await fillLogin(input(), deps)
    expect(out.status).toBe(200)
    expect(bwCalls).toEqual([['list', 'items', '--url', tabUrl]])
    expect(sent).toEqual([{ action: 'fill_login', args: { tab: 7, url: tabUrl, username: 'pat@example.test', password: 'Bw-Fake-Pass-1' } }])
    expect(out.body).toMatchObject({ filled: true, source: 'bitwarden', item: { id: 'bw-1', title: 'Idp' }, fields: ['username', 'password'] })
    expect(JSON.stringify(out.body)).not.toContain('Bw-Fake-Pass-1')
    expect(fake.note).toHaveBeenCalledWith('t-bw', tabUrl, 'fill_login', expect.any(Number), 'pat@example.test')
  })

  it('several logins for the page: which_login lists them; one named by username fills', async () => {
    bwItems.push(bwItem('bw-2', 'Idp work', 'pat.work@example.test', 'Bw-Fake-Pass-2', 'https://idp.example.test'))
    await expect(fillLogin(input(), deps)).rejects.toMatchObject({ code: 'which_login' })
    expect(sent).toEqual([])
    const out = await fillLogin(input({ item: 'pat.work@example.test' }), deps)
    expect(out.status).toBe(200)
    expect(sent[0].args).toMatchObject({ username: 'pat.work@example.test', password: 'Bw-Fake-Pass-2' })
  })

  it('a login saved for another site, or one Bitwarden asks the master password again for, is never filled', async () => {
    bwItems = [
      bwItem('bw-3', 'Other', 'x@example.test', 'Bw-Other', 'https://shop.other.test'),
      bwItem('bw-4', 'Reprompt', 'pat@example.test', 'Bw-Reprompt', 'https://idp.example.test', { reprompt: true }),
    ]
    await expect(fillLogin(input(), deps)).rejects.toMatchObject({ code: 'vault_locked', message: expect.stringMatching(/no login for idp\.example\.test in Bitwarden/) })
    expect(sent).toEqual([])
  })

  it('a use Walnut would ask the person about stays refused (it needs Passwords unlocked); Allow fills', async () => {
    fake.askMe = true
    await expect(fillLogin(input(), deps)).rejects.toMatchObject({ code: 'vault_locked', message: expect.stringMatching(/asks the person/) })
    expect(bwCalls).toEqual([])
    agents = 'allow'
    expect((await fillLogin(input(), deps)).status).toBe(200)
  })

  it('agent access Off: refused, Bitwarden not read', async () => {
    agents = 'off'
    await expect(fillLogin(input(), deps)).rejects.toMatchObject({ code: 'vault_locked' })
    expect(bwCalls).toEqual([])
  })

  it('Bitwarden not added as a source, or no session: the locked refusal says why', async () => {
    fake.sources = []
    await expect(fillLogin(input(), deps)).rejects.toMatchObject({ code: 'vault_locked', message: expect.stringMatching(/not one of the password sources/) })
    fake.sources = ['bitwarden']
    delete process.env.BW_SESSION
    setVaultRunnerForTest(async () => ({ code: 1, stdout: '', stderr: 'no keychain', timedOut: false }))
    await expect(fillLogin(input(), deps)).rejects.toMatchObject({ code: 'vault_locked' })
    expect(sent).toEqual([])
  })

  it('fill_code: the code of now from the Bitwarden login\'s setup key, never the key itself', async () => {
    bwItems = [bwItem('bw-5', 'Idp', 'pat@example.test', 'Bw-Fake-Pass-1', 'https://idp.example.test', { totp: SEED })]
    const out = await fillLogin(input({ what: 'code' }), deps)
    expect(out.status).toBe(200)
    expect(sent[0].action).toBe('fill_code')
    expect(String(sent[0].args.code)).toMatch(/^\d{6}$/)
    expect(JSON.stringify(sent)).not.toContain(SEED)
  })

  it('an open vault fills from the vault, and Bitwarden is not read', async () => {
    await unlockVault({ passwordKey: pwKey })
    const out = await fillLogin(input(), deps)
    expect(out.status).toBe(200)
    expect(out.body.source).toBeUndefined()
    expect(sent[0].args).toMatchObject({ username: 'vault@example.test' })
    expect(bwCalls).toEqual([])
  })
})
