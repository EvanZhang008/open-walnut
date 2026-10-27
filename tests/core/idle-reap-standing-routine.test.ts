/**
 * An idle reap (session-health-monitor.ts reapIdleSession) hands the task back, except a standing
 * routine's (phase.ts standingRoutineWaits), which waits on its next fire: 2026-10-26, a watch
 * reaped after hours of quiet read "needs you" until its lead parked it by hand.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-idle-reap-routine'))

const phase = vi.hoisted(() => ({ standing: false, calls: [] as unknown[][] }))
vi.mock('../../src/core/phase.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/phase.js')>()),
  standingRoutineWaits: async () => phase.standing,
  applySessionPhase: async (...args: unknown[]) => { phase.calls.push(args); return { changed: true } },
}))
const resume = vi.hoisted(() => ({ dropped: [] as string[] }))
vi.mock('../../src/core/task-wait-resume.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/task-wait-resume.js')>()),
  dropFireTurn: (id: string) => { resume.dropped.push(`fire:${id}`) },
  dropInterruptedWait: (id: string) => { resume.dropped.push(`wait:${id}`) },
}))
vi.mock('../../src/core/task-manager.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/task-manager.js')>()),
  getTask: async (id: string) => ({ id, title: 'A watch', phase: 'IN_PROGRESS' }),
}))
vi.mock('../../src/core/session-tracker.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/session-tracker.js')>()),
  emitSessionStatusChanged: () => {},
}))

import { SessionHealthMonitor } from '../../src/core/session-health-monitor.js'
import type { SessionRecord } from '../../src/core/types.js'

type Reap = (session: SessionRecord, mgr: unknown, idleMinutes: number,
  update: (id: string, u: Record<string, unknown>) => Promise<SessionRecord>, tools: unknown) => Promise<string | null>

async function reap(): Promise<void> {
  const monitor = new SessionHealthMonitor()
  const session = { claudeSessionId: 'sid-watch', taskId: 'task-watch', process_status: 'idle' } as SessionRecord
  const run = (monitor as unknown as { reapIdleSession: Reap }).reapIdleSession.bind(monitor)
  const killed = await run(session, { stopForIdle: async () => true, kill: () => {} }, 329,
    async (id, u) => ({ claudeSessionId: id, ...u }) as SessionRecord, { markExpectedTeardown: () => () => {} })
  expect(killed).toBe('sid-watch')
}

beforeEach(() => { phase.standing = false; phase.calls = []; resume.dropped = [] })

describe('an idle reap', () => {
  it('hands an ordinary task back to the user', async () => {
    await reap()
    expect(phase.calls).toHaveLength(1)
    expect(phase.calls[0]!.slice(0, 2)).toEqual(['task-watch', 'session:error'])
    expect(resume.dropped).toEqual([])
  })

  it('parks a standing routine on its next fire, and only work in flight', async () => {
    phase.standing = true
    await reap()
    const [taskId, trigger, , opts] = phase.calls[0] as [string, string, string, { newPhase: string; shouldApply: (t: { phase: string }) => boolean }]
    expect([taskId, trigger, opts.newPhase]).toEqual(['task-watch', 'reconciler', 'WAITING'])
    expect(['IN_PROGRESS', 'TODO', 'NEED_ACTION', 'WAITING', 'COMPLETE'].map((p) => opts.shouldApply({ phase: p })))
      .toEqual([true, true, false, false, false])
    // What the session:error edge would have cleared is cleared before the park.
    expect(resume.dropped).toEqual(['fire:task-watch', 'wait:task-watch'])
  })
})
