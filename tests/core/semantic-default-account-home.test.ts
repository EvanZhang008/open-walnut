/**
 * The semantic-lane decision reads the account's home without a lookup on every call
 * (src/core/search/semantic-default.ts accountHomeDir). When the read ahead had not given the
 * entry, every decision (health checks, test runs, plugin jobs) called accountInfo(), whose
 * failed lookup is a spawnSync of up to 5 s retried every 30 s on the server's thread.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const account = vi.hoisted(() => ({
  known: null as null | { homedir: string },
  info: vi.fn((): { homedir: string } => { throw new Error('could not read the passwd entry') }),
}))
vi.mock('../../src/lib/account.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/account.js')>()),
  primeAccount: async () => null,
  knownAccount: () => account.known,
  accountInfo: account.info,
}))

const { resetAccountHomeForTest, semanticLaneDecision } = await import('../../src/core/search/semantic-default.js')

const decide = () => semanticLaneDecision({ env: { HOME: '/home/someone' }, isEphemeral: false, walnutHome: '/home/someone/.open-walnut', tmpRoots: [] })

describe('account home for the semantic lane', () => {
  beforeEach(() => { resetAccountHomeForTest(); account.known = null; account.info.mockClear() })

  it('a lookup that could not run is tried once, not on every decision', () => {
    for (let i = 0; i < 5; i++) decide()
    expect(account.info).toHaveBeenCalledTimes(1)
  })

  it('the entry, once known, wins over the kept fallback', () => {
    decide()
    account.known = { homedir: '/home/other' }
    // HOME is not the account's home any more: a fake HOME.
    expect(decide()).toEqual({ on: false, reason: 'fake-home' })
    expect(account.info).toHaveBeenCalledTimes(1)
  })
})
