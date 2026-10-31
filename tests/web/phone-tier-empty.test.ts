import { describe, expect, it } from 'vitest'
import type { Task } from '@open-walnut/core'
import { countNeedingYou, phoneTierEmptyHint } from '../../web/src/components/tasks/PhoneTierEmpty'

type Row = Pick<Task, 'phase' | 'status' | 'user_status'>
const rows = (r: Partial<Row>[]): Row[] => r as Row[]
// A snoozed task (start date still to come): handed back, but the server's status reads Waiting.
const SNOOZED = { state: 'waiting', kind: 'time', waitingOn: 'Snoozed until 2026-11-13', snoozed: { until: '2026-11-13' } } as Task['user_status']

describe('phone empty tier (N22)', () => {
  it('counts open NEED_ACTION tasks only', () => {
    expect(countNeedingYou(rows([
      { phase: 'NEED_ACTION', status: 'todo' }, { phase: 'NEED_ACTION', status: 'done' },
      { phase: 'IN_PROGRESS', status: 'todo' }, { phase: 'NEED_ACTION' },
    ]))).toBe(2)
  })
  it('reads the user status over the phase: a snoozed task never counts, a derived needs does', () => {
    expect(countNeedingYou(rows([
      { phase: 'NEED_ACTION', status: 'todo', user_status: SNOOZED },
      { phase: 'NEED_ACTION', status: 'todo', user_status: { state: 'waiting', kind: 'lead', waitingOn: 'Its lead' } },
      { phase: 'WAITING', status: 'todo', user_status: { state: 'needs', source: 'letter', ask: 'Pick a date' } },
      { phase: 'NEED_ACTION', status: 'todo' },
    ]))).toBe(2)
  })
  it('names the count in words, and says nothing at zero', () => {
    expect(phoneTierEmptyHint(0)).toBe('')
    expect(phoneTierEmptyHint(1)).toBe('1 task needs you.')
    expect(phoneTierEmptyHint(12)).toBe('12 tasks need you.')
  })
})
