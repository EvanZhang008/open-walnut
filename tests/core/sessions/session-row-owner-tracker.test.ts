/**
 * The leader's session store keeps a host's row the host's (sessions/session-row-owner.ts):
 * every update path of session-tracker writes only the leader fields of a row its host judges,
 * and the channel that applies the host's facts (writingAsHost) writes the rest.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/** The host's stop of a session it runs (sessions/host-judged-controls.ts terminateOnHost): recorded, never run. */
const hostStops = vi.hoisted(() => [] as Array<{ sid: string; opts: unknown }>)
const ownerStops = vi.hoisted(() => [] as string[])
vi.mock('../../../src/core/sessions/host-judged-controls.js', () => ({
  terminateOnHost: async (sid: string, opts: unknown) => { hostStops.push({ sid, opts }); return { status: 'terminated', sessionId: sid } },
}))
vi.mock('../../../src/core/sessions/owner-stop.js', async (orig) => ({
  ...(await orig() as object),
  stopThroughOwner: async (r: { claudeSessionId: string }) => { ownerStops.push(r.claudeSessionId); return 'stopped' },
}))
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

  it('R2-M7: an engine switch\'s marks are the leader\'s: written here on a host\'s row, kept by the host\'s next row', async () => {
    await tracker.updateSessionRecord('sid-host-1', { supersededBy: 'sid-next', leftContext: { fingerprint: 'f1', at: 'x' } as never, engineSwitch: { fromSessionId: 'sid-prev', at: 'x' } as never, resumedBySwitch: { fromSessionId: 'sid-prev', at: 'x' } as never })
    expect(await tracker.getSessionByClaudeId('sid-host-1')).toMatchObject({ supersededBy: 'sid-next', leftContext: { fingerprint: 'f1' }, engineSwitch: { fromSessionId: 'sid-prev' }, resumedBySwitch: { fromSessionId: 'sid-prev' } })
    // The host's whole row (it never writes these) keeps them.
    const row = (await tracker.getSessionByClaudeId('sid-host-1'))!
    const { supersededBy: _s, leftContext: _l, engineSwitch: _e, resumedBySwitch: _r, title: _t, ...hostPart } = row as unknown as Record<string, unknown>
    await tracker.applyHostChannelBatch({ hostId: 'devbox', rows: [{ sid: 'sid-host-1', born: true, patch: hostPart }], renames: [], cursor: { logId: 'L-m7', seq: 1 } })
    expect(await tracker.getSessionByClaudeId('sid-host-1')).toMatchObject({ supersededBy: 'sid-next', engineSwitch: { fromSessionId: 'sid-prev' } })
  })

  it('R2-M3: completing a task hands a host\'s running session to its host to stop: its row is not written here, no owner stop is sent from here', async () => {
    await tracker.createSessionRecord('sid-host-2', 'task-h2', 'Marina', '/w', { host: 'devbox', title: 'Host run 2' })
    await writingAsHost(() => tracker.updateSessionRecord('sid-host-2', { judge: 'host', process_status: 'running', pid: 4242 }))
    const before = await tracker.getSessionByClaudeId('sid-host-2')
    const n = await tracker.completeTaskSessions(['sid-host-2'])
    expect(n).toBe(1)
    await vi.waitFor(() => expect(hostStops).toEqual([{ sid: 'sid-host-2', opts: { force: true, by: 'task_completed' } }]))
    expect(ownerStops).toEqual([])
    const after = await tracker.getSessionByClaudeId('sid-host-2')
    expect(after).toMatchObject({ process_status: 'running', pid: 4242, judge: 'host' })
    expect(after?.status_reason).toBe(before?.status_reason)
    expect(after?.taskCompleteStop).toBeUndefined()
  })

  it('the host channel\'s writer writes its host fields', async () => {
    await writingAsHost(() => tracker.updateSessionRecord('sid-host-1', { messageCount: 6 }))
    expect((await tracker.getSessionByClaudeId('sid-host-1'))?.messageCount).toBe(6)
  })
})
