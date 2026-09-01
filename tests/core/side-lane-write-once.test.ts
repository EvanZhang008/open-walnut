/**
 * Regression pin: the runner echoes its spawn-time in-memory lane through
 * createSessionRecord's existing-row branch on EVERY turn result
 * (persistSessionRecord → createSessionRecord). A record-side lane change
 * (side-thread standby consume renames it, promote clears it) MUST survive
 * that echo — when it didn't, a consumed thread reverted to the standby lane
 * after its first answer and was then retired/re-consumed under the user, and
 * a promoted session silently re-hid itself.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-lane-once'))

import { WALNUT_HOME } from '../../src/constants.js'
import {
  createSessionRecord, getSessionByClaudeId, updateSessionRecord,
} from '../../src/core/session-tracker.js'

const SID = '22222222-2222-4222-8222-222222222222'
const STANDBY_LANE = `side:${SID}:standby`
const THREAD_LANE = `side:${SID}:sth-1`

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  const [sessionDb, sessionTracker] = await Promise.all([
    import('../../src/core/session-db.js'),
    import('../../src/core/session-tracker.js'),
  ])
  sessionDb.closeDb()
  sessionTracker._resetSessionTrackerForTesting()
})

afterEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
})

describe('lane survives the runner echo', () => {
  it('a RENAMED lane is not reverted by a turn-result echo of the spawn-time lane', async () => {
    await createSessionRecord(SID, '', 'proj', '/repo', { lane: STANDBY_LANE })
    // Standby consume: record-side rename.
    await updateSessionRecord(SID, { lane: THREAD_LANE })
    // Turn result: the runner re-persists with its stale in-memory lane.
    await createSessionRecord(SID, '', 'proj', '/repo', { lane: STANDBY_LANE, pid: 4242 })
    expect((await getSessionByClaudeId(SID))?.lane).toBe(THREAD_LANE)
  })

  it('a CLEARED lane (promote) is not resurrected by the echo', async () => {
    await createSessionRecord(SID, '', 'proj', '/repo', { lane: THREAD_LANE })
    // Promote: lane cleared to un-hide the session.
    await updateSessionRecord(SID, { taskId: 'task-9', lane: undefined })
    await createSessionRecord(SID, 'task-9', 'proj', '/repo', { lane: THREAD_LANE, pid: 4242 })
    expect((await getSessionByClaudeId(SID))?.lane).toBeUndefined()
  })

  it('the CREATION write still seeds the lane (write path is new rows only)', async () => {
    await createSessionRecord(SID, '', 'proj', '/repo', { lane: STANDBY_LANE })
    expect((await getSessionByClaudeId(SID))?.lane).toBe(STANDBY_LANE)
  })
})
