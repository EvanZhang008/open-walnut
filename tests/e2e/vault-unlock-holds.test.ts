/**
 * An unlock that holds (docs/reference/passwords.md, "Unlocking") on a real server: a new vault's
 * windows stay unlocked 48 hours after their last use, a Walnut restart on the same data dir keeps
 * them when the vault reopens by itself (this Mac's keychain, stubbed here: child-run.ts) and locks
 * them when it cannot, a window's Lock locks every window while an older client's Lock (no body)
 * still ends only its own, and a quiet status read is no use of the vault. Fake data only.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fsp from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-vault-unlock-holds-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { derivePasswordKey, randomBytes, toB64, type KdfParams } from '../../src/core/vault/crypto.js'
import { resetVaultForTest } from '../../src/core/vault/store.js'
import { setVaultRunnerForTest, type VaultRunner } from '../../src/core/vault/child-run.js'
import { resetKeychainSecretForTest } from '../../src/core/vault/keychain-secret.js'
import { KEYCHAIN_SERVICE, setKeychainPlatformForTest } from '../../src/core/vault/keychain-unlock.js'
import { flushSessionStoreForTest, lastRestoreForTest, simulateRestartForTest } from '../../src/core/vault/session-store.js'

const MASTER = 'a fake holding master 3'
const kdf: KdfParams = { name: 'PBKDF2-SHA256', iterations: 600_000, salt: toB64(randomBytes(16)) }
let pwKey = ''
let base = ''
let keychainHolds: string | null = MASTER
const runner: VaultRunner = async (cmd, args) => {
  if (cmd !== 'security' || !args.includes(KEYCHAIN_SERVICE) || keychainHolds === null) return { code: 44, stdout: '', stderr: '', timedOut: false }
  return { code: 0, stdout: args.includes('-w') ? `${keychainHolds}\n` : 'keychain: "login.keychain-db"\n', stderr: '', timedOut: false }
}

async function http(method: string, p: string, token: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/v1${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-walnut-vault-session': token } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> }
}

async function boot(): Promise<void> {
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** A Walnut restart on the same data dir: the server stops, memory goes, the files stay. */
async function restart(): Promise<void> {
  await flushSessionStoreForTest()
  await stopServer()
  await simulateRestartForTest()
  resetVaultForTest(null)
  resetKeychainSecretForTest()
  await boot()
}

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  resetVaultForTest(null)
  await simulateRestartForTest()
  setVaultRunnerForTest(runner)
  setKeychainPlatformForTest('darwin')
  pwKey = toB64(await derivePasswordKey(MASTER, kdf))
  await boot()
}, 120_000)

afterAll(async () => {
  await flushSessionStoreForTest()
  await stopServer()
  setVaultRunnerForTest(null)
  setKeychainPlatformForTest(null)
})

describe('an unlock that holds', () => {
  let web = ''
  let ext = ''
  let item = ''

  it('a new vault keeps windows unlocked 48 hours after their last use', async () => {
    const r = await http('POST', '/vault/setup', '', { passwordKey: pwKey, kdf, agentsWhileAway: false, client: 'web' })
    expect(r.status).toBe(200)
    web = r.body.session.token
    item = (await http('POST', '/vault/items', web, { item: { type: 'login', title: 'Example', password: 'fake-Pass-1!' } })).body.item.id
    const s = await http('GET', '/vault/status', web)
    expect(s.body).toMatchObject({ unlocked: true, unlockFor: '48h', lockAfterIdleMinutes: null, autoLockMinutes: 2880 })
    ext = (await http('POST', '/vault/unlock', '', { passwordKey: pwKey, client: 'Walnut extension' })).body.session.token
    expect(ext).toBeTruthy()
  }, 60_000)

  it('a Walnut restart keeps every window unlocked when the keychain reopens the vault', async () => {
    await restart()
    const s = await http('GET', '/vault/status', web)
    expect(lastRestoreForTest()).toBe('restored')
    expect(s.body).toMatchObject({ open: true, unlocked: true })
    expect((await http('GET', `/vault/items/${item}`, web)).body.item.password).toBe('fake-Pass-1!')
    expect((await http('GET', '/vault/items', ext)).status).toBe(200)
  }, 120_000)

  it('an older client\'s Lock (no body) ends only its own window; a window\'s Lock ends every one', async () => {
    const third = (await http('POST', '/vault/unlock', '', { passwordKey: pwKey, client: 'old client' })).body.session.token
    expect((await http('POST', '/vault/lock', third, {})).body.ended).toBe(1)
    expect((await http('GET', '/vault/status', third)).body.unlocked).toBe(false)
    expect((await http('GET', '/vault/status', web)).body.unlocked).toBe(true)
    const r = await http('POST', '/vault/lock', ext, { everywhere: true })
    expect(r.body.ended).toBe(2)
    expect((await http('GET', '/vault/status', web)).body).toMatchObject({ unlocked: false, open: false })
    expect((await http('GET', '/vault/items', web)).status).toBe(401)
    // And for the next start too.
    await restart()
    expect((await http('GET', '/vault/status', web)).body.unlocked).toBe(false)
    expect(lastRestoreForTest()).toBe('none')
  }, 120_000)

  it('a restart with no way to reopen the vault leaves every window locked', async () => {
    web = (await http('POST', '/vault/unlock', '', { passwordKey: pwKey, client: 'web' })).body.session.token
    keychainHolds = null
    try {
      await restart()
      expect((await http('GET', '/vault/status', web)).body).toMatchObject({ unlocked: false, open: false })
      expect(lastRestoreForTest()).toBe('cannot_reopen')
      expect((await http('GET', '/vault/items', web)).status).toBe(401)
    } finally {
      keychainHolds = MASTER
    }
  }, 120_000)

  it('a Lock has written the file before it answers', async () => {
    web = (await http('POST', '/vault/unlock', '', { passwordKey: pwKey, client: 'web' })).body.session.token
    await flushSessionStoreForTest()
    const file = `${await (await import('../../src/core/vault/state.js')).dir()}/sessions.json`
    const kept = async () => JSON.parse(await fsp.readFile(file, 'utf8')).sessions.length
    expect(await kept()).toBeGreaterThan(0)
    await http('POST', '/vault/lock', web, { everywhere: true })
    expect(await kept()).toBe(0) // no flush: the answer came after the write
  }, 60_000)

  it('agents-while-away turned off (a new vault key) still restores the windows after a restart', async () => {
    web = (await http('POST', '/vault/unlock', '', { passwordKey: pwKey, client: 'web' })).body.session.token
    expect((await http('POST', '/vault/settings', web, { agentsWhileAway: true, passwordKey: pwKey })).status).toBe(200)
    expect((await http('POST', '/vault/settings', web, { agentsWhileAway: false, passwordKey: pwKey })).status).toBe(200)
    await restart()
    expect((await http('GET', '/vault/status', web)).body.unlocked).toBe(true)
    expect(lastRestoreForTest()).toBe('restored')
    await http('POST', '/vault/lock', web, { everywhere: true })
  }, 120_000)

  it('a quiet status read does not count as use', async () => {
    web = (await http('POST', '/vault/unlock', '', { passwordKey: pwKey, client: 'web' })).body.session.token
    const sessions = await import('../../src/core/vault/sessions.js')
    const before = sessions.sessionList()[0].lastUsedAt
    await new Promise((r) => setTimeout(r, 20))
    expect((await http('GET', '/vault/status', web, undefined, { 'x-walnut-vault-quiet': '1' })).body.unlocked).toBe(true)
    expect(sessions.sessionList()[0].lastUsedAt).toBe(before)
    await http('GET', '/vault/status', web)
    expect(sessions.sessionList()[0].lastUsedAt).toBeGreaterThan(before)
  }, 60_000)
})
