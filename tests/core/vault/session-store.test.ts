/**
 * The open Passwords windows kept across a Walnut restart (src/core/vault/session-store.ts), over a
 * real vault in a temp dir with the keychain's `security` call stubbed (child-run.ts): the file holds
 * hashes only, a restart restores them when the vault reopens by itself (the keychain, the machine
 * key) and drops them when it cannot, when the computer restarted, when they ran out, when the file
 * was forged, and when a new master password replaced the vault key. Fake data only.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-vault-session-store'))

import { getConfig, updateConfig } from '../../../src/core/config-manager.js'
import { derivePasswordKey, randomBytes, toB64, type KdfParams } from '../../../src/core/vault/crypto.js'
import { changeMasterPassword, closeVault, isOpen, resetVaultForTest, setAgentsWhileAway, setupVault } from '../../../src/core/vault/store.js'
import { setVaultRunnerForTest, type VaultRunner } from '../../../src/core/vault/child-run.js'
import { resetKeychainSecretForTest } from '../../../src/core/vault/keychain-secret.js'
import { KEYCHAIN_SERVICE, setKeychainPlatformForTest, unlockFromKeychain } from '../../../src/core/vault/keychain-unlock.js'
import { createSession, endAllSessions, endOtherSessions, liveSessionCount, resetSessionsForTest, retimeSessions, useSession } from '../../../src/core/vault/sessions.js'
import { flushSessionStoreForTest, lastRestoreForTest, saveSessionsNow, sessionsRestored, setBootForTest, simulateRestartForTest } from '../../../src/core/vault/session-store.js'
import { keepOldIdleLock } from '../../../src/core/vault/unlock-migrate.js'
import { unlockChoice } from '../../../src/core/vault/unlock-length.js'

const MASTER = 'a fake session store master 7'
const NEXT = 'a fake next master password 8'
let dir = ''
let kdf: KdfParams
let keychainHolds: string | null = MASTER
const runner: VaultRunner = async (cmd, args) => {
  if (cmd !== 'security' || !args.includes(KEYCHAIN_SERVICE) || keychainHolds === null) return { code: 44, stdout: '', stderr: '', timedOut: false }
  return { code: 0, stdout: args.includes('-w') ? `${keychainHolds}\n` : 'keychain: "login.keychain-db"\n', stderr: '', timedOut: false }
}
const pwKey = async (pw: string, k = kdf) => toB64(await derivePasswordKey(pw, k))
const file = () => path.join(dir, 'sessions.json')
const FOR_48H = unlockChoice({ unlock_for: '48h' }, false).limits

async function restart(): Promise<void> {
  await simulateRestartForTest()
  await sessionsRestored()
  await flushSessionStoreForTest()
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-vault-sessions-'))
  resetVaultForTest(dir)
  kdf = { name: 'PBKDF2-SHA256', iterations: 600_000, salt: toB64(randomBytes(16)) }
  await setupVault({ passwordKey: await pwKey(MASTER), kdf, agentsWhileAway: false })
  setVaultRunnerForTest(runner)
  await updateConfig({ passwords: { unlock_for: '48h' } }) // what a new vault's setup writes
}, 60_000)

afterAll(() => {
  setVaultRunnerForTest(null)
  setKeychainPlatformForTest(null)
  setBootForTest(null)
  resetSessionsForTest()
  resetVaultForTest(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  await updateConfig({ passwords: { unlock_for: '48h' } })
  setKeychainPlatformForTest('darwin')
  setBootForTest(null)
  keychainHolds = MASTER
  resetKeychainSecretForTest()
  // A fresh start with an open vault and nothing kept.
  await restart()
  endAllSessions()
  await flushSessionStoreForTest()
  if (!isOpen()) {
    const { unlockVault } = await import('../../../src/core/vault/store.js')
    await unlockVault({ passwordKey: await pwKey(MASTER) })
  }
})

describe('the windows a Walnut restart keeps', () => {
  it('keeps hashes only, in a file only this user reads, and brings them back through the keychain', async () => {
    const a = createSession('web window', FOR_48H)
    const b = createSession('the extension', FOR_48H, 'extension-aaaaaa')
    await flushSessionStoreForTest()
    const text = fs.readFileSync(file(), 'utf8')
    expect(text).not.toContain(a.token)
    expect(text).not.toContain(b.token)
    if (process.platform !== 'win32') expect(fs.statSync(file()).mode & 0o777).toBe(0o600)
    await restart()
    expect(lastRestoreForTest()).toBe('restored')
    expect(isOpen()).toBe(true)
    expect(useSession(a.token, true, undefined)).toMatchObject({ client: 'web window' })
    // A device's session still holds only for that device.
    expect(useSession(b.token, true, 'browser-bbbbbb')).toBeNull()
  }, 60_000)

  it('without a keychain item (and no machine key) every window stays locked, and the file forgets them', async () => {
    const a = createSession('web window', FOR_48H)
    await flushSessionStoreForTest()
    keychainHolds = null
    await restart()
    expect(lastRestoreForTest()).toBe('cannot_reopen')
    expect(isOpen()).toBe(false)
    expect(useSession(a.token, true, undefined)).toBeNull()
    expect(JSON.parse(fs.readFileSync(file(), 'utf8')).sessions).toEqual([])
  }, 60_000)

  it('a throwaway server never reads the keychain to reopen', async () => {
    const a = createSession('web window', FOR_48H)
    await flushSessionStoreForTest()
    setKeychainPlatformForTest(null) // no forced platform: not the person's real vault, so no keychain
    await restart()
    expect(lastRestoreForTest()).toBe('cannot_reopen')
    expect(useSession(a.token, true, undefined)).toBeNull()
  }, 60_000)

  it('the machine key reopens the vault by itself', async () => {
    await setAgentsWhileAway(true, await pwKey(MASTER))
    try {
      const a = createSession('web window', FOR_48H)
      await flushSessionStoreForTest()
      keychainHolds = null
      await restart()
      expect(lastRestoreForTest()).toBe('restored')
      expect(useSession(a.token, true, undefined)).not.toBeNull()
    } finally {
      await setAgentsWhileAway(false, await pwKey(MASTER))
    }
  }, 120_000)

  it('a restart of the computer locks every window', async () => {
    const a = createSession('web window', FOR_48H)
    await flushSessionStoreForTest()
    setBootForTest({ at: Math.round(Date.now() / 1000) - 5, id: 'another-boot' })
    await restart()
    expect(lastRestoreForTest()).toBe('other_boot')
    expect(useSession(a.token, true, undefined)).toBeNull()
  }, 60_000)

  it('sessions past their clock are dropped; the live ones come back', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    setBootForTest({ at: 1_000, id: 'this-boot' }) // the clock moves, the boot does not
    try {
      const short = createSession('short', 1) // one idle minute
      const long = createSession('long', FOR_48H)
      await flushSessionStoreForTest()
      vi.setSystemTime(Date.now() + 5 * 60_000)
      await restart()
      expect(useSession(short.token, true, undefined)).toBeNull()
      expect(useSession(long.token, true, undefined)).not.toBeNull()
      expect(liveSessionCount()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  }, 60_000)

  it('"until restart" is not kept', async () => {
    const r = createSession('until restart', unlockChoice({ unlock_for: 'restart' }, false).limits)
    const k = createSession('kept', FOR_48H)
    await flushSessionStoreForTest()
    await restart()
    expect(useSession(r.token, true, undefined)).toBeNull()
    expect(useSession(k.token, true, undefined)).not.toBeNull()
  }, 60_000)

  it('Lock ends them for the next start too', async () => {
    const a = createSession('web window', FOR_48H)
    await flushSessionStoreForTest()
    endAllSessions()
    await restart()
    expect(lastRestoreForTest()).toBe('none')
    expect(useSession(a.token, true, undefined)).toBeNull()
  }, 60_000)

  it('a session written into the file by something that cannot open the vault restores nothing', async () => {
    const a = createSession('web window', FOR_48H)
    await flushSessionStoreForTest()
    const f = JSON.parse(fs.readFileSync(file(), 'utf8'))
    f.sessions.push({ ...f.sessions[0], hash: 'f'.repeat(64), client: 'forged' })
    fs.writeFileSync(file(), JSON.stringify(f))
    await restart()
    expect(lastRestoreForTest()).toBe('bad_mac')
    expect(useSession(a.token, true, undefined)).toBeNull()
    expect(isOpen()).toBe(false) // opened for nothing: closed again
  }, 60_000)

  it('a new master password ends every other window, also for the next start', async () => {
    const mine = createSession('this window', FOR_48H)
    const other = createSession('another window', FOR_48H)
    await flushSessionStoreForTest()
    const next: KdfParams = { ...kdf, salt: toB64(randomBytes(16)) }
    await changeMasterPassword({ oldPasswordKey: await pwKey(MASTER), newPasswordKey: await pwKey(NEXT, next), kdf: next })
    try {
      // The file still holds both, sealed under the replaced key: a restart now keeps neither.
      keychainHolds = NEXT
      await simulateRestartForTest()
      await sessionsRestored()
      expect(lastRestoreForTest()).toBe('bad_mac')
      expect(useSession(mine.token, true, undefined)).toBeNull()
      // What the route does after the change (vault-v1.ts /vault/password): the window that changed it stays.
      const { unlockVault } = await import('../../../src/core/vault/store.js')
      await unlockVault({ passwordKey: await pwKey(NEXT, next) })
      const again = createSession('this window', FOR_48H)
      createSession('another window', FOR_48H)
      endOtherSessions(again.token)
      await flushSessionStoreForTest()
      await restart()
      expect(useSession(again.token, true, undefined)).not.toBeNull()
      expect(liveSessionCount()).toBe(1)
      expect(useSession(other.token, true, undefined)).toBeNull()
    } finally {
      const { unlockVault } = await import('../../../src/core/vault/store.js')
      if (!isOpen()) await unlockVault({ passwordKey: await pwKey(NEXT, next) })
      await changeMasterPassword({ oldPasswordKey: await pwKey(NEXT, next), newPasswordKey: await pwKey(MASTER), kdf })
      keychainHolds = MASTER
    }
  }, 180_000)

  it('a changed choice only ever shortens the windows open now; a longer one is for the next unlock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const a = createSession('web window', FOR_48H)
      vi.setSystemTime(Date.now() + 2 * 3_600_000) // two hours later, used just now
      expect(useSession(a.token, true, undefined)).not.toBeNull()
      // 48 hours to 1 hour: an unlock two hours old is over.
      expect(retimeSessions(unlockChoice({ unlock_for: '1h' }, false).limits)).toBe(1)
      expect(useSession(a.token, true, undefined)).toBeNull()
      const b = createSession('web window', unlockChoice({ unlock_for: '1h' }, false).limits)
      // 1 hour to 48: the open window keeps its hour.
      expect(retimeSessions(FOR_48H)).toBe(0)
      vi.setSystemTime(Date.now() + 61 * 60_000)
      expect(useSession(b.token, true, undefined)).toBeNull()
      // A new unlock gets the longer choice.
      const c = createSession('web window', FOR_48H)
      vi.setSystemTime(Date.now() + 3 * 3_600_000)
      expect(useSession(c.token, true, undefined)).not.toBeNull()
    } finally {
      vi.useRealTimers()
      closeVault()
    }
  }, 60_000)

  it('fewer idle minutes in the same choice retime the windows too, and "until restart" stops keeping them', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const a = createSession('web window', unlockChoice({ unlock_for: 'idle', auto_lock_minutes: 15 }, false).limits)
      expect(retimeSessions(unlockChoice({ unlock_for: 'idle', auto_lock_minutes: 5 }, false).limits)).toBe(1)
      vi.setSystemTime(Date.now() + 6 * 60_000)
      expect(useSession(a.token, true, undefined)).toBeNull()
      const b = createSession('web window', FOR_48H)
      expect(retimeSessions(unlockChoice({ unlock_for: 'restart' }, false).limits)).toBe(1)
      await flushSessionStoreForTest()
      expect(JSON.parse(fs.readFileSync(file(), 'utf8')).sessions).toEqual([])
      expect(useSession(b.token, true, undefined)).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  }, 60_000)

  it('Walnut\'s own keychain unlock (a sync, the start) is not kept for a restart', async () => {
    const r = await unlockFromKeychain({ client: 'This Mac (Bitwarden sync)' })
    expect(r.ok).toBe(true)
    await flushSessionStoreForTest()
    expect(fs.existsSync(file()) ? JSON.parse(fs.readFileSync(file(), 'utf8')).sessions : []).toEqual([])
  }, 60_000)

  it('a restore whose shorter choice ends every window closes the vault again', async () => {
    createSession('web window', FOR_48H)
    await flushSessionStoreForTest()
    await updateConfig({ passwords: { unlock_for: '1h' } })
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 2 * 3_600_000)
      await restart()
      expect(lastRestoreForTest()).toBe('expired')
      expect(isOpen()).toBe(false)
      expect(liveSessionCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  }, 60_000)

  it('a write that fails removes the file, so a Lock never leaves a window to come back', async () => {
    createSession('web window', FOR_48H)
    await flushSessionStoreForTest()
    expect(JSON.parse(fs.readFileSync(file(), 'utf8')).sessions).toHaveLength(1)
    const fsp = (await import('node:fs/promises')).default
    const spy = vi.spyOn(fsp, 'open').mockRejectedValue(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
    try {
      endAllSessions()
      await saveSessionsNow()
    } finally {
      spy.mockRestore()
    }
    expect(fs.existsSync(file())).toBe(false)
  }, 60_000)

  it('turning agents-while-away off seals the kept windows under the new vault key at once', async () => {
    await setAgentsWhileAway(true, await pwKey(MASTER))
    const a = createSession('web window', FOR_48H)
    await flushSessionStoreForTest()
    await setAgentsWhileAway(false, await pwKey(MASTER))
    retimeSessions(unlockChoice({ unlock_for: '48h' }, false).limits)
    await saveSessionsNow()
    await restart()
    expect(lastRestoreForTest()).toBe('restored')
    expect(useSession(a.token, true, undefined)).not.toBeNull()
  }, 120_000)
})

describe('an older install keeps its idle lock', () => {
  it('writes unlock_for: idle once when a vault exists and no choice was written', async () => {
    await updateConfig({ passwords: {} })
    expect(await keepOldIdleLock()).toBe(true)
    expect((await getConfig()).passwords?.unlock_for).toBe('idle')
    expect(await keepOldIdleLock()).toBe(false)
    // Old minutes written by an older Walnut read as idle already: nothing written.
    await updateConfig({ passwords: { auto_lock_minutes: 30 } })
    expect(await keepOldIdleLock()).toBe(false)
    expect((await getConfig()).passwords?.unlock_for).toBeUndefined()
  })

  it('writes nothing without a vault (a new vault\'s setup writes 48 hours)', async () => {
    await updateConfig({ passwords: {} })
    resetVaultForTest(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-vault-none-')))
    try {
      expect(await keepOldIdleLock()).toBe(false)
      expect((await getConfig()).passwords?.unlock_for).toBeUndefined()
    } finally {
      resetVaultForTest(dir)
    }
  })
})
