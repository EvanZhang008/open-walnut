/**
 * A snoozed task (a start date still to come, src/core/snooze.ts) asks nothing of the user until
 * that date (2026-10-30, the user, after snoozing a task for two weeks: "if something you look at is
 * already snoozed, don't remind me again, unless you have a particular reason"). Its session's own
 * report kept it under Needs you; the derived status now holds it back, the re-checks wait, and the
 * clock starts again when the date comes.
 */
import { describe, it, expect } from 'vitest'
import { deriveUserStatus, NEEDS_RECHECK_MS, type StatusReport, type UserStatusInput } from '../../src/core/user-status.js'
import { effectiveStartDate, snoozeEndedMs, snoozedUntil, startDateMs } from '../../src/core/snooze.js'
import { recheckDue } from '../../src/core/sessions/needs-recheck.js'
import { seenOf } from '../../src/core/sessions/status-push.js'
import { snoozedLetterTask } from '../../src/core/human-inbox/snooze-letter.js'
import { briefSectionLines } from '../../src/core/sessions/brief.js'
import type { Task } from '../../src/core/types.js'

const NOW = new Date(2026, 9, 30, 16, 0).getTime()
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const report = (r: Partial<StatusReport>): StatusReport => ({ at: ago(60_000), ...r })
const UNTIL = '2026-11-13'

const asking: UserStatusInput = {
  phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', phaseChangedAt: ago(120_000),
  report: report({ state: 'needs', ask: 'Sign in on the phone and say start', now: 'Code is live', next: 'You sign in' }),
}

describe('a snoozed task asks nothing of the user until its date', () => {
  it('its own report asking the user reads Waiting until the date, the ask held back', () => {
    const s = deriveUserStatus({ ...asking, snoozedUntil: UNTIL }, NOW)
    expect(s).toMatchObject({ state: 'waiting', kind: 'time', waitingOn: `Snoozed until ${UNTIL}`, snoozed: { until: UNTIL, ask: 'Sign in on the phone and say start' } })
    expect(s.until).toBe(new Date(2026, 10, 13).toISOString())
    expect(s.now).toBe('Code is live')
    expect(s.checkedAt).toBeUndefined()
    expect(deriveUserStatus(asking, NOW).state).toBe('needs')
  })

  it('every way of asking the user is held: a letter, a choice, a hand-back, a wait on the user', () => {
    const cases: UserStatusInput[] = [
      { ...asking, openLetter: 'Pick a design' },
      { ...asking, openChoice: 'Which host?' },
      { ...asking, report: null },
      { ...asking, report: report({ state: 'waiting', waiting_kind: 'you', waiting_on: 'you: paste the notes' }) },
      { ...asking, report: report({ state: 'done' }) },
      { phase: 'TODO' },
      { phase: 'IN_PROGRESS', hasSession: true, processStatus: 'stopped' },
    ]
    for (const c of cases) {
      const s = deriveUserStatus({ ...c, snoozedUntil: UNTIL }, NOW)
      expect(s.state, JSON.stringify(c)).not.toBe('needs')
      expect(s.snoozed?.until, JSON.stringify(c)).toBe(UNTIL)
    }
  })

  it('what it is doing now stays true: a running turn is Working, a live prompt still needs the user, Done is done', () => {
    expect(deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'running', snoozedUntil: UNTIL }, NOW).state).toBe('working')
    expect(deriveUserStatus({ ...asking, processStatus: 'running', pendingPermissionTool: 'AskUserQuestion', snoozedUntil: UNTIL }, NOW))
      .toMatchObject({ state: 'needs', source: 'prompt' })
    expect(deriveUserStatus({ phase: 'COMPLETE', snoozedUntil: UNTIL }, NOW)).toEqual({ state: 'done' })
  })

  it('an outside wait keeps its words and only carries the mark; Main is never snoozed', () => {
    const s = deriveUserStatus({ phase: 'WAITING', report: report({ state: 'waiting', waiting_kind: 'outside', waiting_on: 'The CI run' }), phaseChangedAt: ago(120_000), snoozedUntil: UNTIL }, NOW)
    expect(s).toMatchObject({ state: 'waiting', kind: 'outside', waitingOn: 'The CI run', snoozed: { until: UNTIL } })
    expect(deriveUserStatus({ ...asking, isMain: true, snoozedUntil: UNTIL }, NOW).state).toBe('needs')
  })

  it('a deadline is not raised while snoozed', () => {
    expect(deriveUserStatus({ ...asking, dueDate: '2026-10-29', snoozedUntil: UNTIL }, NOW).due).toBeUndefined()
    expect(deriveUserStatus({ ...asking, dueDate: '2026-10-29' }, NOW).due?.state).toBe('overdue')
  })

  it('the date comes: the task reads where its state puts it again', () => {
    const at = new Date(2026, 10, 13).getTime()
    expect(deriveUserStatus({ ...asking, snoozedUntil: UNTIL }, at - 1).state).toBe('waiting')
    expect(deriveUserStatus({ ...asking, snoozedUntil: UNTIL }, at).state).toBe('needs')
  })
})

describe('what counts as snoozed (the board\'s own Date rule)', () => {
  const t = (id: string, start?: string, parent?: string) => ({ id, start_date: start, parent_task_id: parent }) as Pick<Task, 'id' | 'start_date' | 'parent_task_id'>
  const byId = new Map([t('root', UNTIL), t('kid', undefined, 'root'), t('own', '2026-10-01', 'root'), t('free')].map((x) => [x.id, x] as const))

  it('a bare date starts at local midnight; a time is that moment', () => {
    expect(startDateMs('2026-11-13')).toBe(new Date(2026, 10, 13).getTime())
    expect(startDateMs('2026-11-13T09:30:00Z')).toBe(Date.parse('2026-11-13T09:30:00Z'))
    expect(startDateMs('')).toBeNaN()
  })

  it('a subtask with no start date sleeps with its ancestor; its own date wins', () => {
    expect(effectiveStartDate(byId.get('kid')!, byId)).toBe(UNTIL)
    expect(snoozedUntil(byId.get('kid')!, byId, NOW)).toBe(UNTIL)
    expect(snoozedUntil(byId.get('own')!, byId, NOW)).toBeNull()
    expect(snoozedUntil(byId.get('free')!, byId, NOW)).toBeNull()
    expect(snoozeEndedMs(byId.get('own')!, byId, NOW)).toBe(new Date(2026, 9, 1).getTime())
    expect(snoozeEndedMs(byId.get('kid')!, byId, NOW)).toBeNaN()
  })
})

describe('the reminders wait, and start fresh at the date', () => {
  const needsTask = (checkedAt: string, extra: Partial<Task['user_status']> = {}) => ({
    phase: 'NEED_ACTION', status: 'in_progress',
    user_status: { state: 'needs', source: 'session', ask: 'Sign in', checkedAt, ...extra },
  }) as Task

  it('no re-check of a snoozed ask', () => {
    expect(recheckDue(needsTask(ago(10 * NEEDS_RECHECK_MS), { snoozed: { until: UNTIL } } as never), { nowMs: NOW })).toBe(false)
  })

  it('after the date the 4-hour clock counts from the date, not from the old check', () => {
    const ended = NOW - 60_000
    const t = needsTask(ago(14 * 24 * 3_600_000))
    expect(recheckDue(t, { nowMs: NOW })).toBe(true)
    expect(recheckDue(t, { nowMs: NOW, snoozeEndedMs: ended })).toBe(false)
    expect(recheckDue(t, { nowMs: ended + NEEDS_RECHECK_MS + 1, snoozeEndedMs: ended })).toBe(true)
  })

  it('the status push marks a snoozed status, so its leader, VP and Main hear nothing of it', () => {
    const snoozed = deriveUserStatus({ ...asking, snoozedUntil: UNTIL }, NOW)
    expect(seenOf({ phase: 'NEED_ACTION', user_status: snoozed }).snoozed).toBe(true)
    expect(seenOf({ phase: 'NEED_ACTION', user_status: deriveUserStatus(asking, NOW) }).snoozed).toBeUndefined()
    // An agent reads one word for it, not the people's tab name.
    expect(seenOf({ phase: 'NEED_ACTION', user_status: snoozed }).label).toMatch(/^Snoozed/)
  })

  it('the Brief lists a snoozed task under Waiting / snoozed with its date, never as an ask', () => {
    const owner = { id: 'lead', title: 'Lead', phase: 'IN_PROGRESS', org_role: 'lead', project: 'P' }
    const mk = (id: string, snoozed: boolean) => ({
      id, title: id, phase: 'NEED_ACTION', project: 'P', parent_task_id: 'lead', due_date: '2026-10-29',
      user_status: snoozed ? deriveUserStatus({ ...asking, snoozedUntil: UNTIL }, NOW) : deriveUserStatus(asking, NOW),
    })
    const lists = briefSectionLines(owner as never, [owner, mk('a', true), mk('b', false)] as never, NOW)
    expect(lists.needs.map((l) => l.match(/id="(\w+)"/)?.[1])).toEqual(['b'])
    expect(lists.waiting).toEqual([`- <task-ref id="a" label="a"/>: snoozed until ${UNTIL} (then asks: "Sign in on the phone and say start")`])
  })

  it('a letter names the snoozed task it is from or about', () => {
    const byId = new Map([
      ['s', { id: 's', title: 'Snoozed', start_date: UNTIL }],
      ['k', { id: 'k', title: 'Its subtask', parent_task_id: 's' }],
      ['f', { id: 'f', title: 'Free' }],
    ] as const) as never
    expect(snoozedLetterTask(['f'], byId, NOW)).toBeNull()
    expect(snoozedLetterTask(['f', 'k'], byId, NOW)).toEqual({ id: 'k', title: 'Its subtask', until: UNTIL })
  })
})
