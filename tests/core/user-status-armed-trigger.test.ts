/**
 * A task whose own trigger is armed is waiting on that trigger, never "stuck, nothing will wake
 * it" and never "needs you" when only its turn ended (src/core/user-status.ts wakeSource).
 * 2026-10-29 on prod: a worker parked on two armed triggers read "Waiting (stuck): It stopped, and
 * nothing will wake it" in the seconds between its CLI going idle and the turn-end phase write,
 * and that status was pushed to its lead and Main as a false alarm; the same turn then ended as
 * NEED_ACTION (its peer message came straight from the host daemon, so the server saw a turn it
 * did not send and handed the task back), which read "Its turn ended and handed the task back to
 * you" although a fire would resume it.
 */
import { describe, it, expect } from 'vitest'
import { deriveUserStatus, type StatusReport, type UserStatusInput } from '../../src/core/user-status.js'

const NOW = Date.parse('2026-10-29T05:27:16Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
// The facts the sync read for the task: a stale report (before the latest phase move), a leader,
// its session's CLI alive and idle, two armed triggers.
const base: UserStatusInput = {
  hasSession: true, processStatus: 'idle', hasLeader: true,
  phaseChangedAt: ago(16_000),
  report: { state: 'working', at: ago(2 * 3600_000), now: 'The web fold is live; the phone build is testing.' } as StatusReport,
  triggers: ['A simulator lane notice', 'iOS fold unit run done'],
  waitUntil: '2026-10-29T09:56:39.332Z',
}
const WATCH = 'A watch: A simulator lane notice, iOS fold unit run done'

describe('an armed trigger of its own wakes the task', () => {
  it('in progress with its turn over: waits on the watch, not stuck', () => {
    for (const processStatus of ['idle', 'stopped']) {
      const s = deriveUserStatus({ ...base, phase: 'IN_PROGRESS', processStatus }, NOW)
      expect(s, processStatus).toMatchObject({ state: 'waiting', kind: 'other', waitingOn: WATCH, until: base.waitUntil })
    }
  })

  it('handed back only by its turn end: waits on the watch, not on the user', () => {
    for (const processStatus of ['idle', 'stopped']) {
      const s = deriveUserStatus({ ...base, phase: 'NEED_ACTION', processStatus }, NOW)
      expect(s, processStatus).toMatchObject({ state: 'waiting', kind: 'other', waitingOn: WATCH })
    }
  })

  it('a scheduled routine of its own is a waker too while in progress', () => {
    const s = deriveUserStatus({ ...base, phase: 'IN_PROGRESS', processStatus: 'stopped', triggers: [], schedules: [{ name: 'Daily digest', nextAt: ago(-3600_000) }] }, NOW)
    expect(s).toMatchObject({ state: 'waiting', kind: 'time', waitingOn: 'Its next scheduled run (Daily digest)' })
  })

  it('keeps every real ask of the user, and its report window, ahead of the watch', () => {
    const na = { ...base, phase: 'NEED_ACTION' }
    // Its own report of the latest turn asks the user.
    expect(deriveUserStatus({ ...na, report: { state: 'needs', ask: 'Accept the new license', at: ago(1_000) } }, NOW))
      .toMatchObject({ state: 'needs', source: 'session', ask: 'Accept the new license' })
    expect(deriveUserStatus({ ...na, openLetter: 'Approve the send' }, NOW)).toMatchObject({ state: 'needs', source: 'letter' })
    expect(deriveUserStatus({ ...na, openChoice: 'Which host?' }, NOW)).toMatchObject({ state: 'needs', source: 'choice' })
    expect(deriveUserStatus({ ...na, processStatus: 'error', errorMessage: 'auth expired' }, NOW)).toMatchObject({ state: 'needs', source: 'error' })
    // Set inside a running turn: that turn's report decides, until then it reads as set.
    expect(deriveUserStatus({ ...na, processStatus: 'running' }, NOW).state).toBe('needs')
    // The report on the turn that just ended is still to come: it decides in a moment.
    expect(deriveUserStatus({ ...na, reportPending: true }, NOW)).toMatchObject({ state: 'waiting', transient: true })
  })

  it('never covers a failed session, Main or a lead', () => {
    // In progress with a failed session: still read as stuck, the watch does not hide it.
    expect(deriveUserStatus({ ...base, phase: 'IN_PROGRESS', processStatus: 'error', errorMessage: 'exited 1' }, NOW).waitingOn).not.toBe(WATCH)
    // Main and a lead handed back read as before, a watch or not.
    for (const role of [{ isMain: true }, { isLead: true }]) {
      const s = deriveUserStatus({ ...base, ...role, hasLeader: false, phase: 'NEED_ACTION' }, NOW)
      expect(s.waitingOn, JSON.stringify(role)).not.toBe(WATCH)
    }
  })

  it('with nothing armed, the old words stand', () => {
    expect(deriveUserStatus({ ...base, phase: 'IN_PROGRESS', processStatus: 'stopped', triggers: [] }, NOW))
      .toMatchObject({ state: 'waiting', kind: 'stuck', waitingOn: 'It stopped, and nothing will wake it' })
    expect(deriveUserStatus({ ...base, phase: 'NEED_ACTION', hasLeader: false, triggers: [] }, NOW))
      .toMatchObject({ state: 'needs', ask: expect.stringContaining('Its turn ended') })
    expect(deriveUserStatus({ ...base, phase: 'NEED_ACTION', processStatus: 'stopped', triggers: [] }, NOW))
      .toMatchObject({ state: 'waiting', kind: 'lead' })
  })

  it('the sync passes the armed triggers it read into the derivation', async () => {
    const { statusInputOf } = await import('../../src/core/user-status-sync.js')
    const facts = {
      sessions: new Map([['sid-a', { processStatus: 'idle', taskId: 't1' }]]), letters: new Map(), choices: new Map(),
      requestsFrom: new Map(), triggers: new Map([['t1', base.triggers!.map((name, i) => ({ id: `job-${i}`, name }))]]), schedules: new Map(), titles: new Map(),
      sessionsOf: new Map([['t1', ['sid-a']]]),
    } as unknown as import('../../src/core/user-status-sync.js').StatusFacts
    const task = { id: 't1', title: 'x', phase: 'IN_PROGRESS', session_id: 'sid-a', parent_task_id: 'lead', phase_changed_at: ago(16_000) } as unknown as import('../../src/core/types.js').Task
    expect(deriveUserStatus(statusInputOf(task, facts), NOW)).toMatchObject({ state: 'waiting', kind: 'other', waitingOn: WATCH })
  })

  // 2026-10-30, the user: waiting on the user is Needs you. A trigger armed to watch the task's own
  // ask of the user (trigger_create `watches`) is no outside watch, so a handed-back task stays on him.
  it('a trigger that watches the user\'s ask is no waker for the status', async () => {
    const { statusInputOf } = await import('../../src/core/user-status-sync.js')
    const facts = {
      sessions: new Map([['sid-a', { processStatus: 'idle', taskId: 't1' }]]), letters: new Map(), choices: new Map(),
      requestsFrom: new Map(), triggers: new Map([['t1', [{ id: 'job-ask', name: 'Sign-in watch' }]]]), schedules: new Map(), titles: new Map(),
      sessionsOf: new Map([['t1', ['sid-a']]]),
    } as unknown as import('../../src/core/user-status-sync.js').StatusFacts
    const task = {
      id: 't1', title: 'x', phase: 'NEED_ACTION', session_id: 'sid-a', phase_changed_at: ago(16_000),
      recheck_watch: [{ trigger: 'job-ask', watches: 'ask', at: ago(20_000) }],
    } as unknown as import('../../src/core/types.js').Task
    const input = statusInputOf(task, facts)
    expect(input.triggers).toEqual([])
    expect(deriveUserStatus(input, NOW).state).toBe('needs')
    // The same trigger with no `watches` record is an outside watch.
    const outside = statusInputOf({ ...task, recheck_watch: [] } as never, facts)
    expect(deriveUserStatus(outside, NOW)).toMatchObject({ state: 'waiting', waitingOn: 'A watch: Sign-in watch' })
  })
})
