/**
 * A line the CLI never took goes back to the queue when its process ends, and the
 * next delivery must reach a process that reads it. The resend carries `dedupe`,
 * so the daemon is asked first; a daemon answering "waiting" from its record of
 * the write into the process that ended (2026-10-25: the test daemon did, the
 * real one reaps first) parked the rows as 'processing' with no process left to
 * name them, and they never ran.
 *
 * Now a "waiting" answer while this session has seen its process end, started none
 * since, and has no pipe counts as not delivered: the line goes to the next process.
 * A live process's "waiting" still keeps the line where it is, also after an end
 * when the transport found the pipe alive again.
 *
 * What's real: SessionRunner (processNext, injectMidTurn, the reclaim handler),
 * ClaudeCodeSession (writeMessage, the exit paths), the disk queue. Scripted: the
 * transport; a resume is recorded, never spawned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-reclaimed-line-not-parked'))
vi.mock('../../src/providers/daemon-connection.js', () => ({ disconnectAllDaemons: vi.fn() }))
vi.mock('../../src/providers/cloud-session-link.js', () => ({ CloudSessionLink: vi.fn() }))

import { enqueueMessage, getQueue } from '../../src/core/session-message-queue.js'
import { SID, harness, probeSetup, probeTeardown, rows, settle, type Harness, type Script } from '../helpers/runner-probe-harness.js'

beforeEach(probeSetup)
afterEach(probeTeardown)

type Internals = { handleProcessDeath(): void; _transport: { hasPipe: boolean } }
const internal = (h: Harness) => h.session as unknown as Internals

/** The daemon's exit event for a quiet exit: the transport's pipe is gone and the
 *  lines the process never took are handed back (the transport's onExit). */
function quietExit(h: Harness) {
  internal(h)._transport.hasPipe = false
  h.session.reclaimUntakenLines('exit', true)
}

/** The daemon's answer to a resend: "waiting" from its write record, nothing written. */
const waitingOnResend: Script = async (_m, o) => {
  if (o.dedupe) o.onFate?.({ fate: 'waiting' })
  return true
}

const UUID = '40000000-0000-4000-8000-0000000000b1'

describe('a line handed back by a process end reaches the next process', () => {
  it('the process ended before the resend: a "waiting" answer is not a delivery, the line is resumed once', async () => {
    const h = harness({ script: waitingOnResend })
    h.runner.init()
    await settle(200)
    await enqueueMessage(SID, 'q2')
    await h.internals.injectMidTurn(SID)
    await settle()
    expect(await rows()).toEqual(['q2:processing'])
    // The CLI exits quietly with the line still in its queue: it goes back.
    quietExit(h)
    await vi.waitFor(() => expect(h.resumes.join('\n')).toContain('q2'), { timeout: 5000 })
    await settle(300)
    expect(h.resumes).toHaveLength(1)
    // Asked once under its own uuid, then resumed: never parked on the dead process.
    const resend = h.writes.filter((w) => w.dedupe)
    expect(resend.map((w) => w.message)).toEqual(['q2'])
    expect(resend[0].uuid).toBe(h.writes[0].uuid)
  })

  it('the process ends while the resend is out (its pid kept, the liveness path): the line still reaches the next process once', async () => {
    let ended = false
    const h = harness({
      running: false,
      // The process dies before the daemon's "waiting" comes back. Any later send
      // finds the session dead, as the real daemon answers then.
      script: async (_m, o) => {
        if (ended) return false
        ended = true
        internal(h).handleProcessDeath()
        o.onFate?.({ fate: 'waiting' })
        return true
      },
    })
    h.runner.init()
    await settle(200)
    await enqueueMessage(SID, 'q1', { lineUuid: UUID })
    await h.internals.processNext(SID)
    await vi.waitFor(() => expect(h.resumes.join('\n')).toContain('q1'), { timeout: 5000 })
    await settle(300)
    expect(h.resumes).toHaveLength(1)
    expect(h.writes[0]).toMatchObject({ message: 'q1', dedupe: true, uuid: UUID })
  })

  it('a live process answering "waiting" keeps the line in place: no second copy, no resume', async () => {
    const h = harness({ script: waitingOnResend })
    h.runner.init()
    await settle(200)
    await enqueueMessage(SID, 'q3', { lineUuid: UUID })
    await h.internals.injectMidTurn(SID)
    await settle(300)
    expect(h.writes.map((w) => [w.message, w.dedupe])).toEqual([['q3', true]])
    expect(h.resumes).toEqual([])
    expect(await rows()).toEqual(['q3:processing'])
    expect((await getQueue(SID))[0].lineUuid).toBe(UUID)
  })

  it('after an end, a pipe the transport found alive again keeps a "waiting" answer: no stop, no resume', async () => {
    const h = harness({ running: false, script: waitingOnResend })
    h.runner.init()
    await settle(200)
    quietExit(h)
    await settle()
    // The same sid's CLI came back without this object (the daemon resumed it, or a
    // rescue found it alive): the transport sees its pipe, the object still reads ended.
    internal(h)._transport.hasPipe = true
    await enqueueMessage(SID, 'q4', { lineUuid: UUID })
    await h.internals.processNext(SID)
    await settle(300)
    expect(h.writes.map((w) => [w.message, w.dedupe])).toEqual([['q4', true]])
    expect(h.resumes).toEqual([])
    expect(h.stop).not.toHaveBeenCalled()
  })
})
