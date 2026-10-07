/**
 * A host's "I journaled something" nudge, as the server's turn-end hooks see it
 * (src/core/offline-handover.ts noteHandoverDue / waitForOfflineHandovers).
 *
 * A host delivers messages between its own sessions itself, also while this
 * server answers, and journals the request it opened and any reply it carried.
 * The hook that asks "did anyone answer?" waits until that journal is taken:
 *   - nothing due, nothing running: no wait at all;
 *   - a nudge waits for a drain that BEGAN after it (an older drain may have
 *     read the journal before the record was written);
 *   - bounded: a host that never drains costs at most the wait cap, and a nudge
 *     nobody drained for a minute is dropped.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-handover-due'))

import {
  noteHandoverDue, runOfflineHandover, runningHandover, waitForOfflineHandovers, _resetOfflineHandoverForTesting,
} from '../../src/core/offline-handover.js'

/** A connection whose drain returns nothing, released by hand. */
function gatedConn(hostKey: string) {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const drains: number[] = []
  return {
    conn: {
      hostKey,
      send: async (cmd: string) => {
        if (cmd === 'offline.drain') { drains.push(Date.now()); await gate; return { ok: true, records: [] } }
        return { ok: true }
      },
    },
    release: () => release(),
    drains,
  }
}

async function settled(p: Promise<unknown>, ms = 50): Promise<boolean> {
  let done = false
  void p.then(() => { done = true })
  await new Promise((r) => setTimeout(r, ms))
  return done
}

beforeEach(() => _resetOfflineHandoverForTesting())
afterEach(() => { vi.useRealTimers(); _resetOfflineHandoverForTesting() })

describe('waiting for a host journal before judging a request', () => {
  it('nothing due and nothing running: answers at once', async () => {
    const t0 = Date.now()
    await waitForOfflineHandovers(2_000)
    expect(Date.now() - t0).toBeLessThan(50)
  })

  it('a nudge waits for the drain that follows it, and that drain clears it', async () => {
    noteHandoverDue('devbox')
    const waiting = waitForOfflineHandovers(3_000)
    expect(await settled(waiting)).toBe(false)
    const g = gatedConn('devbox')
    const job = runOfflineHandover(g.conn)
    expect(runningHandover('devbox')).toBe(job)
    expect(await settled(waiting)).toBe(false)
    g.release()
    await job
    expect(await settled(waiting)).toBe(true)
    // Cleared: the next hook does not wait.
    const t0 = Date.now()
    await waitForOfflineHandovers(2_000)
    expect(Date.now() - t0).toBeLessThan(50)
  })

  it('a drain that began before the nudge does not clear it; the next one does', async () => {
    const first = gatedConn('devbox')
    const job = runOfflineHandover(first.conn)
    await new Promise((r) => setTimeout(r, 5))
    noteHandoverDue('devbox')
    first.release()
    await job
    expect(runningHandover('devbox')).toBeUndefined()
    const waiting = waitForOfflineHandovers(3_000)
    expect(await settled(waiting)).toBe(false)
    const second = gatedConn('devbox')
    const next = runOfflineHandover(second.conn)
    second.release()
    await next
    expect(await settled(waiting)).toBe(true)
  })

  it('another host\'s drain is not this host\'s', async () => {
    noteHandoverDue('devbox')
    const other = gatedConn('olddev')
    const job = runOfflineHandover(other.conn)
    other.release()
    await job
    expect(await settled(waitForOfflineHandovers(3_000))).toBe(false)
  })

  it('bounded: a host that never drains costs the cap, and a nudge a minute old is dropped', async () => {
    noteHandoverDue('devbox')
    const t0 = Date.now()
    await waitForOfflineHandovers(150)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 61_000)
    const t1 = performance.now()
    await waitForOfflineHandovers(2_000)
    expect(performance.now() - t1).toBeLessThan(50)
  })

  it('a second nudge before the drain is one wait, not two', async () => {
    noteHandoverDue('devbox')
    noteHandoverDue('devbox')
    const g = gatedConn('devbox')
    const job = runOfflineHandover(g.conn)
    g.release()
    await job
    expect(g.drains).toHaveLength(1)
    expect(await settled(waitForOfflineHandovers(3_000))).toBe(true)
  })
})
