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
  it('needs you when the phase is NEED_ACTION, whatever letters, choices or reports say', () => {
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

  // 2026-10-27, the lead on the user's demo: the user answered a question, the turn only confirmed
  // the plan, and every surface still read Needs you, for the four minutes until the report and for
  // good once it said done.
  it('a turn that only ended is not Needs you: its report of done, or its report still to come', () => {
    const base = { phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', phaseChangedAt: ago(5 * 60_000) }
    expect(deriveUserStatus({ ...base, report: report({ state: 'done', now: 'Plan: ship in 2.4.' }) }, NOW))
      .toMatchObject({ state: 'waiting', kind: 'you', waitingOn: expect.stringContaining('close it'), now: 'Plan: ship in 2.4.' })
    expect(deriveUserStatus({ ...base, hasLeader: true, report: report({ state: 'done' }) }, NOW)).toMatchObject({ state: 'waiting', kind: 'lead' })
    // Main and a lead are never closed: they wait on the user's next message.
    for (const who of [{ isMain: true }, { isLead: true }]) {
      expect(deriveUserStatus({ ...base, ...who, report: report({ state: 'done' }) }, NOW)).toMatchObject({ state: 'waiting', kind: 'you', waitingOn: expect.stringContaining('next message') })
    }
    expect(deriveUserStatus({ ...base, reportPending: true }, NOW)).toMatchObject({ state: 'waiting', kind: 'other', waitingOn: expect.stringContaining('report') })
    // A done report from before the latest hand-back is an older turn's: with none coming, the turn needs reading.
    expect(deriveUserStatus({ ...base, phaseChangedAt: ago(10_000), report: report({ state: 'done', at: ago(20 * 60_000) }) }, NOW))
      .toMatchObject({ state: 'needs', ask: expect.stringContaining('read it and reply') })
    // What does need the user still does, report pending or not.
    expect(deriveUserStatus({ ...base, reportPending: true, openLetter: 'Approve the quota raise' }, NOW)).toMatchObject({ state: 'needs', source: 'letter' })
    expect(deriveUserStatus({ ...base, reportPending: true, openChoice: 'Raise the quota?' }, NOW)).toMatchObject({ state: 'needs', source: 'choice' })
    expect(deriveUserStatus({ ...base, reportPending: true, pendingPermissionTool: 'AskUserQuestion' }, NOW)).toMatchObject({ state: 'needs', source: 'prompt' })
    expect(deriveUserStatus({ ...base, reportPending: true, processStatus: 'error', errorMessage: 'auth expired' }, NOW)).toMatchObject({ state: 'needs', source: 'error' })
    expect(deriveUserStatus({ ...base, report: report({ state: 'needs', ask: 'Pick A or B?' }), reportPending: true }, NOW)).toMatchObject({ state: 'needs', ask: 'Pick A or B?' })
  })

  // 2026-10-27: a worker whose session Walnut reaped while its tests ran read Needs you everywhere.
  it('a worker whose session stopped waits on its lead, unless its own report asks the user', () => {
    const base = { phase: 'NEED_ACTION', hasSession: true, processStatus: 'stopped', hasLeader: true, phaseChangedAt: ago(60_000) }
    expect(deriveUserStatus(base, NOW)).toMatchObject({ state: 'waiting', kind: 'lead', waitingOn: expect.stringContaining('session stopped') })
    expect(deriveUserStatus({ ...base, reportPending: true }, NOW)).toMatchObject({ state: 'waiting', kind: 'lead' })
    // An older turn's ask lends nothing: the stop came after it.
    expect(deriveUserStatus({ ...base, report: report({ state: 'needs', ask: 'Pick A or B?', at: ago(30 * 60_000) }) }, NOW)).toMatchObject({ kind: 'lead' })
    // Its own current report, a letter, a failed session: still the user's.
    expect(deriveUserStatus({ ...base, report: report({ state: 'needs', ask: 'Pick A or B?' }) }, NOW)).toMatchObject({ state: 'needs', ask: 'Pick A or B?' })
    expect(deriveUserStatus({ ...base, openLetter: 'Approve the quota raise' }, NOW)).toMatchObject({ state: 'needs', source: 'letter' })
    expect(deriveUserStatus({ ...base, processStatus: 'error' }, NOW)).toMatchObject({ state: 'needs', source: 'error' })
    // No lead: the user, as before.
    expect(deriveUserStatus({ ...base, hasLeader: false }, NOW)).toMatchObject({ state: 'needs' })
    // A lead (or Main) with no ask of its own is never a bare Needs you (2026-10-31, the user: "u can
    // show VP sure, but u need to show what are actually waiting"): it waits on the user's next message.
    expect(deriveUserStatus({ ...base, isLead: true }, NOW)).toMatchObject({ state: 'waiting', kind: 'you' })
    expect(deriveUserStatus({ ...base, hasLeader: false, isMain: true, processStatus: 'idle' }, NOW)).toMatchObject({ state: 'waiting', kind: 'you' })
    // A turn that only ended (its process alive between turns), with no ask: its lead's, too.
    expect(deriveUserStatus({ ...base, processStatus: 'idle' }, NOW)).toMatchObject({ state: 'waiting', kind: 'lead', waitingOn: expect.stringContaining('without asking you') })
    // A lead with a real ask still needs the user.
    expect(deriveUserStatus({ ...base, isLead: true, report: report({ state: 'needs', ask: 'Pick A or B?' }) }, NOW)).toMatchObject({ state: 'needs', ask: 'Pick A or B?' })
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
  it('a wait it names no outside thing for is the user\'s unless the task has one armed', () => {
    for (const kind of ['other', 'time', undefined] as const) {
      expect(phaseForReport({ state: 'waiting', waiting_kind: kind }, worker, true, false), String(kind)).toBe('NEED_ACTION')
      expect(phaseForReport({ state: 'waiting', waiting_kind: kind }, worker, true, true), String(kind)).toBe('WAITING')
    }
    expect(phaseForReport({ state: 'waiting', waiting_kind: 'outside', waiting_on: 'the CI run' }, solo, true, false)).toBe('WAITING')
    expect(phaseForReport({ state: 'waiting', waiting_kind: 'lead' }, solo, true, false)).toBe('NEED_ACTION')
    expect(phaseForReport({ state: 'waiting', waiting_kind: 'task', waiting_on: 'user: a review' }, worker, true, true)).toBe('NEED_ACTION')
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
    expect(userStatusLine(c)).toBe('2 Needs you · 1 Working · 1 Waiting / snoozed · 1 Completed')
    expect(userStatusLine({ needs: 1, working: 0, waiting: 0, done: 0 }, { withDone: false })).toBe('1 Needs you · 0 Working · 0 Waiting / snoozed')
  })
})

// 2026-10-28: the Mac disk filled, a host dropped, and the org update listed the tasks it stopped
// under "Needs the user now". The machine's failures are Walnut's and the lead's to bring back.
describe('stopped by the machine, not the work', () => {
  const lost = { hasSession: true, processStatus: 'error', errorReason: 'remote_unreachable' }

  it('reads Waiting on the machine in every open phase, never Needs you', () => {
    for (const phase of ['NEED_ACTION', 'IN_PROGRESS', 'WAITING'] as const) {
      expect(deriveUserStatus({ phase, ...lost }, NOW), phase).toMatchObject({ state: 'waiting', kind: 'machine', stoppedBy: 'machine' })
    }
    expect(deriveUserStatus({ phase: 'COMPLETE', ...lost }, NOW).state).toBe('done')
  })

  it('reads the cause from the structured facts only, never the message text', () => {
    const at = (f: Partial<UserStatusInput>) => deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'error', ...f }, NOW)
    expect(at({ errorReason: 'remote_unreachable' }).waitingOn).toMatch(/^Its host to come back/)
    expect(at({ errorReason: 'server_restart' }).waitingOn).toBe('Walnut, resuming it after Walnut restarted')
    expect(at({ errorReason: 'daemon_reported_exit' }).waitingOn).toMatch(/its process stopped under it/)
    expect(at({ errorKind: 'infra', errorReason: 'snapshot_projection' })).toMatchObject({ kind: 'machine' })
    // A real failure still needs the user, and prose that sounds like a lost host proves nothing.
    expect(at({ errorReason: 'api_error' })).toMatchObject({ state: 'needs', source: 'error' })
    expect(at({ errorMessage: 'Connection lost — unable to reach remote host' })).toMatchObject({ state: 'needs', source: 'error' })
    expect(at({ errorKind: 'terminal', errorReason: 'remote_unreachable' })).toMatchObject({ state: 'needs' })
  })

  it('names the lead as the one who restarts it, when there is one', () => {
    expect(deriveUserStatus({ phase: 'IN_PROGRESS', ...lost, projectLead: true }, NOW).waitingOn).toContain('its lead restarts it if that fails')
    expect(deriveUserStatus({ phase: 'IN_PROGRESS', ...lost }, NOW).waitingOn).not.toContain('lead')
  })

  it('keeps the ask of its own latest turn: a decision the user owes stays theirs', () => {
    const asked = report({ state: 'needs', ask: 'CRD or CFN?', at: ago(30_000) })
    const s = deriveUserStatus({ phase: 'NEED_ACTION', ...lost, report: asked, phaseChangedAt: ago(60_000) }, NOW)
    expect(s).toMatchObject({ state: 'needs', source: 'session', ask: 'CRD or CFN?' })
  })

  it('a restart loss reads Walnut resuming it, and the lead when Walnut gave up', () => {
    const dead = { phase: 'IN_PROGRESS', hasSession: true, processStatus: 'stopped' }
    for (const state of ['queued', 'sent']) {
      expect(deriveUserStatus({ ...dead, restartLoss: { state, cause: 'machine_reboot' } }, NOW))
        .toMatchObject({ state: 'waiting', kind: 'machine', waitingOn: 'Walnut, resuming it after this computer restarted' })
    }
    const gaveUp = { ...dead, phase: 'NEED_ACTION', restartLoss: { state: 'gave_up', cause: 'server_restart' } }
    expect(deriveUserStatus({ ...gaveUp, projectLead: true }, NOW)).toMatchObject({ state: 'waiting', kind: 'lead', stoppedBy: 'machine' })
    expect(deriveUserStatus({ ...gaveUp, hasLeader: true }, NOW)).toMatchObject({ state: 'waiting', kind: 'lead' })
    // No lead to restart it: the user is the one.
    expect(deriveUserStatus(gaveUp, NOW)).toMatchObject({ state: 'needs', source: 'error', ask: expect.stringContaining('Walnut could not resume it') })
    // Undecided yet (most are decided settled a moment later): not told as a stop.
    expect(deriveUserStatus({ ...dead, restartLoss: { state: 'pending' } }, NOW).kind).toBe('stuck')
    // Back and alive, or decided as settled: the loss says nothing more.
    expect(deriveUserStatus({ ...dead, processStatus: 'idle', restartLoss: { state: 'queued' } }, NOW).kind).not.toBe('machine')
    expect(deriveUserStatus({ ...dead, phase: 'NEED_ACTION', restartLoss: { state: 'skipped' } }, NOW).state).toBe('needs')
  })

  it('a turn that reported waiting on the machine (a full disk) reads so', () => {
    const disk = report({ state: 'waiting', waiting_kind: 'machine', waiting_on: 'Free disk on the Walnut server' })
    expect(deriveUserStatus({ phase: 'WAITING', hasSession: true, processStatus: 'idle', report: disk }, NOW))
      .toMatchObject({ state: 'waiting', kind: 'machine', waitingOn: 'Free disk on the Walnut server' })
    expect(phaseForReport(disk, {}, true)).toBe('WAITING')
  })

  it('a parked task needs no process: only a lost host stops its wait', () => {
    const parked = { phase: 'WAITING', hasSession: true, triggers: ['CI watch'] }
    expect(deriveUserStatus({ ...parked, processStatus: 'error', errorReason: 'daemon_reported_exit' }, NOW))
      .toMatchObject({ kind: 'other', waitingOn: 'A watch: CI watch' })
    expect(deriveUserStatus({ ...parked, processStatus: 'error', errorReason: 'server_restart' }, NOW).kind).toBe('other')
    expect(deriveUserStatus({ ...parked, processStatus: 'error', errorReason: 'remote_unreachable' }, NOW).kind).toBe('machine')
  })

  it('a stop that stands a day goes to its lead, or to the user when it has none', () => {
    const old = { phase: 'IN_PROGRESS', ...lost, statusSince: ago(25 * 3600_000) }
    expect(deriveUserStatus({ ...old, projectLead: true }, NOW)).toMatchObject({ state: 'waiting', kind: 'lead', stoppedBy: 'machine' })
    expect(deriveUserStatus(old, NOW)).toMatchObject({ state: 'needs', source: 'error', ask: expect.stringContaining('unreachable for a day') })
    expect(deriveUserStatus({ ...old, statusSince: ago(3600_000) }, NOW).kind).toBe('machine')
  })
})

// 2026-10-28: a refused send read as "Its turn ended and handed the task back to you".
describe('a message that never reached the session', () => {
  it('names the cause, ahead of the session error it also caused', () => {
    const base = { phase: 'NEED_ACTION', hasSession: true, processStatus: 'error', errorMessage: 'Session process exited with code 1' }
    const why = 'Not delivered: another Claude Code process (pid 4087) already has this session open on host "box", and Walnut runs one process per session.'
    expect(deriveUserStatus({ ...base, undeliveredMessage: why }, NOW)).toMatchObject({
      state: 'needs', source: 'error',
      ask: 'A message to it was not delivered: another Claude Code process (pid 4087) already has this session open on host "box", and Walnut runs one process per session.',
    })
    expect(deriveUserStatus({ ...base, undeliveredMessage: null }, NOW).ask).toContain('Its session failed')
    // Only a handed-back task: the same park on a running task is not what it waits on.
    expect(deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'running', undeliveredMessage: why }, NOW).state).toBe('working')
  })

  it('counts a park from the latest hand-back only, not one from before the phase last moved', async () => {
    const { statusInputOf } = await import('../../src/core/user-status-sync.js')
    const facts = {
      sessions: new Map([['sid-a', { processStatus: 'stopped', taskId: 't1' }]]), letters: new Map(), choices: new Map(),
      requestsFrom: new Map(), triggers: new Map(), schedules: new Map(), titles: new Map(), sessionsOf: new Map([['t1', ['sid-a']]]),
      undelivered: new Map([['sid-a', { reason: 'Not delivered: x', at: '2026-10-28T06:05:03.000Z' }]]),
    } as unknown as import('../../src/core/user-status-sync.js').StatusFacts
    const task = (moved: string) => ({ id: 't1', title: 'x', phase: 'NEED_ACTION', session_id: 'sid-a', phase_changed_at: moved }) as unknown as import('../../src/core/types.js').Task
    expect(statusInputOf(task('2026-10-28T06:05:04.000Z'), facts).undeliveredMessage).toBe('Not delivered: x')
    expect(statusInputOf(task('2026-10-28T07:00:00.000Z'), facts).undeliveredMessage).toBeNull()
  })
})
