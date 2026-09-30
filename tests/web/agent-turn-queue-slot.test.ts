/**
 * A turn gives up the agent's slot while it waits on something that is not the
 * agent's work (core/turn-slot.ts), and takes it back before it goes on.
 *
 * Gate finding N2 (2026-09-30): a phone follow-up waiting for an earlier stalled
 * turn on its own lane held the per-agent queue (concurrency 1) for the whole
 * wait, so another conversation of the same agent, sent 0.3 s later, started
 * only after that wait ended. The rules pinned here: the other turn starts at
 * once; the waiter comes back AHEAD of turns queued meanwhile, but never while
 * another turn holds the slot; the slot count ends at zero on every path.
 *
 * Gate round 3 added two more. Waiters that come back do so in the order their
 * waits ended, FIFO among themselves (an unshift made four waiters on one gate
 * resume W1, W4, W3, W2). A turn with two waits running at once gives its slot
 * up once, not twice (the second release would start two other turns).
 */
import { describe, it, expect, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-agent-turn-slot'))

import { enqueueAgentTurn, getQueueStatus } from '../../src/web/agent-turn-queue.js'
import { releaseTurnSlotWhile } from '../../src/core/turn-slot.js'

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const tick = async (n = 5): Promise<void> => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

describe('a turn that waits on an earlier turn of its own lane', () => {
  it('lets another conversation of the same agent run meanwhile, then resumes ahead of later turns', async () => {
    const agent = 'slot-a'
    const log: string[] = []
    const gate = deferred<string>()
    const other = deferred()
    const b = enqueueAgentTurn(agent, 'B', async () => {
      log.push('B start')
      const verdict = await releaseTurnSlotWhile(gate.promise)
      log.push(`B resumed (${verdict})`)
      return 'B done'
    })
    await tick()
    const c = enqueueAgentTurn(agent, 'C', async () => { log.push('C start'); await other.promise; log.push('C end') })
    await tick()
    expect(log).toEqual(['B start', 'C start']) // C did not wait for B's gate
    expect(getQueueStatus(agent)).toEqual({ active: 1, queued: 0 })

    const d = enqueueAgentTurn(agent, 'D', async () => { log.push('D start') })
    gate.resolve('free') // B's wait ends while C still holds the slot
    await tick()
    expect(log).toEqual(['B start', 'C start']) // B waits for C: never two turns at once
    other.resolve()
    expect(await b).toBe('B done')
    await Promise.all([c, d])
    expect(log).toEqual(['B start', 'C start', 'C end', 'B resumed (free)', 'D start']) // B ahead of D
    expect(getQueueStatus(agent)).toEqual({ active: 0, queued: 0 })
  })

  it('a wait that rejects takes the slot back first, then the turn fails as usual', async () => {
    const agent = 'slot-b'
    const log: string[] = []
    const gate = deferred<string>()
    const hold = deferred()
    const b = enqueueAgentTurn(agent, 'B', async () => { await releaseTurnSlotWhile(gate.promise) })
    await tick()
    const c = enqueueAgentTurn(agent, 'C', async () => { log.push('C start'); await hold.promise; log.push('C end') })
    await tick()
    gate.reject(new Error('lane gone'))
    await tick()
    expect(log).toEqual(['C start'])
    hold.resolve()
    await expect(b).rejects.toThrow('lane gone')
    await c
    expect(log).toEqual(['C start', 'C end'])
    expect(getQueueStatus(agent)).toEqual({ active: 0, queued: 0 })
  })

  it('a wait left running after its turn ended does not keep the slot', async () => {
    const agent = 'slot-c'
    const gate = deferred<string>()
    let detached: Promise<string> | undefined
    await enqueueAgentTurn(agent, 'B', async () => { detached = releaseTurnSlotWhile(gate.promise) })
    const ran: string[] = []
    await enqueueAgentTurn(agent, 'C', async () => { ran.push('C') })
    gate.resolve('late')
    expect(await detached).toBe('late')
    await tick()
    expect(ran).toEqual(['C'])
    expect(getQueueStatus(agent)).toEqual({ active: 0, queued: 0 })
    await enqueueAgentTurn(agent, 'D', async () => { ran.push('D') })
    expect(ran).toEqual(['C', 'D'])
  })

  it('four waiters on one gate come back in the order they were queued', async () => {
    const agent = 'slot-fifo-one-gate'
    const order: string[] = []
    const gate = deferred<string>()
    const all = ['W1', 'W2', 'W3', 'W4'].map((id) => enqueueAgentTurn(agent, id, async () => {
      order.push(`${id} at gate`)
      await releaseTurnSlotWhile(gate.promise)
      order.push(`${id} resumed`)
    }))
    await tick()
    expect(order).toEqual(['W1 at gate', 'W2 at gate', 'W3 at gate', 'W4 at gate'])
    gate.resolve('free')
    await Promise.all(all)
    expect(order.slice(4)).toEqual(['W1 resumed', 'W2 resumed', 'W3 resumed', 'W4 resumed'])
    expect(getQueueStatus(agent)).toEqual({ active: 0, queued: 0 })
  })

  it('two waiters on different gates, back while a third turn holds the slot: first opened, first resumed', async () => {
    const agent = 'slot-fifo-two-gates'
    const order: string[] = []
    const gB = deferred<string>()
    const gE = deferred<string>()
    const hold = deferred()
    const b = enqueueAgentTurn(agent, 'B', async () => { await releaseTurnSlotWhile(gB.promise); order.push('B resumed') })
    await tick()
    const e = enqueueAgentTurn(agent, 'E', async () => { await releaseTurnSlotWhile(gE.promise); order.push('E resumed') })
    await tick()
    const d = enqueueAgentTurn(agent, 'D', async () => { order.push('D start'); await hold.promise; order.push('D end') })
    await tick()
    gB.resolve('free'); await tick()
    gE.resolve('free'); await tick()
    const f = enqueueAgentTurn(agent, 'F', async () => { order.push('F start') })
    await tick()
    expect(order).toEqual(['D start']) // neither resumes while D holds the slot
    hold.resolve()
    await Promise.all([b, e, d, f])
    expect(order).toEqual(['D start', 'D end', 'B resumed', 'E resumed', 'F start'])
    expect(getQueueStatus(agent)).toEqual({ active: 0, queued: 0 })
  })

  it('two waits at once in one turn give the slot up once: a turn queued meanwhile still waits', async () => {
    const agent = 'slot-two-waits'
    const order: string[] = []
    const g1 = deferred<string>()
    const g2 = deferred<string>()
    const hold = deferred()
    const b = enqueueAgentTurn(agent, 'B', async () => {
      const got = await Promise.all([releaseTurnSlotWhile(g1.promise), releaseTurnSlotWhile(g2.promise)])
      order.push(`B resumed (${got.join('+')})`)
    })
    await tick()
    const c = enqueueAgentTurn(agent, 'C', async () => { order.push('C start'); await hold.promise; order.push('C end') })
    await tick()
    const d = enqueueAgentTurn(agent, 'D', async () => { order.push('D start') })
    await tick()
    expect(order).toEqual(['C start']) // D waits for C
    expect(getQueueStatus(agent)).toEqual({ active: 1, queued: 1 })
    g2.resolve('two'); g1.resolve('one'); await tick()
    expect(order).toEqual(['C start'])
    hold.resolve()
    await Promise.all([b, c, d])
    expect(order).toEqual(['C start', 'C end', 'B resumed (one+two)', 'D start'])
    expect(getQueueStatus(agent)).toEqual({ active: 0, queued: 0 })
  })

  it('outside the queue there is no slot: the wait is just a wait', async () => {
    await expect(releaseTurnSlotWhile(Promise.resolve('free'))).resolves.toBe('free')
  })
})
