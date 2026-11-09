/**
 * No delivery path may take the same queue row again and again without a bound.
 *
 * 2026-11-09: a Codex session's queued peer reply was steered into a live turn the
 * adapter would not steer into. Each refusal came back as a turn error, the runner's
 * SESSION_ERROR path drove processNext at once, and the drain steered the same row
 * again: about 30,000 takes in 37 minutes, each a full queue-file write under its
 * lock, which starved every other session's queue write. After the turn ended the
 * row was left 'processing' with a newer row behind it, and nothing went out again.
 *
 * Real: SessionRunner (its SESSION_ERROR path, processNext, drainAcpQueue,
 * steerAcpQueued, the native processNext) and the disk queue. Faked: the ACP session
 * (a steer that is always refused and, like an older worker, reports the refusal as a
 * turn error) and the native transport.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('acp-redelivery-loop'))
vi.mock('../../src/providers/daemon-connection.js', () => ({ disconnectAllDaemons: vi.fn() }))
vi.mock('../../src/providers/cloud-session-link.js', () => ({ CloudSessionLink: vi.fn() }))

import { enqueueMessage, getQueue, markNextProcessing } from '../../src/core/session-message-queue.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { SendHeldError } from '../../src/providers/delivery-failure.js'
import { MAX_TAKES_IN_WINDOW, REDELIVERY_LOOP_REASON } from '../../src/core/sessions/redelivery-guard.js'
import { harness, probeSetup, probeTeardown, SID, type Harness } from '../helpers/runner-probe-harness.js'

type Internals = {
  acpSessions: Map<string, unknown>
  drainAcpQueue(session: unknown, sid: string): Promise<void>
  processNext(sid: string): Promise<void>
}

let h: Harness
let internals: Internals

function fakeAcp(opts: { activity: 'processing' | 'idle'; refuseAsTurnError?: boolean; taken?: (id: string) => boolean }) {
  const steers: string[] = []
  const sends: string[] = []
  const acp = {
    sessionId: SID, runtimeId: `rt-${SID}`, taskId: 'gate-task', activity: opts.activity,
    canSteer: true, workerLive: true,
    hasTaken: (id: string) => opts.taken?.(id) ?? false,
    establish: async () => SID,
    abortTurn: async () => {},
    detach: () => {},
    send: vi.fn(async (message: string) => { sends.push(message) }),
    steer: vi.fn(async (_message: string, id: string) => {
      steers.push(id)
      if (opts.refuseAsTurnError) {
        // What an older worker's journaled refusal projects to, emitted as AcpSession does.
        bus.emit(EventNames.SESSION_ERROR, {
          sessionId: SID, taskId: 'gate-task',
          error: 'steer_race: ACP live turn ended before steering applied', errorKind: 'provider_error',
        } as never, ['main-ai', 'session-runner'])
      }
      return false
    }),
  }
  internals.acpSessions.set(SID, acp)
  return { acp, steers, sends }
}

const statuses = async () => (await getQueue(SID)).map((m) => `${m.message}:${m.status}`)

beforeEach(async () => {
  await probeSetup()
  // The harness's native session sits under another id: SID is the ACP session here.
  h = harness({ running: false, sid: '30000000-0000-4000-8000-0000000000b2' })
  internals = h.runner as unknown as Internals
})
afterEach(async () => {
  internals.acpSessions.clear()
  vi.spyOn(h.session, 'detach').mockImplementation(() => {})
  h.runner.destroy()
  vi.restoreAllMocks()
  await probeTeardown()
})

describe('a delivery that fails at once is not redelivered without a bound', () => {
  it('a refused steer reported as a turn error parks the row after the cap, with words the user reads', async () => {
    // The runner's bus handlers (SESSION_RESULT / SESSION_ERROR → processNext) are live.
    h.runner.init()
    await new Promise((r) => setTimeout(r, 200))
    const { steers } = fakeAcp({ activity: 'processing', refuseAsTurnError: true })
    const row = await enqueueMessage(SID, 'peer reply')
    void internals.processNext(SID)
    await vi.waitFor(async () => expect(await statuses()).toEqual(['peer reply:parked']), { timeout: 10_000 })
    // Let any redelivery already scheduled run out: none may take the row again.
    await new Promise((r) => setTimeout(r, 300))
    expect(steers.length).toBeLessThanOrEqual(MAX_TAKES_IN_WINDOW)
    expect(steers.every((id) => id === row.id)).toBe(true)
    const [parked] = await getQueue(SID)
    expect(parked.parkedReason).toBe(REDELIVERY_LOOP_REASON)
    expect(parked.parkedReason).toMatch(/Retry sends it again/)
  })

  it('a steer refused once falls back to one prompt when the turn has ended, and is not parked', async () => {
    const { acp, steers, sends } = fakeAcp({ activity: 'processing' })
    acp.steer.mockImplementation(async (_m: string, id: string) => { steers.push(id); acp.activity = 'idle'; return false })
    await enqueueMessage(SID, 'follow-up')
    await internals.drainAcpQueue(acp, SID)
    expect(steers).toHaveLength(1)
    expect(sends).toEqual(['follow-up'])
    expect(await statuses()).toEqual([])
  })

  it('many sends into a turn that refused a steer leave the row waiting for the turn end, never parked', async () => {
    const { acp, steers } = fakeAcp({ activity: 'processing' })
    let refused = false
    Object.defineProperty(acp, 'steerRefusedThisTurn', { get: () => refused })
    acp.steer.mockImplementation(async (_m: string, id: string) => { steers.push(id); refused = true; return false })
    await enqueueMessage(SID, 'head')
    for (let i = 0; i < MAX_TAKES_IN_WINDOW + 4; i++) await internals.drainAcpQueue(acp, SID)
    expect(steers).toHaveLength(1)
    expect(await statuses()).toEqual(['head:pending'])
  })

  it('native: a line that keeps failing at once is parked after the cap', async () => {
    const old = h
    vi.spyOn(old.session, 'detach').mockImplementation(() => {})
    old.runner.destroy()
    h = harness({ running: false, script: async () => { throw new SendHeldError() } })
    internals = h.runner as unknown as Internals
    await enqueueMessage(SID, 'native line')
    for (let i = 0; i < MAX_TAKES_IN_WINDOW + 3; i++) await h.internals.processNext(SID)
    expect(h.writes.length).toBeLessThanOrEqual(MAX_TAKES_IN_WINDOW)
    expect(await statuses()).toEqual(['native line:parked'])
  })
})

describe('a row left processing with no delivery in flight never holds the queue', () => {
  it('goes back to pending and out as the next prompt, the newer row after it', async () => {
    const { acp, sends } = fakeAcp({ activity: 'idle' })
    await enqueueMessage(SID, 'old reply')
    await markNextProcessing(SID) // taken, then its settle was lost
    await enqueueMessage(SID, 'newer message')
    expect(await statuses()).toEqual(['old reply:processing', 'newer message:pending'])
    await internals.drainAcpQueue(acp, SID)
    expect(sends).toEqual(['old reply'])
    expect(await statuses()).toEqual(['newer message:pending'])
    await internals.drainAcpQueue(acp, SID)
    expect(sends).toEqual(['old reply', 'newer message'])
  })

  it('is removed, not sent again, when the worker is known to have taken it', async () => {
    let stuckId = ''
    const { acp, sends } = fakeAcp({ activity: 'idle', taken: (id) => id === stuckId })
    stuckId = (await enqueueMessage(SID, 'already steered')).id
    await markNextProcessing(SID)
    await enqueueMessage(SID, 'newer message')
    await internals.drainAcpQueue(acp, SID)
    expect(sends).toEqual(['newer message'])
    expect(await statuses()).toEqual([])
  })

  it('mid-turn too: the stranded row is re-pended, then steered', async () => {
    const { acp, steers } = fakeAcp({ activity: 'processing' })
    const row = await enqueueMessage(SID, 'stuck')
    await markNextProcessing(SID)
    await internals.drainAcpQueue(acp, SID)
    expect(steers).toEqual([row.id])
  })
})
