import { describe, expect, it } from 'vitest'
import { countNeedingYou, phoneTierEmptyHint } from '../../web/src/components/tasks/PhoneTierEmpty'

describe('phone empty tier (N22)', () => {
  it('counts open NEED_ACTION tasks only', () => {
    expect(countNeedingYou([
      { phase: 'NEED_ACTION', status: 'todo' }, { phase: 'NEED_ACTION', status: 'done' },
      { phase: 'IN_PROGRESS', status: 'todo' }, { phase: 'NEED_ACTION' },
    ])).toBe(2)
  })
  it('names the count in words, and says nothing at zero', () => {
    expect(phoneTierEmptyHint(0)).toBe('')
    expect(phoneTierEmptyHint(1)).toBe('1 task needs you.')
    expect(phoneTierEmptyHint(12)).toBe('12 tasks need you.')
  })
})
