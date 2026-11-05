/**
 * One unlock on the computer Walnut runs on (docs/reference/passwords.md, "Unlocking"): the
 * browser extension on this computer, locked while the person has Passwords unlocked here, shares
 * that unlock with no password (POST /vault/join), on the same clocks, and nothing else may: no
 * other device, no proxied or session request, nothing after a Lock, nothing after the extension
 * locked only itself until the person unlocks again. A Walnut restart keeps what may be shared.
 * Fake data only.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fsp from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-vault-join-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { derivePasswordKey, randomBytes, toB64, type KdfParams } from '../../src/core/vault/crypto.js'
import { resetVaultForTest } from '../../src/core/vault/store.js'
import { setVaultRunnerForTest, type VaultRunner } from '../../src/core/vault/child-run.js'
import { resetKeychainSecretForTest } from '../../src/core/vault/keychain-secret.js'
import { KEYCHAIN_SERVICE, setKeychainPlatformForTest } from '../../src/core/vault/keychain-unlock.js'
import { flushSessionStoreForTest, lastRestoreForTest, simulateRestartForTest } from '../../src/core/vault/session-store.js'
import { createDeviceAs } from '../../src/core/device-auth.js'
import { LOCAL_ACTOR } from '../../src/core/device-actor.js'

const MASTER = 'a fake shared master 7'
const kdf: KdfParams = { name: 'PBKDF2-SHA256', iterations: 600_000, salt: toB64(randomBytes(16)) }
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
let pwKey = ''
let base = ''
// The keychain stub only reopens the vault after a restart (the windows it kept).
const runner: VaultRunner = async (cmd, args) => {
  if (cmd !== 'security' || !args.includes(KEYCHAIN_SERVICE)) return { code: 44, stdout: '', stderr: '', timedOut: false }
  return { code: 0, stdout: args.includes('-w') ? `${MASTER}\n` : 'keychain: "login.keychain-db"\n', stderr: '', timedOut: false }
}

interface Caller { device?: string; origin?: string; headers?: Record<string, string> }

async function http(method: string, p: string, token: string, body?: unknown, who: Caller = {}) {
  const res = await fetch(`${base}/api/v1${p}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-walnut-vault-session': token } : {}),
      ...(who.device ? { authorization: `Bearer ${who.device}` } : {}),
      ...(who.origin ? { origin: who.origin } : {}),
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
  await boot()
}

/** A Walnut window on this computer: its own origin. */
const page = (): Caller => ({ origin: base })
let ext: Caller
let ext2: Caller
let browser: Caller

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  resetVaultForTest(null)
  await simulateRestartForTest()
  setVaultRunnerForTest(runner)
  setKeychainPlatformForTest('darwin')
  pwKey = toB64(await derivePasswordKey(MASTER, kdf))
  await boot()
  ext = { device: (await createDeviceAs('extension-a1b2c3', { by: LOCAL_ACTOR, extension: true })).token, origin: EXT_ORIGIN }
  ext2 = { device: (await createDeviceAs('extension-d4e5f6', { by: LOCAL_ACTOR, extension: true })).token, origin: EXT_ORIGIN }
  browser = { device: (await createDeviceAs('browser-0a0b0c', { by: LOCAL_ACTOR })).token, origin: EXT_ORIGIN }
}, 120_000)

afterAll(async () => {
  await flushSessionStoreForTest()
  await stopServer()
  setVaultRunnerForTest(null)
  setKeychainPlatformForTest(null)
})

describe('one unlock on this computer, shared with its extension', () => {
  let web = ''
  let item = ''
  let joined = ''

  it('nothing to share while Passwords is locked', async () => {
    const made = await http('POST', '/vault/setup', '', { passwordKey: pwKey, kdf, agentsWhileAway: false, client: 'web' })
    expect(made.status).toBe(200)
    item = (await http('POST', '/vault/items', made.body.session.token, { item: { type: 'login', title: 'Example', password: 'fake-Pass-9!' } })).body.item.id
    await http('POST', '/vault/lock', made.body.session.token, { everywhere: true })
    const st = await http('GET', '/vault/status', '', undefined, ext)
    expect(st.body.unlocked).toBe(false)
    expect(st.body.canJoin).toBeUndefined()
    expect((await http('POST', '/vault/join', '', {}, ext)).body.code).toBe('nothing_to_join')
  }, 60_000)

  it('a Walnut window unlocking here lets the extension share it, with no password', async () => {
    web = (await http('POST', '/vault/unlock', '', { passwordKey: pwKey, client: 'web' }, page())).body.session.token
    const st = await http('GET', '/vault/status', '', undefined, ext)
    expect(st.body).toMatchObject({ unlocked: false, canJoin: true })
    const j = await http('POST', '/vault/join', '', { client: 'Walnut extension' }, ext)
    expect(j.status).toBe(200)
    joined = j.body.session.token
    expect(joined).toBeTruthy()
    expect(joined).not.toBe(web)
    expect((await http('GET', `/vault/items/${item}`, joined, undefined, ext)).body.item.password).toBe('fake-Pass-9!')
    expect((await http('GET', '/vault/status', joined, undefined, ext)).body).toMatchObject({ unlocked: true })
  }, 60_000)

  it('the shared session is the extension\'s alone and never outlasts the unlock it shares', async () => {
    // Another device presenting it: refused (and it ends, as any session another device presents).
    expect((await http('GET', '/vault/items', joined, undefined, ext2)).status).toBe(401)
    const again = (await http('POST', '/vault/join', '', {}, ext)).body.session
    const own = (await import('../../src/core/vault/sessions.js')).sessionList()
    const src = own.find((s) => s.here && !s.device)!
    const copy = own.find((s) => s.device === 'extension-a1b2c3')!
    expect(copy.createdAt).toBe(src.createdAt)
    expect(copy.maxMs).toBe(src.maxMs)
    expect(copy.here).toBeUndefined() // a shared session is shared from, never shared on
    expect(again.token).toBeTruthy()
    joined = again.token
  }, 60_000)

  it('a script\'s unlock (no Origin: not a window) is not shared', async () => {
    await http('POST', '/vault/lock', web, { everywhere: true })
    const script = (await http('POST', '/vault/unlock', '', { passwordKey: pwKey, client: 'script' })).body.session.token
    expect(script).toBeTruthy()
    expect((await http('GET', '/vault/status', '', undefined, ext)).body.canJoin).toBeUndefined()
    expect((await http('POST', '/vault/join', '', {}, ext)).body.code).toBe('nothing_to_join')
    await http('POST', '/vault/lock', script, { everywhere: true })
    web = (await http('POST', '/vault/unlock', '', { passwordKey: pwKey, client: 'web' }, page())).body.session.token
    joined = (await http('POST', '/vault/join', '', {}, ext)).body.session.token
    expect(joined).toBeTruthy()
  }, 60_000)

  it('only this computer\'s extension may share: no other device, page, session or proxied request', async () => {
    expect((await http('POST', '/vault/join', '', {}, browser)).body.code).toBe('join_refused')
    expect((await http('POST', '/vault/join', '', {})).body.code).toBe('join_refused')
    expect((await http('POST', '/vault/join', '', {}, { ...ext, headers: { 'x-forwarded-for': '203.0.113.9' } })).body.code).toBe('join_refused')
    expect((await http('POST', '/vault/join', '', {}, { ...ext, headers: { 'x-walnut-caller-sid': 'sess-123' } })).status).toBe(403)
    const st = await http('GET', '/vault/status', '', undefined, browser)
    expect(st.body.canJoin).toBeUndefined()
  }, 60_000)

  it('a Walnut restart keeps what may be shared', async () => {
    await restart()
    expect((await http('GET', '/vault/items', joined, undefined, ext)).status).toBe(200)
    expect(lastRestoreForTest()).toBe('restored')
    expect((await http('GET', '/vault/status', '', undefined, ext2)).body).toMatchObject({ unlocked: false, canJoin: true })
  }, 120_000)

  it('an extension that locked only itself shares nothing until the person unlocks again', async () => {
    await http('POST', '/vault/lock', joined, {}, ext) // its own auto-lock: this browser only
    expect((await http('GET', '/vault/status', '', undefined, ext)).body.canJoin).toBeUndefined()
    expect((await http('POST', '/vault/join', '', {}, ext)).body.code).toBe('nothing_to_join')
    // The other extension was not the one that locked.
    expect((await http('GET', '/vault/status', '', undefined, ext2)).body.canJoin).toBe(true)
    // A Walnut restart keeps that record with the windows (signed in sessions.json).
    await restart()
    expect((await http('GET', '/vault/status', '', undefined, ext)).body.canJoin).toBeUndefined()
    expect(lastRestoreForTest()).toBe('restored')
    expect((await http('POST', '/vault/join', '', {}, ext)).body.code).toBe('nothing_to_join')
    expect((await http('GET', '/vault/status', '', undefined, ext2)).body.canJoin).toBe(true)
    await new Promise((r) => setTimeout(r, 5))
    web = (await http('POST', '/vault/unlock', '', { passwordKey: pwKey, client: 'web' }, page())).body.session.token
    expect((await http('POST', '/vault/join', '', {}, ext)).status).toBe(200)
  }, 60_000)

  it('the shared session is one unlock with the window\'s: that window\'s own Lock ends it too', async () => {
    joined = (await http('POST', '/vault/join', '', {}, ext)).body.session.token
    expect((await http('GET', '/vault/items', joined, undefined, ext)).status).toBe(200)
    await http('POST', '/vault/lock', web, {}) // an older client's Lock: that window only
    expect((await http('GET', '/vault/items', joined, undefined, ext)).body.code).toBe('vault_session_needed')
    web = (await http('POST', '/vault/unlock', '', { passwordKey: pwKey, client: 'web' }, page())).body.session.token
  }, 60_000)

  it('a Lock ends the shared sessions with the rest, and nothing is left to share', async () => {
    joined = (await http('POST', '/vault/join', '', {}, ext)).body.session.token
    await http('POST', '/vault/lock', web, { everywhere: true })
    expect((await http('GET', '/vault/items', joined, undefined, ext)).body.code).toBe('vault_session_needed')
    expect((await http('GET', '/vault/status', '', undefined, ext)).body).toMatchObject({ unlocked: false, open: false })
    expect((await http('GET', '/vault/status', '', undefined, ext)).body.canJoin).toBeUndefined()
    expect((await http('POST', '/vault/join', '', {}, ext)).body.code).toBe('nothing_to_join')
  }, 60_000)
})
