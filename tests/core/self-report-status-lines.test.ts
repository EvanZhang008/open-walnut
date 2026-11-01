/**
 * The self-report's FOR_USER_* lines read as the task's status report
 * (readStatusReport in src/core/session-hooks/builtins.ts), the words the Board, the Org
 * page and the phone show beside the facts. No state is ever guessed: a report without
 * FOR_USER_STATE (an older prompt) is no report.
 */
import { describe, it, expect } from 'vitest'
import { FOR_USER_PROMPT, readStatusReport } from '../../src/core/session-hooks/builtins.js'
import { deriveUserStatus } from '../../src/core/user-status.js'
import { phaseForReport } from '../../src/core/sessions/report-phase.js'

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
    expect(readStatusReport('FOR_USER_STATE: waiting\nFOR_USER_WAITING_ON: outside: the CI run on main', AT))
      .toMatchObject({ waiting_kind: 'outside', waiting_on: 'the CI run on main' })
    // "user:" is the user, the same as "you:".
    expect(readStatusReport('FOR_USER_STATE: waiting\nFOR_USER_WAITING_ON: user: the meeting notes', AT))
      .toMatchObject({ waiting_kind: 'you', waiting_on: 'the meeting notes' })
  })

  // 2026-11-01: a worker wrote its kind with a full-width colon (CJK words), it read as "other",
  // and its "waits for your call" words made a wait on its lead Needs you.
  it('a full-width colon after the kind splits it too, and that wait on the lead is no wait on the user', () => {
    const r = readStatusReport('FOR_USER_STATE: waiting\nFOR_USER_WAITING_ON: lead\uff1a\u4e0a\u7ea7\u4efb\u52a1\u4f1a\u628a\u95ee\u9898\u8f6c\u7ed9\u4f60\uff0c\u7b49\u4f60\u62cd\u677f', AT)
    expect(r).toMatchObject({ waiting_kind: 'lead', waiting_on: '\u4e0a\u7ea7\u4efb\u52a1\u4f1a\u628a\u95ee\u9898\u8f6c\u7ed9\u4f60\uff0c\u7b49\u4f60\u62cd\u677f' })
    expect(readStatusReport('FOR_USER_STATE: waiting\nFOR_USER_WAITING_ON: task\uff1a the review', AT)).toMatchObject({ waiting_kind: 'task', waiting_on: 'the review' })
  })

  // 2026-11-01: two workers answered needs-you with an "ask" only their lead could do ("lead: merge
  // and deploy it on the Mac"), and it read Needs you. Any ask that names another's kind is a wait on it.
  it('an ask addressed to its lead or another task is a wait on it, never an ask of the user', () => {
    for (const kind of ['lead', 'task', 'outside', 'machine']) {
      for (const colon of [':', '\uff1a']) {
        const r = readStatusReport(`FOR_USER_STATE: needs-you\nFOR_USER_ASK: ${kind}${colon} merge and deploy it on the Mac\nFOR_USER_NOW: Fixed and tested.\nFOR_USER_NEXT: The lead lands it.`, AT)
        expect(r, `${kind}${colon}`).toEqual({
          state: 'waiting', waiting_kind: kind, waiting_on: 'merge and deploy it on the Mac',
          now: 'Fixed and tested.', next: 'The lead lands it.', at: AT.toISOString(),
        })
      }
    }
    // Its own wait line, when it names one, says on what.
    expect(readStatusReport('FOR_USER_STATE: needs-you\nFOR_USER_ASK: lead: land it\nFOR_USER_WAITING_ON: lead: the land and the rerun on the Mac', AT))
      .toMatchObject({ state: 'waiting', waiting_kind: 'lead', waiting_on: 'the land and the rerun on the Mac' })
    // A wait line of another kind does not lend its words to this one.
    expect(readStatusReport('FOR_USER_STATE: needs-you\nFOR_USER_ASK: lead: land it\nFOR_USER_WAITING_ON: outside: the CI run', AT))
      .toMatchObject({ state: 'waiting', waiting_kind: 'lead', waiting_on: 'land it' })
    // An ask of the user stays one, also "you:".
    expect(readStatusReport('FOR_USER_STATE: needs-you\nFOR_USER_ASK: you: approve the merge?', AT)).toMatchObject({ state: 'needs', ask: 'you: approve the merge?' })
    expect(FOR_USER_PROMPT).toMatch(/Never a step for your lead or another task/)
    // A task with no lead: the one above it is the user, so the same words still ask them.
    const r = readStatusReport('FOR_USER_STATE: needs-you\nFOR_USER_ASK: lead: merge it', AT)!
    expect(phaseForReport(r, {}, true)).toBe('NEED_ACTION')
    expect(deriveUserStatus({ phase: 'NEED_ACTION', report: r, hasSession: true, processStatus: 'idle', phaseChangedAt: new Date(AT.getTime() - 60_000).toISOString() }, AT.getTime() + 1_000))
      .toMatchObject({ state: 'needs', ask: 'merge it' })
    expect(phaseForReport(r, { parent_task_id: 'p' }, true)).toBe('WAITING')
    // Parked anyway (an unrelated armed trigger): still the user's ask, never Waiting on a lead it lacks.
    expect(phaseForReport(r, {}, true, true)).toBe('WAITING')
    expect(deriveUserStatus({ phase: 'WAITING', report: r, hasSession: true, processStatus: 'idle', phaseChangedAt: new Date(AT.getTime() - 60_000).toISOString() }, AT.getTime() + 1_000))
      .toMatchObject({ state: 'needs', ask: 'merge it' })
    // A lead's own "lead:" wait is no question to the user in its chat.
    expect(deriveUserStatus({ phase: 'NEED_ACTION', isLead: true, report: r, hasSession: true, processStatus: 'idle', phaseChangedAt: new Date(AT.getTime() - 60_000).toISOString() }, AT.getTime() + 1_000))
      .toMatchObject({ state: 'waiting', waitingOn: 'Your next message, or news from its teams' })
  })

  it('the ask says a wait on the user is needs-you, and waiting is only for an outside wait', () => {
    expect(FOR_USER_PROMPT).toContain('a wait on the user is ALWAYS needs-you')
    expect(FOR_USER_PROMPT).toMatch(/waiting ONLY when nothing of this turn is for the user to read and the next move belongs to something outside Walnut and the user/)
    expect(FOR_USER_PROMPT).toContain('<outside | task | lead | machine>')
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
