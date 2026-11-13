/**
 * Empty clock wakes (2026-11-13, the org reflection: 19 wait_until wakes in one night, 7 answered
 * with only an agent-ack). A lead's turn that reported "waiting on my teams" was parked WAITING
 * with the default 4-hour clock; the clock woke it with "No trigger watches it", it acked, its
 * report parked it again, and one VP read the same wake line twice in one message.
 *
 * Guards for the class:
 *  - a lead parks only on a trigger of its own, for every report a turn can give
 *    (parksOnlyOnTrigger: phaseForReport, reportNeedsEvidence, outsideWaitEvidence);
 *  - a clock wake whose turn answered only with the ack is not parked again
 *    (clockWakeOnlyAcked, report-phase.ts);
 *  - one clock wakes its task once, even when a task event tracks it again before the wake's
 *    own phase move (task-wait-until.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-empty-clock-wakes'))

const tasks = new Map<string, Record<string, unknown>>()
const children = new Map<string, Record<string, unknown>[]>()
vi.mock('../../src/core/task-manager.js', () => ({
  getTask: async (id: string) => tasks.get(id) ?? null,
  listTasks: async () => [...tasks.values()],
  getChildTasks: async (id: string) => children.get(id) ?? [],
  updateTaskRaw: vi.fn(async () => ({ task: null, changed: false })),
}))

const triggers = new Map<string, { id: string; state: string; fires: number; watchesUser?: boolean }[]>()
vi.mock('../../src/core/routines/routines-core.js', () => ({
  listRoutines: async () => ({
    jobs: [...triggers.entries()].flatMap(([target, list]) => list.map((t) => ({
      id: t.id, name: t.id, check: { command: 'x' }, enabled: t.state === 'armed',
      executor: { type: 'session', config: { target } }, schedule: { kind: 'every', everyMs: 300_000 },
      state: { fireCount: t.fires },
    }))),
  }),
}))

const sessionsOf = new Map<string, { claudeSessionId: string; taskId: string; process_status: string }[]>()
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionsForTask: async (id: string) => sessionsOf.get(id) ?? [],
  getSessionByClaudeId: async () => null,
}))
vi.mock('../../src/core/routines/session-target.js', () => ({
  pickDeliverySession: (s: { claudeSessionId: string }[]) => s[0] ?? null,
}))
const sendMessageToSession = vi.fn(async () => ({ id: 'qm-1' }))
vi.mock('../../src/core/session-message-queue.js', () => ({
  sendMessageToSession: (...a: unknown[]) => sendMessageToSession(...(a as [])),
}))
const pendingRequestsFromSession = vi.fn(async () => [] as { id: string }[])
vi.mock('../../src/core/session-requests.js', () => ({
  pendingRequestsFromSession: (...a: unknown[]) => pendingRequestsFromSession(...(a as [])),
}))
let lastTurn: { words?: { text: string; ack?: boolean }; openedBy?: { role: string; text: string } } | undefined
vi.mock('../../src/core/sessions/session-request-notify.js', () => ({
  readLastTurn: async () => lastTurn,
}))

import { phaseForReport, reportNeedsEvidence, clockWakeOnlyAcked } from '../../src/core/sessions/report-phase.js'
import { outsideWaitEvidence, parksOnlyOnTrigger } from '../../src/core/sessions/outside-wait.js'
import { clockWokeAt, loadWaitUntilDeadlines, startWaitUntilWatch, stopWaitUntilWatch, sweepWaitUntil, WAIT_WAKE_FROM } from '../../src/core/task-wait-until.js'
import { buildWalnutMessage } from '../../src/core/peers/walnut-message-tag.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import type { StatusReport, WaitKind } from '../../src/core/user-status.js'

const NOW = Date.parse('2026-11-13T06:35:41Z')
const at = new Date(NOW).toISOString()

/** Every report a turn can give that could park a task. */
const parkingReports: StatusReport[] = [
  { state: 'done', at },
  ...(['outside', 'task', 'lead', 'machine', 'own', 'other', undefined] as (WaitKind | undefined)[])
    .map((k) => ({ state: 'waiting' as const, at, waiting_kind: k, waiting_on: 'the CR review and my teams' })),
]

beforeEach(() => {
  tasks.clear(); children.clear(); triggers.clear(); sessionsOf.clear()
  sendMessageToSession.mockClear()
  pendingRequestsFromSession.mockReset(); pendingRequestsFromSession.mockResolvedValue([])
  lastTurn = undefined
})

describe('a lead parks only on a trigger of its own', () => {
  const lead = { id: 'vp-1', parent_task_id: 'main-1', org_role: 'lead' as const, session_id: 'vp-sid' }

  it('no report parks a lead without one, whatever it names; with one armed it parks', () => {
    expect(parksOnlyOnTrigger(lead)).toBe(true)
    for (const report of parkingReports) {
      for (const alive of [false, true]) {
        expect(phaseForReport(report, lead, alive, false), JSON.stringify(report)).not.toBe('WAITING')
        // The caller looks the evidence up for every one of them, never trusting the words.
        expect(reportNeedsEvidence(report, lead), JSON.stringify(report)).toBe(true)
      }
      if (report.state === 'waiting' && report.waiting_kind !== 'you') expect(phaseForReport(report, lead, false, true)).toBe('WAITING')
    }
  })

  it('an open subtask, a request out or its own leader parking it is no evidence for a lead; a worker keeps them', async () => {
    children.set('vp-1', [{ id: 'w-1', phase: 'IN_PROGRESS' }])
    children.set('worker-1', [{ id: 'w-2', phase: 'IN_PROGRESS' }])
    pendingRequestsFromSession.mockResolvedValue([{ id: 'rq-aaaaaa' }])
    expect(await outsideWaitEvidence(lead, { callerTaskId: 'main-1' })).toBeNull()
    expect(await outsideWaitEvidence(lead)).toBeNull()
    expect(await outsideWaitEvidence({ id: 'worker-1', parent_task_id: 'vp-1', session_id: 'w-sid' })).not.toBeNull()
    triggers.set('vp-1', [{ id: 'cr-watch', state: 'armed', fires: 0 }])
    expect(await outsideWaitEvidence(lead)).toMatchObject({ kind: 'trigger' })
    // A paused trigger watches nothing: still none.
    triggers.set('vp-1', [{ id: 'ask-watch', state: 'paused', fires: 0 }])
    expect(await outsideWaitEvidence(lead)).toBeNull()
  })
})

describe('the wait_until clock', () => {
  beforeEach(() => { startWaitUntilWatch({ ephemeral: false }) })
  afterEach(() => { stopWaitUntilWatch() })

  const parked = (id: string, until: string) => ({ id, title: id, phase: 'WAITING', wait_until: until, org_role: 'lead' })

  it('wakes its task once, even when a task event tracks the same clock again before the phase moves', async () => {
    const until = new Date(NOW - 1_000).toISOString()
    tasks.set('vp-2', parked('vp-2', until))
    sessionsOf.set('vp-2', [{ claudeSessionId: 'vp2-sid', taskId: 'vp-2', process_status: 'idle' }])
    await loadWaitUntilDeadlines()
    expect(await sweepWaitUntil(NOW)).toEqual(['vp-2'])
    // The send has not moved the phase yet: a write to the task (a status sync) emits it as it is.
    bus.emit(EventNames.TASK_UPDATED, { task: tasks.get('vp-2') }, ['*'], { source: 'test' })
    await loadWaitUntilDeadlines()
    expect(await sweepWaitUntil(NOW + 5_000)).toEqual([])
    expect(sendMessageToSession).toHaveBeenCalledTimes(1)
    expect(clockWokeAt('vp-2', NOW + 60_000, 'vp2-sid')).toBe(NOW)
    // Out of WAITING and parked again on a new clock: a new wait, woken when it passes.
    tasks.set('vp-2', { ...tasks.get('vp-2')!, phase: 'IN_PROGRESS', wait_until: undefined })
    bus.emit(EventNames.TASK_UPDATED, { task: tasks.get('vp-2') }, ['*'], { source: 'test' })
    const next = new Date(NOW + 60_000).toISOString()
    tasks.set('vp-2', parked('vp-2', next))
    bus.emit(EventNames.TASK_UPDATED, { task: tasks.get('vp-2') }, ['*'], { source: 'test' })
    expect(await sweepWaitUntil(NOW + 120_000)).toEqual(['vp-2'])
    expect(sendMessageToSession).toHaveBeenCalledTimes(2)
  })

  it('two sweeps that overlap while the first looks the session up wake it once', async () => {
    const until = new Date(NOW - 1_000).toISOString()
    tasks.set('vp-3', parked('vp-3', until))
    let open!: () => void
    const gate = new Promise<void>((r) => { open = r })
    let calls = 0
    sessionsOf.set('vp-3', [{ claudeSessionId: 'vp3-sid', taskId: 'vp-3', process_status: 'idle' }])
    const tracker = await import('../../src/core/session-tracker.js')
    const spy = vi.spyOn(tracker, 'getSessionsForTask').mockImplementation(async (id: string) => {
      if (calls++ === 0) await gate
      return (sessionsOf.get(id) ?? []) as never
    })
    try {
      await loadWaitUntilDeadlines()
      const a = sweepWaitUntil(NOW)
      await new Promise((r) => setTimeout(r, 5))
      // The task is written meanwhile (unchanged clock), and the next sweep runs.
      bus.emit(EventNames.TASK_UPDATED, { task: tasks.get('vp-3') }, ['*'], { source: 'test' })
      await loadWaitUntilDeadlines()
      const b = await sweepWaitUntil(NOW + 1_000)
      open()
      await a
      expect(b).toEqual([])
      expect(sendMessageToSession).toHaveBeenCalledTimes(1)
    } finally { spy.mockRestore() }
  })

  it('a wake whose turn answered only with the ack is not parked again; any other answer, or an armed trigger, is', async () => {
    const until = new Date(NOW - 1_000).toISOString()
    tasks.set('w-9', { ...parked('w-9', until), org_role: undefined })
    sessionsOf.set('w-9', [{ claudeSessionId: 'w9-sid', taskId: 'w-9', process_status: 'idle' }])
    await loadWaitUntilDeadlines()
    expect(await sweepWaitUntil(NOW)).toEqual(['w-9'])
    const wake = (sendMessageToSession.mock.calls[0] as unknown as [string, string])[1]
    expect(wake).toContain(`from="${WAIT_WAKE_FROM}"`)
    const ended = NOW + 20_000
    lastTurn = { openedBy: { role: 'user', text: wake }, words: { text: '', ack: true } }
    expect(await clockWakeOnlyAcked({ id: 'w-9' }, 'w9-sid', ended)).toBe(true)
    // It did something and said so: its own report decides.
    lastTurn = { openedBy: { role: 'user', text: wake }, words: { text: 'Checked the CR: still in review, parked again.' } }
    expect(await clockWakeOnlyAcked({ id: 'w-9' }, 'w9-sid', ended)).toBe(false)
    // A turn something else opened (a peer note) is not the clock's.
    lastTurn = { openedBy: { role: 'user', text: buildWalnutMessage({ kind: 'peer-note', attrs: { from: 'VP' }, body: 'hi' }) }, words: { text: '', ack: true } }
    expect(await clockWakeOnlyAcked({ id: 'w-9' }, 'w9-sid', ended)).toBe(false)
    // An armed trigger of its own still watches it: parking again is right.
    lastTurn = { openedBy: { role: 'user', text: wake }, words: { text: '', ack: true } }
    triggers.set('w-9', [{ id: 'cr', state: 'armed', fires: 0 }])
    expect(await clockWakeOnlyAcked({ id: 'w-9' }, 'w9-sid', ended)).toBe(false)
    // Another session's turn, or a turn that ended before the wake, is not that wake's.
    triggers.clear()
    expect(await clockWakeOnlyAcked({ id: 'w-9' }, 'other-sid', ended)).toBe(false)
    expect(await clockWakeOnlyAcked({ id: 'w-9' }, 'w9-sid', NOW - 60_000)).toBe(false)
  })
})
