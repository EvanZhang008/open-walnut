/**
 * Unlock with this Mac's keychain (src/core/vault/keychain-unlock.ts) over a real vault in a
 * temp dir, the `security` call stubbed (child-run.ts setVaultRunnerForTest) and the platform
 * forced to macOS: the right item unlocks and opens a session of the chosen length, a wrong one
 * counts as a wrong password, a missing one answers no_item, off macOS it is unavailable, and
 * the password never comes back in any answer. Fake data only.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { derivePasswordKey, randomBytes, toB64 } from '../../../src/core/vault/crypto.js'
import { closeVault, isOpen, resetVaultForTest, setupVault } from '../../../src/core/vault/store.js'
import { setVaultRunnerForTest, type VaultRunner } from '../../../src/core/vault/child-run.js'
import { resetKeychainSecretForTest } from '../../../src/core/vault/keychain-secret.js'
import { KEYCHAIN_SERVICE, keychainItemPresent, removeKeychainItem, setKeychainPlatformForTest, unlockFromKeychain } from '../../../src/core/vault/keychain-unlock.js'
import { liveSessionCount, resetSessionsForTest, unlockWaitMs, useSession } from '../../../src/core/vault/sessions.js'

const MASTER = 'a fake keychain master 42'
let dir = ''
let stored: string | null = MASTER
const calls: string[][] = []
const runner: VaultRunner = async (cmd, args) => {
  calls.push([cmd, ...args])
  if (cmd !== 'security') return { code: 127, stdout: '', stderr: '', timedOut: false, error: 'ENOENT' }
  if (!args.includes(KEYCHAIN_SERVICE)) return { code: 44, stdout: '', stderr: '', timedOut: false }
  if (args[0] === 'delete-generic-password') { const had = stored !== null; stored = null; return { code: had ? 0 : 44, stdout: '', stderr: '', timedOut: false } }
  if (stored === null) return { code: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.', timedOut: false }
  return { code: 0, stdout: args.includes('-w') ? `${stored}\n` : 'keychain: "login.keychain-db"\n', stderr: '', timedOut: false }
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-vault-keychain-'))
  resetVaultForTest(dir)
  const kdf = { name: 'PBKDF2-SHA256' as const, iterations: 600_000, salt: toB64(randomBytes(16)) }
  await setupVault({ passwordKey: toB64(await derivePasswordKey(MASTER, kdf)), kdf, agentsWhileAway: false })
  setVaultRunnerForTest(runner)
}, 60_000)

afterAll(() => {
  setVaultRunnerForTest(null)
  setKeychainPlatformForTest(null)
  resetSessionsForTest()
  resetVaultForTest(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  setKeychainPlatformForTest('darwin')
  resetSessionsForTest()
  closeVault()
  stored = MASTER
  calls.length = 0
  resetKeychainSecretForTest()
})

describe('unlock from the keychain', () => {
  it('reads the item for this user and unlocks like a typed password, with a session', async () => {
    const r = await unlockFromKeychain({ client: 'test window' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(isOpen()).toBe(true)
    expect(useSession(r.session.token, false, undefined)).toMatchObject({ client: 'test window' })
    expect(liveSessionCount()).toBe(1)
    // The default length (48 h) has a clock.
    expect(r.session.expiresAt).toEqual(expect.any(String))
    // Presence first (no secret), then the one read (keychain-secret.ts).
    expect(calls[0]).toEqual(['security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', os.userInfo().username])
    expect(calls[1]).toEqual(['security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', os.userInfo().username, '-w'])
    expect(JSON.stringify(r)).not.toContain(MASTER)
  })

  it('a wrong item is a wrong password: it counts toward the brake and opens nothing', async () => {
    stored = 'wrong-fake-secret-9'
    for (let i = 0; i < 5; i++) {
      const r = await unlockFromKeychain({ client: 'test' })
      expect(r).toMatchObject({ ok: false, code: 'wrong_password' })
      expect(JSON.stringify(r)).not.toContain('wrong-fake-secret-9')
    }
    expect(isOpen()).toBe(false)
    expect(unlockWaitMs()).toBeGreaterThan(0)
    expect(await unlockFromKeychain({ client: 'test' })).toMatchObject({ ok: false, code: 'unlock_slowed' })
  })

  it('no item: no_item, and nothing counted', async () => {
    stored = null
    expect(await unlockFromKeychain({ client: 'test' })).toMatchObject({ ok: false, code: 'no_item' })
    expect(unlockWaitMs()).toBe(0)
    expect(isOpen()).toBe(false)
  })

  it('off macOS: unavailable, and no security call', async () => {
    setKeychainPlatformForTest('linux')
    expect(await unlockFromKeychain({ client: 'test' })).toMatchObject({ ok: false, code: 'unavailable' })
    expect(await keychainItemPresent()).toBe(false)
    expect(calls).toEqual([])
  })

  it('says whether the item is there without reading the password, and removes it', async () => {
    expect(await keychainItemPresent()).toBe(true)
    expect(calls[0]).not.toContain('-w')
    expect(await removeKeychainItem()).toBe(true)
    expect(await keychainItemPresent()).toBe(false)
    expect(await unlockFromKeychain({ client: 'test' })).toMatchObject({ ok: false, code: 'no_item' })
  })
})
