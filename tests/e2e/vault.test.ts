/**
 * Passwords end to end on a real server (src/web/routes/vault-v1.ts over src/core/vault/):
 * set up, unlock, items and their history, trash, TOTP, import, lock, a restart with and
 * without the machine key, the Secret Key from the recovery kit, a new master password,
 * export, and who may touch the vault at all. Fake data only; the vault lives in the
 * test's own data home.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-vault-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { derivePasswordKey, fromB64, open, randomBytes, toB64, type KdfParams } from '../../src/core/vault/crypto.js'
import { resetVaultForTest } from '../../src/core/vault/store.js'
import { resetSessionsForTest } from '../../src/core/vault/sessions.js'

let base = ''
let session = ''
let secretKey = ''
const kdf: KdfParams = { name: 'PBKDF2-SHA256', iterations: 600_000, salt: toB64(randomBytes(16)) }
const MASTER = 'tr0ub4dor & 3 test horses'
let pwKey = ''
const vaultDirPath = () => path.join(WALNUT_HOME, 'vault')

async function http(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/v1${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(session ? { 'x-walnut-vault-session': session } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any>, cache: res.headers.get('cache-control') }
}

beforeAll(async () => {
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

describe('who may open the vault', () => {
  it('refuses a session, a CLI automation and a test run, before anything else', async () => {
    for (const h of [{ 'x-walnut-caller-sid': 's1' }, { 'x-walnut-caller-kind': 'automation' }]) {
      const r = await http('GET', '/vault/status', undefined, h)
      expect(r.status).toBe(403)
      expect(r.body.code).toBe('human_only')
    }
    const t = await http('POST', '/vault/setup', { passwordKey: pwKey, kdf }, { 'x-walnut-test-run': 'probe' })
    expect(t.status).toBe(403)
    expect(t.body.code).toBe('test_run')
    // A test run may read the status (no secret in it), so an automated browser sees the page.
    expect((await http('GET', '/vault/status', undefined, { 'x-walnut-test-run': 'probe' })).status).toBe(200)
    for (const [m, p] of [['GET', '/vault/items'], ['POST', '/vault/unlock']] as const) {
      expect((await http(m, p, m === 'POST' ? { password: 'x' } : undefined, { 'x-walnut-test-run': 'probe' })).body.code).toBe('test_run')
    }
    expect(fs.existsSync(path.join(vaultDirPath(), 'vault.json'))).toBe(false)
  })
})

describe('the vault, start to end', () => {
  it('starts not set up, and items need a vault', async () => {
    const s = await http('GET', '/vault/status')
    expect(s.status).toBe(200)
    expect(s.cache).toBe('no-store')
    expect(s.body).toMatchObject({ setUp: false, open: false, unlocked: false })
    expect((await http('GET', '/vault/items')).status).toBe(401)
  })

  it('sets up once, returning the Secret Key and a session', async () => {
    const r = await http('POST', '/vault/setup', { passwordKey: pwKey, kdf, agentsWhileAway: true, client: 'test' })
    expect(r.status).toBe(200)
    expect(r.body.secretKey).toMatch(/^W1-/)
    secretKey = r.body.secretKey
    session = r.body.session.token
    expect((await http('POST', '/vault/setup', { passwordKey: pwKey, kdf })).body.code).toBe('vault_exists')
    const s = await http('GET', '/vault/status')
    expect(s.body).toMatchObject({ setUp: true, open: true, unlocked: true, agentsWhileAway: true, hasSecretKey: true, itemCount: 0, kdf })
  })

  let id = ''
  it('adds, lists without secrets, reads with them, and keeps password history', async () => {
    const c = await http('POST', '/vault/items', { item: { type: 'login', title: 'Example Git', username: 'alice@example.test', password: 'first-Pass-1!', urls: ['git.example.test'], totp: 'JBSWY3DPEHPK3PXP', agentAccess: 'never' } })
    expect(c.status).toBe(200)
    id = c.body.item.id
    expect(c.body.item.urls).toEqual(['https://git.example.test'])
    const l = await http('GET', '/vault/items')
    expect(l.body.items).toHaveLength(1)
    expect(l.body.items[0]).toMatchObject({ title: 'Example Git', username: 'alice@example.test', hasPassword: true, hasTotp: true, agentAccess: 'never' })
    expect(JSON.stringify(l.body)).not.toContain('first-Pass-1!')
    expect(JSON.stringify(l.body)).not.toContain('JBSWY3DPEHPK3PXP')
    const g = await http('GET', `/vault/items/${id}`)
    expect(g.body.item.password).toBe('first-Pass-1!')
    const u = await http('PUT', `/vault/items/${id}`, { item: { ...g.body.item, password: 'second-Pass-2!' }, expectedUpdatedAt: g.body.item.updatedAt })
    expect(u.status).toBe(200)
    expect(u.body.item.passwordHistory[0].password).toBe('first-Pass-1!')
    const stale = await http('PUT', `/vault/items/${id}`, { item: { ...g.body.item, password: 'x' }, expectedUpdatedAt: g.body.item.updatedAt })
    expect(stale.status).toBe(409)
    expect(stale.body.code).toBe('stale_item')
    const t = await http('GET', `/vault/items/${id}/totp`)
    expect(t.body.code).toMatch(/^\d{6}$/)
    expect(t.body.remaining).toBeGreaterThan(0)
  })

  it('refuses a bad item', async () => {
    expect((await http('POST', '/vault/items', { item: { type: 'login', title: '' } })).status).toBe(400)
    expect((await http('POST', '/vault/items', { item: { type: 'nope', title: 'x' } })).status).toBe(400)
    expect((await http('POST', '/vault/items', { item: { type: 'api_key', title: 'k', envName: 'bad name' } })).status).toBe(400)
  })

  it('trashes, restores, and deletes only from the trash', async () => {
    const c = await http('POST', '/vault/items', { item: { type: 'note', title: 'Throwaway', notes: 'x' } })
    const nid = c.body.item.id
    expect((await http('DELETE', `/vault/items/${nid}`)).body.code).toBe('not_in_trash')
    expect((await http('POST', `/vault/items/${nid}/trash`)).body.item.trashedAt).toBeTruthy()
    expect((await http('POST', `/vault/items/${nid}/restore`)).body.item.trashedAt).toBeUndefined()
    await http('POST', `/vault/items/${nid}/trash`)
    expect((await http('DELETE', `/vault/items/${nid}`)).status).toBe(200)
    expect((await http('GET', `/vault/items/${nid}`)).status).toBe(404)
  })

  it('imports with a dry run first, then skips duplicates', async () => {
    const text = 'name,url,username,password,note\nmail.example.test,https://mail.example.test/,bob,pw-mail-1,\nshop.example.test,https://shop.example.test/,bob,pw-shop-1,\n'
    const dry = await http('POST', '/vault/import', { text })
    expect(dry.body).toMatchObject({ dryRun: true, report: { format: 'chrome_csv', found: 2, toAdd: 2 } })
    expect((await http('GET', '/vault/items')).body.items).toHaveLength(1)
    const go = await http('POST', '/vault/import', { text, dryRun: false })
    expect(go.body.added).toBe(2)
    const again = await http('POST', '/vault/import', { text, dryRun: false })
    expect(again.body).toMatchObject({ added: 0, report: { duplicates: 2 } })
    expect((await http('POST', '/vault/import', { text: 'just some words' })).body.code).toBe('bad_import')
  })

  it('reports weak and reused passwords', async () => {
    await http('POST', '/vault/items', { item: { type: 'login', title: 'Weak', password: '123456' } })
    const r = await http('GET', '/vault/report')
    expect(r.body.weak).toHaveLength(1)
  })

  it('keeps only ciphertext on disk, with the machine file private', async () => {
    const raw = await fsp.readFile(path.join(vaultDirPath(), 'vault.json'), 'utf8')
    for (const plain of ['Example Git', 'alice@example.test', 'second-Pass-2!', 'JBSWY3DPEHPK3PXP', 'mail.example.test']) expect(raw).not.toContain(plain)
    const st = fs.statSync(path.join(vaultDirPath(), 'machine.json'))
    expect(st.mode & 0o077).toBe(0)
    expect(fs.readdirSync(path.join(vaultDirPath(), 'backups')).length).toBeGreaterThan(0)
  })

  it('locks this window, and a wrong password is refused', async () => {
    await http('POST', '/vault/lock')
    expect((await http('GET', '/vault/items')).status).toBe(401)
    session = ''
    const wrong = await http('POST', '/vault/unlock', { password: 'not the password' })
    expect(wrong.status).toBe(401)
    expect(wrong.body.code).toBe('wrong_password')
    // The typed-password path (a browser with no WebCrypto) and the password-key path both unlock.
    const ok = await http('POST', '/vault/unlock', { password: MASTER })
    expect(ok.status).toBe(200)
    session = ok.body.session.token
    expect((await http('GET', '/vault/items')).body.items.length).toBe(4)
  })

  it('after a restart with the machine key, the vault is open but every window is locked', async () => {
    resetVaultForTest(null)
    resetSessionsForTest()
    const s = await http('GET', '/vault/status')
    expect(s.body).toMatchObject({ open: true, unlocked: false })
    expect((await http('GET', '/vault/items')).status).toBe(401)
    session = (await http('POST', '/vault/unlock', { passwordKey: pwKey })).body.session.token
    expect((await http('GET', `/vault/items/${id}`)).body.item.password).toBe('second-Pass-2!')
  })

  it('turning agents-while-away off needs the master password and makes a new vault key', async () => {
    const before = JSON.parse(await fsp.readFile(path.join(vaultDirPath(), 'vault.json'), 'utf8'))
    const oldMachineKey = fromB64(JSON.parse(await fsp.readFile(path.join(vaultDirPath(), 'machine.json'), 'utf8')).machineKey)
    expect((await http('POST', '/vault/settings', { agentsWhileAway: false })).body.code).toBe('bad_password_key')
    expect((await http('POST', '/vault/settings', { agentsWhileAway: false, password: 'wrong guess' })).body.code).toBe('wrong_password')
    expect((await http('POST', '/vault/settings', { agentsWhileAway: false, passwordKey: pwKey })).body.agentsWhileAway).toBe(false)
    expect(JSON.parse(await fsp.readFile(path.join(vaultDirPath(), 'machine.json'), 'utf8')).machineKey).toBeUndefined()
    // A machine key copied before opens the old vault key, which opens no item key written now.
    const oldKey = await open(oldMachineKey, before.wraps.machine, `walnut-vault:${before.id}:wrap:machine`)
    const after = JSON.parse(await fsp.readFile(path.join(vaultDirPath(), 'vault.json'), 'utf8'))
    await expect(open(oldKey, after.items[id].key, `walnut-vault:${after.id}:item-key:${id}`)).rejects.toThrow()
    expect((await http('GET', `/vault/items/${id}`)).body.item.password).toBe('second-Pass-2!')
  })

  it('with agents-while-away off, the vault closes when the last window locks, and after a restart', async () => {
    await http('POST', '/vault/lock')
    session = ''
    expect((await http('GET', '/vault/status')).body).toMatchObject({ open: false, agentsWhileAway: false })
    session = (await http('POST', '/vault/unlock', { passwordKey: pwKey })).body.session.token
    resetVaultForTest(null)
    resetSessionsForTest()
    session = ''
    expect((await http('GET', '/vault/status')).body).toMatchObject({ open: false, agentsWhileAway: false })
    session = (await http('POST', '/vault/unlock', { passwordKey: pwKey })).body.session.token
    expect((await http('GET', '/vault/status')).body.open).toBe(true)
    expect((await http('POST', '/vault/settings', { agentsWhileAway: true, passwordKey: pwKey })).body.agentsWhileAway).toBe(true)
  })

  it('shows the Secret Key again only for the master password', async () => {
    expect((await http('POST', '/vault/secret-key', { password: 'nope nope' })).body.code).toBe('wrong_password')
    expect((await http('POST', '/vault/secret-key', { passwordKey: pwKey })).body.secretKey).toBe(secretKey)
  })

  it('keeps passkeys an editor did not send, and a failed write changes nothing', async () => {
    const c = await http('POST', '/vault/items', { item: { type: 'login', title: 'Passkey site', password: 'pk-Pass-1!', passkeys: [{ credentialId: 'cred-1', rpId: 'pk.example.test' }] } })
    const pid = c.body.item.id
    const { passkeys: _p, ...noPasskeys } = c.body.item
    const u = await http('PUT', `/vault/items/${pid}`, { item: { ...noPasskeys, password: 'pk-Pass-2!' } })
    expect(u.body.item.passkeys).toHaveLength(1)
    await fsp.chmod(vaultDirPath(), 0o500)
    try {
      const fail = await http('PUT', `/vault/items/${pid}`, { item: { ...u.body.item, password: 'never-saved-3!' } })
      expect(fail.status).toBe(500)
    } finally {
      await fsp.chmod(vaultDirPath(), 0o700)
    }
    expect((await http('GET', `/vault/items/${pid}`)).body.item.password).toBe('pk-Pass-2!')
    await http('POST', `/vault/items/${pid}/trash`)
    await http('DELETE', `/vault/items/${pid}`)
  })

  it('reads vault.json again when it was put back by hand (a backup restored)', async () => {
    const file = path.join(vaultDirPath(), 'vault.json')
    const copy = await fsp.readFile(file)
    const c = await http('POST', '/vault/items', { item: { type: 'note', title: 'Added after the copy', notes: 'n' } })
    expect((await http('GET', `/vault/items/${c.body.item.id}`)).status).toBe(200)
    await fsp.writeFile(file, copy)
    expect((await http('GET', `/vault/items/${c.body.item.id}`)).status).toBe(404)
  })

  it('never keeps a vault answer in the op-id ledger, so a repeated id runs the route again', async () => {
    const h = { 'x-walnut-op-id': 'op-vault-ledger-check' }
    const a = await fetch(`${base}/api/v1/vault/items`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-walnut-vault-session': session, ...h }, body: JSON.stringify({ item: { type: 'note', title: 'Ledger probe', notes: 'ledger-secret-probe' } }) })
    const b = await fetch(`${base}/api/v1/vault/items`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-walnut-vault-session': '', ...h }, body: JSON.stringify({ item: { type: 'note', title: 'Ledger probe', notes: 'ledger-secret-probe' } }) })
    expect(a.status).toBe(200)
    // Replayed from a ledger, the second would answer 200 with the first answer and skip the session check.
    expect(b.headers.get('x-walnut-op-replayed')).toBeNull()
    expect(b.status).toBe(401)
    const ledger = path.join(WALNUT_HOME, 'cache', 'applied-ops.sqlite')
    if (fs.existsSync(ledger)) expect((await fsp.readFile(ledger)).includes('ledger-secret-probe')).toBe(false)
  })

  it('tells a window that read an old KDF to read it again, without counting a wrong password', async () => {
    const r = await http('POST', '/vault/unlock', { passwordKey: pwKey, kdfSalt: toB64(randomBytes(16)) })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('kdf_changed')
  })

  it('without the machine file, the password alone opens nothing; with the Secret Key it does', async () => {
    await fsp.rm(path.join(vaultDirPath(), 'machine.json'))
    resetVaultForTest(null)
    resetSessionsForTest()
    session = ''
    expect((await http('GET', '/vault/status')).body).toMatchObject({ open: false, hasSecretKey: false })
    const need = await http('POST', '/vault/unlock', { passwordKey: pwKey })
    expect(need.status).toBe(428)
    expect(need.body.code).toBe('secret_key_needed')
    expect((await http('POST', '/vault/unlock', { passwordKey: pwKey, secretKey: 'W1-AAAAAA-AAAAA-AAAAA-AAAAA-AAAAA' })).body.code).toBe('wrong_password')
    const ok = await http('POST', '/vault/unlock', { passwordKey: pwKey, secretKey: secretKey.toLowerCase() })
    expect(ok.status).toBe(200)
    session = ok.body.session.token
    expect((await http('GET', '/vault/status')).body.hasSecretKey).toBe(true)
  })

  it('changes the master password, locking the other windows', async () => {
    const other = (await http('POST', '/vault/unlock', { passwordKey: pwKey })).body.session.token
    expect((await http('POST', '/vault/password', { oldPassword: 'not it at all', newPassword: 'a whole new test phrase' })).body.code).toBe('wrong_password')
    const r = await http('POST', '/vault/password', { oldPassword: MASTER, newPassword: 'a whole new test phrase' })
    expect(r.status).toBe(200)
    expect(r.body.otherWindowsLocked).toBeGreaterThanOrEqual(1)
    expect((await http('GET', '/vault/items', undefined, { 'x-walnut-vault-session': other })).status).toBe(401)
    expect((await http('GET', '/vault/items')).status).toBe(200)
    session = ''
    expect((await http('POST', '/vault/unlock', { password: MASTER })).body.code).toBe('wrong_password')
    const ok = await http('POST', '/vault/unlock', { password: 'a whole new test phrase' })
    expect(ok.status).toBe(200)
    session = ok.body.session.token
  })

  it('exports only with the master password again', async () => {
    expect((await http('POST', '/vault/export', { password: 'wrong', format: 'csv' })).status).toBe(401)
    const r = await http('POST', '/vault/export', { password: 'a whole new test phrase', format: 'csv' })
    expect(r.status).toBe(200)
    expect(r.body.text).toContain('second-Pass-2!')
    expect(r.body.fileName).toMatch(/\.csv$/)
  })

  it('slows down a run of wrong passwords', async () => {
    resetSessionsForTest()
    let last = 0
    for (let i = 0; i < 6; i++) last = (await http('POST', '/vault/unlock', { password: `guess ${i}` })).status
    expect(last).toBe(429)
    resetSessionsForTest()
  })

  it('counts a burst of parallel guesses one at a time', async () => {
    resetSessionsForTest()
    const wrongKey = toB64(randomBytes(32))
    const all = await Promise.all(Array.from({ length: 12 }, () => http('POST', '/vault/unlock', { passwordKey: wrongKey })))
    const checked = all.filter((r) => r.body.code === 'wrong_password').length
    expect(checked).toBeGreaterThanOrEqual(1)
    expect(checked).toBeLessThanOrEqual(5)
    expect(all.filter((r) => r.body.code === 'unlock_busy' || r.body.code === 'unlock_slowed').length).toBe(12 - checked)
    resetSessionsForTest()
  })
})
