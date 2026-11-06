/**
 * One unlock on the computer Walnut runs on, the other way round (docs/reference/passwords.md,
 * "One unlock on this computer"): a locked Walnut window here (the /passwords page, the Mac app's
 * page) shares an unlock the person made in the extension or another window, with no password,
 * on the same clocks. A page and a local process look the same to Walnut, so a window shares only
 * with the browser key it got when the person typed the master password in it: no key, a forged
 * one, a script, a session, a proxied request, another origin or a paired device share nothing; a
 * window that locked only itself shares nothing until the person unlocks again; a Lock ends all.
 * Fake data only.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-vault-window-join-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { derivePasswordKey, randomBytes, toB64, type KdfParams } from '../../src/core/vault/crypto.js'
import { resetVaultForTest } from '../../src/core/vault/store.js'
import { dir as vaultDir } from '../../src/core/vault/state.js'
import { setVaultRunnerForTest, type VaultRunner } from '../../src/core/vault/child-run.js'
import { resetKeychainSecretForTest } from '../../src/core/vault/keychain-secret.js'
import { KEYCHAIN_SERVICE, setKeychainPlatformForTest } from '../../src/core/vault/keychain-unlock.js'
import { flushSessionStoreForTest, lastRestoreForTest, simulateRestartForTest } from '../../src/core/vault/session-store.js'
import { resetBrowserKeysForTest } from '../../src/core/vault/browser-keys.js'
import { createDeviceAs } from '../../src/core/device-auth.js'
import { LOCAL_ACTOR } from '../../src/core/device-actor.js'

const MASTER = 'a fake window master 8'
const kdf: KdfParams = { name: 'PBKDF2-SHA256', iterations: 600_000, salt: toB64(randomBytes(16)) }
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
let pwKey = ''
let base = ''
/** What the stubbed keychain holds (it reopens the vault after a restart). */
let keychainPassword = MASTER
const runner: VaultRunner = async (cmd, args) => {
  if (cmd !== 'security' || !args.includes(KEYCHAIN_SERVICE)) return { code: 44, stdout: '', stderr: '', timedOut: false }
  return { code: 0, stdout: args.includes('-w') ? `${keychainPassword}\n` : 'keychain: "login.keychain-db"\n', stderr: '', timedOut: false }
}

interface Caller { device?: string; origin?: string; key?: string; headers?: Record<string, string> }

async function http(method: string, p: string, token: string, body?: unknown, who: Caller = {}) {
  const res = await fetch(`${base}/api/v1${p}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-walnut-vault-session': token } : {}),
      ...(who.device ? { authorization: `Bearer ${who.device}` } : {}),
      ...(who.origin ? { origin: who.origin } : {}),
      ...(who.key ? { 'x-walnut-vault-browser': who.key } : {}),
      ...who.headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> }
}

async function boot(): Promise<void> {
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function restart(): Promise<void> {
  await flushSessionStoreForTest()
  await stopServer()
  await simulateRestartForTest()
  resetVaultForTest(null)
  resetKeychainSecretForTest()
  resetBrowserKeysForTest()
  await boot()
}

/** A Walnut window on this computer holding `key` (a POST carries its Origin; a GET of its own page none). */
const win = (key?: string): Caller => ({ origin: base, ...(key ? { key } : {}) })
const winGet = (key?: string): Caller => (key ? { key } : {})
let ext: Caller
let browser: Caller
let item = ''
let keyA = ''
let keyB = ''

/** The extension unlocks with the master password (its own unlock, made here: it sends its Origin). */
async function unlockInExtension(): Promise<string> {
  const r = await http('POST', '/vault/unlock', '', { passwordKey: pwKey, client: 'Walnut extension' }, ext)
  expect(r.status).toBe(200)
  return r.body.session.token
}

async function unlockInExtensionWith(passwordKey: string): Promise<string> {
  const r = await http('POST', '/vault/unlock', '', { passwordKey, client: 'Walnut extension' }, ext)
  expect(r.status).toBe(200)
  return r.body.session.token
}

async function lockAll(token = ''): Promise<void> {
  await http('POST', '/vault/lock', token, { everywhere: true }, win())
}

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  resetVaultForTest(null)
  await simulateRestartForTest()
  resetBrowserKeysForTest()
  setVaultRunnerForTest(runner)
  setKeychainPlatformForTest('darwin')
  pwKey = toB64(await derivePasswordKey(MASTER, kdf))
  await boot()
  ext = { device: (await createDeviceAs('extension-a1b2c3', { by: LOCAL_ACTOR, extension: true })).token, origin: EXT_ORIGIN }
  browser = { device: (await createDeviceAs('browser-0a0b0c', { by: LOCAL_ACTOR })).token, origin: base }
}, 120_000)

afterAll(async () => {
  await flushSessionStoreForTest()
  await stopServer()
  setVaultRunnerForTest(null)
  setKeychainPlatformForTest(null)
})

describe('a Walnut window here shares an unlock made in the extension', () => {
  it('a window the person typed the master password in gets a browser key; a script and the extension do not', async () => {
    const made = await http('POST', '/vault/setup', '', { passwordKey: pwKey, kdf, agentsWhileAway: false, client: 'Walnut web' }, win())
    expect(made.status).toBe(200)
    keyA = made.body.browserKey
    expect(keyA).toMatch(/^[A-Za-z0-9_-]{43}$/)
    item = (await http('POST', '/vault/items', made.body.session.token, { item: { type: 'login', title: 'Example', password: 'fake-Pass-9!' } })).body.item.id
    // The same browser unlocking again keeps its key.
    const again = await http('POST', '/vault/unlock', '', { passwordKey: pwKey, client: 'Walnut web' }, win(keyA))
    expect(again.body.browserKey).toBe(keyA)
    // A second browser (no key yet) gets its own.
    keyB = (await http('POST', '/vault/unlock', '', { passwordKey: pwKey, client: 'Walnut web' }, win())).body.browserKey
    expect(keyB).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(keyB).not.toBe(keyA)
    expect((await http('POST', '/vault/unlock', '', { passwordKey: pwKey, client: 'script' })).body.browserKey).toBeUndefined()
    expect((await http('POST', '/vault/unlock', '', { passwordKey: pwKey, client: 'ext' }, ext)).body.browserKey).toBeUndefined()
    // Only its hash is kept, sealed beside the vault.
    const file = await fsp.readFile(path.join(await vaultDir(), 'browsers.json'), 'utf8')
    expect(file).not.toContain(keyA)
    expect(file).not.toContain(crypto.createHash('sha256').update(`walnut-vault-browser\0${keyA}`).digest('hex'))
    await lockAll()
  }, 120_000)

  it('nothing to share while Passwords is locked', async () => {
    expect((await http('GET', '/vault/status', '', undefined, winGet(keyA))).body.canJoin).toBeUndefined()
    expect((await http('POST', '/vault/join', '', {}, win(keyA))).body.code).toBe('nothing_to_join')
  }, 60_000)

  it('an unlock in the extension lets a locked window share it, with no password, on the same clocks', async () => {
    await unlockInExtension()
    const st = await http('GET', '/vault/status', '', undefined, winGet(keyA))
    expect(st.body).toMatchObject({ unlocked: false, canJoin: true })
    const j = await http('POST', '/vault/join', '', { client: 'Walnut web' }, win(keyA))
    expect(j.status).toBe(200)
    const token = j.body.session.token
    expect((await http('GET', `/vault/items/${item}`, token, undefined, winGet(keyA))).body.item.password).toBe('fake-Pass-9!')
    expect((await http('GET', '/vault/status', token, undefined, winGet(keyA))).body.unlocked).toBe(true)
    const list = (await import('../../src/core/vault/sessions.js')).sessionList()
    const src = list.find((s) => s.here && s.device === 'extension-a1b2c3')!
    const copy = list.find((s) => s.source === src.hash)!
    expect([copy.createdAt, copy.idleMs, copy.maxMs]).toEqual([src.createdAt, src.idleMs, src.maxMs])
    expect(copy.device).toBeUndefined()
  }, 60_000)

  it('nothing else shares: no key, a forged key, a script, a session, a proxy, another origin, a paired device', async () => {
    const forged = crypto.randomBytes(32).toString('base64url')
    /** Refused, by the vault route or before it (auth, the person gate): no session either way. */
    const refused = (r: { status: number; body: Record<string, any> }) => {
      expect(r.status).toBeGreaterThanOrEqual(400)
      expect(r.body.session).toBeUndefined()
    }
    expect((await http('GET', '/vault/status', '', undefined, winGet())).body.canJoin).toBeUndefined()
    expect((await http('POST', '/vault/join', '', {}, win())).body.code).toBe('join_refused')
    expect((await http('GET', '/vault/status', '', undefined, winGet(forged))).body.canJoin).toBeUndefined()
    expect((await http('POST', '/vault/join', '', {}, win(forged))).body.code).toBe('join_refused')
    // A POST with no Origin is no window, whatever key it carries.
    expect((await http('POST', '/vault/join', '', {}, { key: keyA })).body.code).toBe('join_refused')
    // Through a proxy (a request from elsewhere).
    refused(await http('POST', '/vault/join', '', {}, { ...win(keyA), headers: { 'x-forwarded-for': '203.0.113.9' } }))
    expect((await http('GET', '/vault/status', '', undefined, { ...winGet(keyA), headers: { 'x-forwarded-for': '203.0.113.9' } })).body.canJoin).toBeUndefined()
    // A session (an agent) holding a window's key.
    expect((await http('POST', '/vault/join', '', {}, { ...win(keyA), headers: { 'x-walnut-caller-sid': 'sess-123' } })).status).toBe(403)
    // Another site on this computer (a dev server on another port) is not Walnut's window.
    refused(await http('POST', '/vault/join', '', {}, { origin: 'http://127.0.0.1:5999', key: keyA }))
    // A paired device (a browser elsewhere signed in) carrying a window's key.
    refused(await http('POST', '/vault/join', '', {}, { ...browser, key: keyA }))
    expect((await http('GET', '/vault/status', '', undefined, { ...browser, key: keyA })).body.canJoin).toBeUndefined()
  }, 60_000)

  it('a window that locked only itself shares nothing until the person unlocks again; another window still may', async () => {
    const mine = (await http('POST', '/vault/join', '', {}, win(keyA))).body.session.token
    await new Promise((r) => setTimeout(r, 5))
    await http('POST', '/vault/lock', mine, {}, win(keyA)) // its own auto-lock: this browser only
    expect((await http('GET', '/vault/status', '', undefined, winGet(keyA))).body.canJoin).toBeUndefined()
    expect((await http('POST', '/vault/join', '', {}, win(keyA))).body.code).toBe('nothing_to_join')
    expect((await http('GET', '/vault/status', '', undefined, winGet(keyB))).body.canJoin).toBe(true)
    // A Walnut restart keeps the browser keys (sealed in browsers.json) and that window's own lock.
    await restart()
    expect((await http('GET', '/vault/status', '', undefined, winGet(keyA))).body.canJoin).toBeUndefined()
    expect(lastRestoreForTest()).toBe('restored')
    expect((await http('GET', '/vault/status', '', undefined, winGet(keyB))).body.canJoin).toBe(true)
    // The person unlocks again (in the extension): the window shares that one.
    await new Promise((r) => setTimeout(r, 5))
    await unlockInExtension()
    expect((await http('POST', '/vault/join', '', {}, win(keyA))).status).toBe(200)
  }, 120_000)

  it('a person\'s Lock ends the shared windows with the rest, and nothing is left to share', async () => {
    const shared = (await http('POST', '/vault/join', '', {}, win(keyB))).body.session.token
    await http('POST', '/vault/lock', shared, { everywhere: true }, win(keyB))
    expect((await http('GET', '/vault/items', shared, undefined, winGet(keyB))).body.code).toBe('vault_session_needed')
    expect((await http('GET', '/vault/status', '', undefined, ext)).body.unlocked).toBe(false)
    expect((await http('GET', '/vault/status', '', undefined, winGet(keyB))).body.canJoin).toBeUndefined()
  }, 60_000)

  it('a browsers.json written by something that cannot open the vault counts for nothing', async () => {
    await unlockInExtension()
    const hash = crypto.createHash('sha256').update(`walnut-vault-browser\0${keyB}`).digest('hex')
    await fsp.writeFile(path.join(await vaultDir(), 'browsers.json'), JSON.stringify({ version: 1, browsers: [{ hash, at: Date.now() }] }))
    resetBrowserKeysForTest()
    expect((await http('GET', '/vault/status', '', undefined, winGet(keyB))).body.canJoin).toBeUndefined()
    expect((await http('POST', '/vault/join', '', {}, win(keyB))).body.code).toBe('join_refused')
    await lockAll()
  }, 60_000)
})

describe('a new master password or a recovery shares nothing from before', () => {
  const kdf2: KdfParams = { name: 'PBKDF2-SHA256', iterations: 600_000, salt: toB64(randomBytes(16)) }
  const kdf3: KdfParams = { name: 'PBKDF2-SHA256', iterations: 600_000, salt: toB64(randomBytes(16)) }
  let pwKey2 = ''
  let pwKey3 = ''
  let recoveryCode = ''
  const tick = () => new Promise((r) => setTimeout(r, 5))

  it('a password change ends every other browser\'s key and every share of an unlock from before', async () => {
    pwKey2 = toB64(await derivePasswordKey('a fake second master 9', kdf2))
    pwKey3 = toB64(await derivePasswordKey('a fake third master 10', kdf3))
    // Both browsers let in again (the planted file above forgot them), then A unlocks and B and the extension share it.
    const a = await http('POST', '/vault/unlock', '', { passwordKey: pwKey, client: 'Walnut web' }, win(keyA))
    keyA = a.body.browserKey
    const aToken = a.body.session.token
    keyB = (await http('POST', '/vault/unlock', '', { passwordKey: pwKey, client: 'Walnut web' }, win(keyB))).body.browserKey
    await http('POST', '/vault/lock', '', {}, win()) // nothing: B's own unlock is not needed
    const bShared = (await http('POST', '/vault/join', '', {}, win(keyB))).body.session.token
    const extShared = (await http('POST', '/vault/join', '', {}, ext)).body.session.token
    expect(bShared).toBeTruthy()
    expect(extShared).toBeTruthy()

    const changed = await http('POST', '/vault/password', aToken, { oldPasswordKey: pwKey, newPasswordKey: pwKey2, kdf: kdf2 }, win(keyA))
    expect(changed.status).toBe(200)
    expect(changed.body.otherWindowsLocked).toBeGreaterThanOrEqual(2)
    recoveryCode = changed.body.recoveryKit?.recoveryCode ?? ''
    // The window that changed it keeps its unlock and gets a new key; the old one counts for nothing.
    expect(changed.body.browserKey).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(changed.body.browserKey).not.toBe(keyA)
    expect((await http('GET', `/vault/items/${item}`, aToken, undefined, winGet(changed.body.browserKey))).status).toBe(200)
    const oldA = keyA
    keyA = changed.body.browserKey

    // B (still holding its old key) and the extension: no share of A's unlock, made with the old password.
    expect((await http('GET', '/vault/items', bShared, undefined, winGet(keyB))).body.code).toBe('vault_session_needed')
    expect((await http('GET', '/vault/status', '', undefined, winGet(keyB))).body.canJoin).toBeUndefined()
    expect((await http('POST', '/vault/join', '', {}, win(keyB))).body.code).toBe('join_refused')
    expect((await http('GET', '/vault/status', '', undefined, winGet(oldA))).body.canJoin).toBeUndefined()
    expect((await http('GET', '/vault/items', extShared, undefined, ext)).body.code).toBe('vault_session_needed')
    expect((await http('GET', '/vault/status', '', undefined, ext)).body.canJoin).toBeUndefined()
    expect((await http('POST', '/vault/join', '', {}, ext)).body.code).toBe('nothing_to_join')

    // A restart keeps that: A's unlock is still not shared.
    keychainPassword = 'a fake second master 9'
    await restart()
    expect((await http('GET', '/vault/status', '', undefined, ext)).body.canJoin).toBeUndefined()
    expect(lastRestoreForTest()).toBe('restored')
    expect((await http('POST', '/vault/join', '', {}, ext)).body.code).toBe('nothing_to_join')
    expect((await http('POST', '/vault/join', '', {}, win(keyB))).body.code).toBe('join_refused')
  }, 180_000)

  it('an unlock typed with the new password is shared again; B shares only after it types the new one once', async () => {
    await tick()
    await unlockInExtensionWith(pwKey2)
    expect((await http('GET', '/vault/status', '', undefined, winGet(keyB))).body.canJoin).toBeUndefined()
    expect((await http('POST', '/vault/join', '', {}, win(keyB))).body.code).toBe('join_refused')
    // The old password no longer unlocks, so B cannot get a key with it.
    expect((await http('POST', '/vault/unlock', '', { passwordKey: pwKey, client: 'Walnut web' }, win(keyB))).body.browserKey).toBeUndefined()
    const b = await http('POST', '/vault/unlock', '', { passwordKey: pwKey2, client: 'Walnut web' }, win(keyB))
    expect(b.body.browserKey).toMatch(/^[A-Za-z0-9_-]{43}$/)
    keyB = b.body.browserKey
    await http('POST', '/vault/lock', b.body.session.token, {}, win()) // that window's unlock goes; the extension's stays
    await tick()
    await unlockInExtensionWith(pwKey2)
    expect((await http('GET', '/vault/status', '', undefined, winGet(keyB))).body.canJoin).toBe(true)
    expect((await http('POST', '/vault/join', '', {}, win(keyB))).status).toBe(200)
    await lockAll()
  }, 120_000)

  it('a recovery ends every browser key and every share from before; its own new unlock is shared', async () => {
    expect(recoveryCode).toBeTruthy()
    await unlockInExtensionWith(pwKey2)
    expect((await http('POST', '/vault/join', '', {}, win(keyB))).status).toBe(200)
    await tick()
    const rec = await http('POST', '/vault/recover', '', { recoveryCode, newPasswordKey: pwKey3, kdf: kdf3 }, win())
    expect(rec.status).toBe(200)
    expect(rec.body.browserKey).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // B's key is gone: it shares nothing, though the recovery's unlock is live.
    expect((await http('GET', '/vault/status', '', undefined, winGet(keyB))).body.canJoin).toBeUndefined()
    expect((await http('POST', '/vault/join', '', {}, win(keyB))).body.code).toBe('join_refused')
    // The recovering window's new key, and the extension, share the recovery's own unlock.
    expect((await http('GET', '/vault/status', '', undefined, ext)).body.canJoin).toBe(true)
    expect((await http('POST', '/vault/join', '', {}, ext)).status).toBe(200)
    await lockAll()
  }, 120_000)
})

