/**
 * A task's own line (2026-10-31, the user: "each task shoud be giving the what is waiting next other
 * like vp can chaneg it but each task mange it self"): user_status.line from its current report
 * (user-status.ts lineOf), and a change from outside its turn checked (sessions/report-set.ts).
 */
import { describe, expect, it } from 'vitest'
import { deriveUserStatus, type StatusReport, type UserStatusInput } from '../../src/core/user-status.js'
import { ReportChangeError, reportOfChange } from '../../src/core/sessions/report-set.js'

const NOW = Date.parse('2026-10-31T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const base: UserStatusInput = { hasSession: true, processStatus: 'stopped', hasLeader: true, phaseChangedAt: ago(120_000) }
const rep = (r: Partial<StatusReport>): StatusReport => ({ at: ago(60_000), ...r })

describe('the line comes from the current report, for the state the facts give', () => {
  it('needs: the ask, by the task itself', () => {
    const s = deriveUserStatus({ ...base, phase: 'NEED_ACTION', report: rep({ state: 'needs', ask: 'Pick A or B' }) }, NOW)
    expect(s.line).toEqual({ text: 'Pick A or B', by: 'self', at: ago(60_000) })
  })

  it('waiting: on whom or what, with who set it', () => {
    const s = deriveUserStatus({ ...base, phase: 'WAITING', report: rep({ state: 'waiting', waiting_kind: 'lead', waiting_on: 'Its lead, to land it', by: 'task:lead1', by_name: 'Acme lead' }) }, NOW)
    expect(s.line).toEqual({ text: 'Its lead, to land it', by: 'task:lead1', byName: 'Acme lead', at: ago(60_000) })
  })

  it('working: its next step', () => {
    const s = deriveUserStatus({ ...base, phase: 'IN_PROGRESS', processStatus: 'running', report: rep({ state: 'working', next: 'Run the suite' }) }, NOW)
    expect(s.line?.text).toBe('Run the suite')
  })

  it('none from a report older than the latest phase move, or one that says another state', () => {
    expect(deriveUserStatus({ ...base, phase: 'NEED_ACTION', report: rep({ state: 'needs', ask: 'Old ask', at: ago(30 * 60_000) }) }, NOW).line).toBeUndefined()
    expect(deriveUserStatus({ ...base, phase: 'IN_PROGRESS', processStatus: 'running', report: rep({ state: 'needs', ask: 'Pick' }) }, NOW).line).toBeUndefined()
  })

  it('a snoozed ask keeps its words in snoozed.ask, not as the line of a waiting task', () => {
    const s = deriveUserStatus({ ...base, phase: 'NEED_ACTION', snoozedUntil: '2026-11-13', report: rep({ state: 'needs', ask: 'Pick A or B' }) }, NOW)
    expect(s.state).toBe('waiting')
    expect(s.line).toBeUndefined()
    expect(s.snoozed?.ask).toBe('Pick A or B')
  })
})

describe('a change from outside its turn', () => {
  it('is stored as a report with by and its name; its own session is self', () => {
    expect(reportOfChange({ state: 'waiting', waiting_kind: 'lead', waiting_on: ' Its lead,  to land it ' }, 'task:l1', 'Acme lead', NOW)).toEqual({
      state: 'waiting', waiting_on: 'Its lead, to land it', waiting_kind: 'lead', at: new Date(NOW).toISOString(), turn_ended_at: new Date(NOW).toISOString(), by: 'task:l1', by_name: 'Acme lead',
    })
    expect(reportOfChange({ state: 'needs', ask: 'Sign it' }, 'self', undefined, NOW)).not.toHaveProperty('by')
    expect(reportOfChange({ state: 'needs', ask: 'Sign it' }, 'human', undefined, NOW).by).toBe('human')
  })

  it('needs always names the ask, waiting names what it waits on; bad input is refused', () => {
    for (const bad of [{ state: 'needs' }, { state: 'needs', ask: ' ' }, { state: 'waiting' }, { state: 'done' }, { state: 'waiting', waiting_on: 'x', waiting_kind: 'nope' }, { state: 'needs', ask: 'x'.repeat(301) }, null]) {
      expect(() => reportOfChange(bad, 'human', undefined, NOW), JSON.stringify(bad)).toThrow(ReportChangeError)
    }
  })

  it('keeps only the fields of its state', () => {
    expect(reportOfChange({ state: 'working', ask: 'stray', waiting_on: 'stray', next: 'Run it' }, 'human', undefined, NOW)).toEqual({
      state: 'working', next: 'Run it', at: new Date(NOW).toISOString(), turn_ended_at: new Date(NOW).toISOString(), by: 'human',
    })
  })
})
