/**
 * The real reads behind "is the task's work over" (workspaces/still-working.ts,
 * realStillWorkingIo) over a real session store: the incident's record (marked
 * stopped, its pid cleared, its process still running on the host), a deleted
 * task's session found by its folder after the deletion unlinked it, another
 * spelling of the same folder, and a host that does not answer in time. The host's
 * daemon is a fake that answers `status` from a table, or never.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

const state = vi.hoisted(() => ({ alive: new Map<string, boolean>(), hang: new Set<string>(), asked: [] as string[] }))

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-workspace-still-working-io'))
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  probeDaemonSession: async (host: string, sid: string) => {
    state.asked.push(`${host}:${sid}`)
    if (state.hang.has(sid)) return new Promise(() => {})
    return { alive: state.alive.get(sid) === true }
  },
  getConnectedDaemonConnection: () => null,
  isDaemonConnected: () => false,
  getDaemonDisconnectedSince: () => null,
}))

import { createSessionRecord, getSessionsInFolder, unlinkSessionsFromTasks, updateSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js'
import { closeDb } from '../../../src/core/session-db.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { PROBE_DEADLINE_MS, realStillWorkingIo, stillWorking as gate } from '../../../src/core/workspaces/still-working.js'

/** The gate's reason, or null (the `soon` flag is checked on its own). */
const stillWorking = async (...a: Parameters<typeof gate>) => (await gate(...a))?.why ?? null

const ROOT = '/home/u/.open-walnut-worktrees/open-walnut/threads-e7a5ea6a'

beforeEach(async () => {
  state.alive.clear()
  state.hang.clear()
  state.asked = []
  _resetSessionTrackerForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
})

afterEach(() => {
  vi.useRealTimers()
  closeDb()
  _resetSessionTrackerForTesting()
})

describe('realStillWorkingIo', () => {
  it("the incident: a record marked stopped with its pid cleared, whose process still runs, holds the task's workspace", async () => {
    await createSessionRecord('e5989ff5-live', 'task-a', 'Walnut', ROOT)
    await updateSessionRecord('e5989ff5-live', { process_status: 'stopped', pid: undefined, host: 'clouddev' })
    state.alive.set('e5989ff5-live', true)
    expect(await stillWorking({ id: 'task-a' }, { root: ROOT }, realStillWorkingIo, { requests: false })).toMatch(/still runs on the host \(its record says stopped\)/)
    expect(state.asked).toEqual(['clouddev:e5989ff5-live'])
    state.alive.set('e5989ff5-live', false)
    expect(await stillWorking({ id: 'task-a' }, { root: ROOT }, realStillWorkingIo, { requests: false })).toBeNull()
  })

  it("a deleted task's session is still found by its folder, also under the host's other spelling of the path", async () => {
    await createSessionRecord('s-sub', 'task-gone', 'Walnut', `/local${ROOT}/web`)
    await createSessionRecord('s-other', 'task-x', 'Walnut', `${ROOT}-other`)
    await updateSessionRecord('s-sub', { process_status: 'stopped' })
    await updateSessionRecord('s-other', { process_status: 'stopped' })
    await unlinkSessionsFromTasks(['task-gone'])
    expect((await getSessionsInFolder(ROOT)).map((s) => s.claudeSessionId)).toEqual(['s-sub'])
    expect((await realStillWorkingIo.sessions('task-gone', ROOT)).map((s) => s.claudeSessionId)).toEqual(['s-sub'])
    state.alive.set('s-sub', true)
    expect(await stillWorking({ id: 'task-gone' }, { root: ROOT }, realStillWorkingIo, { requests: false })).toMatch(/s-sub/)
  })

  it('a folder with a LIKE wildcard in its name matches only itself', async () => {
    await createSessionRecord('s-a', 't', 'P', '/w/repo/a_b')
    await createSessionRecord('s-b', 't2', 'P', '/w/repo/axb')
    expect((await getSessionsInFolder('/w/repo/a_b')).map((s) => s.claudeSessionId)).toEqual(['s-a'])
  })

  it('a host that does not answer in time counts as "cannot say"', async () => {
    await createSessionRecord('s-hang', 'task-h', 'Walnut', ROOT)
    await updateSessionRecord('s-hang', { process_status: 'stopped', host: 'clouddev' })
    state.hang.add('s-hang')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const answer = stillWorking({ id: 'task-h' }, { root: ROOT }, realStillWorkingIo, { requests: false })
    await vi.advanceTimersByTimeAsync(PROBE_DEADLINE_MS + 10)
    expect(await answer).toMatch(/could not say/)
  })
})
