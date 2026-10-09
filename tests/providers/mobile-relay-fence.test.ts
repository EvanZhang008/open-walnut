/**
 * The Mac half of the withdraw protocol (gate r2 regressions, M1 to M5): the
 * real DaemonConnection relay handling, the real queue, the real fates
 * (core/relay-fates.ts, kept in the queue file).
 *
 *  - M1: an id answered "not received" is fenced: a relay frame of it that
 *    lands later is refused, never queued (the companion delivered it).
 *  - M2: a message with an earlier one of its session still queued is never
 *    given back ('behind'), so nothing delivers it ahead of that one.
 *  - M3/M4: every crash point of the enqueue and of the withdraw resolves to
 *    one delivery: the row and the fate are one write, and a person's removal
 *    is reported as such, never as "delivered".
 *  - M5: the fates live in the queue file, bounded, ids and times only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-relay-fence'))

const getSessionMock = vi.fn()
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: getSessionMock,
  updateSessionRecord: vi.fn(async () => undefined),
}))

/** Makes the next queue write fail, the way a crash before the rename would leave the file. */
let failNextWrite = false
vi.mock('../../src/utils/fs.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/utils/fs.js')>()
  return {
    ...mod,
    updateJsonFile: (async (file: string, fallback: unknown, mutate: (c: unknown) => unknown, opts?: Record<string, unknown>) => {
      if (failNextWrite) { failNextWrite = false; throw new Error('disk write failed') }
      return mod.updateJsonFile(file, fallback, mutate as never, opts)
    }) as typeof mod.updateJsonFile,
  }
})

import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import {
  getQueue, loadQueue, resetCache, markNextProcessing, removeProcessed, deleteMessage, sendMessageToSession,
} from '../../src/core/session-message-queue.js'
import { handleSessionControlRelay } from '../../src/core/sessions/session-controls.js'
import { setFate, fateOf, MAX_FATES, FATE_HORIZON_MS, type FateStore } from '../../src/core/relay-fates.js'
import { SESSION_QUEUE_FILE, WALNUT_HOME } from '../../src/constants.js'

const SID = 'fence-sid'

function makeConn(): { conn: DaemonConnection; replies: Array<Record<string, unknown>> } {
  const conn = new DaemonConnection('__local__', null)
  const replies: Array<Record<string, unknown>> = []
  ;(conn as unknown as { send: (cmd: string, params: Record<string, unknown>) => Promise<unknown> }).send =
    async (_cmd: string, params: Record<string, unknown>) => { replies.push(params); return { ok: true } }
  return { conn, replies }
}
async function relay(conn: DaemonConnection, messageId: string, relayId: number): Promise<void> {
  await (conn as unknown as { handleMessageRequest: (e: Record<string, unknown>) => Promise<void> })
    .handleMessageRequest({ relayId, sessionId: SID, message: `text of ${messageId}`, messageId, stopFence: null })
}
const withdraw = async (messageId: string) => {
  const r = await handleSessionControlRelay('message.withdraw', SID, { messageId }) as { ok: boolean; result?: { state?: string } }
  return r.ok ? r.result?.state : 'no-answer'
}
const ids = async () => (await getQueue(SID)).map((m) => m.id)
/** A restart of the Mac's server: only what is on disk survives. */
const restart = () => resetCache()

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  failNextWrite = false
  resetCache()
  await loadQueue()
  resetCache()
  getSessionMock.mockReset()
  getSessionMock.mockResolvedValue({ claudeSessionId: SID, taskId: 'task-f', process_status: 'idle', host: 'devbox' })
})
afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('M1 a relay frame that lands after the Mac answered not-received', () => {
  it('is refused and never queued, also after a restart', async () => {
    const { conn, replies } = makeConn()
    expect(await withdraw('qm-mobile-f10000000001')).toBe('not-received')
    restart()
    await relay(conn, 'qm-mobile-f10000000001', 1)
    expect(await ids()).toEqual([])
    expect(replies[0]).toMatchObject({ relayId: 1, errorKind: 'withdrawn' })
    expect(await withdraw('qm-mobile-f10000000001'), 'asked again: the same answer').toBe('not-received')
  })
})

describe('M2 a message queued behind an earlier pending one of its session', () => {
  it('is not given back while the earlier one waits; it is once that one is gone', async () => {
    const { conn } = makeConn()
    await relay(conn, 'qm-mobile-f20000000001', 1)
    await relay(conn, 'qm-mobile-f20000000002', 2)
    expect(await withdraw('qm-mobile-f20000000002')).toBe('behind')
    expect(await ids()).toEqual(['qm-mobile-f20000000001', 'qm-mobile-f20000000002'])
    expect(await withdraw('qm-mobile-f20000000001')).toBe('withdrawn')
    expect(await withdraw('qm-mobile-f20000000002')).toBe('withdrawn')
    expect(await ids()).toEqual([])
  })

  it('an id it never saw, with an earlier one queued, is behind and stays unfenced', async () => {
    const { conn } = makeConn()
    await relay(conn, 'qm-mobile-f20000000003', 1)
    expect(await withdraw('qm-mobile-f20000000004')).toBe('behind')
    // When the Mac's link returns, the companion relays it and it queues behind the earlier one.
    await relay(conn, 'qm-mobile-f20000000004', 2)
    expect(await ids()).toEqual(['qm-mobile-f20000000003', 'qm-mobile-f20000000004'])
  })

  it('a row mid-delivery ahead of it counts as earlier', async () => {
    const { conn } = makeConn()
    await relay(conn, 'qm-mobile-f20000000005', 1)
    await markNextProcessing(SID)
    await relay(conn, 'qm-mobile-f20000000006', 2)
    expect(await withdraw('qm-mobile-f20000000006')).toBe('behind')
  })
})

describe('M3 the crash points of a withdraw', () => {
  it('a row a person removed is reported removed, never delivered, and a later relay of it is refused', async () => {
    const { conn, replies } = makeConn()
    await relay(conn, 'qm-mobile-f30000000001', 1)
    expect(await deleteMessage(SID, 'qm-mobile-f30000000001')).toBe(true)
    restart()
    expect(await withdraw('qm-mobile-f30000000001')).toBe('removed')
    await relay(conn, 'qm-mobile-f30000000001', 2)
    expect(await ids()).toEqual([])
    expect(replies[1]).toMatchObject({ relayId: 2, errorKind: 'removed' })
  })

  it('a withdraw whose write fails changes nothing and answers nothing; asked again it withdraws', async () => {
    const { conn } = makeConn()
    await relay(conn, 'qm-mobile-f30000000002', 1)
    failNextWrite = true
    expect(await withdraw('qm-mobile-f30000000002')).toBe('no-answer')
    restart()
    expect(await ids(), 'the row is still there').toEqual(['qm-mobile-f30000000002'])
    expect(await withdraw('qm-mobile-f30000000002')).toBe('withdrawn')
    restart()
    expect(await ids()).toEqual([])
    expect(await withdraw('qm-mobile-f30000000002'), 'the removal and its fence went together').toBe('withdrawn')
  })
})

describe('M4 the crash points of an enqueue', () => {
  it('the row and its fate are one write', async () => {
    const { conn } = makeConn()
    await relay(conn, 'qm-mobile-f40000000001', 1)
    const saved = JSON.parse(await fs.readFile(SESSION_QUEUE_FILE, 'utf-8')) as { queues: Record<string, Array<{ id: string }>>; relay: Record<string, [string, number]> }
    expect(saved.queues[SID].map((m) => m.id)).toEqual(['qm-mobile-f40000000001'])
    expect(saved.relay['qm-mobile-f40000000001'][0]).toBe('taken')
  })

  it('a message that ran is delivered after a restart, and a replay of it is not a second turn', async () => {
    const { conn, replies } = makeConn()
    await relay(conn, 'qm-mobile-f40000000002', 1)
    const batch = await markNextProcessing(SID)
    await removeProcessed(SID, batch.map((m) => m.id))
    restart()
    expect(await withdraw('qm-mobile-f40000000002')).toBe('delivered')
    await relay(conn, 'qm-mobile-f40000000002', 2)
    expect(await ids()).toEqual([])
    expect(replies[1]).toMatchObject({ relayId: 2, result: { messageId: 'qm-mobile-f40000000002' } })
  })

  it('a phone message queued by another path that ran is still delivered, never not-received', async () => {
    await sendMessageToSession(SID, 'text', { source: 'mobile', taskId: 'task-f', messageId: 'qm-mobile-f40000000003', stopFence: null })
    const batch = await markNextProcessing(SID)
    await removeProcessed(SID, batch.map((m) => m.id))
    restart()
    expect(await withdraw('qm-mobile-f40000000003')).toBe('delivered')
  })
})

describe('M5 the fates: where, how many, what they hold', () => {
  it('in the queue file, ids with a fate and a time only, and they survive a restart', async () => {
    const { conn } = makeConn()
    for (let i = 1; i <= 3; i++) await relay(conn, `qm-mobile-f5000000000${i}`, i)
    const saved = JSON.parse(await fs.readFile(SESSION_QUEUE_FILE, 'utf-8')) as { relay: Record<string, unknown> }
    for (const [id, entry] of Object.entries(saved.relay)) {
      expect(id).toMatch(/^qm-mobile-f5\d{10}$/)
      expect(entry).toEqual(['taken', expect.any(Number)])
    }
    restart()
    expect(await withdraw('qm-mobile-f50000000001')).toBe('withdrawn')
  })

  it('at most MAX_FATES ids, the oldest dropped first, none past the horizon', () => {
    const s: FateStore = { queues: {} }
    const t0 = Date.now()
    for (let i = 0; i < MAX_FATES + 5; i++) setFate(s, `qm-mobile-m5${String(i).padStart(10, '0')}`, 'taken', t0)
    expect(Object.keys(s.relay ?? {}).length).toBe(MAX_FATES)
    expect(fateOf(s, 'qm-mobile-m50000000000', t0)).toBeUndefined()
    expect(fateOf(s, `qm-mobile-m5${String(MAX_FATES + 4).padStart(10, '0')}`, t0)).toBe('taken')
    expect(fateOf(s, `qm-mobile-m5${String(MAX_FATES + 4).padStart(10, '0')}`, t0 + FATE_HORIZON_MS + 1)).toBeUndefined()
  })
})
