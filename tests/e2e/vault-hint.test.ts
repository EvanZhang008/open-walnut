/**
 * The master password hint end to end on a real server (src/core/vault/hint.ts through
 * src/web/routes/vault-v1.ts): set up with one, read it while locked, change and remove it,
 * and what happens to it with a new master password or a recovery. Fake data only.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-vault-hint-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { derivePasswordKey, randomBytes, toB64, type KdfParams } from '../../src/core/vault/crypto.js'
import { resetVaultForTest } from '../../src/core/vault/store.js'
import { resetSessionsForTest } from '../../src/core/vault/sessions.js'

let base = ''
let session = ''
let recoveryCode = ''
const kdf: KdfParams = { name: 'PBKDF2-SHA256', iterations: 600_000, salt: toB64(randomBytes(16)) }
const MASTER = 'purple elephant dances'
const vaultFile = () => path.join(WALNUT_HOME, 'vault', 'vault.json')
const onDisk = () => JSON.parse(fs.readFileSync(vaultFile(), 'utf8')) as Record<string, unknown>

async function http(method: string, p: string, body?: unknown) {
  const res = await fetch(`${base}/api/v1${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(session ? { 'x-walnut-vault-session': session } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> }
}

beforeAll(async () => {
  process.env.WALNUT_TEST_RUN_MARK = '1'
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  resetVaultForTest(null)
  resetSessionsForTest()
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  await stopServer()
  delete process.env.WALNUT_TEST_RUN_MARK
})

describe('master password hint', () => {
  it('refuses a setup whose hint gives the password away, by key or by typed password', async () => {
    const pwKey = toB64(await derivePasswordKey(MASTER, kdf))
    // Only the key: a hint that IS the password (another case) derives the same key.
    let r = await http('POST', '/vault/setup', { passwordKey: pwKey, kdf, hint: 'Purple Elephant Dances' })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('bad_hint')
    // The typed password: the whole rule (here: the hint is part of it).
    r = await http('POST', '/vault/setup', { password: MASTER, kdf, hint: 'elephant' })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('bad_hint')
    r = await http('POST', '/vault/setup', { password: MASTER, kdf, hint: 'x'.repeat(101) })
    expect(r.body.code).toBe('bad_hint')
    expect(fs.existsSync(vaultFile())).toBe(false)
    expect((await http('GET', '/vault/status')).body.setUp).toBe(false)
  }, 60_000)

  it('sets up with a hint, kept in vault.json and given by the status while locked', async () => {
    const r = await http('POST', '/vault/setup', { password: MASTER, kdf, hint: '  the  circus poster ', client: 'test' })
    expect(r.status).toBe(200)
    recoveryCode = r.body.recoveryCode
    session = r.body.session.token
    expect(onDisk().hint).toBe('the circus poster')
    // The vault format is unchanged, so an older Walnut opens it (it keeps fields it does not know).
    expect(onDisk().version).toBe(1)
    expect((await http('POST', '/vault/lock', {})).status).toBe(200)
    session = ''
    const st = await http('GET', '/vault/status')
    expect(st.body).toMatchObject({ setUp: true, unlocked: false, hint: 'the circus poster' })
    const u = await http('POST', '/vault/unlock', { password: MASTER, client: 'test' })
    expect(u.status).toBe(200)
    session = u.body.session.token
  }, 60_000)

  it('changes the hint only with the master password, checked against it, and removes it without', async () => {
    const saved = session
    session = ''
    expect((await http('PUT', '/vault/hint', { hint: 'a new one', password: MASTER })).status).toBe(401)
    session = saved
    expect((await http('PUT', '/vault/hint', { hint: 'a new one' })).body.code).toBe('bad_password_key')
    expect((await http('PUT', '/vault/hint', { hint: 'a new one', password: 'not the password' })).body.code).toBe('wrong_password')
    expect((await http('PUT', '/vault/hint', { hint: 'purple elephant dances!', password: MASTER })).body.code).toBe('bad_hint')
    expect((await http('PUT', '/vault/hint', {})).body.code).toBe('bad_hint')
    const ok = await http('PUT', '/vault/hint', { hint: 'the zoo trip', password: MASTER })
    expect(ok.status).toBe(200)
    expect((await http('GET', '/vault/status')).body.hint).toBe('the zoo trip')
    expect((await http('PUT', '/vault/hint', { hint: '' })).status).toBe(200)
    const st = await http('GET', '/vault/status')
    expect(st.status).toBe(200)
    expect('hint' in st.body).toBe(false)
    expect('hint' in onDisk()).toBe(false)
  }, 60_000)

  it('a new master password takes its own hint; one sent without (an older client) drops the old', async () => {
    expect((await http('POST', '/vault/password', { oldPassword: MASTER, newPassword: 'green tiger sleeps', hint: 'tiger' })).body.code).toBe('bad_hint')
    let r = await http('POST', '/vault/password', { oldPassword: MASTER, newPassword: 'green tiger sleeps', hint: 'the zoo, again' })
    expect(r.status).toBe(200)
    recoveryCode = r.body.recoveryKit.recoveryCode
    expect((await http('GET', '/vault/status')).body.hint).toBe('the zoo, again')
    r = await http('POST', '/vault/password', { oldPassword: 'green tiger sleeps', newPassword: MASTER })
    expect(r.status).toBe(200)
    recoveryCode = r.body.recoveryKit.recoveryCode
    expect((await http('GET', '/vault/status')).body.hint).toBeUndefined()
  }, 60_000)

  it('a recovery sets the new password\'s hint', async () => {
    session = ''
    const r = await http('POST', '/vault/recover', { recoveryCode, newPassword: 'orange whale sings', hint: 'the aquarium' })
    expect(r.status).toBe(200)
    expect((await http('GET', '/vault/status')).body.hint).toBe('the aquarium')
  }, 60_000)
})
