import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/constants.js', () => ({ IS_DEMO: true }))
const run = vi.hoisted(() => vi.fn())
vi.mock('../../../src/core/vault/child-run.js', () => ({ runVaultHelper: run }))
import { readKeychainSecret } from '../../../src/core/vault/keychain-secret.js'
import { keychainAvailable, keychainItemPresent, removeKeychainItem, setKeychainPlatformForTest, unlockFromKeychain } from '../../../src/core/vault/keychain-unlock.js'

afterEach(() => { run.mockReset(); setKeychainPlatformForTest(null) })

describe('Demo never uses the real vault keychain', () => {
  it('does not probe, read, delete or unlock real items even on a Mac', async () => {
    setKeychainPlatformForTest('darwin')
    expect(keychainAvailable()).toBe(false)
    expect(await readKeychainSecret('walnut-vault-master', 'darwin')).toBeNull()
    expect(await readKeychainSecret('BW_SESSION', 'darwin')).toBeNull()
    expect(await keychainItemPresent()).toBe(false)
    expect(await removeKeychainItem()).toBe(false)
    expect(await unlockFromKeychain({ client: 'Demo' })).toMatchObject({ ok: false, code: 'unavailable' })
    expect(run).not.toHaveBeenCalled()
  })
})
