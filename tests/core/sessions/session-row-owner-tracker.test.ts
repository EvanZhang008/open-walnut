/**
 * The leader's session store keeps a host's row the host's (sessions/session-row-owner.ts):
 * every update path of session-tracker writes only the leader fields of a row its host judges,
 * and the channel that applies the host's facts (writingAsHost) writes the rest.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-row-owner-tracker', { CLOUD_MODE: false }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { _resetServerRoleForTesting } from '../../../src/core/server-role.js'
import * as sessionDb from '../../../src/core/session-db.js'
import * as tracker from '../../../src/core/session-tracker.js'
import { writingAsHost } from '../../../src/core/sessions/session-row-owner.js'

beforeAll(async () => {
  for (const k of ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER']) delete process.env[k]
  _resetServerRoleForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  await tracker.createSessionRecord('sid-host-1', 'task-h1', 'Marina', '/home/acme/marina', { host: 'devbox', title: 'Host run' })
  await writingAsHost(() => tracker.updateSessionRecord('sid-host-1', { judge: 'host', process_status: 'running', messageCount: 5 }))
  await tracker.createSessionRecord('sid-lead-1', 'task-l1', 'Marina', undefined, { title: 'Leader run' })
})

afterAll(async () => {
  sessionDb.closeDb()
  tracker._resetSessionTrackerForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('on the leader, a host\'s row', () => {
  it('updateSessionRecord writes its leader fields and leaves its host fields', async () => {
    const r = await tracker.updateSessionRecord('sid-host-1', { title: 'Renamed', process_status: 'stopped', messageCount: 0 })
    expect(r).toMatchObject({ title: 'Renamed', process_status: 'running', messageCount: 5, judge: 'host' })
  })

  it('the batch and the conditional update do the same', async () => {
    await tracker.batchUpdateSessionRecords(['sid-host-1', 'sid-lead-1'], { archived: true, process_status: 'stopped' })
    expect(await tracker.getSessionByClaudeId('sid-host-1')).toMatchObject({ archived: true, process_status: 'running' })
    expect(await tracker.getSessionByClaudeId('sid-lead-1')).toMatchObject({ archived: true, process_status: 'stopped' })
    await tracker.updateSessionRecordConditionally('sid-host-1', { human_note: 'n', messageCount: 99 }, () => true)
    expect(await tracker.getSessionByClaudeId('sid-host-1')).toMatchObject({ human_note: 'n', messageCount: 5 })
  })

  it('the host channel\'s writer writes its host fields', async () => {
    await writingAsHost(() => tracker.updateSessionRecord('sid-host-1', { messageCount: 6 }))
    expect((await tracker.getSessionByClaudeId('sid-host-1'))?.messageCount).toBe(6)
  })
})
