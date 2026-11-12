/**
 * A link wait's bound counts awake time only (link-wait.ts, awakeStopwatch). 2026-11-12: the Mac
 * slept 41 minutes, and on wake both task moves in flight failed at once, their 10 minute bounds
 * read on Date.now long gone. Here the wall clock jumps an hour between two polls, as a sleep
 * does, and the step still waits its bound after the jump:
 *  - Bun on macOS: process.hrtime stops in sleep, so the sleep ledger (lib/sleep-ledger.ts) sees it;
 *  - a clock that counts sleep too (Node's hrtime): the jump itself, far past a poll, is left out.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { __resetSleepLedgerForTest } from '../../../src/lib/sleep-ledger.js'
import { __setLinkWaitClockForTesting, __setLinkWaitPollForTesting, awaitLink, awakeStopwatch, withLinkWait } from '../../../src/core/transfer/link-wait.js'
import { partRetry } from '../../../src/core/transfer/part-retry.js'
import { markLinkFailure } from '../../../src/providers/link-failure.js'
import { __setTransferConnectionResolverForTesting, probeHostFacts, type TransferConn } from '../../../src/core/transfer/daemon-transfer-client.js'

const HOUR = 3_600_000
/** Real time, plus an offset a test moves: the wall clock jumps; `mono` jumps too only when asked. */
function clocks() {
  let wallOffset = 0
  let monoOffset = 0
  const c = {
    now: () => Date.now() + wallOffset,
    monoNow: () => performance.now() + monoOffset,
    /** A sleep: the wall clock jumps; a clock that stops in sleep (hrtime under Bun) does not. */
    sleep(ms: number, monoCountsSleep = false) { wallOffset += ms; if (monoCountsSleep) monoOffset += ms },
  }
  __resetSleepLedgerForTest(c)
  __setLinkWaitClockForTesting(c.now)
  return c
}

afterEach(() => { __resetSleepLedgerForTest(null); __setLinkWaitClockForTesting(null); __setLinkWaitPollForTesting(null); __setTransferConnectionResolverForTesting(null) })

describe('a link wait across a sleep', () => {
  it('the stopwatch leaves out a sleep the ledger saw, and a jump far past a poll where the clock counts sleep', () => {
    const c = clocks()
    const bun = awakeStopwatch(120_000)
    const node = awakeStopwatch(120_000)
    c.sleep(HOUR)
    expect(bun.ms()).toBeLessThan(1_000)
    c.sleep(HOUR, true)
    expect(node.ms()).toBeLessThan(1_000)
    // Without a jump limit, a clock that counts sleep reads it as awake (only the ledger helps).
    const plain = awakeStopwatch()
    c.sleep(HOUR, true)
    expect(plain.ms()).toBeGreaterThanOrEqual(HOUR)
  })

  for (const monoCountsSleep of [false, true]) {
    it(`awaitLink: an hour's jump between two polls uses at most one poll and one dial of its bound (${monoCountsSleep ? 'a clock that counts sleep' : 'hrtime stops in sleep'})`, async () => {
      const c = clocks()
      __setLinkWaitPollForTesting(10)
      let polls = 0
      let backAt = Infinity
      const t0 = performance.now()
      // The bound is over one poll and one dial (20 s): the most a late poll counts.
      const conns = await awaitLink('b', 25_000, async () => {
        polls++
        // The second poll comes after an hour's sleep; the link is back 150 ms of awake time later.
        if (polls === 2) { c.sleep(HOUR, monoCountsSleep); backAt = performance.now() + 150 }
        return performance.now() >= backAt ? ['link'] : []
      }, () => new Error('stopping'))
      expect(conns).toEqual(['link'])
      expect(performance.now() - t0).toBeGreaterThanOrEqual(150)
    })
  }

  it('awaitLink still ends at its bound of awake time after the jump', async () => {
    const c = clocks()
    __setLinkWaitPollForTesting(10)
    let polls = 0
    let jumpedAt = 0
    const conns = await awaitLink('b', 300, async () => {
      if (++polls === 2) { c.sleep(HOUR); jumpedAt = performance.now() }
      return []
    }, () => new Error('stopping'))
    expect(conns).toEqual([])
    // Most of the bound was still left after the jump: it ran out on awake time.
    expect(performance.now() - jumpedAt).toBeGreaterThanOrEqual(200)
  })

  it('the stopwatch with no jump limit leaves out a sleep on a clock that stops in sleep (Bun)', () => {
    const c = clocks()
    const plain = awakeStopwatch()
    c.sleep(HOUR)
    expect(plain.ms()).toBeLessThan(1_000)
  })

  it('awaitLink: a 90 s sleep, under the jump limit, is left out where the clock stops in sleep and counted where it does not', async () => {
    for (const monoCountsSleep of [false, true]) {
      const c = clocks()
      __setLinkWaitPollForTesting(10)
      let polls = 0
      const t0 = performance.now()
      const conns = await awaitLink('b', 400, async () => {
        if (++polls === 2) c.sleep(90_000, monoCountsSleep)
        return []
      }, () => new Error('stopping'))
      expect(conns).toEqual([])
      const ran = performance.now() - t0
      // Left out: the bound runs on awake time. Counted: 90 s is far past the 400 ms bound.
      if (monoCountsSleep) expect(ran).toBeLessThan(300)
      else expect(ran).toBeGreaterThanOrEqual(350)
    }
  })

  it('awaitLink: a wait whose every poll comes more than 2 minutes late still ends (each counts one poll and one dial)', async () => {
    const c = clocks()
    __setLinkWaitPollForTesting(10)
    let polls = 0
    const conns = await awaitLink('b', 60_000, async () => { polls++; c.sleep(3 * 60_000, true); return [] }, () => new Error('stopping'))
    expect(conns).toEqual([])
    // 10 ms + 20 s counted per poll: the 60 s bound ends after three or four.
    expect(polls).toBeGreaterThanOrEqual(3)
    expect(polls).toBeLessThanOrEqual(4)
  })

  it('call(): a sleep between a send that found no link and its resend uses none of the bound', async () => {
    const c = clocks()
    __setLinkWaitPollForTesting(10)
    const sent: string[] = []
    const conn: TransferConn = {
      hasCapability: () => true,
      async send(cmd) {
        sent.push(cmd)
        if (sent.length === 1) { c.sleep(HOUR); throw markLinkFailure(new Error('link no-link'), 'no-link') }
        return { id: 1, ok: true, facts: 'there' }
      },
    }
    __setTransferConnectionResolverForTesting(async () => [conn])
    expect(await withLinkWait(300, () => probeHostFacts('b'))).toMatchObject({ facts: 'there' })
    expect(sent).toEqual(['host.facts', 'host.facts'])
  })

  it('partRetry: parts cut before and after an hour\'s sleep go on; the bound counts the awake time between them only', async () => {
    const c = clocks()
    __setLinkWaitPollForTesting(1)
    const lost = () => markLinkFailure(new Error('daemon command lost: fs.writePart'), 'lost')
    await withLinkWait(300, async () => {
      const r = partRetry({ host: 'b', path: '/f', size: 1024 * 1024, tries: 1, delayMs: 0 })
      await r.next(lost(), 0)
      c.sleep(HOUR)
      await r.next(lost(), 0)
      await r.next(lost(), 0)
      // And it still ends on awake time.
      let thrown: unknown
      const t0 = performance.now()
      while (!thrown) { try { await r.next(lost(), 0) } catch (err) { thrown = err } }
      expect(performance.now() - t0).toBeGreaterThanOrEqual(250)
    })
  })
})
