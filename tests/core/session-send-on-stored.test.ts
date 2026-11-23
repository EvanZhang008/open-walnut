/**
 * A send that carries `onStored` (a scheduled routine's sent mark, src/core/cron/sent-run.ts) is
 * told so only once its row is on disk (sendMessageToSession, session-message-queue.ts). A row the
 * disk refused lives in the queue's cache until a later flush; a kill before that flush loses it,
 * so a mark written for it would record a run whose message never existed (review, 2026-11-21).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/constants.js')>()
  return { ...actual, ...createMockConstants('walnut-send-on-stored') }
})

const disk = vi.hoisted(() => ({ refuseQueue: false }))
vi.mock('../../src/utils/fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/fs.js')>()
  return {
    ...actual,
    writeJsonFile: async (...args: Parameters<typeof actual.writeJsonFile>) => {
      if (disk.refuseQueue && String(args[0]).endsWith('session-message-queue.json')) throw new Error('ENOSPC: no space left on device')
      return await actual.writeJsonFile(...args)
    },
  }
})

import { WALNUT_HOME, SESSION_QUEUE_FILE } from '../../src/constants.js'
import { resetCache, sendMessageToSession } from '../../src/core/session-message-queue.js'
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js'

const SID = 'bbbbbbbb-1111-4222-8333-444444444444'
const ROUTINE_ID = 'qm-routine-0123456789abcdef'

async function rowsOnDisk(): Promise<string[]> {
  const raw = await fsp.readFile(SESSION_QUEUE_FILE, 'utf-8').catch(() => '{"queues":{}}')
  const store = JSON.parse(raw) as { queues: Record<string, Array<{ id: string }>> }
  return (store.queues[SID] ?? []).map((r) => r.id)
}

beforeEach(async () => {
  disk.refuseQueue = false
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  _resetSessionTrackerForTesting()
  await createSessionRecord(SID, 't-vp', 'Acme', '/tmp')
})

afterEach(async () => {
  disk.refuseQueue = false
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('onStored', () => {
  it('is told once the row is on disk', async () => {
    const onStored = vi.fn()
    await sendMessageToSession(SID, 'Reflect on the day.', { source: 'routine-trigger', messageId: ROUTINE_ID, onStored })
    expect(onStored).toHaveBeenCalledTimes(1)
    expect(await rowsOnDisk()).toEqual([ROUTINE_ID])
  })

  // 2026-11-23: a queue file that refuses the row sends it to the spool, synced, never the cache
  // alone; the send is stored, and the queue takes it once it can be written (session-queue-spool.ts).
  it('is told only once the row is on disk: a refused queue write stores it in the spool', async () => {
    const onStored = vi.fn()
    disk.refuseQueue = true
    await sendMessageToSession(SID, 'Reflect on the day.', { source: 'routine-trigger', messageId: ROUTINE_ID, onStored })
    expect(onStored).toHaveBeenCalledTimes(1)
    expect(await rowsOnDisk()).toEqual([])
    disk.refuseQueue = false
    const { drainQueueSpool } = await import('../../src/core/session-queue-spool.js')
    await drainQueueSpool()
    expect(await rowsOnDisk()).toEqual([ROUTINE_ID])
  })
})
