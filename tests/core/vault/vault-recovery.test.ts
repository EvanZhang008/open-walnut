/**
 * The recovery code (src/core/vault/store.ts recoverVault, newRecoveryKit) over a real vault in
 * a temp dir: it sets a new master password and keeps every item, works once (a new code comes
 * back), changes with every new vault key so an old code opens nothing written since (not even
 * through an old backup), needs the Secret Key when this machine lacks it, refuses a wrong or
 * malformed code, a vault set up before recovery codes gets one from a new kit, and a wrap an
 * older Walnut left stale reads as none. Fake data only.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deriveRecoveryKey, derivePasswordKey, fromB64, newRecoveryCode, open, parseRecoveryCode, parseSecretKey, randomBytes, toB64, type KdfParams } from '../../../src/core/vault/crypto.js'
import {
  changeMasterPassword, confirmRecoveryKit, createItems, getItem, listItems, newRecoveryKit, recoverVault, resetVaultForTest, setAgentsWhileAway,
  setupVault, unlockVault, vaultStatus,
} from '../../../src/core/vault/store.js'
import { readPolicy, writePolicy } from '../../../src/core/vault/policy.js'

const dirs: string[] = []
let dir = ''
let pwKey = ''
let newPwKey = ''
let kit = { secretKey: '', recoveryCode: '' }
const kdf: KdfParams = { name: 'PBKDF2-SHA256', iterations: 600_000, salt: toB64(randomBytes(16)) }
const newKdf: KdfParams = { ...kdf, salt: toB64(randomBytes(16)) }
const machinePath = () => path.join(dir, 'machine.json')
const machine = () => JSON.parse(fs.readFileSync(machinePath(), 'utf8'))
const vaultPath = () => path.join(dir, 'vault.json')
const vaultFile = () => JSON.parse(fs.readFileSync(vaultPath(), 'utf8'))

async function setup(agentsWhileAway: boolean): Promise<void> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-vault-recovery-'))
  dirs.push(dir)
  resetVaultForTest(dir)
  const made = await setupVault({ passwordKey: pwKey, kdf, agentsWhileAway })
  kit = { secretKey: made.secretKey, recoveryCode: made.recoveryCode }
}

beforeEach(async () => {
  pwKey ||= toB64(await derivePasswordKey('a fake recovery test master', kdf))
  newPwKey ||= toB64(await derivePasswordKey('a new fake master after recovery', newKdf))
  await setup(false)
}, 60_000)

afterAll(() => {
  resetVaultForTest(null)
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code)

describe('recovery code', () => {
  it('setup returns a recovery code, and it sets a new master password that keeps every item', async () => {
    expect(kit.recoveryCode).toMatch(/^R1-[A-Z2-9]{6}(-[A-Z2-9]{5}){4}$/)
    expect((await vaultStatus()).hasRecovery).toBe(true)
    const [item] = await createItems([{ type: 'login', title: 'Kept', username: 'fake@example.com', password: 'kept-fake-Pass-1' }])
    await writePolicy({ agents: 'allow' })
    resetVaultForTest(dir) // a restart: the vault is closed, and the password is forgotten
    const next = await recoverVault({ recoveryCode: kit.recoveryCode, newPasswordKey: newPwKey, kdf: newKdf })
    expect(next.secretKey).toBe(kit.secretKey)
    expect(next.recoveryCode).not.toBe(kit.recoveryCode)
    expect((await getItem(item.id)).password).toBe('kept-fake-Pass-1')
    expect(await readPolicy()).toEqual({ agents: 'allow' })
    resetVaultForTest(dir)
    expect(await code(unlockVault({ passwordKey: pwKey }))).toBe('wrong_password')
    await unlockVault({ passwordKey: newPwKey })
    expect((await listItems()).map((i) => i.title)).toEqual(['Kept'])
    expect(await readPolicy()).toEqual({ agents: 'allow' })
  })

  it('a kit reads unsaved until the person confirms it, and again after every new code', async () => {
    expect((await vaultStatus()).recoveryUnsaved).toBe(true)
    await confirmRecoveryKit()
    expect(await vaultStatus()).toMatchObject({ hasRecovery: true, recoveryUnsaved: false })
    await changeMasterPassword({ oldPasswordKey: pwKey, newPasswordKey: newPwKey, kdf: newKdf })
    expect((await vaultStatus()).recoveryUnsaved).toBe(true)
    await confirmRecoveryKit()
    await newRecoveryKit(newPwKey)
    expect((await vaultStatus()).recoveryUnsaved).toBe(true)
  })

  it('works once: the old code opens nothing after it was used, the new one does', async () => {
    const next = await recoverVault({ recoveryCode: kit.recoveryCode, newPasswordKey: newPwKey, kdf: newKdf })
    resetVaultForTest(dir)
    expect(await code(recoverVault({ recoveryCode: kit.recoveryCode, newPasswordKey: pwKey, kdf }))).toBe('wrong_recovery_code')
    await recoverVault({ recoveryCode: next.recoveryCode, newPasswordKey: pwKey, kdf })
    resetVaultForTest(dir)
    await unlockVault({ passwordKey: pwKey })
  })

  it('a case-, space- and dash-free code is the same code', async () => {
    const loose = kit.recoveryCode.toLowerCase().replace(/-/g, ' ')
    expect(await code(recoverVault({ recoveryCode: loose, newPasswordKey: newPwKey, kdf: newKdf }))).toBe('ok')
  })

  it('every new vault key brings a new code, and the old one opens nothing (a new password, agents-while-away off)', async () => {
    await setup(true)
    const pw = await changeMasterPassword({ oldPasswordKey: pwKey, newPasswordKey: newPwKey, kdf: newKdf })
    expect(pw.kit!.secretKey).toBe(kit.secretKey)
    expect(pw.kit!.recoveryCode).not.toBe(kit.recoveryCode)
    const off = await setAgentsWhileAway(false, newPwKey)
    expect(off.kit!.recoveryCode).not.toBe(pw.kit!.recoveryCode)
    resetVaultForTest(dir)
    expect((await vaultStatus()).hasRecovery).toBe(true)
    for (const old of [kit.recoveryCode, pw.kit!.recoveryCode]) {
      expect(await code(recoverVault({ recoveryCode: old, newPasswordKey: pwKey, kdf }))).toBe('wrong_recovery_code')
    }
    expect(await code(recoverVault({ recoveryCode: off.kit!.recoveryCode, newPasswordKey: pwKey, kdf }))).toBe('ok')
    // Turning it on adds a key, makes no new vault key, and leaves the code as it is.
    expect(await setAgentsWhileAway(true, pwKey)).toEqual({})
  })

  it('an old code with an old backup of vault.json opens nothing written after a new kit', async () => {
    const [item] = await createItems([{ type: 'login', title: 'Later', password: 'later-fake-Pass-1' }])
    const backup = vaultFile()
    await newRecoveryKit(pwKey)
    const now = vaultFile()
    // The thief has the old kit (Secret Key and code) and the old file: it opens the old vault key...
    const rk = await deriveRecoveryKey(parseRecoveryCode(kit.recoveryCode)!, parseSecretKey(kit.secretKey)!, backup.id)
    const oldKey = await open(rk, backup.wraps.recovery, `walnut-vault:${backup.id}:wrap:recovery`)
    // ...which opens no item key of the vault as it is now.
    await expect(open(oldKey, now.items[item.id].key, `walnut-vault:${now.id}:item-key:${item.id}`)).rejects.toThrow()
    expect((await getItem(item.id)).password).toBe('later-fake-Pass-1')
  })

  it('refuses a wrong code, a malformed one, and a Secret Key of another vault', async () => {
    expect(await code(recoverVault({ recoveryCode: newRecoveryCode(), newPasswordKey: newPwKey, kdf: newKdf }))).toBe('wrong_recovery_code')
    expect(await code(recoverVault({ recoveryCode: 'R1-NOT-A-CODE', newPasswordKey: newPwKey, kdf: newKdf }))).toBe('bad_recovery_code')
    expect(await code(recoverVault({ recoveryCode: kit.secretKey, newPasswordKey: newPwKey, kdf: newKdf }))).toBe('bad_recovery_code')
    const otherSk = 'W1-AAAAAA-AAAAA-AAAAA-AAAAA-AAAAB'
    expect(await code(recoverVault({ recoveryCode: kit.recoveryCode, secretKey: otherSk, newPasswordKey: newPwKey, kdf: newKdf }))).toBe('wrong_recovery_code')
    // Nothing changed: the old password still opens it.
    resetVaultForTest(dir)
    await unlockVault({ passwordKey: pwKey })
  })

  it('needs the Secret Key when this machine lacks it, and keeps the one brought', async () => {
    fs.rmSync(machinePath())
    resetVaultForTest(dir)
    expect(await code(recoverVault({ recoveryCode: kit.recoveryCode, newPasswordKey: newPwKey, kdf: newKdf }))).toBe('secret_key_needed')
    await recoverVault({ recoveryCode: kit.recoveryCode, secretKey: kit.secretKey, newPasswordKey: newPwKey, kdf: newKdf })
    expect(machine().secretKey).toBe(kit.secretKey)
    resetVaultForTest(dir)
    await unlockVault({ passwordKey: newPwKey })
  })

  it('with agents-while-away on, a recovery makes a new machine key and the old one opens nothing', async () => {
    await setup(true)
    const oldMk = fromB64(machine().machineKey)
    await recoverVault({ recoveryCode: kit.recoveryCode, newPasswordKey: newPwKey, kdf: newKdf })
    const f = vaultFile()
    await expect(open(oldMk, f.wraps.machine, `walnut-vault:${f.id}:wrap:machine`)).rejects.toThrow()
    resetVaultForTest(dir)
    expect(await vaultStatus()).toMatchObject({ open: true, agentsWhileAway: true })
  })

  it('a vault set up before recovery codes has none until a new kit makes one', async () => {
    await createItems([{ type: 'note', title: 'Old', notes: 'n' }])
    const f = vaultFile()
    delete f.wraps.recovery
    delete f.recoveryFor
    fs.writeFileSync(vaultPath(), JSON.stringify(f))
    resetVaultForTest(dir)
    expect((await vaultStatus()).hasRecovery).toBe(false)
    expect(await code(recoverVault({ recoveryCode: kit.recoveryCode, newPasswordKey: newPwKey, kdf: newKdf }))).toBe('no_recovery')
    await unlockVault({ passwordKey: pwKey })
    expect(await code(newRecoveryKit(newPwKey))).toBe('wrong_password')
    const made = await newRecoveryKit(pwKey)
    expect(made.secretKey).toBe(kit.secretKey)
    expect((await vaultStatus()).hasRecovery).toBe(true)
    expect(await code(recoverVault({ recoveryCode: made.recoveryCode, newPasswordKey: newPwKey, kdf: newKdf }))).toBe('ok')
  })

  it('a new kit replaces the code: the old one stops working, items stay open', async () => {
    const [item] = await createItems([{ type: 'note', title: 'Still open', notes: 'n' }])
    const made = await newRecoveryKit(pwKey)
    expect((await getItem(item.id)).notes).toBe('n')
    expect(await code(recoverVault({ recoveryCode: kit.recoveryCode, newPasswordKey: newPwKey, kdf: newKdf }))).toBe('wrong_recovery_code')
    expect(await code(recoverVault({ recoveryCode: made.recoveryCode, newPasswordKey: newPwKey, kdf: newKdf }))).toBe('ok')
  })

  it('a recovery wrap an older Walnut left under an earlier key reads as none, and is refused', async () => {
    await createItems([{ type: 'note', title: 'Item', notes: 'n' }])
    const stale = vaultFile()
    await changeMasterPassword({ oldPasswordKey: pwKey, newPasswordKey: newPwKey, kdf: newKdf })
    // An older Walnut, which knows no recovery wraps, rekeys and keeps the old ones as they were.
    const f = vaultFile()
    f.wraps.recovery = stale.wraps.recovery
    f.recoveryFor = stale.recoveryFor
    fs.writeFileSync(vaultPath(), JSON.stringify(f))
    resetVaultForTest(dir)
    expect((await vaultStatus()).hasRecovery).toBe(false)
    expect(await code(recoverVault({ recoveryCode: kit.recoveryCode, newPasswordKey: pwKey, kdf }))).toBe('recovery_stale')
    await unlockVault({ passwordKey: newPwKey })
    const made = await newRecoveryKit(newPwKey)
    expect((await vaultStatus()).hasRecovery).toBe(true)
    expect(await code(recoverVault({ recoveryCode: made.recoveryCode, newPasswordKey: pwKey, kdf }))).toBe('ok')
  })
})
