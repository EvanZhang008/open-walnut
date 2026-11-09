/**
 * A delivery that throws is tried again on its own clock until it goes through, a bounded
 * number of times. 2026-11-09: rows of four sessions waited minutes behind a jammed queue lock
 * with nothing to send them again; review of the fix: its clock retried once, because the
 * retry's own throw armed nothing.
 *
 * Real: SessionRunner's retry clock (retryAfterDeliveryThrow). Faked: processNext (throws a
 * set number of times, then delivers) and the timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('delivery-throw-retry'))
vi.mock('../../src/providers/daemon-connection.js', () => ({ disconnectAllDaemons: vi.fn() }))
vi.mock('../../src/providers/cloud-session-link.js', () => ({ CloudSessionLink: vi.fn() }))

import { enqueueMessage } from '../../src/core/session-message-queue.js'
import { harness, probeSetup, probeTeardown, SID, type Harness } from '../helpers/runner-probe-harness.js'

type Internals = {
  processNext(sid: string): Promise<void>
  retryAfterDeliveryThrow(sid: string): void
}

let h: Harness
let internals: Internals

beforeEach(async () => {
  await probeSetup()
  h = harness({ running: false })
  internals = h.runner as unknown as Internals
})
afterEach(async () => {
  vi.useRealTimers()
  vi.spyOn(h.session, 'detach').mockImplementation(() => {})
  h.runner.destroy()
  vi.restoreAllMocks()
  await probeTeardown()
})

async function runClock(throws: number): Promise<number> {
  await enqueueMessage(SID, 'waiting row')
  let calls = 0
  vi.spyOn(internals, 'processNext').mockImplementation(async () => {
    calls++
    if (calls <= throws) throw new Error('File lock timeout after 10000ms')
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  internals.retryAfterDeliveryThrow(SID)
  for (let i = 0; i < 12; i++) {
    await vi.advanceTimersByTimeAsync(61_000)
  }
  return calls
}

describe('a delivery that threw is tried again on its clock', () => {
  it('a fault that lasts several rounds is retried until the delivery goes through', async () => {
    expect(await runClock(3)).toBe(4)
  })

  it('a fault that never ends is retried a bounded number of times, then left', async () => {
    const calls = await runClock(Infinity)
    expect(calls).toBe(8)
  })
})
