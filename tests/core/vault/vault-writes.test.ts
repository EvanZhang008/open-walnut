/**
 * How the vault store writes (src/core/vault/state.ts, store.ts) over a real vault in a temp
 * dir: reads racing writes lose nothing, a close wins over a change still running, a side
 * file sealed under a new key is found when a rekey stopped half way, a machine key that no
 * longer opens the vault is not fatal, a new master password makes a new machine key, and a
 * new vault never writes over another vault's machine file. Fake data only.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

// A slow disk: a rename returns a little late, which widens the moment between a write renaming its file
// and the store recording it. A read that took that new file for an outside change (a backup
// put back) and decrypted it again would then overwrite newer items in memory.
const slow = vi.hoisted(() => ({ on: false }))
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>()
  const rename = (async (from: string, to: string) => {
    await real.rename(from, to)
    // The new file is in place; the writer hears so only a moment later.
    if (slow.on && String(to).endsWith('vault.json')) await new Promise((r) => setTimeout(r, 30))
  }) as typeof real.rename
  return { ...real, rename, default: { ...real, rename } }
})
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { derivePasswordKey, fromB64, open, randomBytes, toB64, type KdfParams } from '../../../src/core/vault/crypto.js'
import {
  changeMasterPassword, closeVault, createItems, isOpen, listItems, getItem, resetVaultForTest, setAgentsWhileAway, setupVault,
  unlockVault, vaultStatus,
} from '../../../src/core/vault/store.js'
import { readPolicy, writePolicy } from '../../../src/core/vault/policy.js'

const dirs: string[] = []
let dir = ''
let pwKey = ''
const kdf: KdfParams = { name: 'PBKDF2-SHA256', iterations: 600_000, salt: toB64(randomBytes(16)) }
const machine = () => JSON.parse(fs.readFileSync(path.join(dir, 'machine.json'), 'utf8'))
const vaultFile = () => JSON.parse(fs.readFileSync(path.join(dir, 'vault.json'), 'utf8'))

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-vault-writes-'))
  dirs.push(dir)
  resetVaultForTest(dir)
  pwKey ||= toB64(await derivePasswordKey('a fake writes test master', kdf))
  await setupVault({ passwordKey: pwKey, kdf, agentsWhileAway: true })
}, 60_000)

afterAll(() => {
  resetVaultForTest(null)
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})

/** Forget everything in memory, as a restart does, and open the vault from disk. */
async function reopen(): Promise<void> {
  resetVaultForTest(dir)
  await unlockVault({ passwordKey: pwKey })
}

describe('vault writes', () => {
  it('reads racing writes lose no write, in memory or on disk', async () => {
    // Enough items that decrypting the file again takes a while, so a read that mistook our own
    // write for an outside change would still be decrypting when the next write lands.
    await createItems(Array.from({ length: 3000 }, (_, i) => ({ type: 'note' as const, title: `Base ${i}`, notes: 'n' })))
    slow.on = true
    const writes: Array<Promise<unknown>> = []
    for (let i = 0; i < 40; i++) writes.push(createItems([{ type: 'note', title: `Note ${i}`, notes: `body ${i}` }]))
    let done = false
    const all = Promise.all(writes).finally(() => { done = true })
    // Readers keep reading while the writes land, as open windows and agents do.
    const reader = async () => { while (!done) { await listItems(); await vaultStatus() } }
    try {
      await Promise.all([all, reader(), reader(), reader(), reader()])
    } finally {
      slow.on = false
    }
    const want = [...Array.from({ length: 3000 }, (_, i) => `Base ${i}`), ...Array.from({ length: 40 }, (_, i) => `Note ${i}`)].sort()
    expect((await listItems()).map((i) => i.title).sort()).toEqual(want)
    expect(Object.keys(vaultFile().items).length).toBe(3040)
    await reopen()
    expect((await listItems()).map((i) => i.title).sort()).toEqual(want)
  }, 120_000)

  it('a close wins over a change still running: the write stands, nothing goes back into memory', async () => {
    await setAgentsWhileAway(false, pwKey)
    const batch = Array.from({ length: 150 }, (_, i) => ({ type: 'note' as const, title: `Batch ${i}`, notes: 'n' }))
    const made = createItems(batch).then(() => 'written', (err: { code?: string }) => err.code)
    await new Promise((r) => setTimeout(r, 2))
    closeVault()
    const outcome = await made
    // Whenever the close landed, the vault is closed after it; a write that got in is on disk.
    expect(isOpen()).toBe(false)
    await unlockVault({ passwordKey: pwKey })
    expect((await listItems()).length).toBe(outcome === 'written' ? 150 : 0)
  }, 60_000)

  it('a side file sealed under the new key is found when a rekey stopped before renaming it', async () => {
    await writePolicy({ agents: 'allow' })
    const file = path.join(dir, 'policy.json')
    fs.copyFileSync(file, `${file}.next`)
    const body = JSON.parse(fs.readFileSync(file, 'utf8'))
    body.data.ct = Buffer.from('sealed under a key that is gone').toString('base64')
    fs.writeFileSync(file, JSON.stringify(body))
    expect(await readPolicy()).toEqual({ agents: 'allow' })
    await writePolicy({ agents: 'off' })
    expect(fs.existsSync(`${file}.next`)).toBe(false)
    expect(await readPolicy()).toEqual({ agents: 'off' })
  })

  it('side files survive a rekey (agents-while-away off, a new master password)', async () => {
    await writePolicy({ agents: 'allow' })
    await setAgentsWhileAway(false, pwKey)
    expect(await readPolicy()).toEqual({ agents: 'allow' })
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.next'))).toEqual([])
    await reopen()
    expect(await readPolicy()).toEqual({ agents: 'allow' })
  })

  it('a machine key that no longer opens the vault is not fatal: the password still opens it', async () => {
    await createItems([{ type: 'note', title: 'Kept', notes: 'n' }])
    const m = machine()
    fs.writeFileSync(path.join(dir, 'machine.json'), JSON.stringify({ ...m, machineKey: toB64(randomBytes(32)) }))
    resetVaultForTest(dir)
    expect(await vaultStatus()).toMatchObject({ setUp: true, open: false })
    await unlockVault({ passwordKey: pwKey })
    expect((await listItems()).map((i) => i.title)).toEqual(['Kept'])
    // Turning it on again repairs the pair.
    await setAgentsWhileAway(true, pwKey)
    resetVaultForTest(dir)
    expect((await vaultStatus()).open).toBe(true)
  })

  it('a new master password makes a new machine key, and the old one opens nothing written since', async () => {
    const [item] = await createItems([{ type: 'login', title: 'Rotated', password: 'rot-fake-Pass-1' }])
    const oldMk = fromB64(machine().machineKey)
    const newKdf: KdfParams = { ...kdf, salt: toB64(randomBytes(16)) }
    const newPw = toB64(await derivePasswordKey('a second fake master', newKdf))
    await changeMasterPassword({ oldPasswordKey: pwKey, newPasswordKey: newPw, kdf: newKdf })
    const f = vaultFile()
    expect(machine().machineKey).not.toBe(toB64(oldMk))
    await expect(open(oldMk, f.wraps.machine, `walnut-vault:${f.id}:wrap:machine`)).rejects.toThrow()
    resetVaultForTest(dir)
    expect((await vaultStatus()).open).toBe(true)
    expect((await getItem(item.id)).password).toBe('rot-fake-Pass-1')
  })

  it('a new vault sets another vault\'s machine file aside instead of writing over it', async () => {
    const first = machine()
    fs.rmSync(path.join(dir, 'vault.json'))
    resetVaultForTest(dir)
    await setupVault({ passwordKey: pwKey, kdf, agentsWhileAway: false })
    expect(machine().vaultId).not.toBe(first.vaultId)
    const aside = fs.readdirSync(dir).filter((n) => n.startsWith(`machine-${first.vaultId}`))
    expect(aside).toHaveLength(1)
    expect(JSON.parse(fs.readFileSync(path.join(dir, aside[0]), 'utf8')).secretKey).toBe(first.secretKey)
  })
})
