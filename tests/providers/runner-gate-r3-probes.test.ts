/**
 * The round-2 gate's probes (Q1-Q5), ported as regression tests, plus what
 * round 3 fixed beside them. Each asserts the contract the gate checked:
 *
 * - Q2 (B2): after a server restart the daemon says a line still waits in the
 *   live CLI, and that CLI dies before starting it. The line must come back,
 *   also when the restarted session object has seen no lifecycle frame (attach
 *   subscribes to new events only). Failed on round 2 with lifecycle=false.
 * - Q5 (MU4): a Stop that lands during a write the dead process refuses parks
 *   the line; it never reaches a fresh process.
 * - P1: a reconnect redelivers to at most REDELIVERY_PARALLEL sessions at once.
 * - P4: a session past the line bound settles its oldest line, never strands it.
 *
 * Harness: tests/helpers/runner-probe-harness.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-runner-gate-r3'))

import { WALNUT_HOME } from '../../src/constants.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { enqueueMessage, getQueue, loadQueue, resetCache } from '../../src/core/session-message-queue.js'
import { hasUntakenLines, resetLineConsumption } from '../../src/providers/line-consumption.js'
import { SendOutcomeUnknownError } from '../../src/providers/delivery-failure.js'
import { REDELIVERY_PARALLEL } from '../../src/providers/claude-code-session.js'
import { EventNames } from '../../src/core/event-bus.js'
import {
  SID, crash, harness, named, probeSetup, probeTeardown, rows, settle, turnEnds, turnStarts, type Harness,
} from '../helpers/runner-probe-harness.js'

beforeEach(probeSetup)
afterEach(probeTeardown)

/** Record every resume call with its arguments (the line's uuid rides argument 14). */
function recordResumes(h: Harness): unknown[][] {
  const args: unknown[][] = []
  const prev = (h.session as unknown as { send: (...a: unknown[]) => void }).send
  ;(h.session as unknown as { send: (...a: unknown[]) => void }).send = (...a: unknown[]) => { args.push(a); prev(...a) }
  return args
}
const resumeUuid = (args: unknown[][], i = 0) => (args[i]?.[14] as { uuid?: string } | undefined)?.uuid

describe('Q1: two lines queued behind a turn; the first runs, then the CLI crashes (the dead process refuses the write)', () => {
  it('the second line reaches the next process exactly once, under its own uuid, and the first is not resent', async () => {
    let dead = false
    const h = harness({ script: async () => !dead })
    const resumeArgs = recordResumes(h)
    h.runner.init()
    await settle(200)
    await enqueueMessage(SID, 'm1')
    await h.internals.injectMidTurn(SID)
    await enqueueMessage(SID, 'm2')
    await h.internals.injectMidTurn(SID)
    const [l1, l2] = h.writes.map((w) => w.uuid!)
    h.lifecycle(l1, 'queued'); h.lifecycle(l2, 'queued')
    await settle()
    turnEnds(h); await settle(200)
    turnStarts(h); h.lifecycle(l1, 'started'); await settle()
    turnEnds(h); await settle(200)
    dead = true
    crash(h)
    await settle(800)
    const resumed = h.resumes.map((m, i) => ({ text: m, uuid: resumeUuid(resumeArgs, i) }))
    for (const s of h.resumeSettles) s(true)
    await settle(300)
    expect({ resumed, rowsAfter: await rows() }).toEqual({ resumed: [{ text: 'm2', uuid: l2 }], rowsAfter: [] })
  })
})

/** A line written by the first server, then a restart: a new session object for the same live CLI. */
async function restartWithQueuedLine(fateOnResend: { fate: string; state?: string } | null, lifecycleAfterRestart: boolean) {
  const h = harness()
  await enqueueMessage(SID, 'aside before the deploy')
  await h.internals.injectMidTurn(SID)
  const sent = h.writes[0].uuid!
  h.lifecycle(sent, 'queued')
  await settle()
  // The deploy: in-memory state is gone, the queue file is read again.
  resetLineConsumption()
  resetCache()
  await loadQueue()
  let dead = false
  const h2 = harness({
    task: 'gate-task-2', lifecycle: lifecycleAfterRestart,
    script: async (_m, o) => {
      if (dead) return false
      if (o.dedupe && fateOnResend) o.onFate?.(fateOnResend)
      return true
    },
  })
  const resumeArgs = recordResumes(h2)
  h2.runner.init()
  await settle(200)
  await h2.internals.processNext(SID)
  await settle(300)
  return { h, h2, sent, resumeArgs, kill: () => { dead = true } }
}

describe('Q2 (B2): restart, the daemon says the line waits in the live CLI, then the CLI crashes before starting it', () => {
  it.each([
    ['the restarted session object has seen no lifecycle frame (attach skipped the replay)', false],
    ['the restarted session object has seen one', true],
  ])('the line is not lost: %s', async (_name, seen) => {
    const { h2, sent, resumeArgs, kill } = await restartWithQueuedLine({ fate: 'waiting' }, seen)
    // Nothing was written again, and the row still waits for the CLI's word.
    expect(h2.writes.map((w) => ({ uuid: w.uuid, dedupe: w.dedupe }))).toEqual([{ uuid: sent, dedupe: true }])
    expect(await rows()).toEqual(['aside before the deploy:processing'])
    // Registered again, for the live process.
    expect(hasUntakenLines(SID)).toBe(true)
    kill()
    crash(h2)
    await settle(800)
    // It went back to the queue and out to the next process, under the same uuid.
    expect(h2.resumes).toEqual(['aside before the deploy'])
    expect(resumeUuid(resumeArgs)).toBe(sent)
  })

  it('the CLI names the line after the restart: it leaves the queue, and a crash after that resends nothing', async () => {
    const { h2, sent, kill } = await restartWithQueuedLine({ fate: 'waiting' }, false)
    h2.lifecycle(sent, 'started')
    await settle(200)
    expect(await rows()).toEqual([])
    kill()
    crash(h2)
    await settle(500)
    expect(h2.resumes).toEqual([])
  })
})

describe('Q3: restart, the daemon says the line already ran', () => {
  it('nothing is written and the row leaves the queue', async () => {
    const { h2 } = await restartWithQueuedLine({ fate: 'ran', state: 'completed' }, false)
    expect(h2.writes).toHaveLength(1)
    expect(await rows()).toEqual([])
    expect(named(h2, EventNames.SESSION_MESSAGES_DELIVERED)).toHaveLength(1)
  })
})

describe('Q4: an unconfirmed mid-turn line that the CLI later starts', () => {
  it('the runner emits a late messages-delivered for that row only (what the web gets)', async () => {
    let first = true
    const h = harness({ script: async () => { if (first) { first = false; throw new SendOutcomeUnknownError('daemon command timeout: send (30000ms)') } return true } })
    await enqueueMessage(SID, 'aside whose ack was lost')
    const [row] = await getQueue(SID)
    await h.internals.injectMidTurn(SID)
    await settle(200)
    expect(named(h, EventNames.SESSION_BATCH_FAILED, row.id)).toHaveLength(1)
    h.lifecycle(h.writes[0].uuid!, 'started')
    await settle(200)
    const late = named(h, EventNames.SESSION_MESSAGES_DELIVERED, row.id).map((e) => e.data)
    expect(late).toEqual([expect.objectContaining({ count: 1, messageIds: [row.id] })])
  })
})

describe('Q5 (MU4): a Stop lands while a write is on its way, and the dead process then refuses it', () => {
  it('the stopped line is parked and offered for Retry, never resumed on a fresh process', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const h = harness({ running: false, script: async () => { await gate; return false } })
    await enqueueMessage(SID, 'rewrite the importer')
    const [row] = await getQueue(SID)
    const run = h.internals.processNext(SID)
    await settle(150)
    // The turn this write opened, as a caller awaiting it sees it.
    const turn = h.runner.currentTurn(SID)
    expect(turn).toBeDefined()
    // The user's Stop: the stop epoch moves while the write is still pending.
    void (h.runner as unknown as { interruptNativeSession(sid: string): Promise<void> }).interruptNativeSession(SID)
    await settle(150)
    release()
    await Promise.race([run, settle(12_000)])
    await settle(300)
    expect(h.resumes).toEqual([])
    expect(named(h, EventNames.SESSION_BATCH_FAILED, row.id)).toHaveLength(1)
    expect(await rows()).toEqual(['rewrite the importer:parked'])
    // It ended as the Stop, never as a turn that ran.
    await expect(turn).resolves.toEqual({ kind: 'stopped' })
  }, 30_000)
})

describe('P1: a reconnect redelivers to a bounded number of sessions at once', () => {
  it(`never more than ${REDELIVERY_PARALLEL} at a time, and every session gets its turn`, async () => {
    const h = harness({ running: false })
    const sids = Array.from({ length: 9 }, (_, i) => `30000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`)
    for (const sid of sids) {
      await createSessionRecord(sid, `task-${sid}`, 'test', WALNUT_HOME, { initialProcessStatus: 'idle' })
      await enqueueMessage(sid, `queued for ${sid}`)
    }
    let active = 0
    let peak = 0
    const done: string[] = []
    ;(h.internals as unknown as { processNext(sid: string): Promise<void> }).processNext = async (sid: string) => {
      active++
      peak = Math.max(peak, active)
      await settle(150)
      active--
      done.push(sid)
    }
    await h.internals.redeliverPendingForHost('__local__')
    expect(peak).toBe(REDELIVERY_PARALLEL)
    expect([...done].sort()).toEqual([...sids].sort())
  })
})

describe('P4: a session past the line bound settles its oldest line by its write', () => {
  it('the evicted line\'s row leaves the queue instead of staying in processing forever', async () => {
    const h = harness()
    for (let i = 0; i < 65; i++) {
      await enqueueMessage(SID, `aside ${i}`)
      await h.internals.injectMidTurn(SID)
    }
    await settle(200)
    const left = (await getQueue(SID)).map((m) => m.message)
    expect(left).toHaveLength(64)
    expect(left).not.toContain('aside 0')
    expect(left[0]).toBe('aside 1')
  }, 30_000)
})
