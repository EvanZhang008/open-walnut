/**
 * Two tests that each held the fixture lease the other then asked for waited on each other until
 * one gave up after 600 s (2026-11-10, CI: session-threads-landing and session-threads-send).
 * takeInOrder (tests/e2e/browser/fixture-lease-order.ts) never waits for a lease while holding one
 * that sorts after it, so the same two finish.
 */
import { describe, expect, it } from 'vitest'
import { takeInOrder, type HeldLease, type LeaseOps } from '../e2e/browser/fixture-lease-order'

/** One table of leases shared by every holder, like the lease files of a run. */
function table() {
  const owner = new Map<string, string>()
  const waits: Array<() => void> = []
  const wake = () => { for (const w of waits.splice(0)) w() }
  const opsFor = (who: string): LeaseOps => ({
    tryTake: (key) => {
      if (owner.has(key)) return false
      owner.set(key, who)
      return true
    },
    take: async (key) => {
      while (owner.has(key)) await new Promise<void>((resolve) => waits.push(resolve))
      owner.set(key, who)
    },
    release: (key) => {
      if (owner.get(key) === who) owner.delete(key)
      wake()
    },
  })
  return { owner, opsFor, releaseAll: (who: string) => { for (const [k, w] of owner) if (w === who) owner.delete(k); wake() } }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('takeInOrder', () => {
  it('two holders that ask for each other\'s lease both finish', async () => {
    const t = table()
    const resets: string[] = []
    const reset = (who: string, key: string) => async () => { resets.push(`${who}:${key}`) }
    // A holds "dense", B holds "failed"; then A asks for "failed" and B for "dense".
    const a: HeldLease[] = []
    const b: HeldLease[] = []
    await takeInOrder(a, 'threads:dense', reset('a', 'dense'), t.opsFor('a'))
    await takeInOrder(b, 'threads:failed', reset('b', 'failed'), t.opsFor('b'))
    const aDone = takeInOrder(a, 'threads:failed', reset('a', 'failed'), t.opsFor('a')).then(async () => {
      expect(a.map((l) => l.key).sort()).toEqual(['threads:dense', 'threads:failed'])
      await tick()
      t.releaseAll('a')
    })
    const bDone = takeInOrder(b, 'threads:dense', reset('b', 'dense'), t.opsFor('b')).then(async () => {
      expect(b.map((l) => l.key).sort()).toEqual(['threads:dense', 'threads:failed'])
      await tick()
      t.releaseAll('b')
    })
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('the two holders waited on each other')), 2_000))
    await Promise.race([Promise.all([aDone, bDone]), timeout])
    // B let "failed" go to wait for "dense" in order, and reset "failed" again once it had it back.
    expect(resets).toContain('b:failed')
    expect(resets.filter((r) => r === 'b:failed')).toHaveLength(1)
  })

  it('a free key that sorts before a held one is taken at once, keeping what is held', async () => {
    const t = table()
    const held: HeldLease[] = []
    let again = 0
    await takeInOrder(held, 'threads:z', async () => { again++ }, t.opsFor('a'))
    await takeInOrder(held, 'threads:a', async () => {}, t.opsFor('a'))
    expect(held.map((l) => l.key)).toEqual(['threads:z', 'threads:a'])
    expect(t.owner.get('threads:z')).toBe('a')
    expect(again).toBe(0)
  })

  it('a key after every held one is waited for while holding them', async () => {
    const t = table()
    const held: HeldLease[] = []
    await takeInOrder(held, 'threads:a', async () => {}, t.opsFor('a'))
    t.opsFor('other').tryTake('threads:b')
    const done = takeInOrder(held, 'threads:b', async () => {}, t.opsFor('a'))
    await tick()
    expect(t.owner.get('threads:a')).toBe('a')
    t.opsFor('other').release('threads:b')
    await done
    expect(held.map((l) => l.key)).toEqual(['threads:a', 'threads:b'])
  })
})
