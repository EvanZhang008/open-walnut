/**
 * The vault's ciphertext for a device that opens it itself (src/web/routes/vault-sealed-v1.ts,
 * docs/reference/passwords.md "iPhone"): the header and the item tags, the sealed items in pages
 * under the companion's forward limit, a tag that changes on every seal (an edit, a new master
 * password), who may read it, and a device opening it with the master password and the Secret Key
 * the way the iPhone does. Fake data only; the vault lives in the test's own data home.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-vault-sealed-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import {
  deriveUnlockKey, derivePasswordKey, fromB64, open, openJson, parseSecretKey, randomBytes, toB64, type KdfParams, type Sealed,
} from '../../src/core/vault/crypto.js'
import { aadItem, aadItemKey, aadWrap } from '../../src/core/vault/state.js'
import { resetVaultForTest } from '../../src/core/vault/store.js'
import { resetSessionsForTest } from '../../src/core/vault/sessions.js'
import { MAX_FORWARD_RESPONSE_BYTES } from '../../src/web/v1-forward/policy.js'

let base = ''
let session = ''
let secretKey = ''
const kdf: KdfParams = { name: 'PBKDF2-SHA256', iterations: 600_000, salt: toB64(randomBytes(16)) }
const MASTER = 'correct horse sealed battery'
let pwKey = ''

async function http(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/v1${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(session ? { 'x-walnut-vault-session': session } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, bytes: Buffer.byteLength(text), body: (text ? JSON.parse(text) : {}) as Record<string, any>, cache: res.headers.get('cache-control') }
}

/** What the phone does: every page of the index, then every item, then opens them with its two secrets. */
async function deviceRead(password: string, sk: string) {
  const index: Record<string, string> = {}
  let header: Record<string, any> = {}
  let after = ''
  for (;;) {
    const r = await http('GET', `/vault/sealed${after ? `?after=${encodeURIComponent(after)}` : ''}`)
    expect(r.status).toBe(200)
    header = r.body.vault
    Object.assign(index, r.body.items)
    if (!r.body.next) break
    after = r.body.next
  }
  const sealed: Record<string, { key: Sealed; data: Sealed; tag: string }> = {}
  let want = Object.keys(index)
  while (want.length) {
    const r = await http('POST', '/vault/sealed/items', { ids: want })
    expect(r.status).toBe(200)
    expect(r.bytes).toBeLessThan(MAX_FORWARD_RESPONSE_BYTES)
    Object.assign(sealed, r.body.items)
    want = want.filter((id) => !(id in sealed))
    if (!r.body.more) break
  }
  const pk = await derivePasswordKey(password, header.kdf)
  const auk = await deriveUnlockKey(pk, parseSecretKey(sk)!, fromB64(header.aukSalt))
  const vk = await open(auk, header.wrap, aadWrap(header.id, 'password'))
  const items: Record<string, any> = {}
  for (const [id, s] of Object.entries(sealed)) {
    expect(s.tag).toBe(index[id])
    const ik = await open(vk, s.key, aadItemKey(header.id, id))
    items[id] = await openJson(ik, s.data, aadItem(header.id, id))
  }
  return { header, index, items }
}

beforeAll(async () => {
  // A throwaway server ignores the test-run header unless asked to honor it.
  process.env.WALNUT_TEST_RUN_MARK = '1'
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  resetVaultForTest(null)
  resetSessionsForTest()
  pwKey = toB64(await derivePasswordKey(MASTER, kdf))
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  await stopServer()
  delete process.env.WALNUT_TEST_RUN_MARK
})

describe('the sealed vault for a device', () => {
  it('says there is no vault yet, and refuses an agent and a test run', async () => {
    const none = await http('GET', '/vault/sealed')
    expect(none.status).toBe(409)
    expect(none.body.code).toBe('vault_not_set_up')
    expect(none.cache).toBe('no-store')
    for (const h of [{ 'x-walnut-caller-sid': 's1' }, { 'x-walnut-caller-kind': 'automation' }]) {
      expect((await http('GET', '/vault/sealed', undefined, h)).body.code).toBe('human_only')
      expect((await http('POST', '/vault/sealed/items', { ids: [] }, h)).body.code).toBe('human_only')
    }
    expect((await http('GET', '/vault/sealed', undefined, { 'x-walnut-test-run': 'probe' })).body.code).toBe('test_run')
  })

  it('serves only ciphertext, which the master password and the Secret Key open', async () => {
    const r = await http('POST', '/vault/setup', { passwordKey: pwKey, kdf, agentsWhileAway: false, client: 'test' })
    expect(r.status).toBe(200)
    secretKey = r.body.secretKey
    session = r.body.session.token
    await http('POST', '/vault/items', { item: { type: 'login', title: 'Example Mail', username: 'alice@example.test', password: 'Sealed-Pass-1!', urls: ['mail.example.test'], totp: 'JBSWY3DPEHPK3PXP' } })
    await http('POST', '/vault/items', { item: { type: 'note', title: 'Wifi', notes: 'router: \u00e9t\u00e9 \u{1F511}' } })
    // The device needs no vault session: it reads only ciphertext.
    session = ''
    const s = await http('GET', '/vault/sealed')
    expect(s.status).toBe(200)
    expect(s.cache).toBe('no-store')
    expect(Object.keys(s.body.items)).toHaveLength(2)
    expect(s.body.vault).toMatchObject({ format: 'walnut-vault', version: 1, kdf, count: 2 })
    expect(s.body.vault.wrap).toMatchObject({ iv: expect.any(String), ct: expect.any(String) })
    // The machine and recovery wraps (no device can use them) and the Secret Key stay on the Mac.
    const all = JSON.stringify(s.body)
    for (const plain of ['Example Mail', 'alice@example.test', 'Sealed-Pass-1!', 'JBSWY3DPEHPK3PXP', secretKey]) expect(all).not.toContain(plain)
    expect(all).not.toContain('recovery')
    const got = await deviceRead(MASTER, secretKey)
    const titles = Object.values(got.items).map((i) => i.title).sort()
    expect(titles).toEqual(['Example Mail', 'Wifi'])
    const mail = Object.values(got.items).find((i) => i.title === 'Example Mail')
    expect(mail).toMatchObject({ username: 'alice@example.test', password: 'Sealed-Pass-1!', urls: ['https://mail.example.test'] })
    expect(Object.values(got.items).find((i) => i.title === 'Wifi').notes).toBe('router: \u00e9t\u00e9 \u{1F511}')
    // The wrong master password, or the right one without the Secret Key, opens nothing.
    await expect(deviceRead('not the password', secretKey)).rejects.toThrow()
    await expect(deviceRead(MASTER, 'W1-AAAAAA-AAAAA-AAAAA-AAAAA-AAAAA')).rejects.toThrow()
  })

  it('changes an item\'s tag when it is edited, and every tag when the vault key changes', async () => {
    const before = (await http('GET', '/vault/sealed')).body.items as Record<string, string>
    session = (await http('POST', '/vault/unlock', { passwordKey: pwKey })).body.session.token
    const list = (await http('GET', '/vault/items')).body.items as Array<{ id: string; title: string }>
    const mail = list.find((i) => i.title === 'Example Mail')!
    const full = (await http('GET', `/vault/items/${mail.id}`)).body.item
    expect((await http('PUT', `/vault/items/${mail.id}`, { item: { ...full, password: 'Sealed-Pass-2!' } })).status).toBe(200)
    const after = (await http('GET', '/vault/sealed')).body.items as Record<string, string>
    const other = list.find((i) => i.title === 'Wifi')!
    expect(after[mail.id]).not.toBe(before[mail.id])
    expect(after[other.id]).toBe(before[other.id])
    // A new master password makes a new vault key: every item key is sealed again.
    const newKdf: KdfParams = { ...kdf, salt: toB64(randomBytes(16)) }
    const newMaster = 'a new sealed master password'
    const np = await http('POST', '/vault/password', { oldPasswordKey: pwKey, newPasswordKey: toB64(await derivePasswordKey(newMaster, newKdf)), kdf: newKdf })
    expect(np.status).toBe(200)
    session = ''
    const rekeyed = (await http('GET', '/vault/sealed')).body.items as Record<string, string>
    expect(rekeyed[other.id]).not.toBe(after[other.id])
    const got = await deviceRead(newMaster, secretKey)
    expect(got.items[mail.id].password).toBe('Sealed-Pass-2!')
    await expect(deviceRead(MASTER, secretKey)).rejects.toThrow()
  })

  it('pages the items under the companion\'s forward limit, and names the ones it does not have', async () => {
    session = (await http('POST', '/vault/unlock', { password: 'a new sealed master password' })).body.session.token
    const big = 'n'.repeat(19_000)
    for (let i = 0; i < 24; i++) {
      const r = await http('POST', '/vault/items', { item: { type: 'note', title: `Bulk ${i}`, notes: big } })
      expect(r.status).toBe(200)
    }
    session = ''
    const ids = Object.keys((await http('GET', '/vault/sealed')).body.items as Record<string, string>)
    expect(ids).toHaveLength(26)
    const first = await http('POST', '/vault/sealed/items', { ids: [...ids, 'no-such-item'] })
    expect(first.body.more).toBe(true)
    expect(first.body.missing).toEqual(['no-such-item'])
    expect(first.bytes).toBeLessThan(MAX_FORWARD_RESPONSE_BYTES)
    const got = await deviceRead('a new sealed master password', secretKey)
    expect(Object.keys(got.items)).toHaveLength(26)
    expect((await http('POST', '/vault/sealed/items', { ids: 'x' })).body.code).toBe('bad_ids')
  })
})

describe('the iPhone\'s fixture', () => {
  // ios-native/WalnutTests/VaultCryptoTests.swift opens this same file with the phone's code: a
  // change to the format or the crypto breaks the server side here and the phone side there.
  it('opens with the server\'s own crypto', async () => {
    const f = JSON.parse(await fsp.readFile(path.join(__dirname, '../../ios-native/WalnutTests/Fixtures/vault-fixture.json'), 'utf8'))
    const pk = await derivePasswordKey(f.master, f.header.kdf)
    const auk = await deriveUnlockKey(pk, parseSecretKey(f.secretKey)!, fromB64(f.header.aukSalt))
    const vk = await open(auk, f.header.wrap, aadWrap(f.header.id, 'password'))
    expect(toB64(vk)).toBe(f.expected.vaultKey)
    const titles: string[] = []
    for (const [id, s] of Object.entries(f.items) as Array<[string, { key: Sealed; data: Sealed }]>) {
      const ik = await open(vk, s.key, aadItemKey(f.header.id, id))
      titles.push((await openJson<{ title: string }>(ik, s.data, aadItem(f.header.id, id))).title)
    }
    expect(titles.sort()).toEqual([...f.expected.titles].sort())
  })
})
