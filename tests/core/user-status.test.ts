/**
 * The one user-facing status (src/core/user-status.ts). Each case is a shape seen on the
 * real Walnut lead board on 2026-10-25, where the old surfaces said "0 needs you" on one
 * tile, "1 needs you" on a section and "11 handed back" on the Org page for the same team.
 */
import { describe, it, expect } from 'vitest'
import { deriveUserStatus, countUserStates, userStatusLine, STALE_REPORT_MS, type StatusReport } from '../../src/core/user-status.js'

const NOW = Date.parse('2026-10-26T05:35:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const report = (r: Partial<StatusReport>): StatusReport => ({ at: ago(60_000), ...r })

describe('deriveUserStatus', () => {
  it('a complete task is done whatever else it carries', () => {
    expect(deriveUserStatus({ phase: 'COMPLETE', pendingPermissionTool: 'Bash', report: report({ state: 'needs', ask: 'x' }) }, NOW))
      .toEqual({ state: 'done' })
    expect(deriveUserStatus({ phase: 'IN_PROGRESS', status: 'done' }, NOW).state).toBe('done')
  })

  it('a turn that ended with nothing to ask is not "needs you" (NEED_ACTION alone)', () => {
    const s = deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'stopped', hasLeader: true,
      report: report({ state: 'done', now: 'Shipped and checked on prod.' }) }, NOW)
    expect(s.state).toBe('waiting')
    expect(s.kind).toBe('lead')
    expect(s.now).toBe('Shipped and checked on prod.')
  })

  it('the session asking the user for a decision is "needs you" with the ask', () => {
    const s = deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'stopped',
      report: report({ state: 'needs', ask: 'Approve a real iPhone test?', now: 'Fix is live.', next: 'It tests once you agree.' }) }, NOW)
    expect(s).toMatchObject({ state: 'needs', ask: 'Approve a real iPhone test?', now: 'Fix is live.', next: 'It tests once you agree.' })
  })

  it('a needs report without an ask does not count as needs you', () => {
    expect(deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', report: report({ state: 'needs', ask: 'none' }) }, NOW).state)
      .not.toBe('needs')
  })

  it('live facts win: a prompt, an open letter, an open board choice', () => {
    expect(deriveUserStatus({ phase: 'IN_PROGRESS', processStatus: 'running', pendingPermissionTool: 'AskUserQuestion' }, NOW))
      .toMatchObject({ state: 'needs', ask: expect.stringContaining('AskUserQuestion') })
    expect(deriveUserStatus({ phase: 'WAITING', hasSession: true, openLetter: 'Pick a design' }, NOW)).toMatchObject({ state: 'needs', ask: 'Pick a design' })
    expect(deriveUserStatus({ phase: 'TODO', openChoice: 'Which host?' }, NOW)).toMatchObject({ state: 'needs', ask: 'Which host?' })
  })

  it('running is working, whatever the phase', () => {
    expect(deriveUserStatus({ phase: 'NEED_ACTION', processStatus: 'running', hasSession: true }, NOW).state).toBe('working')
    expect(deriveUserStatus({ phase: 'WAITING', processStatus: 'running', hasSession: true }, NOW).state).toBe('working')
  })

  it('a session error needs the user', () => {
    expect(deriveUserStatus({ phase: 'NEED_ACTION', processStatus: 'error', errorMessage: 'auth expired', hasSession: true }, NOW))
      .toMatchObject({ state: 'needs', ask: expect.stringContaining('auth expired') })
  })

  it('a todo with no session is waiting, not started', () => {
    expect(deriveUserStatus({ phase: 'TODO', hasSession: false }, NOW)).toMatchObject({ state: 'waiting', kind: 'not-started' })
  })

  it('waits on another task while a reply request is open', () => {
    const s = deriveUserStatus({ phase: 'WAITING', hasSession: true, processStatus: 'idle', waitingOnTasks: ['Bun migration lead'] }, NOW)
    expect(s).toMatchObject({ state: 'waiting', kind: 'task' })
    expect(s.waitingOn).toContain('Bun migration lead')
  })

  it('a reported wait on a machine needs a trigger or a clock to be believed', () => {
    const r = report({ state: 'waiting', waiting_kind: 'machine', waiting_on: '20 GB of free disk' })
    expect(deriveUserStatus({ phase: 'WAITING', hasSession: true, processStatus: 'idle', triggers: ['disk free'], report: r }, NOW))
      .toMatchObject({ state: 'waiting', kind: 'machine', waitingOn: '20 GB of free disk' })
    expect(deriveUserStatus({ phase: 'WAITING', hasSession: true, processStatus: 'stopped', report: r }, NOW))
      .toMatchObject({ state: 'waiting', kind: 'stuck' })
  })

  it('a reported wait on a person holds without a trigger', () => {
    expect(deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'stopped',
      report: report({ state: 'waiting', waiting_kind: 'task', waiting_on: 'The Bun lead to send its commit' }) }, NOW))
      .toMatchObject({ state: 'waiting', kind: 'task', waitingOn: 'The Bun lead to send its commit' })
  })

  it('says it is still working but its session stopped and nothing wakes it: stuck', () => {
    const s = deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'stopped',
      report: report({ state: 'working', now: 'Running the browser tests.', at: ago(4 * 3600_000) }) }, NOW)
    expect(s).toMatchObject({ state: 'waiting', kind: 'stuck', now: 'Running the browser tests.' })
  })

  it('a trigger or a future wait_until is what it waits on when the report is silent', () => {
    expect(deriveUserStatus({ phase: 'WAITING', hasSession: true, processStatus: 'idle', triggers: ['TestFlight 127'] }, NOW))
      .toMatchObject({ state: 'waiting', kind: 'other' })
    expect(deriveUserStatus({ phase: 'WAITING', hasSession: true, processStatus: 'idle', waitUntil: new Date(NOW + 3600_000).toISOString() }, NOW))
      .toMatchObject({ state: 'waiting', kind: 'time' })
  })

  it('a past wait_until is not a wait', () => {
    expect(deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'idle', waitUntil: ago(3600_000) }, NOW).kind).toBe('stuck')
  })

  it('no report: IN_PROGRESS with a stopped session is stuck, NEED_ACTION is the reader\'s turn', () => {
    expect(deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'stopped' }, NOW).kind).toBe('stuck')
    expect(deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'stopped' }, NOW))
      .toMatchObject({ state: 'waiting', kind: 'you' })
  })

  it('a report written before the latest turn lends its words, never its state', () => {
    const before = report({ state: 'needs', ask: 'Pick A or B?', now: 'Designs sent.', at: ago(30 * 60_000) })
    const s = deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', phaseChangedAt: ago(60_000), report: before }, NOW)
    expect(s.state).toBe('waiting')
    expect(s.now).toBe('Designs sent.')
    expect(deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', phaseChangedAt: ago(60 * 60_000), report: before }, NOW).state)
      .toBe('needs')
  })

  it('a park with nothing to end it says so', () => {
    expect(deriveUserStatus({ phase: 'WAITING', hasSession: true, processStatus: 'idle' }, NOW)).toMatchObject({ state: 'waiting', kind: 'other' })
  })

  it('flags words a day old on a task that is not running, never on a running one', () => {
    const old = report({ state: 'waiting', waiting_kind: 'task', waiting_on: 'x', at: ago(STALE_REPORT_MS + 1) })
    expect(deriveUserStatus({ phase: 'WAITING', hasSession: true, processStatus: 'idle', report: old }, NOW).stale).toBe(true)
    expect(deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'running', report: old }, NOW).stale).toBeUndefined()
  })
})

describe('review cases (2026-10-26)', () => {
  it('a session that carries on by itself (a background job) is working while its process is there, stuck once it is gone', () => {
    const r = report({ state: 'working', now: 'Waiting for the build it started.', at: ago(1000) })
    expect(deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', phaseChangedAt: ago(2000), report: r }, NOW))
      .toMatchObject({ state: 'working', now: 'Waiting for the build it started.' })
    expect(deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'stopped', phaseChangedAt: ago(2000), report: r }, NOW))
      .toMatchObject({ state: 'waiting', kind: 'stuck' })
  })

  it('a scheduled routine that runs in the task is something that will wake it, with its next run', () => {
    const next = new Date(NOW + 3600_000).toISOString()
    const r = report({ state: 'waiting', waiting_kind: 'time', waiting_on: 'Tomorrow\'s run', at: ago(1000) })
    expect(deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'stopped', phaseChangedAt: ago(2000), report: r, schedules: [{ name: 'Daily digest', nextAt: next }] }, NOW))
      .toMatchObject({ state: 'waiting', kind: 'time', waitingOn: 'Tomorrow\'s run' })
    expect(deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'stopped', schedules: [{ name: 'Daily digest', nextAt: next }] }, NOW))
      .toMatchObject({ state: 'waiting', kind: 'time', waitingOn: 'Its next scheduled run (Daily digest)', until: next })
  })

  it('an idle lead waits on its open workers, and Main on the user and its teams, never stuck', () => {
    const idle = { phase: 'IN_PROGRESS', hasSession: true, processStatus: 'idle' }
    expect(deriveUserStatus(idle, NOW)).toMatchObject({ state: 'waiting', kind: 'stuck' })
    expect(deriveUserStatus({ ...idle, openWorkers: 3 }, NOW)).toMatchObject({ state: 'waiting', kind: 'task', waitingOn: 'Its workers (3 open)' })
    expect(deriveUserStatus({ ...idle, openWorkers: 1 }, NOW).waitingOn).toBe('Its worker (1 open)')
    expect(deriveUserStatus({ ...idle, isMain: true, openWorkers: 4 }, NOW)).toMatchObject({ state: 'waiting', kind: 'you', waitingOn: 'Your next message, or news from its teams' })
    // A prompt still needs the user first.
    expect(deriveUserStatus({ ...idle, isMain: true, pendingPermissionTool: 'Bash' }, NOW).state).toBe('needs')
  })

  it('a task worked by hand (in progress, no session) is working', () => {
    expect(deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: false }, NOW).state).toBe('working')
    expect(deriveUserStatus({ phase: 'TODO', hasSession: false }, NOW)).toMatchObject({ state: 'waiting', kind: 'not-started' })
  })

  it('a lost host is Walnut\'s to recover for 20 minutes, then the user\'s; a trigger outlives an old error', () => {
    const base = { phase: 'NEED_ACTION', hasSession: true, processStatus: 'error', errorReason: 'remote_unreachable', errorMessage: 'host gone' }
    expect(deriveUserStatus({ ...base, statusSince: ago(5 * 60_000) }, NOW)).toMatchObject({ state: 'waiting', kind: 'machine' })
    expect(deriveUserStatus({ ...base, statusSince: ago(25 * 60_000) }, NOW)).toMatchObject({ state: 'needs', source: 'error' })
    expect(deriveUserStatus({ ...base, errorReason: 'api_error' }, NOW)).toMatchObject({ state: 'needs', source: 'error' })
    expect(deriveUserStatus({ ...base, errorReason: 'api_error', triggers: ['CI watch'] }, NOW)).toMatchObject({ state: 'waiting', waitingOn: 'A watch: CI watch' })
  })
})

describe('counts', () => {
  it('one line, the same everywhere', () => {
    const c = countUserStates([{ state: 'needs' }, { state: 'needs' }, { state: 'working' }, { state: 'waiting' }, { state: 'done' }])
    expect(c).toEqual({ needs: 2, working: 1, waiting: 1, done: 1 })
    expect(userStatusLine(c)).toBe('2 need you · 1 working · 1 waiting · 1 done')
    expect(userStatusLine({ needs: 1, working: 0, waiting: 0, done: 0 }, { withDone: false })).toBe('1 needs you · 0 working · 0 waiting')
  })
})
