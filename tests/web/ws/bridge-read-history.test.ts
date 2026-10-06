/**
 * One bridge read per session at a time (src/web/ws/bridge-read-history.ts):
 * joiners share it, a change since it started queues exactly one more, a result
 * is reused only while nothing changed and only for READ_HISTORY_CACHE_MS, and
 * one host never runs more than READ_HISTORY_PER_HOST reads at once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  coalescedSessionRead, noteSessionContentChanged, bridgeReadHistoryStats,
  READ_HISTORY_CACHE_MS, READ_HISTORY_PER_HOST, _resetBridgeReadHistoryForTesting,
} from '../../../src/web/ws/bridge-read-history.js'

interface Gate { promise: Promise<void>; open: () => void }
function gate(): Gate {
  let open!: () => void
  const promise = new Promise<void>((r) => { open = r })
  return { promise, open }
}
const tick = async (n = 5): Promise<void> => { for (let i = 0; i < n; i++) await Promise.resolve() }

beforeEach(() => _resetBridgeReadHistoryForTesting())
afterEach(() => vi.useRealTimers())

describe('coalescedSessionRead', () => {
  it('140 concurrent callers share one read', async () => {
    const g = gate()
    let calls = 0
    const read = async (): Promise<string> => { calls++; await g.promise; return `v${calls}` }
    const all = Array.from({ length: 140 }, () => coalescedSessionRead('h', 's', read))
    g.open()
    expect(new Set(await Promise.all(all))).toEqual(new Set(['v1']))
    expect(calls).toBe(1)
    expect(bridgeReadHistoryStats()).toMatchObject({ requests: 140, reads: 1, joined: 139 })
  })

  it('reuses a finished read while nothing changed, and reads again after a change', async () => {
    let calls = 0
    const read = async (): Promise<number> => ++calls
    expect(await coalescedSessionRead('h', 's', read)).toBe(1)
    expect(await coalescedSessionRead('h', 's', read)).toBe(1)
    noteSessionContentChanged('s')
    expect(await coalescedSessionRead('h', 's', read)).toBe(2)
    expect(calls).toBe(2)
  })

  it('expires a finished read after the cache window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let calls = 0
    const read = async (): Promise<number> => ++calls
    await coalescedSessionRead('h', 's', read)
    vi.setSystemTime(Date.now() + READ_HISTORY_CACHE_MS + 1)
    expect(await coalescedSessionRead('h', 's', read)).toBe(2)
  })

  it('a change during a read queues ONE fresh read behind it; earlier callers keep the old one', async () => {
    const gates = [gate(), gate()]
    let calls = 0
    const read = async (): Promise<number> => { const n = ++calls; await gates[n - 1].promise; return n }
    const before = [coalescedSessionRead('h', 's', read), coalescedSessionRead('h', 's', read)]
    await tick()
    noteSessionContentChanged('s')
    const after = Array.from({ length: 50 }, () => coalescedSessionRead('h', 's', read))
    await tick()
    expect(calls).toBe(1) // the fresh read waits for the running one
    gates[0].open()
    expect(await Promise.all(before)).toEqual([1, 1])
    await tick(20)
    expect(calls).toBe(2)
    gates[1].open()
    expect(new Set(await Promise.all(after))).toEqual(new Set([2]))
  })

  it('shares a failure with its joiners but never caches it', async () => {
    let calls = 0
    const failing = async (): Promise<number> => { calls++; throw new Error('bridge disconnected') }
    const both = [coalescedSessionRead('h', 's', failing), coalescedSessionRead('h', 's', failing)]
    await expect(Promise.all(both)).rejects.toThrow('bridge disconnected')
    expect(calls).toBe(1)
    expect(await coalescedSessionRead('h', 's', async () => 7)).toBe(7)
  })

  it('a key names one question of a session: two keys never share, a change stales both', async () => {
    // A relayed transcript page per cursor: the newest page and an older one are
    // different answers about the same session.
    let calls = 0
    const read = (label: string) => async (): Promise<string> => `${label}${++calls}`
    const newest = coalescedSessionRead('h', 's', read('newest'), 's|newest')
    const older = coalescedSessionRead('h', 's', read('older'), 's|older')
    expect(await Promise.all([newest, older])).toEqual(['newest1', 'older2'])
    // Each key reuses its own answer, and the bare session key is a third question.
    expect(await coalescedSessionRead('h', 's', read('newest'), 's|newest')).toBe('newest1')
    expect(await coalescedSessionRead('h', 's', read('older'), 's|older')).toBe('older2')
    expect(await coalescedSessionRead('h', 's', read('tail'))).toBe('tail3')
    // Freshness is the SESSION's: one change stales every key of it.
    noteSessionContentChanged('s')
    expect(await coalescedSessionRead('h', 's', read('newest'), 's|newest')).toBe('newest4')
    expect(await coalescedSessionRead('h', 's', read('older'), 's|older')).toBe('older5')
  })

  it(`caps one host at ${READ_HISTORY_PER_HOST} reads at a time, without holding up another host`, async () => {
    const g = gate()
    let active = 0
    let peak = 0
    const read = async (): Promise<string> => {
      active++; peak = Math.max(peak, active)
      await g.promise
      active--
      return 'ok'
    }
    const sameHost = ['a', 'b', 'c', 'd', 'e'].map((sid) => coalescedSessionRead('mac', sid, read))
    await tick()
    expect(peak).toBe(READ_HISTORY_PER_HOST)
    let otherDone = false
    const other = coalescedSessionRead('dev-box', 'z', async () => 'other').then((v) => { otherDone = true; return v })
    await tick(10)
    expect(otherDone).toBe(true)
    g.open()
    expect(await Promise.all(sameHost)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok'])
    expect(await other).toBe('other')
    expect(peak).toBe(READ_HISTORY_PER_HOST)
  })

  it('a released permit goes to the waiter: a newcomer in between cannot make it three', async () => {
    // Two reads hold the host, a third waits. When one finishes, the waiter
    // resumes a microtask later; a count that dropped in that gap let a newcomer
    // take the slot too, and the waiter then took it again.
    let active = 0
    let peak = 0
    const gates = new Map<string, Gate>()
    const read = (sid: string) => async (): Promise<string> => {
      active++; peak = Math.max(peak, active)
      const g = gate()
      gates.set(sid, g)
      await g.promise
      active--
      return sid
    }
    const held = ['a', 'b'].map((sid) => coalescedSessionRead('mac', sid, read(sid)))
    const waiter = coalescedSessionRead('mac', 'c', read('c'))
    await tick()
    expect(active).toBe(2)

    gates.get('a')!.open()
    // Newcomers on every microtask right after the release, so one of them lands
    // in whatever gap the release leaves.
    const newcomers: Array<Promise<string>> = []
    for (let i = 0; i < 12; i++) {
      await Promise.resolve()
      newcomers.push(coalescedSessionRead('mac', `n${i}`, read(`n${i}`)))
    }
    await tick(10)
    expect(peak).toBe(READ_HISTORY_PER_HOST)
    expect(bridgeReadHistoryStats().peakHostActive).toBe(READ_HISTORY_PER_HOST)

    // Everything still completes, two at a time.
    for (let round = 0; round < 20 && gates.size > 0; round++) {
      for (const [sid, g] of [...gates]) { gates.delete(sid); g.open() }
      await tick(10)
    }
    expect(await held[0]).toBe('a')
    expect(await waiter).toBe('c')
    expect((await Promise.all(newcomers)).length).toBe(12)
    expect(peak).toBe(READ_HISTORY_PER_HOST)
  })
})
