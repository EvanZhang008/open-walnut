/**
 * The leader's session store keeps a host's row the host's (sessions/session-row-owner.ts):
 * every update path of session-tracker writes only the leader fields of a row its host judges,
 * and the channel that applies the host's facts (writingAsHost) writes the rest.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/** The host's stop of a session it runs (sessions/host-judged-controls.ts terminateOnHost): recorded, never run. */
const hostStops = vi.hoisted(() => [] as Array<{ sid: string; opts: unknown }>)
/** A host that takes the stop itself is asked (sessions/host-judged-complete.ts takeCompletionStop): recorded. */
const hostAsks = vi.hoisted(() => [] as Array<{ sid: string; member: string; when: unknown }>)
const ownerStops = vi.hoisted(() => [] as string[])
vi.mock('../../../src/core/sessions/host-judged-controls.js', () => ({
  terminateOnHost: async (sid: string, opts: unknown) => { hostStops.push({ sid, opts }); return { status: 'terminated', sessionId: sid } },
  onJudgingHost: async (sid: string, member: string, args: Array<{ when?: unknown }>) => { hostAsks.push({ sid, member, when: args[0]?.when }); return { state: 'stopped' } },
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
import { _resetHostJudgedCompleteForTesting, noteHostCompleteStop } from '../../../src/core/sessions/host-judged-complete.js'

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
    // A host from before session-complete-stop-v1: the stop is handed over whole.
    _resetHostJudgedCompleteForTesting()
    noteHostCompleteStop('devbox', 'old')
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

  it('R2-M3, a host that takes the stop itself: it is asked, and the row is not written here either', async () => {
    _resetHostJudgedCompleteForTesting()
    noteHostCompleteStop('devbox', 'takes')
    await tracker.createSessionRecord('sid-host-3', 'task-h3', 'Marina', '/w', { host: 'devbox', title: 'Host run 3' })
    await writingAsHost(() => tracker.updateSessionRecord('sid-host-3', { judge: 'host', process_status: 'running', pid: 4343 }))
    const before = await tracker.getSessionByClaudeId('sid-host-3')
    expect(await tracker.completeTaskSessions(['sid-host-3'])).toBe(1)
    await vi.waitFor(() => expect(hostAsks).toEqual([{ sid: 'sid-host-3', member: 'takeCompletionStop', when: 'now' }]))
    expect(hostStops.filter((s) => s.sid === 'sid-host-3')).toEqual([])
    expect(ownerStops).toEqual([])
    const after = await tracker.getSessionByClaudeId('sid-host-3')
    expect(after).toMatchObject({ process_status: 'running', pid: 4343, judge: 'host' })
    expect(after?.status_reason).toBe(before?.status_reason)
    expect(after?.taskCompleteStop).toBeUndefined()
  })

  it('2026-11-24: what the leader told the session is kept in its own copies, and the host\'s next row keeps them', async () => {
    const told = { version: 'v1', promptHash: 'p', lines: ['h1'], toldAt: '2026-11-24T13:00:00.000Z' }
    const place = { promptHash: 'p', project: 'Marina' }
    await tracker.updateSessionRecord('sid-host-1', { taskRoutingNoted: told, placeNoted: place, outputModeHookAt: '2026-11-24T13:00:01.000Z' })
    const row = (await tracker.getSessionByClaudeId('sid-host-1'))!
    expect(row).toMatchObject({ taskRoutingNotedByLeader: told, placeNotedByLeader: place, outputModeHookAtByLeader: '2026-11-24T13:00:01.000Z' })
    expect(row.taskRoutingNoted).toBeUndefined()
    expect(row.placeNoted).toBeUndefined()
    // The host's whole row names only its own told records: the leader's stay.
    const { taskRoutingNotedByLeader: _a, placeNotedByLeader: _b, outputModeHookAtByLeader: _c, title: _t, ...hostPart } = row as unknown as Record<string, unknown>
    await tracker.applyHostChannelBatch({ hostId: 'devbox', rows: [{ sid: 'sid-host-1', born: true, patch: { ...hostPart, taskRoutingNoted: { ...told, version: 'host' } } }], renames: [], cursor: { logId: 'L-told', seq: 1 } })
    expect(await tracker.getSessionByClaudeId('sid-host-1')).toMatchObject({ taskRoutingNotedByLeader: told, taskRoutingNoted: { version: 'host' } })
    // A leader's own session keeps them where they always were.
    await tracker.updateSessionRecord('sid-lead-1', { taskRoutingNoted: told })
    expect(await tracker.getSessionByClaudeId('sid-lead-1')).toMatchObject({ taskRoutingNoted: told })
  })

  it('2026-11-24: a field an older host log cut keeps the leader\'s value, even in a whole row', async () => {
    const full = 'P'.repeat(500)
    await writingAsHost(() => tracker.updateSessionRecord('sid-host-1', { appliedAppendSystemPrompt: full }))
    const row = (await tracker.getSessionByClaudeId('sid-host-1'))!
    const { title: _t, ...hostPart } = row as unknown as Record<string, unknown>
    await tracker.applyHostChannelBatch({ hostId: 'devbox', rows: [{ sid: 'sid-host-1', patch: { appliedAppendSystemPrompt: 'P'.repeat(100), messageCount: 7 }, keep: ['appliedAppendSystemPrompt'] }], renames: [], cursor: { logId: 'L-cut', seq: 1 } })
    expect(await tracker.getSessionByClaudeId('sid-host-1')).toMatchObject({ appliedAppendSystemPrompt: full, messageCount: 7 })
    const { appliedAppendSystemPrompt: _p, ...noPrompt } = hostPart
    await tracker.applyHostChannelBatch({ hostId: 'devbox', rows: [{ sid: 'sid-host-1', born: true, patch: noPrompt, keep: ['appliedAppendSystemPrompt'] }], renames: [], cursor: { logId: 'L-cut', seq: 2 } })
    expect((await tracker.getSessionByClaudeId('sid-host-1'))?.appliedAppendSystemPrompt).toBe(full)
  })

  it('2026-11-24: a boundary the host read makes the leader\'s rich-output instruction due again, unless the hook restated it', async () => {
    await tracker.updateSessionRecord('sid-host-1', { output_mode_injected: 'rich' })
    const prevAt = new Date(Date.now() - 3_600_000).toISOString()
    await tracker.applyHostChannelBatch({ hostId: 'devbox', rows: [{ sid: 'sid-host-1', patch: { lastCompactUuid: 'b1', lastCompactAt: prevAt } }], renames: [], cursor: { logId: 'L-b', seq: 1 } })
    expect((await tracker.getSessionByClaudeId('sid-host-1'))?.output_mode_injected).toBeUndefined()
    // The leader's hook restated it a moment before the host read the next boundary: it stays told.
    await tracker.updateSessionRecord('sid-host-1', { output_mode_injected: 'rich', outputModeHookAt: new Date(Date.now() - 30_000).toISOString() })
    await tracker.applyHostChannelBatch({ hostId: 'devbox', rows: [{ sid: 'sid-host-1', patch: { lastCompactUuid: 'b2', lastCompactAt: new Date().toISOString() } }], renames: [], cursor: { logId: 'L-b', seq: 2 } })
    expect((await tracker.getSessionByClaudeId('sid-host-1'))?.output_mode_injected).toBe('rich')
  })

  it('the host channel\'s writer writes its host fields', async () => {
    await writingAsHost(() => tracker.updateSessionRecord('sid-host-1', { messageCount: 6 }))
    expect((await tracker.getSessionByClaudeId('sid-host-1'))?.messageCount).toBe(6)
  })
})
