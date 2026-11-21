/**
 * Passkeys through the Bitwarden sync (src/core/vault/sources/bitwarden/sync.ts) over a real vault
 * in a temp dir: a login imported by hand before the first sync (the same fields, so adopted as
 * unchanged) still gets Bitwarden's passkey; one deleted in Walnut stays deleted; one Bitwarden
 * added while the login sat in Walnut's trash still comes once it is restored. Fake data only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { derivePasswordKey, randomBytes, toB64 } from '../../../src/core/vault/crypto.js'
import { allItems, createItems, resetVaultForTest, setupVault, updateItem, trashItem, restoreItem } from '../../../src/core/vault/store.js'
import { syncFromBitwarden } from '../../../src/core/vault/sources/bitwarden/sync.js'
import type { VaultItem } from '../../../src/core/vault/types.js'

let dir = ''

const fido = (id: string) => ({ credentialId: id, keyType: 'public-key', keyAlgorithm: 'ECDSA', keyCurve: 'P-256', keyValue: `fake-key-${id}`, rpId: 'shop.example.test', userHandle: 'dXNlcg', userName: 'a@example.test', counter: '0', rpName: 'Shop', discoverable: 'true', creationDate: '2026-11-01T00:00:00Z' })
const shop = (pks: string[], rev = '2026-11-01T00:00:00Z') => JSON.stringify({ encrypted: false, folders: [], items: [
  { id: 'bw-shop', revisionDate: rev, type: 1, name: 'Shop', login: { username: 'a@example.test', password: 'shop-fake-1', uris: [{ uri: 'https://shop.example.test' }], fido2Credentials: pks.map(fido) } },
] })
const theShop = async (): Promise<VaultItem> => (await allItems()).find((i) => i.title === 'Shop')!
const pkIds = (i: VaultItem) => (i.passkeys ?? []).map((p) => (p as { credentialId?: string }).credentialId)

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-vault-bw-pk-'))
  resetVaultForTest(dir)
  const kdf = { name: 'PBKDF2-SHA256' as const, iterations: 600_000, salt: toB64(randomBytes(16)) }
  await setupVault({ passwordKey: toB64(await derivePasswordKey('a fake bitwarden master', kdf)), kdf, agentsWhileAway: false })
  // Imported by hand from another manager first (no passkeys there, the same fields as Bitwarden's).
  await createItems([{ type: 'login', title: 'Shop', username: 'a@example.test', password: 'shop-fake-1', urls: ['https://shop.example.test'] }])
}, 60_000)

afterAll(() => {
  resetVaultForTest(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('passkeys through the Bitwarden sync', () => {
  it('an adopted login with the same fields still gets Bitwarden\'s passkey, and keeps it', async () => {
    await syncFromBitwarden(shop(['b1']), 'agent')
    expect(pkIds(await theShop())).toEqual(['b1'])
    await syncFromBitwarden(shop(['b1']), 'agent')
    expect(pkIds(await theShop())).toEqual(['b1'])
  })

  it('a passkey deleted in Walnut stays deleted on the next sync', async () => {
    const it0 = await theShop()
    await updateItem(it0.id, { ...it0, passkeys: [] }, it0.updatedAt)
    await syncFromBitwarden(shop(['b1']), 'agent')
    expect(pkIds(await theShop())).toEqual([])
  })

  it('one Bitwarden added while the login was in the trash comes once it is restored', async () => {
    const it0 = await theShop()
    await trashItem(it0.id)
    await syncFromBitwarden(shop(['b1', 'b2']), 'agent')
    await restoreItem(it0.id)
    await syncFromBitwarden(shop(['b1', 'b2']), 'agent')
    expect(pkIds(await theShop())).toEqual(['b2'])
  })
})
