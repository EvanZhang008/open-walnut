/**
 * The leader's half of a hold of a session its host runs (src/core/sessions/handed-holds.ts): a
 * message lined up for after the running turn is held where the send is made, then handed to the
 * host with its hold, so the host's own queue-after-turn sends it when the host's turn ends. Before,
 * the held row stayed in the leader's queue, which nothing there releases for a host-judged session
 * (its subscribers skip it), and the host never had it.
 *
 * Real: the leader's queue file, its session store with a host's row the channel applied, the bus,
 * the runner's routing; the leader side is a fake that records what goes to the host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-handed-holds-leader'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { sessionRunner } from '../../../src/providers/claude-code-session.js'
import { closeDb } from '../../../src/core/session-db.js'
import { _resetSessionTrackerForTesting, applyHostChannelBatch, createSessionRecord } from '../../../src/core/session-tracker.js'
import { resetCache, sendMessageToSession, getQueue, enqueueMessage, takeLinesForHost } from '../../../src/core/session-message-queue.js'
import { _resetJudgeOfForTesting } from '../../../src/core/sessions/judge-of.js'
import { _setActiveLeaderSideForTesting } from '../../../src/core/session-channel/leader-boot.js'
import { stopQueueAfterTurn } from '../../../src/core/sessions/queue-after-turn.js'
import { AFTER_TURN_REASON, COLD_HOLD_REASON, STOP_PARKED_REASON } from '../../../src/core/relay-fates.js'
import type { SendBody } from '../../../src/core/session-channel/host-api.js'

const HOST_SID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const sent: Array<{ host: string; body: SendBody }> = []
let refuse = false
let refusals = 0

async function hostRow(): Promise<void> {
  await applyHostChannelBatch({
    hostId: 'devbox', renames: [], cursor: { logId: 'L', seq: 1 },
    rows: [{ sid: HOST_SID, born: true, patch: { claudeSessionId: HOST_SID, taskId: '', project: 'p', host: 'devbox', judge: 'host', process_status: 'running', startedAt: 'x', lastActiveAt: 'x', messageCount: 0 } }],
  })
  _resetJudgeOfForTesting()
}

const until = async (fn: () => Promise<boolean> | boolean, ms = 5_000) => {
  const end = Date.now() + ms
  while (!(await fn())) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)) }
}

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  _resetJudgeOfForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  sent.length = 0
  refuse = false
  refusals = 0
  _setActiveLeaderSideForTesting({
    sendToHost: async (host: string, body: unknown) => {
      if (refuse) { refusals++; throw new Error('the host is not connected') }
      sent.push({ host, body: body as SendBody })
      return { ok: true }
    },
  } as never)
})

afterEach(() => {
  stopQueueAfterTurn()
  _setActiveLeaderSideForTesting(null)
  vi.restoreAllMocks()
  closeDb()
  _resetSessionTrackerForTesting()
  _resetJudgeOfForTesting()
})

describe('a hold of a host-judged session goes to its host', () => {
  it('a message for after the running turn leaves this queue for the host, held, and starts no delivery', async () => {
    await hostRow()
    vi.spyOn(sessionRunner, 'isTurnRunning').mockReturnValue(true)
    const msg = await sendMessageToSession(HOST_SID, 'after this turn, please', { source: 'mobile', afterTurn: true })
    expect(msg.parkedReason).toBe(AFTER_TURN_REASON)
    await until(() => sent.length === 1)
    const body = sent[0]!.body
    expect(sent[0]!.host).toBe('devbox')
    expect(body.holdOnly).toBe(true)
    expect(body.queued).toHaveLength(1)
    expect(body.queued![0]).toMatchObject({ id: msg.id, held: { reason: AFTER_TURN_REASON } })
    expect(body.queued![0]!.message).toContain('after this turn, please')
    await until(async () => (await getQueue(HOST_SID)).length === 0)
  })

  it('a hand that did not reach the host puts the row back; the next send takes it with its own line', async () => {
    await hostRow()
    vi.spyOn(sessionRunner, 'isTurnRunning').mockReturnValue(true)
    refuse = true
    const msg = await sendMessageToSession(HOST_SID, 'held while the host is away', { source: 'mobile', afterTurn: true })
    await until(() => refusals === 1)
    await until(async () => (await getQueue(HOST_SID)).some((m) => m.id === msg.id))
    expect((await getQueue(HOST_SID)).map((m) => [m.id, m.status, m.parkedReason])).toEqual([[msg.id, 'parked', AFTER_TURN_REASON]])
    refuse = false
    const taken = await takeLinesForHost(HOST_SID)
    expect(taken.lines.map((m) => m.id)).toEqual([msg.id])
  })

  it('takes ready rows and held-for-turn or cold rows, and leaves any other held row here', async () => {
    await createSessionRecord('legacy-1', '', 'p')
    await enqueueMessage('legacy-1', 'ready')
    await enqueueMessage('legacy-1', 'after', { heldReason: AFTER_TURN_REASON })
    await enqueueMessage('legacy-1', 'cold', { heldReason: COLD_HOLD_REASON, coldSend: { source: 'agent' } })
    await enqueueMessage('legacy-1', 'stopped', { heldReason: STOP_PARKED_REASON })
    const held = await takeLinesForHost('legacy-1', { heldOnly: true })
    expect(held.lines.map((m) => m.message)).toEqual(['after', 'cold'])
    await held.putBack()
    const all = await takeLinesForHost('legacy-1')
    expect(all.lines.map((m) => m.message).sort()).toEqual(['after', 'cold', 'ready'])
    expect((await getQueue('legacy-1')).map((m) => m.message)).toEqual(['stopped'])
  })

  it('a hold of the leader\'s own session stays in its queue, as before', async () => {
    await createSessionRecord('legacy-2', '', 'p')
    vi.spyOn(sessionRunner, 'isTurnRunning').mockReturnValue(true)
    const msg = await sendMessageToSession('legacy-2', 'mine', { source: 'mobile', afterTurn: true })
    await new Promise((r) => setTimeout(r, 200))
    expect(sent).toEqual([])
    expect((await getQueue('legacy-2')).map((m) => [m.id, m.parkedReason])).toEqual([[msg.id, AFTER_TURN_REASON]])
  })
})
