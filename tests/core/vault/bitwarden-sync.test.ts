/**
 * The Bitwarden sync (src/core/vault/sources/bitwarden/sync.ts, run.ts) over a real vault in a
 * temp dir, with fake exports: an earlier plain import adopted rather than duplicated, a new item
 * added, a changed one updated (keeping what only Walnut has), a change on both sides kept twice
 * with the Walnut copy tagged conflict, a deleted one moved to the trash, counts per type; and
 * the run of `bw` itself with the runner stubbed. Fake data only.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { derivePasswordKey, randomBytes, toB64 } from '../../../src/core/vault/crypto.js'
import { allItems, closeVault, createItems, getItem, isOpen, resetVaultForTest, setupVault, unlockVault, updateItem } from '../../../src/core/vault/store.js'
import { parseImport } from '../../../src/core/vault/import.js'
import { CONFLICT_TAG, lastSyncReport, syncFromBitwarden, syncSummary } from '../../../src/core/vault/sources/bitwarden/sync.js'
import { msUntilNextRun, runBitwardenSync } from '../../../src/core/vault/sources/bitwarden/run.js'
import { setVaultRunnerForTest } from '../../../src/core/vault/child-run.js'
import type { VaultItem } from '../../../src/core/vault/types.js'

let dir = ''
let pwKey = ''

interface BwItem { id: string; revisionDate: string; type: number; name: string; notes?: string; login?: Record<string, unknown>; card?: Record<string, unknown>; identity?: Record<string, unknown>; reprompt?: number }
const exportOf = (items: BwItem[]) => JSON.stringify({ encrypted: false, folders: [], items })

const GITHUB: BwItem = { id: 'bw-1', revisionDate: '2026-11-01T00:00:00Z', type: 1, name: 'GitHub', login: { username: 'bot@example.test', password: 'gh-fake-1', uris: [{ uri: 'https://github.com' }] } }
const NOTE: BwItem = { id: 'bw-2', revisionDate: '2026-11-01T00:00:00Z', type: 2, name: 'Wifi', notes: 'fake-wifi-pass' }
const CARD: BwItem = { id: 'bw-3', revisionDate: '2026-11-01T00:00:00Z', type: 3, name: 'Visa', card: { cardholderName: 'A', number: '4111111111111111', expMonth: '1', expYear: '2030', code: '123' } }
const ME: BwItem = { id: 'bw-4', revisionDate: '2026-11-01T00:00:00Z', type: 4, name: 'Me', identity: { firstName: 'Ada', email: 'ada@example.test' } }
const SHOP: BwItem = { id: 'bw-5', revisionDate: '2026-11-01T00:00:00Z', type: 1, name: 'Shop', login: { username: 'a@example.test', password: 'shop-fake-1', uris: [{ uri: 'https://shop.example.test' }] } }

const byTitle = async (t: string): Promise<VaultItem[]> => (await allItems()).filter((i) => i.title === t)

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-vault-bw-'))
  resetVaultForTest(dir)
  const kdf = { name: 'PBKDF2-SHA256' as const, iterations: 600_000, salt: toB64(randomBytes(16)) }
  pwKey = toB64(await derivePasswordKey('a fake bitwarden master', kdf))
  await setupVault({ passwordKey: pwKey, kdf, agentsWhileAway: false })
  // The person imported from Bitwarden once by hand (no Bitwarden ids kept on the items), then
  // made one item of their own in Walnut.
  await createItems(parseImport(exportOf([GITHUB, NOTE, CARD])).items)
  await createItems([{ type: 'api_key', title: 'Own key', password: 'own-fake', envName: 'OWN_KEY' }])
}, 60_000)

afterAll(() => {
  setVaultRunnerForTest(null)
  resetVaultForTest(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('sync from a Bitwarden export', () => {
  it('first sync: adopts the plain import (no duplicates), adds what is new, counts per type', async () => {
    const r = await syncFromBitwarden(exportOf([GITHUB, NOTE, CARD, ME, SHOP]), 'agent')
    expect(r.counts).toEqual({ added: 2, updated: 0, trashed: 0, conflicts: 0, unchanged: 3, ambiguous: 0 })
    expect(r.byType.login).toEqual({ added: 1, updated: 0, trashed: 0, conflicts: 0, unchanged: 1, ambiguous: 0 })
    expect(r.byType.identity).toMatchObject({ added: 1 })
    expect(r.bitwarden).toEqual({ login: 2, note: 1, card: 1, identity: 1 })
    expect(r.linked).toEqual(r.bitwarden)
    expect(await byTitle('GitHub')).toHaveLength(1)
    expect(await byTitle('Own key')).toHaveLength(1)
    expect(syncSummary(r)).toBe('2 added, 0 updated, 0 moved to the trash, 0 conflicts, 3 unchanged')
    // The same export again changes nothing.
    expect((await syncFromBitwarden(exportOf([GITHUB, NOTE, CARD, ME, SHOP]), 'agent')).counts).toMatchObject({ added: 0, unchanged: 5 })
  })

  it('adopting an item whose fields differ updates it', async () => {
    const own = (await createItems([{ type: 'login', title: 'Forum', username: 'u@example.test', password: 'old-fake', urls: ['https://forum.example.test'] }]))[0]
    const FORUM: BwItem = { id: 'bw-6', revisionDate: '2026-11-02T00:00:00Z', type: 1, name: 'Forum', login: { username: 'u@example.test', password: 'new-fake', uris: [{ uri: 'https://forum.example.test' }] } }
    const r = await syncFromBitwarden(exportOf([GITHUB, NOTE, CARD, ME, SHOP, FORUM]), 'agent')
    expect(r.counts).toMatchObject({ added: 0, updated: 1, unchanged: 5 })
    const after = await getItem(own.id)
    expect(after.password).toBe('new-fake')
    expect(after.passwordHistory?.[0].password).toBe('old-fake')
  })

  it('changed in Bitwarden only: updated, keeping what only Walnut has; a Walnut-only setting is no conflict', async () => {
    const [gh] = await byTitle('GitHub')
    await updateItem(gh.id, { ...gh, agentAccess: 'never', envName: 'GH_TOKEN' })
    const NEW_GH = { ...GITHUB, revisionDate: '2026-11-03T00:00:00Z', login: { ...GITHUB.login, password: 'gh-fake-2' } }
    const FORUM = { id: 'bw-6', revisionDate: '2026-11-02T00:00:00Z', type: 1, name: 'Forum', login: { username: 'u@example.test', password: 'new-fake', uris: [{ uri: 'https://forum.example.test' }] } }
    const r = await syncFromBitwarden(exportOf([NEW_GH, NOTE, CARD, ME, SHOP, FORUM]), 'agent')
    expect(r.counts).toMatchObject({ updated: 1, conflicts: 0, unchanged: 5 })
    const after = await getItem(gh.id)
    expect(after).toMatchObject({ password: 'gh-fake-2', agentAccess: 'never', envName: 'GH_TOKEN' })
    expect(after.passwordHistory?.[0].password).toBe('gh-fake-1')
  })

  it('changed on both sides: both kept, the Walnut copy tagged conflict and no longer synced', async () => {
    const [shop] = await byTitle('Shop')
    await updateItem(shop.id, { ...shop, password: 'shop-walnut-edit' })
    const NEW_SHOP = { ...SHOP, revisionDate: '2026-11-04T00:00:00Z', login: { ...SHOP.login, password: 'shop-bitwarden-edit' } }
    const FORUM = { id: 'bw-6', revisionDate: '2026-11-02T00:00:00Z', type: 1, name: 'Forum', login: { username: 'u@example.test', password: 'new-fake', uris: [{ uri: 'https://forum.example.test' }] } }
    const NEW_GH = { ...GITHUB, revisionDate: '2026-11-03T00:00:00Z', login: { ...GITHUB.login, password: 'gh-fake-2' } }
    const r = await syncFromBitwarden(exportOf([NEW_GH, NOTE, CARD, ME, NEW_SHOP, FORUM]), 'agent')
    expect(r.counts).toMatchObject({ conflicts: 1, updated: 0, added: 0 })
    const shops = await byTitle('Shop')
    expect(shops).toHaveLength(2)
    expect(shops.find((i) => i.id === shop.id)).toMatchObject({ password: 'shop-walnut-edit', tags: [CONFLICT_TAG] })
    expect(shops.find((i) => i.id !== shop.id)).toMatchObject({ password: 'shop-bitwarden-edit' })
    // The next sync leaves the conflict copy alone.
    expect((await syncFromBitwarden(exportOf([NEW_GH, NOTE, CARD, ME, NEW_SHOP, FORUM]), 'agent')).counts).toMatchObject({ unchanged: 6, conflicts: 0 })
  })

  it('gone from Bitwarden: moved to the trash, never deleted; the item of Walnut\'s own is untouched', async () => {
    const r = await syncFromBitwarden(exportOf([GITHUB, NOTE]), 'daily')
    expect(r.counts.trashed).toBe(4) // card, identity, shop, forum
    expect(r.byType.card).toMatchObject({ trashed: 1 })
    const [visa] = await byTitle('Visa')
    expect(visa.trashedAt).toEqual(expect.any(String))
    expect((await byTitle('Own key'))[0].trashedAt).toBeUndefined()
    expect(r.linked).toEqual({ login: 1, note: 1 })
    expect((await lastSyncReport())?.trigger).toBe('daily')
  })

  it('refuses an encrypted export or a file that is not one, and needs the vault open', async () => {
    await expect(syncFromBitwarden(JSON.stringify({ encrypted: true, items: [] }), 'agent')).rejects.toThrow(/encrypted/)
    await expect(syncFromBitwarden('{"nope":1}', 'agent')).rejects.toThrow(/not a Bitwarden export/)
    closeVault()
    await expect(syncFromBitwarden(exportOf([GITHUB]), 'agent')).rejects.toMatchObject({ code: 'vault_locked' })
    await unlockVault({ passwordKey: pwKey })
  })
})

describe('Walnut running bw itself', () => {
  afterEach(() => { setVaultRunnerForTest(null); delete process.env.BW_SESSION })

  it('runs bw sync, then bw export, with BW_SESSION, and syncs the export it got', async () => {
    process.env.BW_SESSION = 'fake-bw-session'
    const seen: Array<{ cmd: string; args: string[]; session?: string }> = []
    setVaultRunnerForTest(async (cmd, args, opts) => {
      seen.push({ cmd, args, session: opts.env?.BW_SESSION })
      if (args[0] === 'export') return { code: 0, stdout: exportOf([GITHUB, NOTE]), stderr: '', timedOut: false }
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    })
    const r = await runBitwardenSync('person')
    expect(r.ok).toBe(true)
    expect(seen.map((x) => [x.cmd, ...x.args])).toEqual([['bw', 'sync'], ['bw', 'export', '--format', 'json', '--raw']])
    expect(seen.every((x) => x.session === 'fake-bw-session')).toBe(true)
  })

  it('a bw failure is the reason shown, and nothing changes', async () => {
    process.env.BW_SESSION = 'fake-bw-session'
    setVaultRunnerForTest(async () => ({ code: 1, stdout: '', stderr: 'You are not logged in.', timedOut: false }))
    const before = (await allItems()).length
    const r = await runBitwardenSync('daily')
    expect(r).toMatchObject({ ok: false, error: 'bw sync failed: You are not logged in.' })
    expect((await allItems()).length).toBe(before)
    expect(syncSummary(r)).toMatch(/^not synced/)
  })

  it('a locked vault with no keychain item: skipped, the reason kept for Settings', async () => {
    closeVault()
    const r = await runBitwardenSync('daily')
    expect(r).toMatchObject({ ok: false, error: 'Passwords is locked' })
    expect(isOpen()).toBe(false)
    expect((await lastSyncReport())?.error).toBe('Passwords is locked')
    await unlockVault({ passwordKey: pwKey })
  })

  it('the daily run is at 04:00 local', () => {
    const at = new Date(2026, 10, 4, 3, 30, 0)
    expect(msUntilNextRun(at)).toBe(30 * 60_000)
    expect(msUntilNextRun(new Date(2026, 10, 4, 4, 0, 0))).toBe(24 * 3_600_000)
  })
})
