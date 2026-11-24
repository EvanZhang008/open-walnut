/**
 * The rows a host that runs a session keeps parked in its own queue, in the leader's panel
 * (src/core/sessions/host-queue-rows.ts). 2026-11-24: twelve rows parked on a host for hours; the
 * console's queue read returned nothing for the session, its Retry made a second copy on the leader,
 * and its Discard found nothing to remove.
 *
 * Pinned here: the leader's queue read lists the host's parked rows (marked onHost) after its own,
 * and says partial when the host does not answer; a Retry and a Discard of a row the leader does not
 * have go to the host; a session this server runs never asks a host; the host's own members read,
 * retry and discard its own rows.
 *
 * Real: the queue file, the session store, judge-of, the host-judged proxy, the host's lifecycle
 * members. Faked: the leader's call to the host (setRemoteJudgedCaller).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/constants.js')>()
  return { ...actual, ...createMockConstants('walnut-host-queue-rows') }
})

import { WALNUT_HOME } from '../../../src/constants.js'
import { enqueueMessage, getQueue, markProcessing, parkMessages, resetCache } from '../../../src/core/session-message-queue.js'
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js'
import { _resetJudgeOfForTesting, noteHostJudged } from '../../../src/core/sessions/judge-of.js'
import { _resetRemoteJudgedSessionsForTesting, setRemoteJudgedCaller, type HostCallBody } from '../../../src/providers/remote-judged-session.js'
import { deleteSessionQueuedMessage, getSessionQueuePayload } from '../../../src/core/sessions/session-extras.js'
import { sendQueuedNow } from '../../../src/core/sessions/send-now.js'
import { discardQueuedRow, readParkedRows, sendQueuedRowNow } from '../../../src/core/sessions/host-lifecycle.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'

const SID = '51000000-0000-4000-8000-0000000000a1'
const HOST_ROW = { id: 'qm-host-parked-1', sessionId: SID, message: 'parked on the host', status: 'parked', enqueuedAt: '2026-11-24T05:01:23.850Z', parkedAt: '2026-11-24T05:01:23.928Z', parkedReason: 'Working directory no longer exists: /work/ws', parkedCode: 'cwd_missing' }
let calls: HostCallBody[] = []
let answer: (body: HostCallBody) => unknown = () => null

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  _resetSessionTrackerForTesting()
  _resetJudgeOfForTesting()
  _resetRemoteJudgedSessionsForTesting()
  calls = []
  answer = () => null
  await createSessionRecord(SID, 't-host-rows', 'Acme', '/work/ws', { initialProcessStatus: 'idle' })
  setRemoteJudgedCaller(async (_host, body) => { calls.push(body); return answer(body) })
})

afterEach(async () => {
  setRemoteJudgedCaller(null)
  _resetJudgeOfForTesting()
  _resetRemoteJudgedSessionsForTesting()
  resetCache()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the leader lists the rows its host keeps parked', () => {
  it('after its own, marked onHost, each once; partial when the host does not answer', async () => {
    noteHostJudged(SID, 'devbox')
    const own = await enqueueMessage(SID, 'on the leader')
    answer = (b) => (b.member === 'readParkedRows' ? [HOST_ROW, { ...HOST_ROW, id: own.id }, { id: 'not-a-row' }] : null)
    const payload = await getSessionQueuePayload(SID)
    expect(payload.messages.map((m) => [(m as { id: string }).id, (m as { onHost?: boolean }).onHost === true])).toEqual([[own.id, false], [HOST_ROW.id, true]])
    expect(payload).not.toHaveProperty('partial')
    expect(calls).toEqual([expect.objectContaining({ sid: SID, target: 'lifecycle', member: 'readParkedRows' })])

    answer = () => { throw new Error('no_such_member') }
    const older = await getSessionQueuePayload(SID)
    expect(older.messages.map((m) => (m as { id: string }).id)).toEqual([own.id])
    expect(older.partial).toBe(true)
  })

  it('a session this server runs asks no host', async () => {
    await enqueueMessage(SID, 'on the leader')
    expect((await getSessionQueuePayload(SID)).messages).toHaveLength(1)
    expect(await sendQueuedNow({ sessionId: SID, messageId: 'qm-nowhere', source: 'web-ui-retry', unpark: true })).toEqual({ sent: false, why: 'gone' })
    expect(calls).toEqual([])
  })
})

describe('a Retry and a Discard of a row the leader does not have go to its host', () => {
  it('Retry: the host sends its own row (a person\'s puts it back in line); no copy here', async () => {
    noteHostJudged(SID, 'devbox')
    answer = (b) => (b.member === 'sendQueuedRowNow' ? { sent: true, sessionId: SID } : null)
    expect(await sendQueuedNow({ sessionId: SID, messageId: HOST_ROW.id, source: 'web-ui-retry', unpark: true })).toEqual({ sent: true, sessionId: SID })
    expect(calls).toEqual([expect.objectContaining({ member: 'sendQueuedRowNow', args: [HOST_ROW.id, 'web-ui-retry', true] })])
    expect(await getQueue(SID)).toEqual([])
  })

  it('Discard: removed on the host; a row the leader still has that is taken is never asked there', async () => {
    noteHostJudged(SID, 'devbox')
    answer = (b) => (b.member === 'discardQueuedRow' ? true : null)
    await expect(deleteSessionQueuedMessage(SID, HOST_ROW.id)).resolves.toEqual({ ok: true })
    expect(calls.map((c) => c.member)).toEqual(['discardQueuedRow'])
    const row = await enqueueMessage(SID, 'taken here')
    await markProcessing(SID)
    await expect(deleteSessionQueuedMessage(SID, row.id)).rejects.toThrow(/not deletable/)
    expect(calls.map((c) => c.member)).toEqual(['discardQueuedRow'])
  })
})

describe('on the host: its own parked rows', () => {
  it('read, Retry and Discard act on this host\'s queue', async () => {
    const a = await enqueueMessage(SID, 'parked a')
    const b = await enqueueMessage(SID, 'parked b')
    const c = await enqueueMessage(SID, 'pending c')
    await parkMessages([a, b], { reason: 'Working directory no longer exists: /work/ws', code: 'cwd_missing' })
    expect(((await readParkedRows(SID)) as Array<{ id: string }>).map((r) => r.id)).toEqual([a.id, b.id])
    const kicks: unknown[] = []
    bus.subscribe('host-rows-kick', (e) => { if (e.name === EventNames.SESSION_SEND) kicks.push(e.data) }, { global: true, interest: [EventNames.SESSION_SEND] })
    try {
      // An agent's send-now leaves a parked row parked; a person's puts it back in line.
      expect(await sendQueuedRowNow(SID, a.id, 'leader-retry', false)).toMatchObject({ sent: false, why: 'parked' })
      expect(await sendQueuedRowNow(SID, a.id, 'leader-retry', true)).toEqual({ sent: true, sessionId: SID })
      expect(kicks).toHaveLength(1)
    } finally {
      bus.unsubscribe('host-rows-kick')
    }
    expect(await discardQueuedRow(SID, b.id)).toBe(true)
    expect((await getQueue(SID)).map((m) => `${m.id}:${m.status}`)).toEqual([`${a.id}:pending`, `${c.id}:pending`])
  })
})
