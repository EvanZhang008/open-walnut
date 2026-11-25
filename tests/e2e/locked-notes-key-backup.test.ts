/**
 * The locked-notes key and the hint are backed up with the data folder (docs/reference/locked-notes.md,
 * "Backup of the key"; the user's pick, 2026-11-25: back up the key and the hint). A locked note
 * still opens after this computer's vault is gone and set up again, once the person restores the key
 * with the old vault's master password and Secret Key. The backup never holds the key in the clear,
 * follows a new master password, and opens with nothing less than both secrets. Fake data only.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-locked-notes-key-backup'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { derivePasswordKey, randomBytes, toB64, type KdfParams } from '../../src/core/vault/crypto.js'
import { resetVaultForTest } from '../../src/core/vault/store.js'
import { resetSessionsForTest } from '../../src/core/vault/sessions.js'
import { keyBackupPath, settleKeyBackup } from '../../src/core/vault/locked-notes-key-backup.js'
import { LOCKED_NOTES_KEY_FIELD } from '../../src/core/vault/locked-notes-key.js'

let base = ''
let session = ''
const kdf: KdfParams = { name: 'PBKDF2-SHA256', iterations: 600_000, salt: toB64(randomBytes(16)) }
const OLD = 'the first master phrase here'
const NEXT = 'a second master phrase later'
const NOTE = 'journal/Backed up.md'
const SECRET = 'pangolinbackupword'

async function http(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(session ? { 'x-walnut-vault-session': session } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let parsed: Record<string, any> = {}
  try { parsed = text ? JSON.parse(text) : {} } catch { parsed = { raw: text } }
  return { status: res.status, body: parsed }
}
const v1 = (method: string, p: string, body?: unknown, headers?: Record<string, string>) => http(method, `/api/v1${p}`, body, headers)
const backup = () => JSON.parse(fs.readFileSync(keyBackupPath(), 'utf8'))

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  resetVaultForTest(null)
  resetSessionsForTest()
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  await stopServer()
})

const vaultFile = () => path.join(WALNUT_HOME, 'vault', 'vault.json')

describe('the locked notes key backup', () => {
  let secretKey = ''
  let keyValue = ''
  let freshKey = ''
  let beforeRestore = ''

  it('is written with the first lock: the vault id, its password wrap, the sealed key item and the hint', async () => {
    expect((await http('PUT', `/api/notes-v2/content/${NOTE}`, { content: `# Backed up\n${SECRET}\n` })).status).toBe(200)
    const setup = await v1('POST', '/vault/setup', { passwordKey: toB64(await derivePasswordKey(OLD, kdf)), kdf, agentsWhileAway: false, client: 'test', hint: 'the first one' })
    expect(setup.status).toBe(200)
    session = setup.body.session.token
    secretKey = setup.body.secretKey
    expect(fs.existsSync(keyBackupPath())).toBe(false) // no key yet, nothing to back up
    expect((await v1('POST', '/vault/notes/lock', { path: NOTE })).status).toBe(200)
    await settleKeyBackup()
    const b = backup()
    expect(b).toMatchObject({ format: 'walnut-locked-notes-key-backup', version: 1, hint: 'the first one' })
    expect(Object.keys(b.items)).toHaveLength(1)
    expect(b.wraps.machine).toBeUndefined()
    expect(b.wraps.recovery).toBeUndefined()
    const items = (await v1('GET', '/vault/items')).body.items as Array<{ id: string; title: string }>
    const keyItem = (await v1('GET', `/vault/items/${items.find((i) => i.title === 'Walnut locked notes key')!.id}`)).body.item
    keyValue = keyItem.fields.find((f: { name: string }) => f.name === LOCKED_NOTES_KEY_FIELD).value
    // Sealed: the key's bytes and the note's text are not in it.
    const raw = fs.readFileSync(keyBackupPath(), 'utf8')
    expect(raw).not.toContain(keyValue)
    expect(raw).not.toContain(SECRET)
  })

  it('follows a new master password and a new hint', async () => {
    const before = backup().wraps.password.ct
    expect((await v1('POST', '/vault/password', { oldPassword: OLD, newPassword: NEXT, hint: 'the second one' })).status).toBe(200)
    session = (await v1('POST', '/vault/unlock', { password: NEXT })).body.session.token
    await settleKeyBackup()
    expect(backup().wraps.password.ct).not.toBe(before)
    expect(backup().hint).toBe('the second one')
  })

  it('opens the note on a vault set up again, after a restore with the master password and Secret Key', async () => {
    // This computer's vault is gone (a new computer): a new vault, another master password.
    const keep = fs.readFileSync(keyBackupPath(), 'utf8')
    resetVaultForTest(null)
    resetSessionsForTest()
    await fsp.rm(path.join(WALNUT_HOME, 'vault'), { recursive: true, force: true })
    session = ''
    const kdf2: KdfParams = { name: 'PBKDF2-SHA256', iterations: 600_000, salt: toB64(randomBytes(16)) }
    const fresh = await v1('POST', '/vault/setup', { passwordKey: toB64(await derivePasswordKey('a brand new vault phrase', kdf2)), kdf: kdf2, agentsWhileAway: false, client: 'test' })
    expect(fresh.status).toBe(200)
    session = fresh.body.session.token
    freshKey = fresh.body.secretKey
    beforeRestore = fs.readFileSync(vaultFile(), 'utf8')
    // The new vault has no key item, so it never touched the backup.
    await settleKeyBackup()
    expect(fs.readFileSync(keyBackupPath(), 'utf8')).toBe(keep)
    expect((await v1('POST', '/vault/notes/read', { path: NOTE })).status).not.toBe(200)

    const info = (await v1('GET', '/vault/notes/key-backup')).body
    expect(info).toMatchObject({ hint: 'the second one', keys: 1, inVault: false })
    const pwKey = async (pw: string) => toB64(await derivePasswordKey(pw, info.kdf))
    // Nothing less than both secrets opens it.
    expect((await v1('POST', '/vault/notes/restore-key', { passwordKey: await pwKey(OLD), secretKey })).body.code).toBe('wrong_password')
    expect((await v1('POST', '/vault/notes/restore-key', { passwordKey: await pwKey(NEXT), secretKey: fresh.body.secretKey })).body.code).toBe('wrong_password')
    // An agent never restores it.
    expect((await v1('POST', '/vault/notes/restore-key', { passwordKey: await pwKey(NEXT), secretKey }, { 'x-walnut-caller-sid': 'sess-agent' })).body.code).toBe('human_only')
    const ok = await v1('POST', '/vault/notes/restore-key', { passwordKey: await pwKey(NEXT), secretKey })
    expect(ok.status).toBe(200)
    expect(ok.body.added).toBe(1)
    const read = await v1('POST', '/vault/notes/read', { path: NOTE })
    expect(read.status).toBe(200)
    expect(read.body.content).toContain(SECRET)
    // The restored key is backed up again under the new vault, and the old vault's backup is kept.
    await settleKeyBackup()
    const now = backup()
    expect(now.vaultId).toBe(fresh.body.vaultId)
    expect(now.earlier.map((e: { vaultId: string }) => e.vaultId)).toEqual([JSON.parse(keep).vaultId])
    const again = await v1('POST', '/vault/notes/restore-key', { passwordKey: await pwKey(NEXT), secretKey, vaultId: JSON.parse(keep).vaultId })
    expect(again.body.added).toBe(0)
    // The note's own key is marked, and a backup whose keys are all in the vault says so.
    const marked = (await v1('GET', `/vault/notes/key-backup?path=${encodeURIComponent(NOTE)}`)).body
    expect(marked.earlier.find((e: { vaultId: string }) => e.vaultId === JSON.parse(keep).vaultId)).toMatchObject({ holdsNoteKey: true })
    expect(marked).toMatchObject({ vaultId: fresh.body.vaultId, inVault: true, holdsNoteKey: false })
  })

  it('keeps the only backup of a key the vault lost under the same vault id (an older vault.json put back)', async () => {
    // This vault's file from before its key came back: the same vault id, no key item.
    const prior = backup()
    resetVaultForTest(null)
    resetSessionsForTest()
    fs.writeFileSync(vaultFile(), beforeRestore)
    session = ''
    const unlocked = await v1('POST', '/vault/unlock', { password: 'a brand new vault phrase', secretKey: freshKey })
    expect(unlocked.status, JSON.stringify(unlocked.body)).toBe(200)
    session = unlocked.body.session.token
    expect((await v1('POST', '/vault/notes/read', { path: NOTE })).body.code).toBe('locked_key_missing')
    // A new lock makes a new key: the backup of the key it lost stays, with its own wrap.
    expect((await http('PUT', '/api/notes-v2/content/journal/Second.md', { content: '# Second\nanother word\n' })).status).toBe(200)
    expect((await v1('POST', '/vault/notes/lock', { path: 'journal/Second.md' })).status).toBe(200)
    await settleKeyBackup()
    const now = backup()
    expect(now.vaultId).toBe(prior.vaultId)
    expect(Object.keys(now.items)).not.toEqual(Object.keys(prior.items))
    const lost = now.earlier.find((e: { vaultId: string; items: Record<string, unknown> }) => e.vaultId === prior.vaultId)
    expect(Object.keys(lost.items)).toEqual(Object.keys(prior.items))
    // Restored by that entry, the first note opens again.
    const info = (await v1('GET', '/vault/notes/key-backup')).body
    const entry = info.earlier.find((e: { vaultId: string }) => e.vaultId === prior.vaultId)
    expect(entry).toMatchObject({ inVault: false })
    const ok = await v1('POST', '/vault/notes/restore-key', { passwordKey: toB64(await derivePasswordKey('a brand new vault phrase', entry.kdf)), secretKey: freshKey, entry: entry.entry })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body.added).toBe(1)
    expect((await v1('POST', '/vault/notes/read', { path: NOTE })).body.content).toContain(SECRET)
  })

  it('sets a file that does not read aside instead of writing over it', async () => {
    fs.writeFileSync(keyBackupPath(), '<<<<<<< ours\n{ not json\n')
    // The next open of the vault writes the backup again; the damaged file stays beside it.
    const again = await v1('POST', '/vault/unlock', { password: 'a brand new vault phrase', secretKey: freshKey })
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    session = again.body.session.token
    await settleKeyBackup()
    expect(backup().format).toBe('walnut-locked-notes-key-backup')
    const aside = fs.readdirSync(WALNUT_HOME).filter((f) => f.startsWith('locked-notes-key-backup.unreadable-'))
    expect(aside).toHaveLength(1)
    expect(fs.readFileSync(path.join(WALNUT_HOME, aside[0]!), 'utf8')).toContain('<<<<<<< ours')
  })
})
