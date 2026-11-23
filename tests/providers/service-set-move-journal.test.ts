/**
 * Review round 2, M3: before the flip a move drains this Walnut's offline journal on the shared
 * daemon to empty (a handover that starts after any running one, whose last read found nothing), else it
 * gives up: records left there are never drained again once the link reaches the set, and a trigger
 * one of them holds stays armed there and can resume a moved session on the shared daemon.
 *
 * What's real: DaemonConnection's drainJournalForMove (the link's SetLinkConn.drainJournal). What's
 * faked: the handover itself (core/offline-handover.ts), the connection's handover view.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const handover = vi.hoisted(() => ({
  running: undefined as Promise<unknown> | undefined,
  result: { rounds: 1, records: 0, imported: 0, settled: 0, replayed: 0, skipped: 0, failed: 0 } as Record<string, unknown>,
  order: [] as string[],
}))
vi.mock('../../src/core/offline-handover.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  runningHandover: () => handover.running,
  runOfflineHandover: async () => { handover.order.push('drain'); return handover.result },
}))

import { DaemonConnection } from '../../src/providers/daemon-connection.js'

type Internals = { drainJournalForMove: (ms: number) => Promise<void>; handoverConnection: () => Promise<unknown> }

function conn(caps: string[]) {
  const c = new DaemonConnection('devbox', null)
  vi.spyOn(c, 'hasCapability').mockImplementation((cap: string) => caps.includes(cap))
  vi.spyOn(c as unknown as Internals, 'handoverConnection').mockResolvedValue({})
  return c as unknown as Internals
}

describe('M3: the move drains this Walnut\'s journal on the shared daemon first', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    handover.running = undefined
    handover.result = { rounds: 1, records: 0, imported: 0, settled: 0, replayed: 0, skipped: 0, failed: 0 }
    handover.order = []
  })

  it('runs its own handover after one already running, and passes when every record applied', async () => {
    let end!: () => void
    handover.running = new Promise<void>((r) => { end = () => { handover.order.push('earlier-ended'); r() } })
    const c = conn(['offline-host-v1'])
    const p = c.drainJournalForMove(5_000)
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(handover.order).toEqual([])
    end()
    await p
    expect(handover.order).toEqual(['earlier-ended', 'drain'])
  })

  it('S2: records still on the host (a retry backoff, a reservation wait, rounds run out) are no drain', async () => {
    handover.result = { ...handover.result, records: 3, failed: 0, pending: true }
    await expect(conn(['offline-host-v1']).drainJournalForMove(5_000)).rejects.toThrow(/records of it are still there/)
  })

  it('L-M1: records refused or given up are lettered and acked: an empty journal passes', async () => {
    handover.result = { ...handover.result, records: 3, failed: 2 }
    await conn(['offline-host-v1']).drainJournalForMove(5_000)
    expect(handover.order).toEqual(['drain'])
  })

  it('a revoked host or a drain past its bound are no drain', async () => {
    handover.result = { ...handover.result, held: true }
    await expect(conn(['offline-host-v1']).drainJournalForMove(5_000)).rejects.toThrow(/revoked here/)
    handover.running = new Promise(() => {})
    await expect(conn(['offline-host-v1']).drainJournalForMove(50)).rejects.toThrow(/did not end within/)
  })

  it('a daemon that keeps no journal has nothing to drain', async () => {
    await conn([]).drainJournalForMove(5_000)
    expect(handover.order).toEqual([])
  })
})
