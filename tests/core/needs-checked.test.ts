/**
 * A session's "needs you" says when it was last checked, and stops reading as fact once that is
 * too long ago (2026-10-28, the user: "I've already resolved some of these. You should at least
 * verify"): the status stamps it (user-status.ts), every surface prints the same words
 * (checkedLine), Main's and a lead's Brief prompt lists the asks with their time (briefSectionLines),
 * and the re-check clock asks the owning session again (sessions/needs-recheck.ts recheckDue).
 */
import { describe, it, expect } from 'vitest'
import {
  NEEDS_RECHECK_MS, UNVERIFIED_AFTER_MS, checkedLine, deriveUserStatus, type StatusReport,
} from '../../src/core/user-status.js'
import { MAX_RECHECKS, recheckBody, recheckDue } from '../../src/core/sessions/needs-recheck.js'
import { briefPrompt, briefSectionLines } from '../../src/core/sessions/brief.js'
import type { Task } from '../../src/core/types.js'

const NOW = Date.parse('2026-10-28T18:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const H = 3_600_000
const asks = (at: string): StatusReport => ({ at, state: 'needs', ask: 'Sign in on the Mac' })

describe('the stamp', () => {
  it('a session ask carries when its report said it, and is fact until UNVERIFIED_AFTER_MS', () => {
    const s = deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', report: asks(ago(2 * H)), phaseChangedAt: ago(2 * H) }, NOW)
    expect(s).toMatchObject({ state: 'needs', source: 'session', checkedAt: ago(2 * H), checkedBy: 'session' })
    expect(s.unverified).toBeUndefined()
    const old = deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', report: asks(ago(UNVERIFIED_AFTER_MS + 60_000)), phaseChangedAt: ago(UNVERIFIED_AFTER_MS + 60_000) }, NOW)
    expect(old.unverified).toBe(true)
  })

  it('the newest of the report and the phase move is the last word; a report older than the move asks nothing', () => {
    const s = deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', report: asks(ago(1 * H)), phaseChangedAt: ago(1 * H + 3_000) }, NOW)
    expect(s.checkedAt).toBe(ago(1 * H))
    // Written before the latest turn: it lends words only, so its ask is not stamped as checked.
    const old = deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', report: asks(ago(9 * H)), phaseChangedAt: ago(1 * H) }, NOW)
    expect(old.checkedAt).toBeUndefined()
  })

  it("a trigger's run is shown beside the ask, never counted as its check (it watches the task, maybe not this ask)", () => {
    const s = deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', report: asks(ago(20 * H)), phaseChangedAt: ago(20 * H), checkRanAt: ago(10 * 60_000) }, NOW)
    expect(s).toMatchObject({ checkedAt: ago(20 * H), checkedBy: 'session', watchedAt: ago(10 * 60_000), unverified: true })
    expect(checkedLine(s, NOW)!.text).toBe('Not verified: last checked 20 hours ago, may be done already; its trigger ran 10 minutes ago')
  })

  it("Walnut's own hand-back words and the moment before a report carry no stamp", () => {
    const back = deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', phaseChangedAt: ago(30 * H) }, NOW)
    expect(back).toMatchObject({ state: 'needs', source: 'session' })
    expect(back.checkedAt).toBeUndefined()
    expect(back.unverified).toBeUndefined()
    const pending = deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', reportPending: true, phaseChangedAt: ago(60_000) }, NOW)
    expect(pending).toMatchObject({ state: 'waiting', transient: true })
  })

  it("Walnut's own records (a letter, a prompt) carry no stamp: they are live", () => {
    const s = deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', openLetter: 'Approve the send', phaseChangedAt: ago(30 * H) }, NOW)
    expect(s.state).toBe('needs')
    expect(s.source).toBe('letter')
    expect(s.checkedAt).toBeUndefined()
    expect(checkedLine(s, NOW)).toBeNull()
  })
})

describe('a stopped team', () => {
  it('a member reads as waiting for the resume, not as a session that stopped for no reason', () => {
    const base = { phase: 'NEED_ACTION', hasSession: true, processStatus: 'stopped', hasLeader: true, teamStoppedAt: ago(2 * 60_000), phaseChangedAt: ago(60_000) } as const
    const s = deriveUserStatus({ ...base, report: { at: ago(H), state: 'working' } }, NOW)
    expect(s).toMatchObject({ state: 'waiting', kind: 'lead' })
    expect(s.waitingOn).toContain('Its team was stopped')
    // Its own ask still needs the user.
    expect(deriveUserStatus({ ...base, report: asks(ago(30_000)) }, NOW).state).toBe('needs')
    // A turn it ran after the stop speaks for itself.
    const ran = deriveUserStatus({ ...base, report: { at: ago(30_000), state: 'waiting', waiting_kind: 'task', waiting_on: 'The review' } }, NOW)
    expect(ran.waitingOn ?? '').not.toContain('Its team was stopped')
    // A failure still needs the user first.
    expect(deriveUserStatus({ ...base, processStatus: 'error', errorMessage: 'boom' }, NOW).source).toBe('error')
  })
})

describe('the words every surface prints', () => {
  it('checked a while ago, by its check, or not verified', () => {
    expect(checkedLine({ state: 'needs', source: 'session', checkedAt: ago(2 * H), checkedBy: 'session' }, NOW)).toEqual({ text: 'Checked 2 hours ago', unverified: false })
    expect(checkedLine({ state: 'needs', source: 'session', checkedAt: ago(H), watchedAt: ago(5 * 60_000) }, NOW)).toEqual({ text: 'Checked 1 hour ago; its trigger ran 5 minutes ago', unverified: false })
    expect(checkedLine({ state: 'needs', source: 'session', checkedAt: ago(9 * H), unverified: true }, NOW))
      .toEqual({ text: 'Not verified: last checked 9 hours ago, may be done already', unverified: true })
    expect(checkedLine({ state: 'working' }, NOW)).toBeNull()
  })
})

describe('the re-check clock', () => {
  const needsTask = (checkedAt: string, extra: Partial<Task> = {}) => ({
    phase: 'NEED_ACTION', status: 'in_progress',
    user_status: { state: 'needs' as const, source: 'session' as const, ask: 'Sign in on the Mac', checkedAt },
    ...extra,
  }) as Task

  it('is due once the ask went NEEDS_RECHECK_MS unchecked, not before', () => {
    expect(recheckDue(needsTask(ago(NEEDS_RECHECK_MS - 60_000)), { nowMs: NOW })).toBe(false)
    expect(recheckDue(needsTask(ago(NEEDS_RECHECK_MS + 60_000)), { nowMs: NOW })).toBe(true)
  })

  it('asks at most MAX_RECHECKS times in a row, one per period, however the session rewords its ask', () => {
    const t = needsTask(ago(30 * H), { needs_recheck: { at: ago(NEEDS_RECHECK_MS + 60_000), count: 2, ask: 'Sign in on the Mac' } })
    expect(recheckDue(t, { nowMs: NOW })).toBe(true)
    expect(recheckDue({ ...t, needs_recheck: { at: ago(H), count: 2, ask: 'Sign in on the Mac' } }, { nowMs: NOW })).toBe(false)
    expect(recheckDue({ ...t, needs_recheck: { at: ago(30 * H), count: MAX_RECHECKS, ask: 'Sign in on the Mac' } }, { nowMs: NOW })).toBe(false)
    expect(recheckDue({ ...t, needs_recheck: { at: ago(30 * H), count: MAX_RECHECKS, ask: 'Sign in on the Mac, then tell me' } }, { nowMs: NOW })).toBe(false)
  })

  it('an ephemeral server never asks about a status it copied (checked before it started)', () => {
    expect(recheckDue(needsTask(ago(10 * H)), { nowMs: NOW, notBefore: NOW - H })).toBe(false)
  })

  it('a done task, a letter, a prompt are never re-checked', () => {
    expect(recheckDue({ ...needsTask(ago(10 * H)), phase: 'COMPLETE' } as Task, { nowMs: NOW })).toBe(false)
    expect(recheckDue({ ...needsTask(ago(10 * H)), user_status: { state: 'needs', source: 'letter', ask: 'x', checkedAt: ago(10 * H) } } as Task, { nowMs: NOW })).toBe(false)
  })

  it('the note names the ask, how long ago, and asks for a check script', () => {
    const body = recheckBody('Sign in on the Mac', ago(5 * H), NOW)
    expect(body).toContain('"Sign in on the Mac", last checked 5 hours ago')
    expect(body).toContain('trigger_create, wait:false')
  })
})

describe("the Brief's live list of what needs the user", () => {
  const t = (id: string, extra: Partial<Task>): Task => ({ id, title: `T ${id}`, phase: 'NEED_ACTION', status: 'in_progress', project: 'Acme', ...extra }) as Task
  const lead = t('lead', { org_role: 'lead', phase: 'IN_PROGRESS' })
  const tasks = [
    lead,
    t('a', { parent_task_id: 'lead', user_status: { state: 'needs', source: 'session', ask: 'Sign in on the Mac', checkedAt: ago(9 * H), unverified: true } }),
    t('b', { parent_task_id: 'lead', user_status: { state: 'needs', source: 'session', ask: 'Pick a <name>', checkedAt: ago(2 * H), checkedBy: 'session' } }),
    t('c', { parent_task_id: 'lead', user_status: { state: 'needs', source: 'letter', ask: 'Approve the send' } }),
    t('d', { parent_task_id: 'lead', phase: 'COMPLETE', status: 'done', user_status: { state: 'needs', source: 'session', ask: 'old', checkedAt: ago(H) } }),
    t('e', { parent_task_id: 'lead', phase: 'IN_PROGRESS', user_status: { state: 'working' } }),
  ]

  it('lists each open ask with when it was checked, marks the old ones NOT VERIFIED, and escapes words', () => {
    const lines = briefSectionLines(lead, tasks, NOW).needs
    expect(lines).toHaveLength(3)
    expect(lines.find((l) => l.includes('T a'))).toContain('"Sign in on the Mac" (NOT VERIFIED: last checked 9 hours ago, the user may have done it already)')
    expect(lines.find((l) => l.includes('T b'))).toContain('"Pick a &lt;name&gt;" (checked 2 hours ago by its session)')
    expect(lines.find((l) => l.includes('T c'))).toContain("(Walnut's live record)")
    const prompt = briefPrompt({ hadBrief: true, sections: { needs: lines, working: [], waiting: [] } })
    expect(prompt).toContain('never as a step the user still owes')
    expect(prompt).toContain(lines[0])
  })
})
