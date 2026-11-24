/**
 * The rows a host that runs a session keeps parked in its own queue, in the leader's panel
 * (src/core/sessions/host-queue-rows.ts). 2026-11-24: twelve rows parked on a host for hours; the
 * console's queue read returned nothing for the session, its Retry made a second copy on the leader,
 * and its Discard found nothing to remove.
 *
 * Pinned here: the leader's queue read lists the host's parked rows (marked onHost) after its own,
 * and, when the host does not answer, its last answer marked partial; a Retry and a Discard of a row
 * the leader does not have go to the host, and when the host cannot be asked (down, or no answer in
 * time while it did act) they do nothing on the leader, never a copy queued here (review B1); the
 * phone's send-now finds the row's session; a session this server runs never asks a host; the
 * host's own members read, retry and discard its own rows.
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
import { _resetHostQueueRowsForTesting, sessionOfHostRow } from '../../../src/core/sessions/host-queue-rows.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'

const SID = '51000000-0000-4000-8000-0000000000a1'
const HOST_ROW = { id: 'qm-host-parked-1', sessionId: SID, message: 'parked on the host', status: 'parked', enqueuedAt: '2026-11-24T05:01:23.850Z', parkedAt: '2026-11-24T05:01:23.928Z', parkedReason: 'Working directory no longer exists: /work/ws', parkedCode: 'cwd_missing' }
let calls: Array<HostCallBody & { timeoutMs?: number }> = []
let answer: (body: HostCallBody, timeoutMs?: number) => unknown = () => null

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  _resetSessionTrackerForTesting()
  _resetJudgeOfForTesting()
  _resetRemoteJudgedSessionsForTesting()
  _resetHostQueueRowsForTesting()
  calls = []
  answer = () => null
  await createSessionRecord(SID, 't-host-rows', 'Acme', '/work/ws', { initialProcessStatus: 'idle' })
  setRemoteJudgedCaller(async (_host, body, timeoutMs) => { calls.push({ ...body, timeoutMs }); return answer(body, timeoutMs) })
})

afterEach(async () => {
  setRemoteJudgedCaller(null)
  _resetJudgeOfForTesting()
  _resetRemoteJudgedSessionsForTesting()
  resetCache()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the leader lists the rows its host keeps parked', () => {
  it('after its own, marked onHost, each once; its last answer, partial, when the host does not answer', async () => {
    noteHostJudged(SID, 'devbox')
    const own = await enqueueMessage(SID, 'on the leader')
    answer = (b) => (b.member === 'readParkedRows' ? [HOST_ROW, { ...HOST_ROW, id: own.id }, { id: 'not-a-row' }] : null)
    const ids = (p: Awaited<ReturnType<typeof getSessionQueuePayload>>) => p.messages.map((m) => [(m as { id: string }).id, (m as { onHost?: boolean }).onHost === true])
    const payload = await getSessionQueuePayload(SID)
    expect(ids(payload)).toEqual([[own.id, false], [HOST_ROW.id, true]])
    expect(payload).not.toHaveProperty('partial')
    // The link itself ends the wait (it drops its pending request then): no timer of its own here.
    expect(calls).toEqual([expect.objectContaining({ sid: SID, target: 'lifecycle', member: 'readParkedRows', timeoutMs: 3_000 })])

    // The host is slow or away: its last answer stands, so no bubble vanishes or reads delivered.
    answer = () => { throw new Error('readParkedRows on devbox: the host did not answer within 3000 ms') }
    const away = await getSessionQueuePayload(SID)
    expect(ids(away)).toEqual([[own.id, false], [HOST_ROW.id, true]])
    expect(away.partial).toBe(true)
  })

  it('a host older than these members lists nothing, as before, and is not partial', async () => {
    noteHostJudged(SID, 'devbox')
    const own = await enqueueMessage(SID, 'on the leader')
    answer = () => { throw new Error('readParkedRows on devbox: no_such_member') }
    const older = await getSessionQueuePayload(SID)
    expect(older.messages.map((m) => (m as { id: string }).id)).toEqual([own.id])
    expect(older).not.toHaveProperty('partial')
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
    expect(calls).toEqual([expect.objectContaining({ member: 'sendQueuedRowNow', args: [HOST_ROW.id, 'web-ui-retry', true], timeoutMs: 10_000 })])
    expect(await getQueue(SID)).toEqual([])
  })

  it('Retry while the host cannot be asked: unavailable, nothing queued here, also when the host did send it and its answer came too late', async () => {
    noteHostJudged(SID, 'devbox')
    // The link is down.
    answer = () => { throw new Error('the host devbox is not connected') }
    const down = await sendQueuedNow({ sessionId: SID, messageId: HOST_ROW.id, source: 'web-ui-retry', unpark: true })
    expect(down).toMatchObject({ sent: false, why: 'unavailable' })
    expect((down as { reason?: string }).reason).toMatch(/devbox.*cannot be reached right now/)
    expect(await getQueue(SID)).toEqual([])
    // The host took the call and sent its row, but its answer missed the link's deadline.
    const sentOnHost: string[] = []
    answer = (b, ms) => {
      if (b.member === 'sendQueuedRowNow') sentOnHost.push(String(b.args[0]))
      throw new Error(`sendQueuedRowNow on devbox: no answer within ${ms} ms`)
    }
    const late = await sendQueuedNow({ sessionId: SID, messageId: HOST_ROW.id, source: 'web-ui-retry', unpark: true })
    expect(late).toMatchObject({ sent: false, why: 'unavailable' })
    expect((late as { reason?: string }).reason).toMatch(/may have done it already/)
    expect(sentOnHost).toEqual([HOST_ROW.id])
    resetCache()
    expect(await getQueue(SID)).toEqual([])
  })

  it('a host older than the Retry member: the row reads gone here, as before', async () => {
    noteHostJudged(SID, 'devbox')
    answer = () => { throw new Error('sendQueuedRowNow on devbox: no_such_member') }
    expect(await sendQueuedNow({ sessionId: SID, messageId: HOST_ROW.id, source: 'web-ui-retry', unpark: true })).toEqual({ sent: false, why: 'gone' })
  })

  it('the phone\'s send-now names only the row: the session is the one whose host listed it', async () => {
    noteHostJudged(SID, 'devbox')
    expect(sessionOfHostRow(HOST_ROW.id)).toBeNull()
    answer = (b) => (b.member === 'readParkedRows' ? [HOST_ROW] : null)
    await getSessionQueuePayload(SID)
    expect(sessionOfHostRow(HOST_ROW.id)).toBe(SID)
    // Sent on the host: the listing forgets it, so a later failed read does not bring it back.
    answer = (b) => (b.member === 'sendQueuedRowNow' ? { sent: true, sessionId: SID } : null)
    await sendQueuedNow({ sessionId: SID, messageId: HOST_ROW.id, source: 'web-ui-retry', unpark: true })
    expect(sessionOfHostRow(HOST_ROW.id)).toBeNull()
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

  it('Discard while the host cannot be asked: refused as host_reconnecting, the row stays, nothing removed here', async () => {
    noteHostJudged(SID, 'devbox')
    const own = await enqueueMessage(SID, 'kept on the leader')
    answer = () => { throw new Error('the host devbox is not connected') }
    await expect(deleteSessionQueuedMessage(SID, HOST_ROW.id)).rejects.toMatchObject({ statusCode: 503, extra: { code: 'host_reconnecting' } })
    expect((await getQueue(SID)).map((m) => m.id)).toEqual([own.id])
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

describe('the phone\'s Send now of a row its host keeps (POST /api/v1/messages/:id/send-now)', () => {
  async function app() {
    const express = (await import('express')).default
    const { messagesV1Router } = await import('../../../src/web/routes/messages-v1.js')
    const { errorHandler } = await import('../../../src/web/middleware/error-handler.js')
    const a = express()
    a.use(express.json())
    a.use('/api/v1', messagesV1Router)
    a.use(errorHandler)
    return a
  }

  it('goes to the host, by the queue listing or a named session; an unreachable host is 503 and nothing is queued here', async () => {
    // Review S4 (2026-11-24): the phone listed the row but its Send now answered not_queued.
    const request = (await import('supertest')).default
    noteHostJudged(SID, 'devbox')
    answer = (b) => (b.member === 'readParkedRows' ? [HOST_ROW] : b.member === 'sendQueuedRowNow' ? { sent: true, sessionId: SID } : null)
    await getSessionQueuePayload(SID)
    const listed = await request(await app()).post(`/api/v1/messages/${HOST_ROW.id}/send-now`).send({})
    expect(listed.status).toBe(200)
    expect(listed.body).toMatchObject({ sent: true, messageId: HOST_ROW.id, sessionId: SID })
    expect(calls.filter((c) => c.member === 'sendQueuedRowNow').map((c) => c.args)).toEqual([[HOST_ROW.id, 'web-ui-retry', true]])

    // Not listed (a fresh server): the body names the session.
    _resetHostQueueRowsForTesting()
    const named = await request(await app()).post(`/api/v1/messages/${HOST_ROW.id}/send-now`).send({ sessionId: SID })
    expect(named.status).toBe(200)

    answer = () => { throw new Error('the host devbox is not connected') }
    const away = await request(await app()).post(`/api/v1/messages/${HOST_ROW.id}/send-now`).send({ sessionId: SID })
    expect(away.status).toBe(503)
    expect(away.body.error?.code ?? away.body.code).toBe('host_reconnecting')
    expect(await getQueue(SID)).toEqual([])
  })
})
