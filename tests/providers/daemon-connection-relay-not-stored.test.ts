/**
 * r4c gate F2, Mac half: a relayed phone message whose queue write fails must
 * not be answered "taken". The best-effort write used to keep the row in this
 * process's memory only and answer success, so the companion marked it
 * "relayed" and forgot it, and a Mac restart lost it. Now the relayed enqueue
 * writes strictly and the Mac answers errorKind `not_stored`; the companion
 * keeps the message and asks again with the same id, which the Mac answers
 * once (also when the failed write did land on disk).
 *
 * The disk failure is the queue store's own write (updateJsonFile) failing on
 * demand, before or after its rename.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-relay-not-stored'))

const disk = vi.hoisted(() => ({ fail: null as null | 'before' | 'after' }))
vi.mock('../../src/utils/fs.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/utils/fs.js')>()
  return {
    ...real,
    updateJsonFile: (async (...args: Parameters<typeof real.updateJsonFile>) => {
      if (disk.fail === 'before') throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      const out = await real.updateJsonFile(...args)
      if (disk.fail === 'after') throw Object.assign(new Error('EIO: directory sync failed'), { code: 'EIO' })
      return out
    }) as typeof real.updateJsonFile,
  }
})

const getSessionMock = vi.fn()
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: getSessionMock,
  updateSessionRecord: vi.fn(async () => undefined),
}))

import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { enqueueMessage, getQueue, loadQueue, resetCache } from '../../src/core/session-message-queue.js'
import { WALNUT_HOME } from '../../src/constants.js'

const SID = 'relay-not-stored-sid'

function makeConn(): { conn: DaemonConnection; sent: Array<Record<string, unknown>> } {
  const conn = new DaemonConnection('__local__', null)
  const sent: Array<Record<string, unknown>> = []
  ;(conn as unknown as { send: (cmd: string, params: Record<string, unknown>) => Promise<unknown> }).send =
    async (cmd: string, params: Record<string, unknown>) => { if (cmd === 'message-result') sent.push(params); return { ok: true } }
  return { conn, sent }
}

const fire = (conn: DaemonConnection, relayId: number, messageId: string) =>
  (conn as unknown as { handleMessageRequest: (e: Record<string, unknown>) => Promise<void> })
    .handleMessageRequest({ ev: 'message-request', relayId, sessionId: SID, message: 'from the phone', messageId })

/** The queue as a restarted Mac reads it: from disk, no cache. */
async function onDisk(): Promise<string[]> {
  resetCache()
  return (await getQueue(SID)).map((m) => m.id)
}

beforeEach(async () => {
  disk.fail = null
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  await loadQueue()
  resetCache()
  getSessionMock.mockReset()
  getSessionMock.mockResolvedValue({ taskId: 'task-1', host: null, output_mode: 'markdown', output_mode_injected: 'markdown' })
})

afterEach(async () => {
  disk.fail = null
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a relayed message the Mac could not store (r4c F2)', () => {
  it('is answered not_stored, never taken, and lives nowhere a restart could lose it', async () => {
    const { conn, sent } = makeConn()
    const mid = 'qm-mobile-not-stored-1'
    disk.fail = 'before'
    await fire(conn, 1, mid)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ relayId: 1, errorKind: 'not_stored' })
    expect(sent[0].result).toBeUndefined()
    expect(String(sent[0].error)).toMatch(/could not store/)
    // Not even in this process's memory: nothing would deliver it behind the companion's back.
    expect((await getQueue(SID)).map((m) => m.id)).toEqual([])
    disk.fail = null
    expect(await onDisk()).toEqual([])
  })

  it('the companion asking again after the disk recovers: stored once, then deduped', async () => {
    const { conn, sent } = makeConn()
    const mid = 'qm-mobile-not-stored-2'
    disk.fail = 'before'
    await fire(conn, 1, mid)
    disk.fail = null
    await fire(conn, 2, mid)
    expect(sent[1]).toMatchObject({ relayId: 2, result: { messageId: mid } })
    expect(await onDisk()).toEqual([mid])
    await fire(conn, 3, mid)
    expect(sent[2]).toMatchObject({ relayId: 3, result: { messageId: mid } })
    expect(await onDisk()).toEqual([mid])
  })

  it('a write that landed before it failed: not_stored, and the retry finds the row (exactly once)', async () => {
    const { conn, sent } = makeConn()
    const mid = 'qm-mobile-not-stored-3'
    disk.fail = 'after'
    await fire(conn, 1, mid)
    expect(sent[0]).toMatchObject({ errorKind: 'not_stored' })
    disk.fail = null
    expect(await onDisk()).toEqual([mid])
    await fire(conn, 2, mid)
    expect(sent[1]).toMatchObject({ relayId: 2, result: { messageId: mid } })
    expect(await onDisk()).toEqual([mid])
  })

  it('a message that was not relayed keeps the old best-effort write (kept in memory, no error)', async () => {
    disk.fail = 'before'
    const msg = await enqueueMessage(SID, 'typed on the Mac')
    expect((await getQueue(SID)).map((m) => m.id)).toEqual([msg.id])
  })
})
