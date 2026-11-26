/**
 * `browser fill_login` / `fill_code` while Walnut Passwords is locked (fill-from-bitwarden.ts): the
 * login comes from the person's Bitwarden, run by Walnut itself (bw faked through child-run.ts), and
 * goes to the extension alone, with every vault guard that can hold while locked (agent-holds.ts):
 * the person's opt-in, the agents switch, Never and sensitive, Lock all, the epoch, the rate brake.
 * A real vault in a temp dir; the browser and the approvals switch faked. Fake data only.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { derivePasswordKey, randomBytes, toB64 } from '../../../src/core/vault/crypto.js'
import { closeVault, createItems, deleteItem, isOpen, trashItem, resetVaultForTest, setupVault, unlockVault, VaultError } from '../../../src/core/vault/store.js'
import { updateSide } from '../../../src/core/vault/state.js'
import { writePolicy, resetPolicyForTest } from '../../../src/core/vault/policy.js'
import { bumpAgentEpoch, endAllGrants, RELEASE_MAX, resetAgentStateForTest, type AgentsSwitch } from '../../../src/core/vault/agent.js'
import { settleAgentHolds, stopAgentHolds, writeAgentHolds } from '../../../src/core/vault/sources/bitwarden/agent-holds.js'
import { setVaultRunnerForTest } from '../../../src/core/vault/child-run.js'
import { _resetFillLoginForTesting, fillLogin, type FillDeps } from '../../../src/core/browser-control/fill-login.js'

const fake = vi.hoisted(() => ({ askMe: false, note: vi.fn(), unasked: vi.fn(async () => undefined) }))
vi.mock('../../../src/core/approvals/ask-me.js', async (orig) => ({ ...(await orig<object>()), asksPerson: async () => fake.askMe, recordUnasked: fake.unasked }))
vi.mock('../../../src/core/browser-control/agent-actions.js', () => ({ noteAgentAction: fake.note }))

const SEED = 'JBSWY3DPEHPK3PXP'
const bwItem = (id: string, name: string, username: string, password: string, uri: string, extra: Record<string, unknown> = {}) =>
  ({ id, type: 1, name, login: { username, password, uris: [{ uri }], ...(extra.totp ? { totp: extra.totp } : {}) }, ...(extra.reprompt ? { reprompt: 1 } : {}) })

let dir = ''
let pwKey = ''
let tabUrl = 'https://idp.example.test/signin'
let bwItems: unknown[] = []
let bwCalls: string[][] = []
let onList: (() => void) | null = null
let sent: Array<{ action: string; args: Record<string, unknown> }> = []

const deps: FillDeps = {
  send: async (action, args) => {
    if (action === 'tabs') return { tabs: [{ id: 7, url: tabUrl, owner: 'task:t-bw' }] }
    sent.push({ action, args })
    return { filled: true }
  },
  // As the server's: the switch is sealed in the vault, so a locked vault refuses it.
  agents: async () => {
    if (!isOpen()) throw new VaultError('The vault is locked: unlock it with the master password', 423, 'vault_locked')
    const { readPolicy } = await import('../../../src/core/vault/policy.js')
    return (await readPolicy()).agents
  },
  createApproval: async () => { throw new Error('no approval is asked for a Bitwarden fill') },
  waitApproval: async () => { throw new Error('no approval is waited for') },
}
const gone = async (id: string) => { await trashItem(id); await deleteItem(id) }
const input = (extra: Record<string, unknown> = {}) => ({ owner: 'task:t-bw', tab: 7, waitMs: 0, requester: { host: 'devbox', taskId: 't-bw' }, ...extra })

/** Open Passwords, set the switches, note the holds, lock again: what a person's last unlock leaves. */
async function primed(p: { agents?: AgentsSwitch; on?: boolean } = {}, also?: () => Promise<void>) {
  if (!isOpen()) await unlockVault({ passwordKey: pwKey })
  await writePolicy({ agents: p.agents ?? 'ask', bitwardenWhileLocked: p.on ?? true })
  if (also) await also()
  await settleAgentHolds()
  expect(await writeAgentHolds({ clearStop: true })).toBe(true)
  closeVault()
}

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

beforeEach(async () => {
  resetAgentStateForTest()
  resetPolicyForTest()
  _resetFillLoginForTesting()
  fake.askMe = false
  fake.unasked.mockClear()
  tabUrl = 'https://idp.example.test/signin'
  bwCalls = []
  sent = []
  onList = null
  bwItems = [bwItem('bw-1', 'Idp', 'pat@example.test', 'Bw-Fake-Pass-1', 'https://idp.example.test')]
  process.env.BW_SESSION = 'fake-bw-session'
  setVaultRunnerForTest(async (_cmd, args) => {
    bwCalls.push(args)
    if (args[0] === 'list') { onList?.(); return { code: 0, stdout: JSON.stringify(bwItems), stderr: '', timedOut: false } }
    return { code: 1, stdout: '', stderr: 'unexpected', timedOut: false }
  })
  await primed()
})

afterEach(() => { setVaultRunnerForTest(null); delete process.env.BW_SESSION })

describe('fill_login while Walnut Passwords is locked', () => {
  it('fills the page\'s Bitwarden login into the extension; the agent hears no secret; bw gets no query string', async () => {
    tabUrl = 'https://idp.example.test/signin?state=fake-token-123'
    const out = await fillLogin(input(), deps)
    expect(out.status).toBe(200)
    expect(bwCalls).toEqual([['list', 'items', '--url', 'https://idp.example.test/signin']])
    expect(sent).toEqual([{ action: 'fill_login', args: { tab: 7, url: tabUrl, username: 'pat@example.test', password: 'Bw-Fake-Pass-1' } }])
    expect(out.body).toMatchObject({ filled: true, source: 'bitwarden', item: { id: 'bw-1', title: 'Idp' }, fields: ['username', 'password'] })
    expect(JSON.stringify(out.body)).not.toContain('Bw-Fake-Pass-1')
    expect(fake.note).toHaveBeenCalledWith('t-bw', tabUrl, 'fill_login', expect.any(Number), 'pat@example.test')
    // Approvals off: listed under Approvals, as the vault's own release is.
    expect(fake.unasked).toHaveBeenCalledWith('vaultUse', expect.objectContaining({ what: expect.stringContaining('Idp') }))
  })

  it('off unless the person turned it on: refused, Bitwarden not read', async () => {
    await primed({ on: false })
    await expect(fillLogin(input(), deps)).rejects.toMatchObject({ code: 'vault_locked', message: expect.stringMatching(/is off \(Settings, Passwords, Agents\)/) })
    expect(bwCalls).toEqual([])
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
    await expect(fillLogin(input(), deps)).rejects.toMatchObject({ code: 'vault_locked', message: expect.stringMatching(/no login for idp\.example\.test in Bitwarden that agents may use \(1 more you keep from agents\)/) })
    expect(sent).toEqual([])
  })

  it('a login the person set to Never in Walnut is kept back: by the sync\'s link, or by its site and username alone', async () => {
    let id = ''
    await primed({}, async () => {
      id = (await createItems([{ type: 'login', title: 'Kept idp', username: 'pat@example.test', password: 'kept-fake', urls: ['https://login.idp.example.test'], agentAccess: 'never' }]))[0].id
    })
    // Unlinked twin: same site (registrable domain) and username.
    await expect(fillLogin(input(), deps)).rejects.toMatchObject({ code: 'vault_locked', message: expect.stringMatching(/keep from agents/) })
    // Linked by the sync, under another username: held by its id.
    bwItems = [bwItem('bw-9', 'Idp', 'someone@example.test', 'Bw-Fake-9', 'https://idp.example.test')]
    await primed({}, async () => {
      await updateSide('bitwarden-sync.json', () => ({ links: { 'bw-9': { itemId: id, hash: 'h', type: 'login', walnutAt: '' } } }))
    })
    await expect(fillLogin(input(), deps)).rejects.toMatchObject({ code: 'vault_locked', message: expect.stringMatching(/keep from agents/) })
    expect(sent).toEqual([])
    await primed({}, async () => { await gone(id); await updateSide('bitwarden-sync.json', () => ({ links: {} })) })
  })

  it('a sensitive item in Walnut keeps its Bitwarden twin back too', async () => {
    let id = ''
    await primed({}, async () => {
      id = (await createItems([{ type: 'login', title: 'Sensitive idp', username: 'PAT@example.test', password: 'kept-fake', urls: ['https://idp.example.test'], sensitive: true }]))[0].id
    })
    await expect(fillLogin(input(), deps)).rejects.toMatchObject({ code: 'vault_locked' })
    expect(sent).toEqual([])
    await primed({}, async () => { await gone(id) })
  })

  it('no holds noted, or vault.json or policy.json changed since: every fill refused until Passwords opens again', async () => {
    fs.rmSync(path.join(dir, 'bitwarden-agent-holds.json'))
    await expect(fillLogin(input(), deps)).rejects.toMatchObject({ code: 'vault_locked', message: expect.stringMatching(/next time Passwords is unlocked/) })
    await primed()
    // vault.json's content changed (a backup put back): same mtime or not, stale.
    fs.appendFileSync(path.join(dir, 'vault.json'), ' ')
    await expect(fillLogin(input(), deps)).rejects.toMatchObject({ code: 'vault_locked', message: expect.stringMatching(/next time Passwords is unlocked/) })
    await primed()
    // The switch turned off with no fresh copy of it (a lost write, an older Walnut): stale, refused.
    await unlockVault({ passwordKey: pwKey })
    await settleAgentHolds()
    await writePolicy({ bitwardenWhileLocked: false })
    closeVault()
    await expect(fillLogin(input(), deps)).rejects.toMatchObject({ code: 'vault_locked', message: expect.stringMatching(/next time Passwords is unlocked/) })
    expect(bwCalls).toEqual([])
    await primed()
    expect((await fillLogin(input(), deps)).status).toBe(200)
  })

  it('holds follow a vault write by themselves (onVaultSaved)', async () => {
    await unlockVault({ passwordKey: pwKey })
    const made = await createItems([{ type: 'login', title: 'Late never', username: 'pat@example.test', password: 'x-fake', urls: ['https://idp.example.test'], agentAccess: 'never' }])
    await settleAgentHolds()
    closeVault()
    await expect(fillLogin(input(), deps)).rejects.toMatchObject({ code: 'vault_locked', message: expect.stringMatching(/keep from agents/) })
    await primed({}, async () => { await gone(made[0].id) })
  })

  it('Lock all stops it until the person unlocks again, not Walnut\'s own open from the keychain', async () => {
    await stopAgentHolds()
    await expect(fillLogin(input(), deps)).rejects.toMatchObject({ code: 'vault_locked', message: expect.stringMatching(/Lock all stopped/) })
    // Walnut's own open from the keychain (the daily sync, the unlock at start) keeps the stop.
    await unlockVault({ passwordKey: pwKey })
    await settleAgentHolds()
    expect(await writeAgentHolds()).toBe(true)
    closeVault()
    await expect(fillLogin(input(), deps)).rejects.toMatchObject({ code: 'vault_locked', message: expect.stringMatching(/Lock all stopped/) })
    expect(bwCalls).toEqual([])
    // The person's own unlock ends it.
    await primed()
    expect((await fillLogin(input(), deps)).status).toBe(200)
  })

  it('Lock all or a switch move while bw runs: nothing is filled', async () => {
    onList = () => bumpAgentEpoch()
    await expect(fillLogin(input(), deps)).rejects.toMatchObject({ code: 'vault_locked', message: expect.stringMatching(/changed while this ran/) })
    // Lock all, as the route does it: every grant ends (the epoch), then the holds stop.
    onList = () => { endAllGrants(); void stopAgentHolds() }
    await expect(fillLogin(input(), deps)).rejects.toMatchObject({ code: 'vault_locked' })
    expect(sent).toEqual([])
  })

  it('a use Walnut would ask the person about stays refused (it needs Passwords unlocked); Any fills', async () => {
    fake.askMe = true
    await expect(fillLogin(input(), deps)).rejects.toMatchObject({ code: 'vault_locked', message: expect.stringMatching(/asks the person/) })
    expect(bwCalls).toEqual([])
    await primed({ agents: 'allow' })
    expect((await fillLogin(input(), deps)).status).toBe(200)
    expect(fake.unasked).not.toHaveBeenCalled()
  })

  it('agent access Off: refused, Bitwarden not read', async () => {
    await primed({ agents: 'off' })
    await expect(fillLogin(input(), deps)).rejects.toMatchObject({ code: 'vault_locked' })
    expect(bwCalls).toEqual([])
  })

  it('the per-task brake of the vault holds here too', async () => {
    for (let i = 0; i < RELEASE_MAX; i++) expect((await fillLogin(input(), deps)).status).toBe(200)
    await expect(fillLogin(input(), deps)).rejects.toMatchObject({ code: 'agent_rate' })
    expect(sent).toHaveLength(RELEASE_MAX)
  })

  it('no bw session: the locked refusal says why', async () => {
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

  it('an open vault fills from the vault, Bitwarden not read; a Bitwarden id from which_login names its linked Walnut item', async () => {
    await unlockVault({ passwordKey: pwKey })
    const out = await fillLogin(input(), deps)
    expect(out.status).toBe(200)
    expect(out.body.source).toBeUndefined()
    expect(sent[0].args).toMatchObject({ username: 'vault@example.test' })
    const { listItems } = await import('../../../src/core/vault/store.js')
    const vaultIdp = (await listItems()).find((i) => i.title === 'Vault idp')!.id
    await updateSide('bitwarden-sync.json', () => ({ links: { 'bw-1': { itemId: vaultIdp, hash: 'h', type: 'login', walnutAt: '' } } }))
    expect((await fillLogin(input({ item: 'bw-1' }), deps)).body).toMatchObject({ item: { id: vaultIdp } })
    expect(bwCalls).toEqual([])
    await updateSide('bitwarden-sync.json', () => ({ links: {} }))
    closeVault()
  })
})
