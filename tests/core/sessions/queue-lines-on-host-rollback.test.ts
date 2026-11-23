/**
 * The host queues the lines a send or a resume brought all or nothing (src/core/sessions/handed-holds.ts
 * queueLinesOnHost): a queue write that fails part-way takes back the rows it had queued, and their
 * once-only marks, before the failure is answered. A resume its leader then delivers itself (it falls
 * back to legacy) leaves no line here to run a second time; a resend of the same ids queues them again.
 *
 * Real: the disk queue and its fates. Faked: one enqueue throws (a lock timeout, a disk error).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

const fail = vi.hoisted(() => ({ on: '' }))
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-queue-lines-rollback'))
vi.mock('../../../src/core/session-message-queue.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/core/session-message-queue.js')>()
  return {
    ...real,
    enqueueMessage: async (...args: Parameters<typeof real.enqueueMessage>) => {
      if (fail.on && args[1].includes(fail.on)) throw new Error('queue lock timed out')
      return real.enqueueMessage(...args)
    },
  }
})

import { WALNUT_HOME } from '../../../src/constants.js'
import { enqueueMessage, getQueue, resetCache } from '../../../src/core/session-message-queue.js'
import { queueLinesOnHost } from '../../../src/core/sessions/handed-holds.js'

const SID = 'cccccccc-3333-4333-8333-cccccccccccc'
const lines = [
  { id: 'qm-one', message: 'line one', sentBy: 'person' as const },
  { id: 'qm-two', message: 'line two', sentBy: 'person' as const },
  { id: 'qm-three', message: 'line three', sentBy: 'person' as const },
]

beforeEach(async () => {
  fail.on = ''
  resetCache()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
})

describe('queueLinesOnHost is all or nothing', () => {
  it('a failure on the second line takes the first back, and a resend of the same ids queues all three', async () => {
    fail.on = 'line two'
    await expect(queueLinesOnHost(SID, lines, 'ui')).rejects.toThrow(/lock timed out/)
    expect(await getQueue(SID)).toEqual([])
    // Its once-only mark went too: the same ids again are queued, not skipped as run already.
    fail.on = ''
    await queueLinesOnHost(SID, lines, 'ui')
    expect((await getQueue(SID)).map((m) => m.id)).toEqual(['qm-one', 'qm-two', 'qm-three'])
  })

  it('a row that was queued before the failed call stays', async () => {
    await enqueueMessage(SID, 'line one', { id: 'qm-one', onceById: true, sentBy: 'person' })
    fail.on = 'line three'
    await expect(queueLinesOnHost(SID, lines, 'ui')).rejects.toThrow(/lock timed out/)
    expect((await getQueue(SID)).map((m) => m.id)).toEqual(['qm-one'])
  })
})
