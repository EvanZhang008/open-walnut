/**
 * The one recovery path of the lines a leader queued for a session its host runs
 * (src/providers/host-judged-send.ts): a send whose link fails, a send the host refuses, a held
 * row whose hand fails, all stay in the leader's queue and go again (a retry clock that never
 * gives up, and at once when the host's channel links); a resend is a no-op on the host (its queue
 * takes a row id once, session-message-queue.ts `onceById`); a host that keeps refusing parks
 * the rows here with its reason.
 *
 * Real: SessionRunner and its bus subscription, both queues' store, judge-of. Faked: the leader
 * side's requests to the host (a recorder whose answer each test sets).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-judged-send'))
vi.mock('../../src/providers/daemon-connection.js', () => ({ disconnectAllDaemons: vi.fn() }))
vi.mock('../../src/providers/cloud-session-link.js', () => ({ CloudSessionLink: vi.fn() }))

import { harness, probeSetup, probeTeardown, settle } from '../helpers/runner-probe-harness.js'
import { _resetHostJudgedRunnerForTesting } from '../../src/providers/host-judged-runner.js'
import { HOST_REFUSED_REASON, REDELIVER_MS, _waitingForTesting, handHeldToHost, redeliverWaitingFor } from '../../src/providers/host-judged-send.js'
import { _resetJudgeOfForTesting, noteHostJudged } from '../../src/core/sessions/judge-of.js'
import { _setActiveLeaderSideForTesting } from '../../src/core/session-channel/leader-boot.js'
import { _resetHostSessionTasksForTesting } from '../../src/core/session-channel/leader-tasks.js'
import { _resetRemoteJudgedSessionsForTesting } from '../../src/providers/remote-judged-session.js'
import type { LeaderSide } from '../../src/core/session-channel/leader-side.js'
import { applyHostChannelBatch } from '../../src/core/session-tracker.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { AFTER_TURN_REASON } from '../../src/core/relay-fates.js'

const HOST_SID = '50000000-0000-4000-8000-0000000000e1'

type Mode = 'down' | 'refuse' | 'ok'
function fakeSide(start: Mode) {
  const sent: Array<{ host: string; body: Record<string, unknown> }> = []
  const state = { mode: start }
  const side = {
    sendToHost: async (host: string, body: Record<string, unknown>) => {
      sent.push({ host, body })
      if (state.mode === 'down') throw new Error('the host devbox is not connected')
      return state.mode === 'refuse' ? { ok: false, error: 'busy' } : { ok: true }
    },
  }
  _setActiveLeaderSideForTesting(side as unknown as LeaderSide)
  return { sent, state }
}

async function hostRow(sid = HOST_SID) {
  await applyHostChannelBatch({
    hostId: 'devbox', renames: [], cursor: { logId: 'L', seq: 1 },
    rows: [{ sid, born: true, patch: { claudeSessionId: sid, taskId: '', project: 'p', host: 'devbox', judge: 'host', process_status: 'idle', startedAt: 'x', lastActiveAt: 'x', messageCount: 0 } }],
  })
  noteHostJudged(sid, 'devbox')
}

beforeEach(async () => {
  await probeSetup()
  _resetJudgeOfForTesting()
  _resetRemoteJudgedSessionsForTesting()
  _resetHostJudgedRunnerForTesting()
  _resetHostSessionTasksForTesting()
})
afterEach(async () => {
  vi.useRealTimers()
  _setActiveLeaderSideForTesting(null)
  _resetHostJudgedRunnerForTesting()
  _resetJudgeOfForTesting()
  _resetRemoteJudgedSessionsForTesting()
  await probeTeardown()
})

describe('a line that did not reach its host', () => {
  it('a send whose link is down stays queued here and goes when the host links again, once', async () => {
    const h = harness()
    h.runner.init()
    await settle(100)
    await hostRow()
    const { enqueueMessage, getQueue } = await import('../../src/core/session-message-queue.js')
    await enqueueMessage(HOST_SID, 'hello', { id: 'qm-h2-1', sentBy: 'person' })
    const side = fakeSide('down')
    bus.emit(EventNames.SESSION_SEND, { sessionId: HOST_SID, message: 'hello' }, ['*'], { source: 'mobile' })
    await vi.waitFor(() => expect(side.sent).toHaveLength(1))
    await vi.waitFor(() => expect(_waitingForTesting(HOST_SID).scheduled).toBe(true))
    expect((await getQueue(HOST_SID)).map((m) => m.id)).toEqual(['qm-h2-1'])
    // The host links again: what waits goes at once, with the kick of the send it stands for.
    side.state.mode = 'ok'
    expect(await redeliverWaitingFor('devbox')).toBe(1)
    await vi.waitFor(() => expect(side.sent).toHaveLength(2))
    expect(side.sent[1].body).toMatchObject({ sessionId: HOST_SID, queued: [{ id: 'qm-h2-1', message: 'hello', sentBy: 'person' }], busSource: 'mobile' })
    expect(side.sent[1].body.holdOnly).toBeUndefined()
    await vi.waitFor(async () => expect(await getQueue(HOST_SID)).toEqual([]))
    expect(_waitingForTesting(HOST_SID)).toMatchObject({ sessions: 0, scheduled: false })
    // Nothing waits any more: another link sends nothing.
    expect(await redeliverWaitingFor('devbox')).toBe(0)
    await settle(20)
    expect(side.sent).toHaveLength(2)
  })

  it('the retry clock never gives up while the host stays away', async () => {
    await hostRow()
    const { enqueueMessage, getQueue } = await import('../../src/core/session-message-queue.js')
    await enqueueMessage(HOST_SID, 'after the turn', { id: 'qm-h2-held', heldReason: AFTER_TURN_REASON })
    const side = fakeSide('down')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    handHeldToHost(HOST_SID)
    await vi.waitFor(() => expect(side.sent).toHaveLength(1))
    // Every wait of the clock, then the last one again and again: well past the old four tries.
    const waits = [...REDELIVER_MS, ...REDELIVER_MS.slice(-1), ...REDELIVER_MS.slice(-1), ...REDELIVER_MS.slice(-1)]
    for (const [i, ms] of waits.entries()) {
      await vi.waitFor(() => expect(_waitingForTesting(HOST_SID).scheduled).toBe(true))
      await vi.advanceTimersByTimeAsync(ms)
      await vi.waitFor(() => expect(side.sent).toHaveLength(i + 2))
    }
    // A hand of held rows is a hold, not a kick.
    expect(side.sent.at(-1)!.body).toMatchObject({ holdOnly: true, queued: [{ id: 'qm-h2-held', held: { reason: AFTER_TURN_REASON } }] })
    // The row goes back to the queue after the send's answer: wait for it, not for a clock.
    await vi.waitFor(async () => expect((await getQueue(HOST_SID)).map((m) => [m.id, m.status])).toEqual([['qm-h2-held', 'parked']]))
    vi.useRealTimers()
    side.state.mode = 'ok'
    await redeliverWaitingFor('devbox')
    await vi.waitFor(async () => expect(await getQueue(HOST_SID)).toEqual([]))
  })

  it('a host that keeps refusing parks the rows here with its reason; held rows keep their hold', async () => {
    await hostRow()
    const { enqueueMessage, getQueue } = await import('../../src/core/session-message-queue.js')
    await enqueueMessage(HOST_SID, 'go', { id: 'qm-h2-go' })
    await enqueueMessage(HOST_SID, 'later', { id: 'qm-h2-later', heldReason: AFTER_TURN_REASON })
    const side = fakeSide('refuse')
    for (let i = 1; i <= 3; i++) {
      await redeliverWaitingFor('devbox')
      await vi.waitFor(() => expect(side.sent).toHaveLength(i))
      // The refused line is back in this queue, waiting (while it is out with the host it is in no queue row at all).
      if (i < 3) await vi.waitFor(async () => expect((await getQueue(HOST_SID)).find((m) => m.id === 'qm-h2-go')?.status).toBe('pending'))
    }
    await vi.waitFor(async () => {
      const q = await getQueue(HOST_SID)
      expect(q.find((m) => m.id === 'qm-h2-go')).toMatchObject({ status: 'parked', parkedReason: `${HOST_REFUSED_REASON}: busy` })
      expect(q.find((m) => m.id === 'qm-h2-later')).toMatchObject({ status: 'parked', parkedReason: AFTER_TURN_REASON })
    })
    expect(_waitingForTesting(HOST_SID).scheduled).toBe(false)
  })
})

describe('the host takes a leader row once', () => {
  it('a resend of a row the host already took (its answer lost) queues nothing again', async () => {
    const { enqueueMessage, getQueue, takeLinesForHost } = await import('../../src/core/session-message-queue.js')
    const { queueLinesOnHost } = await import('../../src/core/sessions/handed-holds.js')
    const sid = '50000000-0000-4000-8000-0000000000e2'
    await queueLinesOnHost(sid, [{ id: 'qm-once-1', message: 'hi', sentBy: 'person' }], 'mobile')
    // Still queued: the same id collapses onto the row.
    await queueLinesOnHost(sid, [{ id: 'qm-once-1', message: 'hi', sentBy: 'person' }], 'mobile')
    expect((await getQueue(sid)).map((m) => m.id)).toEqual(['qm-once-1'])
    // It ran (it left the queue): the resend after a lost answer is a no-op.
    await takeLinesForHost(sid)
    await queueLinesOnHost(sid, [{ id: 'qm-once-1', message: 'hi', sentBy: 'person' }], 'mobile')
    expect(await getQueue(sid)).toEqual([])
    // A row queued without onceById keeps today's rule (only a queued id collapses).
    await enqueueMessage(sid, 'plain', { id: 'qm-once-1' })
    expect((await getQueue(sid)).map((m) => m.id)).toEqual(['qm-once-1'])
  })
})
