/**
 * The vault's one keychain secret reader (src/core/vault/keychain-secret.ts): only allow-listed
 * services, presence before any secret read, and one failed read ends reads of that service, so a
 * locked keychain shows the person at most one dialog. The `security` call is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setVaultRunnerForTest, type RunResult, type VaultRunner } from '../../../src/core/vault/child-run.js'
import { readKeychainSecret, resetKeychainSecretForTest, type KeychainSecretService } from '../../../src/core/vault/keychain-secret.js'

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false })
const fail = (code: number | null, timedOut = false): RunResult => ({ code, stdout: '', stderr: '', timedOut })

let calls: string[][] = []
function use(answer: (args: string[]) => RunResult): void {
  const runner: VaultRunner = async (cmd, args) => { calls.push([cmd, ...args]); return answer(args) }
  setVaultRunnerForTest(runner)
}
const secretReads = () => calls.filter((c) => c.includes('-w')).length

beforeEach(() => { calls = []; resetKeychainSecretForTest() })
afterEach(() => { setVaultRunnerForTest(null); resetKeychainSecretForTest() })

describe('keychain secret reader', () => {
  it('reads an existing item, presence first, and strips the one trailing newline', async () => {
    use((args) => (args.includes('-w') ? ok('s3cret value\n') : ok()))
    expect(await readKeychainSecret('BW_SESSION', 'darwin')).toBe('s3cret value')
    expect(calls.map((c) => c.includes('-w'))).toEqual([false, true])
  })

  it('a missing item is never read for its secret', async () => {
    use(() => fail(44))
    expect(await readKeychainSecret('walnut-vault-master', 'darwin')).toBeNull()
    expect(secretReads()).toBe(0)
  })

  it('off a Mac, or a service not on the list, runs nothing', async () => {
    use(() => ok('x\n'))
    expect(await readKeychainSecret('BW_SESSION', 'linux')).toBeNull()
    expect(await readKeychainSecret('some-other-item' as KeychainSecretService, 'darwin')).toBeNull()
    expect(calls).toEqual([])
  })

  it('a probe that fails (not "no such item") also pauses reads, and a pause ends after 6 hours', async () => {
    let t = 1_000_000
    const now = () => t
    use(() => fail(51))
    expect(await readKeychainSecret('BW_SESSION', 'darwin', now)).toBeNull()
    expect(await readKeychainSecret('BW_SESSION', 'darwin', now)).toBeNull()
    expect(calls).toHaveLength(1)
    use((args) => (args.includes('-w') ? ok('back\n') : ok()))
    t += 6 * 3600_000
    expect(await readKeychainSecret('BW_SESSION', 'darwin', now)).toBe('back')
  })

  it('a failed or timed-out read is not tried again during the pause (one dialog at most)', async () => {
    for (const bad of [fail(51), fail(null, true)]) {
      calls = []
      resetKeychainSecretForTest()
      use((args) => (args.includes('-w') ? bad : ok()))
      expect(await readKeychainSecret('BW_SESSION', 'darwin')).toBeNull()
      expect(await readKeychainSecret('BW_SESSION', 'darwin')).toBeNull()
      expect(secretReads()).toBe(1)
    }
  })
})
