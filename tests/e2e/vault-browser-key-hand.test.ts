/**
 * The extension hands the Walnut window beside it its browser key (POST /api/v1/vault/browser-key;
 * docs/reference/passwords.md, "One unlock on this computer"): after an unlock in the extension, the
 * first visit to Walnut's Passwords page in that browser shares it with no master password. Only
 * this computer's paired extension with a live session of its own, of an unlock made here after the
 * last new master password, gets one; a window, a script, another device, a session, a proxied
 * request get nothing. A key Walnut knows comes back as it is; one it forgot is replaced, carrying
 * that window's own lock. Fake data only.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-vault-browser-key-hand-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { derivePasswordKey, randomBytes, toB64, type KdfParams } from '../../src/core/vault/crypto.js'
import { resetVaultForTest } from '../../src/core/vault/store.js'
import { setVaultRunnerForTest } from '../../src/core/vault/child-run.js'
import { setKeychainPlatformForTest } from '../../src/core/vault/keychain-unlock.js'
import { flushSessionStoreForTest, simulateRestartForTest } from '../../src/core/vault/session-store.js'
import { resetBrowserKeysForTest } from '../../src/core/vault/browser-keys.js'
import { createDeviceAs } from '../../src/core/device-auth.js'
import { LOCAL_ACTOR } from '../../src/core/device-actor.js'

const MASTER = 'a fake handing master 8'
const kdf: KdfParams = { name: 'PBKDF2-SHA256', iterations: 600_000, salt: toB64(randomBytes(16)) }
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/
let pwKey = ''
let base = ''

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

/** A Walnut window on this computer holding `key` (a POST carries its Origin; a GET of its own page none). */
const win = (key?: string): Caller => ({ origin: base, ...(key ? { key } : {}) })
const winGet = (key?: string): Caller => (key ? { key } : {})
let ext: Caller
let browser: Caller
const quiet = { 'x-walnut-vault-quiet': '1' }

async function unlockInExtension(passwordKey = pwKey): Promise<string> {
  const r = await http('POST', '/vault/unlock', '', { passwordKey, client: 'Walnut extension' }, ext)
  expect(r.status).toBe(200)
  return r.body.session.token
}

/** The extension asks for the key of the Walnut page beside it (`key`: the one that page keeps). */
const hand = (token: string, key?: string, who: Caller = ext) =>
  http('POST', '/vault/browser-key', token, key ? { browserKey: key } : {}, { ...who, headers: { ...quiet, ...who.headers } })

async function lockAll(): Promise<void> {
  await http('POST', '/vault/lock', '', { everywhere: true }, win())
}

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  resetVaultForTest(null)
  await simulateRestartForTest()
  resetBrowserKeysForTest()
  // No keychain here: nothing reopens the vault by itself.
  setVaultRunnerForTest(async () => ({ code: 44, stdout: '', stderr: '', timedOut: false }))
  setKeychainPlatformForTest('linux')
  pwKey = toB64(await derivePasswordKey(MASTER, kdf))
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  ext = { device: (await createDeviceAs('extension-a1b2c3', { by: LOCAL_ACTOR, extension: true })).token, origin: EXT_ORIGIN }
  browser = { device: (await createDeviceAs('browser-0a0b0c', { by: LOCAL_ACTOR })).token, origin: base }
  const made = await http('POST', '/vault/setup', '', { passwordKey: pwKey, kdf, agentsWhileAway: false, client: 'Walnut web' }, win())
  expect(made.status).toBe(200)
  await lockAll()
}, 120_000)

afterAll(async () => {
  await flushSessionStoreForTest()
  await stopServer()
  setVaultRunnerForTest(null)
  setKeychainPlatformForTest(null)
})

describe('the extension hands the Walnut window beside it its browser key', () => {
  let handed = ''

  it('after an unlock in the extension, a window with no key gets one and shares that unlock with no password', async () => {
    const token = await unlockInExtension()
    // The first visit: the page has no key, so it may share nothing yet.
    expect((await http('GET', '/vault/status', '', undefined, winGet())).body.canJoin).toBeUndefined()
    const r = await hand(token)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ known: false })
    handed = r.body.browserKey
    expect(handed).toMatch(KEY_SHAPE)
    expect((await http('GET', '/vault/status', '', undefined, winGet(handed))).body).toMatchObject({ unlocked: false, canJoin: true })
    const j = await http('POST', '/vault/join', '', { client: 'Walnut web' }, win(handed))
    expect(j.status).toBe(200)
    expect((await http('GET', '/vault/status', j.body.session.token, undefined, winGet(handed))).body.unlocked).toBe(true)
    // The person's Lock in that window locks the extension too, and the other way round (one unlock).
    await http('POST', '/vault/lock', j.body.session.token, { everywhere: true }, win(handed))
    expect((await http('GET', '/vault/status', token, undefined, ext)).body.unlocked).toBe(false)
  }, 120_000)

  it('a page whose key Walnut knows gets it back unchanged, nothing new is made', async () => {
    const token = await unlockInExtension()
    const r = await hand(token, handed)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ browserKey: handed, known: true })
    await lockAll()
  }, 60_000)

  it('a share the extension holds from a window\'s unlock here hands too', async () => {
    const typed = await http('POST', '/vault/unlock', '', { passwordKey: pwKey, client: 'Walnut web' }, win())
    expect(typed.status).toBe(200)
    const joined = await http('POST', '/vault/join', '', { client: 'Walnut extension' }, ext)
    expect(joined.status).toBe(200)
    const r = await hand(joined.body.session.token)
    expect(r.status).toBe(200)
    expect(r.body.browserKey).toMatch(KEY_SHAPE)
    await lockAll()
  }, 60_000)

  it('nobody else gets a key: a window, a script, another device, no or a foreign session, a session caller, a proxy', async () => {
    const token = await unlockInExtension()
    const webToken = (await http('POST', '/vault/unlock', '', { passwordKey: pwKey, client: 'Walnut web' }, win())).body.session.token
    const none = (r: { status: number; body: Record<string, any> }, status: number, code?: string) => {
      expect(r.status).toBe(status)
      expect(r.body.browserKey).toBeUndefined()
      if (code) expect(r.body.code).toBe(code)
    }
    // A Walnut window (no device token), even with a live unlock of its own.
    none(await hand(webToken, undefined, win()), 403, 'browser_key_refused')
    // A script on this computer with no Origin, holding the extension's token and session.
    none(await hand(token, undefined, { device: ext.device }), 403, 'browser_key_refused')
    // Another paired device (a browser signed in elsewhere) with an unlock of its own.
    const bTok = (await http('POST', '/vault/unlock', '', { passwordKey: pwKey, client: 'b' }, browser)).body.session?.token ?? ''
    none(await hand(bTok, undefined, browser), 403, 'browser_key_refused')
    // The extension with no session, or with someone else's.
    none(await hand(''), 401, 'vault_session_needed')
    none(await hand(webToken), 409, 'nothing_to_hand')
    // A session (an agent) carrying the extension's token.
    none(await hand(token, undefined, { ...ext, headers: { 'x-walnut-caller-sid': 'sess-123' } }), 403, 'human_only')
    // Through a proxy: a request from elsewhere.
    const proxied = await hand(token, undefined, { ...ext, headers: { 'x-forwarded-for': '203.0.113.9' } })
    expect(proxied.status).toBeGreaterThanOrEqual(400)
    expect(proxied.body.browserKey).toBeUndefined()
    await lockAll()
  }, 120_000)

  it('an extension unlock not made on this computer hands nothing', async () => {
    // A device unlock that sent no Origin (no browser made it) is not `here`.
    const r = await http('POST', '/vault/unlock', '', { passwordKey: pwKey, client: 'x' }, { device: ext.device })
    expect(r.status).toBe(200)
    const out = await hand(r.body.session.token)
    expect(out.status).toBe(409)
    expect(out.body.code).toBe('nothing_to_hand')
    await lockAll()
  }, 60_000)

  it('a key Walnut forgot is replaced, and the window\'s own lock goes with it', async () => {
    const token = await unlockInExtension()
    // A window whose key this vault does not know locked only itself (its own idle lock).
    const old = crypto.randomBytes(32).toString('base64url')
    await new Promise((r) => setTimeout(r, 5))
    expect((await http('POST', '/vault/lock', '', {}, win(old))).status).toBe(200)
    const r = await hand(token, old)
    expect(r.status).toBe(200)
    expect(r.body.known).toBe(false)
    const fresh = r.body.browserKey
    expect(fresh).toMatch(KEY_SHAPE)
    expect(fresh).not.toBe(old)
    // Its lock holds against the unlock made before it ...
    expect((await http('GET', '/vault/status', '', undefined, winGet(fresh))).body.canJoin).toBeUndefined()
    // ... until the person unlocks again.
    await new Promise((r2) => setTimeout(r2, 5))
    await unlockInExtension()
    expect((await http('GET', '/vault/status', '', undefined, winGet(fresh))).body.canJoin).toBe(true)
    await lockAll()
  }, 60_000)

  it('after a new master password, an unlock from before hands nothing; one typed with the new password does', async () => {
    const token = await unlockInExtension()
    const kdf2: KdfParams = { name: 'PBKDF2-SHA256', iterations: 600_000, salt: toB64(randomBytes(16)) }
    const pwKey2 = toB64(await derivePasswordKey('a second fake handing master 9', kdf2))
    // The extension changes it: its own session is kept, but that unlock was made before the change.
    const changed = await http('POST', '/vault/password', token, { oldPasswordKey: pwKey, newPasswordKey: pwKey2, kdf: kdf2 }, ext)
    expect(changed.status).toBe(200)
    const before = await hand(token, handed)
    expect(before.status).toBe(409)
    expect(before.body.code).toBe('nothing_to_hand')
    // Every old key ended with the old password: the page's key is replaced by one under the new unlock.
    await lockAll()
    const after = await unlockInExtension(pwKey2)
    const r = await hand(after, handed)
    expect(r.status).toBe(200)
    expect(r.body.known).toBe(false)
    expect(r.body.browserKey).not.toBe(handed)
    expect((await http('GET', '/vault/status', '', undefined, winGet(r.body.browserKey))).body.canJoin).toBe(true)
    expect((await http('GET', '/vault/status', '', undefined, winGet(handed))).body.canJoin).toBeUndefined()
    await lockAll()
  }, 120_000)
})
