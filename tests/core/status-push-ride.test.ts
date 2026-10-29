/**
 * A status line for an asker that is not running rides its next message, through the real
 * sendMessageToSession (session-message-queue.ts), in the same queue row: never a row of its own,
 * which a restart or a host reconnect would dispatch and so wake the asker. Told once.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/constants.js')>()
  return { ...actual, ...createMockConstants('walnut-status-ride') }
})

import { resetCache, sendMessageToSession, getQueue } from '../../src/core/session-message-queue.js'
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js'
import { _rideForTest, pendingStatusNote, stopStatusPush } from '../../src/core/sessions/status-push.js'

const SID = 'aaaaaaaa-1111-4222-8333-444444444444'

beforeEach(async () => {
  stopStatusPush()
  resetCache()
  _resetSessionTrackerForTesting()
  await createSessionRecord(SID, 't-asker', 'Acme', '/tmp')
})

describe('the ride-along status line', () => {
  it('goes out with the next message in its row, once, and adds no row of its own', async () => {
    _rideForTest(SID, 't-w', '- "Sign-in worker" (t-w): Needs you → Working at 17:00 UTC.')
    expect((await getQueue(SID)).length).toBe(0)
    const first = await sendMessageToSession(SID, 'hello', { source: 'ui' })
    expect(first.message).toContain('outcome="status"')
    expect(first.message).toContain('Needs you → Working')
    expect(first.message).toContain('hello')
    expect(pendingStatusNote(SID)).toBeNull()
    const second = await sendMessageToSession(SID, 'again', { source: 'ui' })
    expect(second.message).not.toContain('outcome="status"')
    expect((await getQueue(SID)).length).toBe(2)
  })
})
