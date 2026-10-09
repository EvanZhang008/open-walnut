/**
 * The Mac's answer to the companion's "do you hold this phone message?"
 * (session.control `message.withdraw`, core/sessions/mobile-relay-ledger.ts).
 *
 * The companion asks when a relay of a phone send lost its answer and the
 * Mac's link to the session's host is down while the host takes sends
 * directly. Whatever the Mac answers must make a second delivery impossible:
 * a pending row is removed and its id fenced (a relay of it that lands later is
 * refused: the companion delivers it another way), a message its queue already
 * ran stays "delivered" even after a restart of this server, and a row
 * mid-delivery is never taken from under the delivery.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-msg-withdraw'))

const getSessionMock = vi.fn()
const updateSessionMock = vi.fn(async () => undefined)
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: getSessionMock,
  updateSessionRecord: updateSessionMock,
}))

import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { getQueue, loadQueue, resetCache, markNextProcessing, markProcessing, removeProcessed, deleteMessage, sendMessageToSession, parkMessages } from '../../src/core/session-message-queue.js'
import { handleSessionControlRelay } from '../../src/core/sessions/session-controls.js'
import { WALNUT_HOME } from '../../src/constants.js'

const SID = 'withdraw-sid-1'

function makeConn(): { conn: DaemonConnection; sent: Array<{ cmd: string; params: Record<string, unknown> }> } {
  const conn = new DaemonConnection('__local__', null)
  const sent: Array<{ cmd: string; params: Record<string, unknown> }> = []
  ;(conn as unknown as { send: (cmd: string, params: Record<string, unknown>) => Promise<unknown> }).send =
    async (cmd: string, params: Record<string, unknown>) => { sent.push({ cmd, params }); return { ok: true } }
  return { conn, sent }
}

async function relay(conn: DaemonConnection, messageId: string, relayId: number): Promise<void> {
  await (conn as unknown as { handleMessageRequest: (e: Record<string, unknown>) => Promise<void> })
    .handleMessageRequest({ relayId, sessionId: SID, message: `text of ${messageId}`, messageId, stopFence: null })
}

const withdraw = (messageId: string) => handleSessionControlRelay('message.withdraw', SID, { messageId })

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  await loadQueue()
  resetCache()
  getSessionMock.mockReset()
  getSessionMock.mockResolvedValue({ claudeSessionId: SID, taskId: 'task-w', process_status: 'idle', host: 'devbox' })
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('message.withdraw on the Mac', () => {
  it('a pending row is removed, and a relay of the same message that lands later is refused', async () => {
    const { conn, sent } = makeConn()
    await relay(conn, 'qm-mobile-wd0000000001', 1)
    expect((await getQueue(SID)).map((m) => m.id)).toEqual(['qm-mobile-wd0000000001'])
    expect(await withdraw('qm-mobile-wd0000000001')).toEqual({ ok: true, result: { state: 'withdrawn' } })
    expect(await getQueue(SID)).toEqual([])
    // A frame of it still on its way lands: the companion delivers it another way.
    await relay(conn, 'qm-mobile-wd0000000001', 2)
    expect(await getQueue(SID), 'never taken a second time').toEqual([])
    expect(sent.map((f) => f.params.errorKind)).toEqual([undefined, 'withdrawn'])
    // Asked again (its answer was lost): the same answer.
    expect(await withdraw('qm-mobile-wd0000000001')).toEqual({ ok: true, result: { state: 'withdrawn' } })
  })

  it('a message this Mac never saw is not-received', async () => {
    expect(await withdraw('qm-mobile-wd0000000002')).toEqual({ ok: true, result: { state: 'not-received' } })
  })

  it('a message its queue already ran is delivered, also after this server restarts', async () => {
    const { conn } = makeConn()
    await relay(conn, 'qm-mobile-wd0000000003', 3)
    const batch = await markNextProcessing(SID)
    await removeProcessed(SID, batch.map((m) => m.id))
    expect(await withdraw('qm-mobile-wd0000000003')).toEqual({ ok: true, result: { state: 'delivered' } })
    // A restart wipes the in-memory copy; the queue file still knows.
    resetCache()
    expect(await withdraw('qm-mobile-wd0000000003')).toEqual({ ok: true, result: { state: 'delivered' } })
    // And a replay of it is still answered without a second turn.
    await relay(conn, 'qm-mobile-wd0000000003', 4)
    expect(await getQueue(SID)).toEqual([])
  })

  it('a row mid-delivery is never taken from under the delivery', async () => {
    const { conn } = makeConn()
    await relay(conn, 'qm-mobile-wd0000000004', 5)
    await markNextProcessing(SID)
    expect(await withdraw('qm-mobile-wd0000000004')).toEqual({ ok: true, result: { state: 'delivering' } })
    expect((await getQueue(SID)).map((m) => [m.id, m.status])).toEqual([['qm-mobile-wd0000000004', 'processing']])
  })

  it('refuses a message id that is not a phone message id', async () => {
    const res = await handleSessionControlRelay('message.withdraw', SID, { messageId: '../x' })
    expect(res).toMatchObject({ ok: false, errorKind: 'bad_request' })
  })
})

describe('message.withdraw: rows that will never run here are never handed back (gate r3, M6 M7 N5)', () => {
  it('a phone message an older Mac took with no fate, removed here by a person, is removed (never not-received)', async () => {
    await sendMessageToSession(SID, 'text', { source: 'mobile', taskId: 'task-w', messageId: 'qm-mobile-wd0000000010', stopFence: null })
    expect(await deleteMessage(SID, 'qm-mobile-wd0000000010')).toBe(true)
    expect(await withdraw('qm-mobile-wd0000000010')).toEqual({ ok: true, result: { state: 'removed' } })
  })

  it('a row a stop here parked answers stopped: it must not run directly past the stop', async () => {
    const { conn } = makeConn()
    await relay(conn, 'qm-mobile-wd0000000011', 11)
    // A stop on the Mac: the next delivery attempt carries the new fence and parks the older row.
    await markProcessing(SID, 'stop-newer')
    expect((await getQueue(SID)).map((m) => [m.id, m.status])).toEqual([['qm-mobile-wd0000000011', 'parked']])
    expect(await withdraw('qm-mobile-wd0000000011')).toEqual({ ok: true, result: { state: 'stopped' } })
    expect((await getQueue(SID)).map((m) => m.id), 'the row stays for the person').toEqual(['qm-mobile-wd0000000011'])
  })

  it('a row parked for any other reason answers parked: held, waiting for the person, never sent another way', async () => {
    const { conn } = makeConn()
    await relay(conn, 'qm-mobile-wd0000000012', 12)
    await parkMessages(await getQueue(SID), 'permanent delivery failure')
    expect(await withdraw('qm-mobile-wd0000000012')).toEqual({ ok: true, result: { state: 'parked' } })
  })
})

describe('a replayed relay frame of a message this Mac already took', () => {
  const resultsOf = (sent: Array<{ cmd: string; params: Record<string, unknown> }>) =>
    sent.filter((f) => f.cmd === 'message-result').map((f) => f.params.errorKind ?? 'ok')

  it('that already ran: answered as taken, even after a stop since (it is not "stopped")', async () => {
    const { conn, sent } = makeConn()
    await relay(conn, 'qm-mobile-wd0000000013', 13)
    const batch = await markNextProcessing(SID)
    await removeProcessed(SID, batch.map((m) => m.id))
    getSessionMock.mockResolvedValue({
      claudeSessionId: SID, taskId: 'task-w', process_status: 'stopped', host: 'devbox',
      stopRequest: { id: 'stop-after', state: 'confirmed', requestedAt: new Date().toISOString() },
    })
    await relay(conn, 'qm-mobile-wd0000000013', 14)
    expect(resultsOf(sent)).toEqual(['ok', 'ok'])
    expect(await getQueue(SID)).toEqual([])
  })

  it('still waiting here when a stop overtook it: answered stopped', async () => {
    const { conn, sent } = makeConn()
    await relay(conn, 'qm-mobile-wd0000000015', 15)
    getSessionMock.mockResolvedValue({
      claudeSessionId: SID, taskId: 'task-w', process_status: 'stopped', host: 'devbox',
      stopRequest: { id: 'stop-after', state: 'confirmed', requestedAt: new Date().toISOString() },
    })
    await relay(conn, 'qm-mobile-wd0000000015', 16)
    expect(resultsOf(sent)).toEqual(['ok', 'session_stopped'])
  })
})
