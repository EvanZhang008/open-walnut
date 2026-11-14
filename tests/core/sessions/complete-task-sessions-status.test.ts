/**
 * Completing a task stops its sessions (completeTaskSessions), and every row it marks
 * stopped is announced as session:status-changed. A write no subscriber hears leaves
 * them reading the session as alive: 2026-11-14, a completed task's isolated workspace
 * waited for its session's stop (workspaces/watch.ts), which never came, so it stayed.
 * Nothing is signalled: the stop goes through a fake daemon connection that only records.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

const state = vi.hoisted(() => ({ stops: [] as string[] }))

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-complete-task-sessions-status'))
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  getConnectedDaemonConnection: () => ({
    connected: true,
    hasCapability: () => true,
    async send(command: string, args: Record<string, unknown>) {
      if (command === 'stop') state.stops.push(String(args.sid))
      return { ok: true, stopped: true }
    },
  }),
  isDaemonConnected: () => true,
  getDaemonDisconnectedSince: () => null,
}))
vi.mock('../../../src/providers/claude-code-session.js', () => ({
  sessionRunner: { markExpectedTeardown: () => () => {} },
}))
vi.mock('../../../src/web/terminal/dtach-lifecycle.js', () => ({
  conditionalReap: async () => 'kept',
}))

import { completeTaskSessions, createSessionRecord, updateSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js'
import { closeDb } from '../../../src/core/session-db.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import { workspaceEventAction } from '../../../src/core/workspaces/watch.js'
import { WALNUT_HOME } from '../../../src/constants.js'

const SUB = 'complete-task-sessions-status-test'

beforeEach(async () => {
  state.stops = []
  _resetSessionTrackerForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
})

afterEach(async () => {
  bus.unsubscribe(SUB)
  closeDb()
  _resetSessionTrackerForTesting()
})

describe('completeTaskSessions', () => {
  it('announces each session it stops, so a waiting workspace cleanup runs', async () => {
    // An older row of another task that is already stopped (one active session per task).
    await createSessionRecord('s-done', 'task-b', 'proj')
    await updateSessionRecord('s-done', { process_status: 'stopped' })
    await createSessionRecord('s-live', 'task-a', 'proj')
    await updateSessionRecord('s-live', { process_status: 'idle', pid: 999_999_901 } as never)
    const seen: Array<{ sessionId?: string; taskId?: string | null; process_status?: string }> = []
    const actions: unknown[] = []
    bus.subscribe(SUB, (event) => {
      if (event.name !== EventNames.SESSION_STATUS_CHANGED) return
      seen.push(event.data as never)
      actions.push(workspaceEventAction(event))
    }, { global: true, interest: [EventNames.SESSION_STATUS_CHANGED] })

    expect(await completeTaskSessions(['s-live', 's-done'])).toBe(1)
    // The converged row is not written again, so it is not announced again.
    expect(seen.map((e) => [e.sessionId, e.taskId, e.process_status])).toEqual([['s-live', 'task-a', 'stopped']])
    expect(actions).toEqual([{ action: 'session-stopped', taskId: 'task-a' }])
  })
})
