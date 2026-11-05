/**
 * The Bitwarden sync's guards (src/core/vault/sources/bitwarden/sync.ts): an export item that does not
 * read never trashes its linked copy, a sync that would trash many linked items is refused unless
 * a person allows it, an ambiguous adoption adds instead, and adoption keeps the Walnut item's own
 * agent access and sensitive mark. A real vault in a temp dir, fake data only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { derivePasswordKey, randomBytes, toB64 } from '../../../src/core/vault/crypto.js'
import { allItems, createItems, getItem, resetVaultForTest, setupVault } from '../../../src/core/vault/store.js'
import { syncFromBitwarden } from '../../../src/core/vault/sources/bitwarden/sync.js'
import type { VaultItem } from '../../../src/core/vault/types.js'

let dir = ''

interface BwItem { id: string; revisionDate: string; type: number; name: string; notes?: string; login?: Record<string, unknown> }
const exportOf = (items: unknown[]) => JSON.stringify({ encrypted: false, folders: [], items })
const login = (n: number, extra: Partial<BwItem> = {}): BwItem => ({
  id: `bw-g-${n}`, revisionDate: '2026-11-01T00:00:00Z', type: 1, name: `Site ${n}`,
  login: { username: `u${n}@example.test`, password: `fake-${n}`, uris: [{ uri: `https://s${n}.example.test` }] }, ...extra,
})
const byTitle = async (t: string): Promise<VaultItem[]> => (await allItems()).filter((i) => i.title === t && !i.trashedAt)

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-vault-bwg-'))
  resetVaultForTest(dir)
  const kdf = { name: 'PBKDF2-SHA256' as const, iterations: 600_000, salt: toB64(randomBytes(16)) }
  await setupVault({ passwordKey: toB64(await derivePasswordKey('a fake guard master', kdf)), kdf, agentsWhileAway: false })
}, 60_000)

afterAll(() => {
  resetVaultForTest(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('Bitwarden sync guards', () => {
  const ten = Array.from({ length: 10 }, (_, i) => login(i + 1))

  it('an export item that does not read keeps its linked copy (not trashed, still linked)', async () => {
    expect((await syncFromBitwarden(exportOf(ten), 'person')).counts.added).toBe(10)
    // Item 1 is still in Bitwarden, but this time with an unknown type: skipped, not gone.
    const broken = { ...ten[0], type: 99 }
    const r = await syncFromBitwarden(exportOf([broken, ...ten.slice(1)]), 'agent')
    expect(r.counts.trashed).toBe(0)
    expect(r.skipped).toEqual([expect.objectContaining({ title: 'Site 1' })])
    expect(await byTitle('Site 1')).toHaveLength(1)
    expect(r.linked.login).toBe(10)
    // The next good export finds it linked as before: unchanged, not a second copy.
    expect((await syncFromBitwarden(exportOf(ten), 'agent')).counts).toMatchObject({ unchanged: 10, added: 0 })
  })

  it('a sync that would trash more than 20% (and more than 5) of the linked items is refused unless a person allows it', async () => {
    const before = (await allItems()).filter((i) => !i.trashedAt).length
    await expect(syncFromBitwarden(exportOf(ten.slice(0, 4)), 'agent')).rejects.toMatchObject({ code: 'sync_mass_trash', status: 409 })
    await expect(syncFromBitwarden(exportOf(ten.slice(0, 4)), 'daily')).rejects.toMatchObject({ code: 'sync_mass_trash' })
    expect((await allItems()).filter((i) => !i.trashedAt).length).toBe(before)
    // Five gone is allowed (not more than 5).
    expect((await syncFromBitwarden(exportOf(ten.slice(0, 5)), 'agent')).counts.trashed).toBe(5)
    expect((await syncFromBitwarden(exportOf(ten), 'agent')).counts.added).toBe(5)
    // The person's session allows it.
    expect((await syncFromBitwarden(exportOf(ten.slice(0, 4)), 'person', { allowMassTrash: true })).counts.trashed).toBe(6)
  })

  it('adoption with more than one candidate on either side adds instead (ambiguous)', async () => {
    const same = { type: 'login' as const, title: 'Twin', username: 'twin@example.test', password: 'fake-twin', urls: ['https://twin.example.test'] }
    await createItems([same, { ...same, password: 'fake-twin-2' }])
    const TWIN: BwItem = { id: 'bw-twin', revisionDate: '2026-11-01T00:00:00Z', type: 1, name: 'Twin', login: { username: 'twin@example.test', password: 'fake-twin', uris: [{ uri: 'https://twin.example.test' }] } }
    const r = await syncFromBitwarden(exportOf([...ten.slice(0, 4), TWIN]), 'agent')
    expect(r.counts).toMatchObject({ ambiguous: 1, unchanged: 4, added: 0 })
    expect(await byTitle('Twin')).toHaveLength(3)

    // Two Bitwarden items, one Walnut look-alike: neither adopts it.
    await createItems([{ type: 'login', title: 'Pair', username: 'p@example.test', password: 'fake-pair', urls: ['https://pair.example.test'] }])
    const pair = (id: string): BwItem => ({ id, revisionDate: '2026-11-01T00:00:00Z', type: 1, name: 'Pair', login: { username: 'p@example.test', password: 'fake-pair', uris: [{ uri: 'https://pair.example.test' }] } })
    const r2 = await syncFromBitwarden(exportOf([...ten.slice(0, 4), TWIN, pair('bw-p1'), pair('bw-p2')]), 'agent')
    expect(r2.counts).toMatchObject({ ambiguous: 2, unchanged: 5 })
    expect(await byTitle('Pair')).toHaveLength(3)
  })

  it('adoption keeps the Walnut item\'s own agent access and sensitive mark', async () => {
    const [own] = await createItems([{ type: 'login', title: 'Bank', username: 'b@example.test', password: 'old-fake', urls: ['https://bank.example.test'], agentAccess: 'never' }])
    // Bitwarden's copy differs (new password) and asks for a master password reprompt (sensitive).
    const BANK = { id: 'bw-bank', revisionDate: '2026-11-02T00:00:00Z', type: 1, name: 'Bank', reprompt: 1, login: { username: 'b@example.test', password: 'new-fake', uris: [{ uri: 'https://bank.example.test' }] } }
    const r = await syncFromBitwarden(exportOf([...ten.slice(0, 4), BANK]), 'agent', { allowMassTrash: true })
    expect(r.counts).toMatchObject({ updated: 1 })
    const after = await getItem(own.id)
    expect(after.password).toBe('new-fake')
    expect(after.agentAccess).toBe('never')
    expect(after.sensitive).toBeUndefined()
  })
})
