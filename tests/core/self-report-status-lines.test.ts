/**
 * The self-report's FOR_USER_* lines read as the task's status report
 * (readStatusReport in src/core/session-hooks/builtins.ts), the words the Board, the Org
 * page and the phone show beside the facts. No state is ever guessed: a report without
 * FOR_USER_STATE (an older prompt) is no report.
 */
import { describe, it, expect } from 'vitest'
import { FOR_USER_PROMPT, readStatusReport } from '../../src/core/session-hooks/builtins.js'

const AT = new Date('2026-10-26T05:35:00Z')

describe('readStatusReport', () => {
  it('needs-you keeps the ask and the now / next lines, with the time it was read', () => {
    const r = readStatusReport([
      'STATUS: blocked',
      'FOR_USER_STATE: needs-you',
      'FOR_USER_ASK: Approve testing on your real iPhone?',
      'FOR_USER_WAITING_ON: none',
      'FOR_USER_NOW: The build passes on the simulator.',
      'FOR_USER_NEXT: You decide, then I run the device test.',
    ].join('\n'), AT)
    expect(r).toEqual({
      state: 'needs', ask: 'Approve testing on your real iPhone?',
      now: 'The build passes on the simulator.', next: 'You decide, then I run the device test.', at: AT.toISOString(),
    })
  })

  it('waiting splits the kind from on whom; an unknown kind is other', () => {
    expect(readStatusReport('FOR_USER_STATE: waiting\nFOR_USER_WAITING_ON: task: the Bun lead\'s commit', AT))
      .toMatchObject({ state: 'waiting', waiting_kind: 'task', waiting_on: 'the Bun lead\'s commit' })
    expect(readStatusReport('FOR_USER_STATE: waiting\nFOR_USER_WAITING_ON: Machine: 20 GB of free disk', AT))
      .toMatchObject({ waiting_kind: 'machine', waiting_on: '20 GB of free disk' })
    expect(readStatusReport('FOR_USER_STATE: waiting\nFOR_USER_WAITING_ON: the weather', AT))
      .toMatchObject({ waiting_kind: 'other', waiting_on: 'the weather' })
  })

  it('an ask outside needs-you is dropped; none and n/a are no line', () => {
    const r = readStatusReport('FOR_USER_STATE: working\nFOR_USER_ASK: Approve?\nFOR_USER_NOW: n/a\nFOR_USER_NEXT: none', AT)
    expect(r).toEqual({ state: 'working', at: AT.toISOString() })
  })

  it('no state line, or a word that is not a state, is no report', () => {
    expect(readStatusReport('STATUS: done\nRECAP: shipped', AT)).toBeNull()
    expect(readStatusReport('FOR_USER_STATE: blocked', AT)).toBeNull()
  })

  it('a long line is cut to one sentence the Board can show', () => {
    const long = 'word '.repeat(200)
    const r = readStatusReport(`FOR_USER_STATE: done\nFOR_USER_NOW: ${long}`, AT)
    expect((r?.now ?? '').length).toBeLessThanOrEqual(240)
  })

  it('the prompt asks for plain words and names the four states', () => {
    expect(FOR_USER_PROMPT).toContain('needs-you | working | waiting | done')
    expect(FOR_USER_PROMPT).toMatch(/no codenames, abbreviations/)
  })
})
