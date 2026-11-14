/**
 * Passwords for agents on a real server, the new defaults and settings: a fresh vault is Any
 * (agents list and use; a sensitive item still asks) with 48-hour grants and 48-hour unlocks;
 * the person picks the grant length; a grant is listed, revoked one by one, and ended by a new
 * master password; every use is logged with how it was used; the Bitwarden sync (an agent only
 * triggers it and Walnut runs bw, export text is a person's alone, Off refusing the agent, the
 * person's status); the keychain unlock having no route; the unlock length in the status. Fake data only; the vault lives in the
 * test's own data home.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fsp from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-vault-agent-modes-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { derivePasswordKey, randomBytes, toB64, type KdfParams } from '../../src/core/vault/crypto.js'
import { resetVaultForTest } from '../../src/core/vault/store.js'
import { resetSessionsForTest } from '../../src/core/vault/sessions.js'
import { resetAgentStateForTest } from '../../src/core/vault/agent.js'
import { putGrant } from '../../src/core/vault/agent-grants.js'
import { resetPolicyForTest } from '../../src/core/vault/policy.js'
import { getConfig, updateConfig } from '../../src/core/config-manager.js'

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
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> }
}
const person = (method: string, p: string, body?: unknown) => http(method, p, body, { 'x-walnut-vault-session': session })
const agent = (method: string, p: string, body?: unknown) => http(method, p, body, AGENT)

const bwExport = (items: unknown[]) => JSON.stringify({ encrypted: false, folders: [], items })
const BW_GIT = { id: 'bw-git', revisionDate: '2026-11-01T00:00:00Z', type: 1, name: 'Git host', login: { username: 'bot@example.test', password: 'git-fake-Pass-1', uris: [{ uri: 'https://git.example.test' }] } }
const BW_NOTE = { id: 'bw-note', revisionDate: '2026-11-01T00:00:00Z', type: 2, name: 'Door code', notes: 'fake-1234' }
const BW_ME = { id: 'bw-me', revisionDate: '2026-11-01T00:00:00Z', type: 4, name: 'Me', identity: { firstName: 'Ada' } }

beforeAll(async () => {
  process.env.WALNUT_TEST_RUN_MARK = '1'
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  resetVaultForTest(null)
  resetSessionsForTest()
  resetAgentStateForTest()
  resetPolicyForTest()
  pwKey = toB64(await derivePasswordKey('a fake modes test master', kdf))
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  session = (await http('POST', '/vault/setup', { passwordKey: pwKey, kdf, client: 'test' })).body.session.token
  for (const item of [
    { type: 'login', title: 'Git host', username: 'bot@example.test', password: 'git-fake-Pass-1', urls: ['git.example.test'] },
    { type: 'login', title: 'Payroll', password: 'pay-fake-Pass', urls: ['payroll.example.test'], sensitive: true },
    { type: 'login', title: 'Bank', password: 'bank-fake-Pass', urls: ['bank.example.test'], agentAccess: 'never' },
  ]) ids[item.title] = (await person('POST', '/vault/items', { item })).body.item.id
}, 120_000)

afterAll(async () => {
  await stopServer()
  delete process.env.WALNUT_TEST_RUN_MARK
})

describe('the new defaults', () => {
  it('a fresh vault is Any with 48-hour grants, and stays unlocked 48 hours (older clients still get minutes)', async () => {
    expect((await person('GET', '/vault/agent/policy')).body).toMatchObject({ agents: 'allow', grantMs: 172_800_000, grants: [] })
    const st = (await person('GET', '/vault/status')).body
    expect(st).toMatchObject({ unlocked: true, unlockFor: '48h', lockAfterIdleMinutes: null, autoLockMinutes: 2880 })
    // Both written down by the setup, never read from a default (a missing one keeps the old ask and idle lock).
    expect((await getConfig()).passwords?.unlock_for).toBe('48h')
    expect(await fsp.stat(`${WALNUT_HOME}/vault/policy.json`).then(() => true, () => false)).toBe(true)
  })

  it('Any: an agent lists and uses at once, a reveal logged as shown; a sensitive item still asks; never stays never', async () => {
    expect((await agent('GET', '/vault/agent/items')).body.items.map((i: { title: string }) => i.title).sort()).toEqual(['Git host', 'Payroll'])
    const r = await agent('POST', '/vault/agent/use', { item: 'Git host', purpose: 'sign in to the test git host', use: 'reveal' })
    expect(r.body).toMatchObject({ status: 'released', via: 'allow', values: { password: 'git-fake-Pass-1' } })
    const env = await agent('POST', '/vault/agent/use', { item: 'Git host', purpose: 'push with the CLI', use: 'env', command: 'git push' })
    expect(env.body.status).toBe('released')
    const sensitive = await agent('POST', '/vault/agent/use', { item: 'Payroll', purpose: 'read the payslip' })
    expect(sensitive.body).toMatchObject({ status: 'pending' })
    await agent('POST', `/vault/agent/use/${sensitive.body.requestId}/cancel`, { token: sensitive.body.waitToken })
    expect((await agent('POST', '/vault/agent/use', { item: 'Bank', purpose: 'check the balance' })).body.code).toBe('agent_never')
    const log = (await person('GET', '/vault/agent/log')).body.entries as Array<{ kind: string; use?: string; command?: string }>
    expect(log.find((e) => e.kind === 'released' && e.use === 'env')).toMatchObject({ command: 'git push' })
    expect(log.find((e) => e.kind === 'released' && e.use === 'reveal')).toBeTruthy()
    expect(log.find((e) => e.kind === 'listed')).toMatchObject({ use: 'list', count: 2 })
    expect(JSON.stringify(log)).not.toMatch(/git-fake-Pass|pay-fake/)
  })

  it('the grant length is the person\'s, and only theirs', async () => {
    expect((await person('PUT', '/vault/agent/policy', { grantMs: 3_600_000 })).body).toMatchObject({ agents: 'allow', grantMs: 3_600_000 })
    expect((await person('PUT', '/vault/agent/policy', { grantMs: 999 })).body.grantMs).toBe(172_800_000)
    expect((await person('PUT', '/vault/agent/policy', { grantMs: -1 })).body.grantMs).toBe(-1)
    expect((await http('PUT', '/vault/agent/policy', { grantMs: 0 }, { ...AGENT, 'x-walnut-vault-session': session })).body.code).toBe('human_only')
    // Moving only the grant length leaves the switch as it was.
    expect((await person('GET', '/vault/agent/policy')).body.agents).toBe('allow')
  })
})

describe('grants in Agent Activity', () => {
  const grant = (itemId: string) => putGrant({
    holder: 'task:t-e2e|s-e2e|devbox', itemId, until: Infinity, fields: ['password'], grantedAt: Date.now(),
    asker: 'task:t-e2e', host: 'devbox', taskId: 't-e2e', taskTitle: 'Deploy the test app', sessionId: 's-e2e', itemTitle: 'Git host', approvedBy: 'iPhone',
  })

  it('a grant is listed with who holds it, and the person revokes it by its id', async () => {
    grant(ids['Git host'])
    const g = (await person('GET', '/vault/agent/policy')).body.grants
    expect(g).toHaveLength(1)
    expect(g[0]).toMatchObject({ itemId: ids['Git host'], until: null, taskTitle: 'Deploy the test app', approvedBy: 'iPhone' })
    expect((await agent('POST', `/vault/agent/grants/${g[0].id}/revoke`)).body.code).toBe('human_only')
    expect((await person('POST', `/vault/agent/grants/${g[0].id}/revoke`)).body.revoked).toMatchObject({ id: g[0].id })
    expect((await person('POST', `/vault/agent/grants/${g[0].id}/revoke`)).status).toBe(404)
    expect((await person('GET', '/vault/agent/policy')).body.grants).toEqual([])
    // The revoke's log entry is checked in tests/core/vault/agent-grants.test.ts (a grant made
    // here from the test process writes through the test's own module copy).
  })

  it('a new master password ends every grant', async () => {
    grant(ids['Git host'])
    expect((await person('GET', '/vault/agent/policy')).body.grants).toHaveLength(1)
    const newKdf: KdfParams = { name: 'PBKDF2-SHA256', iterations: 600_000, salt: toB64(randomBytes(16)) }
    const newKey = toB64(await derivePasswordKey('a fake modes test master, new', newKdf))
    const r = await person('POST', '/vault/password', { oldPasswordKey: pwKey, newPasswordKey: newKey, kdf: newKdf })
    expect(r.body.ok).toBe(true)
    pwKey = newKey
    expect((await person('GET', '/vault/agent/policy')).body.grants).toEqual([])
  })
})

describe('Bitwarden sync', () => {
  // A stand-in for the Bitwarden CLI: `bw sync` does nothing, `bw export` prints EXPORT_FILE.
  let fakeBwDir = ''
  const setFakeExport = async (items: unknown[]) => { await fsp.writeFile(`${fakeBwDir}/export.json`, bwExport(items)) }
  beforeAll(async () => {
    fakeBwDir = await fsp.mkdtemp(`${WALNUT_HOME}-fake-bw-`)
    await fsp.writeFile(`${fakeBwDir}/bw`, `#!/bin/sh\nif [ "$1" = export ]; then cat "${fakeBwDir}/export.json"; fi\nexit 0\n`, { mode: 0o755 })
    process.env.WALNUT_BW_PATH = `${fakeBwDir}/bw`
    process.env.BW_SESSION = 'fake-bw-session'
  })
  afterAll(async () => {
    delete process.env.WALNUT_BW_PATH
    delete process.env.BW_SESSION
    await fsp.rm(fakeBwDir, { recursive: true, force: true })
  })

  it('an agent may not hand Walnut export text, with or without a session token; nothing changes', async () => {
    const r = await agent('POST', '/vault/sync/bitwarden', { export: bwExport([BW_GIT, BW_NOTE, BW_ME]) })
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('export_person_only')
    const withToken = await http('POST', '/vault/sync/bitwarden', { export: bwExport([BW_GIT]) }, { ...AGENT, 'x-walnut-vault-session': session })
    expect(withToken.body.code).toBe('export_person_only')
    // No session at all (a plain local request): not a person's window either.
    expect((await http('POST', '/vault/sync/bitwarden', { export: bwExport([BW_GIT]) })).body.code).toBe('export_person_only')
    expect((await person('GET', '/vault/sync/bitwarden')).body.last ?? null).toBeNull()
  })

  it('an agent triggers the sync and Walnut runs bw itself: the plain item adopted, the rest added', async () => {
    await setFakeExport([BW_GIT, BW_NOTE, BW_ME])
    const r = await agent('POST', '/vault/sync/bitwarden/run', {})
    expect(r.status).toBe(200)
    expect(r.body.report.counts).toEqual({ added: 2, updated: 0, trashed: 0, conflicts: 0, unchanged: 1, ambiguous: 0 })
    expect(r.body.report.bitwarden).toEqual({ login: 1, note: 1, identity: 1 })
    expect(JSON.stringify(r.body)).not.toMatch(/fake-1234|git-fake-Pass/)
    const status = (await person('GET', '/vault/sync/bitwarden')).body
    expect(status).toMatchObject({ daily: false, last: { ok: true, trigger: 'cli' }, summary: '2 added, 0 updated, 0 moved to the trash, 0 conflicts, 1 unchanged' })
    const log = (await person('GET', '/vault/agent/log')).body.entries as Array<{ kind: string; summary?: string }>
    expect(log[0]).toMatchObject({ kind: 'synced', summary: expect.stringContaining('2 added') })
  })

  it('a sync that would trash many items is not run; an agent\'s allowMassTrash counts for nothing, a person\'s does', async () => {
    const extra = Array.from({ length: 6 }, (_, i) => ({ id: `bw-x${i}`, revisionDate: '2026-11-01T00:00:00Z', type: 2, name: `Extra ${i}`, notes: `fake-x${i}` }))
    await setFakeExport([BW_GIT, BW_NOTE, BW_ME, ...extra])
    expect((await agent('POST', '/vault/sync/bitwarden/run', {})).body.report.counts.added).toBe(6)
    await setFakeExport([BW_GIT, BW_NOTE, BW_ME])
    const refused = (await agent('POST', '/vault/sync/bitwarden/run', { allowMassTrash: true })).body
    expect(refused.report).toMatchObject({ ok: false, error: expect.stringContaining('would move 6 of 9') })
    const personNo = await person('POST', '/vault/sync/bitwarden/run', {})
    expect(personNo.status).toBe(409)
    expect(personNo.body.code).toBe('sync_mass_trash')
    expect((await person('POST', '/vault/sync/bitwarden/run', { allowMassTrash: true })).body.report.counts).toMatchObject({ trashed: 6, unchanged: 3 })
  })

  it('walnut pass sync-bitwarden asks Walnut to run the sync now, reading no stdin', async () => {
    await import('../../src/ops/index.js')
    const { executeOp } = await import('../../src/ops/executor.js')
    const { parsePassArgv, runPass, PASS_EXIT } = await import('../../src/core/vault/pass-cli.js')
    const p = parsePassArgv(['sync-bitwarden'])
    if (!p.ok) throw new Error(p.error)
    await setFakeExport([BW_GIT, BW_NOTE])
    let out = ''
    const calls: Array<[string, unknown]> = []
    const code = await runPass(p, {
      call: async (name, args) => { calls.push([name, args]); const r = await executeOp(name, args, { apiBase: `${base}/api/v1`, origin: '__local__', sender: 'vault-test' }); return r.ok ? { ok: true, result: r.result } : { ok: false, message: r.message } },
      say: () => undefined,
      out: (t) => { out += t },
    })
    expect(calls).toEqual([['password_sync_bitwarden', {}]])
    expect(code).toBe(PASS_EXIT.ok)
    // Me is gone from this export: to the trash.
    expect(out).toBe('Synced from Bitwarden: 0 added, 0 updated, 1 moved to the trash, 0 conflicts, 2 unchanged\n')
  })

  it('with agent access Off an agent may not sync; the person still may', async () => {
    await person('PUT', '/vault/agent/policy', { agents: 'off' })
    expect((await agent('POST', '/vault/sync/bitwarden/run', {})).body.code).toBe('agents_off')
    expect((await person('POST', '/vault/sync/bitwarden', { export: bwExport([BW_GIT, BW_NOTE]) })).body.report.trigger).toBe('person')
    expect((await person('POST', '/vault/sync/bitwarden/run', {})).body.report.trigger).toBe('person')
    await person('PUT', '/vault/agent/policy', { agents: 'allow' })
  })

  it('a person\'s export that is not one is a 400', async () => {
    expect((await person('POST', '/vault/sync/bitwarden', { export: '{"x":1}' })).body.code).toBe('bad_import')
  })
})

describe('unlock length and the keychain', () => {
  it('the status reports the choice; a config an older Walnut wrote reads idle minutes', async () => {
    await updateConfig({ passwords: { unlock_for: '1h' } })
    expect((await person('GET', '/vault/status')).body).toMatchObject({ unlockFor: '1h', autoLockMinutes: 60, lockAfterIdleMinutes: null })
    await updateConfig({ passwords: { auto_lock_minutes: 20 } })
    expect((await person('GET', '/vault/status')).body).toMatchObject({ unlockFor: 'idle', autoLockMinutes: 20, lockAfterIdleMinutes: 20 })
    await updateConfig({ passwords: { unlock_for: 'restart' } })
    // A new unlock under "until restart" has no clock.
    const s = (await http('POST', '/vault/unlock', { passwordKey: pwKey })).body.session
    expect(s.expiresAt).toBeNull()
    expect((await http('GET', '/vault/status', undefined, { 'x-walnut-vault-session': s.token })).body).toMatchObject({ unlocked: true, unlockFor: 'restart' })
  })

  it('the keychain unlock has no route: the status of the item only, and removing it needs a vault session', async () => {
    const k = (await http('GET', '/vault/keychain')).body
    expect(k.available).toBe(process.platform === 'darwin')
    expect((await agent('GET', '/vault/keychain')).body.code).toBe('human_only')
    // Nobody unlocks the vault over HTTP with the keychain's copy of the master password.
    for (const caller of [http, agent]) expect((await caller('POST', '/vault/unlock-from-keychain', {})).status).toBe(404)
    expect((await http('DELETE', '/vault/keychain')).status).toBe(401)
  })
})
