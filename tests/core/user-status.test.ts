/**
 * The one user-facing status (src/core/user-status.ts): the state is the task's own phase, and
 * the facts and the session's report only give the words. 2026-10-26, the user: one surface said
 * 5 "need you" while the tasks' phases said 1, from letters, Board choices and reports read on
 * their own ("it is a mess"); "task has status, we already have good task system".
 */
import { describe, it, expect } from 'vitest'
import { deriveUserStatus, countUserStates, userStatusLine, STALE_REPORT_MS, type StatusReport, type UserStatusInput } from '../../src/core/user-status.js'
import { phaseForReport, reportMayMovePhase } from '../../src/core/sessions/report-phase.js'

const NOW = Date.parse('2026-10-26T05:35:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const report = (r: Partial<StatusReport>): StatusReport => ({ at: ago(60_000), ...r })
const PHASES = ['TODO', 'IN_PROGRESS', 'WAITING', 'NEED_ACTION', 'COMPLETE'] as const

describe('the state is the phase', () => {
  it('needs you exactly when the phase is NEED_ACTION, whatever letters, choices or reports say', () => {
    const noisy: Partial<UserStatusInput> = {
      hasSession: true, processStatus: 'idle', openLetter: 'Pick a design', openChoice: 'Which host?',
      report: report({ state: 'needs', ask: 'Approve?' }), triggers: ['CI watch'], openWorkers: 2,
    }
    const want = { TODO: 'waiting', IN_PROGRESS: 'waiting', WAITING: 'waiting', NEED_ACTION: 'needs', COMPLETE: 'done' }
    for (const phase of PHASES) expect(deriveUserStatus({ phase, ...noisy }, NOW).state, phase).toBe(want[phase])
  })

  it('a live prompt needs the user (the session machine moves the phase with it)', () => {
    expect(deriveUserStatus({ phase: 'IN_PROGRESS', processStatus: 'running', pendingPermissionTool: 'AskUserQuestion' }, NOW))
      .toMatchObject({ state: 'needs', source: 'prompt', ask: expect.stringContaining('AskUserQuestion') })
  })

  it('a complete task is done whatever else it carries', () => {
    expect(deriveUserStatus({ phase: 'COMPLETE', pendingPermissionTool: 'Bash', report: report({ state: 'needs', ask: 'x' }) }, NOW)).toEqual({ state: 'done' })
    expect(deriveUserStatus({ phase: 'IN_PROGRESS', status: 'done' }, NOW).state).toBe('done')
  })

  it('in progress is working while something runs, else says on whom it waits', () => {
    expect(deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'running' }, NOW).state).toBe('working')
    expect(deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: false }, NOW).state).toBe('working')
    expect(deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'idle', report: report({ state: 'working' }) }, NOW).state).toBe('working')
    expect(deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'idle', isMain: true }, NOW))
      .toMatchObject({ state: 'waiting', kind: 'you', waitingOn: 'Your next message, or news from its teams' })
    expect(deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'idle', openWorkers: 3 }, NOW))
      .toMatchObject({ state: 'waiting', kind: 'task', waitingOn: 'Its workers (3 open)' })
    expect(deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'stopped' }, NOW)).toMatchObject({ state: 'waiting', kind: 'stuck' })
  })

  it('a running session never makes a parked or handed-back task "working"', () => {
    expect(deriveUserStatus({ phase: 'NEED_ACTION', processStatus: 'running', hasSession: true }, NOW).state).toBe('needs')
    expect(deriveUserStatus({ phase: 'WAITING', processStatus: 'running', hasSession: true }, NOW).state).toBe('waiting')
  })
})

describe('the words say why', () => {
  it('a handed-back task names what the user must do: the letter, the choice, the failure, its ask, else its turn', () => {
    const base = { phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle' }
    expect(deriveUserStatus({ ...base, openLetter: 'Approve the quota raise' }, NOW)).toMatchObject({ source: 'letter', ask: 'Approve the quota raise' })
    expect(deriveUserStatus({ ...base, openChoice: 'Raise the quota?' }, NOW)).toMatchObject({ source: 'choice', ask: 'Raise the quota?' })
    expect(deriveUserStatus({ ...base, processStatus: 'error', errorMessage: 'auth expired' }, NOW)).toMatchObject({ source: 'error', ask: expect.stringContaining('auth expired') })
    expect(deriveUserStatus({ ...base, report: report({ state: 'needs', ask: 'Approve a real iPhone test?', now: 'Fix is live.' }) }, NOW))
      .toMatchObject({ source: 'session', ask: 'Approve a real iPhone test?', now: 'Fix is live.' })
    expect(deriveUserStatus({ ...base, report: report({ state: 'waiting', waiting_kind: 'you', waiting_on: 'A real-device test when you have time' }) }, NOW))
      .toMatchObject({ source: 'session', ask: 'A real-device test when you have time' })
    expect(deriveUserStatus(base, NOW)).toMatchObject({ state: 'needs', ask: expect.stringContaining('read it and reply') })
  })

  it('a report from before the latest phase move lends its words, never its ask', () => {
    const before = report({ state: 'needs', ask: 'Pick A or B?', now: 'Designs sent.', at: ago(30 * 60_000) })
    const s = deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', phaseChangedAt: ago(60_000), report: before }, NOW)
    expect(s.ask).not.toBe('Pick A or B?')
    expect(s.now).toBe('Designs sent.')
  })

  it('a wait names what it waits on: another task, its words, a watch, a schedule, a clock, a lost host', () => {
    const base = { phase: 'WAITING', hasSession: true, processStatus: 'idle' }
    expect(deriveUserStatus({ ...base, waitingOnTasks: ['Bun migration lead'] }, NOW).waitingOn).toContain('Bun migration lead')
    expect(deriveUserStatus({ ...base, report: report({ state: 'waiting', waiting_kind: 'task', waiting_on: 'The Bun lead\'s commit' }) }, NOW))
      .toMatchObject({ kind: 'task', waitingOn: 'The Bun lead\'s commit' })
    expect(deriveUserStatus({ ...base, triggers: ['Pipeline watch'] }, NOW)).toMatchObject({ kind: 'other', waitingOn: 'A watch: Pipeline watch' })
    const next = new Date(NOW + 3600_000).toISOString()
    expect(deriveUserStatus({ ...base, schedules: [{ name: 'Daily digest', nextAt: next }] }, NOW)).toMatchObject({ kind: 'time', until: next })
    expect(deriveUserStatus({ ...base, waitUntil: next }, NOW)).toMatchObject({ kind: 'time', until: next })
    expect(deriveUserStatus({ ...base, processStatus: 'error', errorReason: 'remote_unreachable' }, NOW)).toMatchObject({ kind: 'machine' })
    expect(deriveUserStatus({ ...base, hasLeader: true, report: report({ state: 'done' }) }, NOW)).toMatchObject({ kind: 'lead' })
    expect(deriveUserStatus(base, NOW)).toMatchObject({ kind: 'other', waitingOn: expect.stringContaining('parked') })
    expect(deriveUserStatus({ phase: 'TODO', hasSession: false }, NOW)).toMatchObject({ state: 'waiting', kind: 'not-started' })
  })

  it('flags words a day old on a task that is not running, never on a running one', () => {
    const old = report({ state: 'waiting', waiting_kind: 'task', waiting_on: 'x', at: ago(STALE_REPORT_MS + 1) })
    expect(deriveUserStatus({ phase: 'WAITING', hasSession: true, processStatus: 'idle', report: old }, NOW).stale).toBe(true)
    expect(deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'running', report: old }, NOW).stale).toBeUndefined()
  })
})

describe('a turn\'s report moves its phase (sessions/report-phase.ts)', () => {
  const worker = { parent_task_id: 'lead-1' }
  const solo = {}
  it('maps the task\'s own words to the phase every surface counts', () => {
    expect(phaseForReport({ state: 'needs' }, worker, true)).toBe('NEED_ACTION')
    expect(phaseForReport({ state: 'waiting', waiting_kind: 'you' }, worker, true)).toBe('NEED_ACTION')
    expect(phaseForReport({ state: 'waiting', waiting_kind: 'task' }, worker, true)).toBe('WAITING')
    expect(phaseForReport({ state: 'working' }, worker, true)).toBe('IN_PROGRESS')
    expect(phaseForReport({ state: 'working' }, worker, false)).toBeNull()
    expect(phaseForReport({ state: 'done' }, worker, true)).toBe('WAITING')
    expect(phaseForReport({ state: 'done' }, solo, true)).toBeNull()
  })
  it('Main moves only when it is stopped on the user', () => {
    const main = { org_role: 'main' as const }
    expect(phaseForReport({ state: 'needs' }, main, true)).toBe('NEED_ACTION')
    // Its turns end on the user's next message: that is no stop on them.
    expect(phaseForReport({ state: 'waiting', waiting_kind: 'you' }, main, true)).toBeNull()
    expect(phaseForReport({ state: 'waiting', waiting_kind: 'task' }, main, true)).toBeNull()
    expect(phaseForReport({ state: 'done' }, main, true)).toBeNull()
  })
  it('never over a move made after the turn ended, nor on a parked or finished task', () => {
    const end = NOW - 60_000
    expect(reportMayMovePhase({ phase: 'NEED_ACTION', phase_changed_at: new Date(end - 1000).toISOString() }, end)).toBe(true)
    expect(reportMayMovePhase({ phase: 'NEED_ACTION', phase_changed_at: new Date(end + 30_000).toISOString() }, end)).toBe(false)
    expect(reportMayMovePhase({ phase: 'WAITING', phase_changed_at: new Date(end - 1000).toISOString() }, end)).toBe(false)
    expect(reportMayMovePhase({ phase: 'COMPLETE' }, end, 'NEED_ACTION')).toBe(false)
  })
  it('a parked task moves only to Needs you (a routine\'s fire turn that found something for the user)', () => {
    const end = NOW - 60_000
    const parked = { phase: 'WAITING' as const, phase_changed_at: new Date(end).toISOString() }
    expect(reportMayMovePhase(parked, end, 'NEED_ACTION', 'needs')).toBe(true)
    // "When you have time" leaves a routine on its next run.
    expect(reportMayMovePhase(parked, end, 'NEED_ACTION', 'waiting')).toBe(false)
    expect(reportMayMovePhase(parked, end, 'IN_PROGRESS', 'working')).toBe(false)
    expect(reportMayMovePhase({ ...parked, phase_changed_at: new Date(end + 30_000).toISOString() }, end, 'NEED_ACTION', 'needs')).toBe(false)
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
