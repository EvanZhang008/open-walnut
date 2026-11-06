/**
 * A browser key is never written after every key ended (code review 2026-11-06, D02 round 3): an
 * issue that started under an unlock a new master password then ended, and waited on the side file
 * meanwhile, wrote its key into the list forgetAllBrowsers had just cleared, so a window holding it
 * shared the first unlock typed with the new password. The side file's queue is modelled here as the
 * real one is (state.ts updateSide: one write at a time, in order), with a hold to interleave.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const side = vi.hoisted(() => ({
  file: null as { version: 1; browsers: { hash: string; at: number }[] } | null,
  tail: Promise.resolve() as Promise<unknown>,
  hold: null as Promise<void> | null,
}))

vi.mock('../../../src/core/vault/state.js', () => ({
  dir: async () => '/vault',
  openKey: async () => ({ vaultId: 'v1' }),
  openSide: async () => side.file,
  updateSide: (_name: string, fn: (cur: unknown) => unknown) => {
    const run = side.tail.then(async () => {
      if (side.hold) await side.hold
      side.file = fn(side.file) as typeof side.file
      return side.file
    })
    side.tail = run.catch(() => undefined)
    return run
  },
}))

const B = await import('../../../src/core/vault/browser-keys.js')

beforeEach(() => {
  side.file = null
  side.tail = Promise.resolve()
  side.hold = null
  B.resetBrowserKeysForTest()
})

function held(): () => void {
  let release!: () => void
  side.hold = new Promise<void>((r) => { release = r })
  return () => { side.hold = null; release() }
}

describe('issueBrowserKey and forgetAllBrowsers', () => {
  it('an issue still waiting when every key ends writes nothing and hands nothing', async () => {
    const release = held()
    const issuing = B.issueBrowserKey(undefined, 'handed by the Walnut extension')
    const forgetting = B.forgetAllBrowsers()
    release()
    const key = await issuing
    await forgetting
    expect(key).toBeNull()
    expect(side.file?.browsers ?? []).toEqual([])
  })

  it('an issue whose caller may no longer hand (asked inside the queue) writes nothing', async () => {
    let allowed = true
    const release = held()
    const issuing = B.issueBrowserKey(undefined, 'w', Date.now(), () => allowed)
    allowed = false // a Lock or a new master password came while it waited
    release()
    expect(await issuing).toBeNull()
    expect(side.file?.browsers ?? []).toEqual([])
  })

  it('with nothing in between, the key is written and known', async () => {
    const key = await B.issueBrowserKey(undefined, 'w', Date.now(), () => true)
    expect(key).not.toBeNull()
    expect(await B.knownBrowser(key!)).toBe(B.windowJoiner(key!))
  })
})
