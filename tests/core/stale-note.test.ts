/**
 * A task's own close is asked once to update a note that still reads as unfinished, and a message
 * that asks for a decision is named back to its sender (src/core/sessions/stale-note.ts; 2026-11-11,
 * a VP's daily reflection: four COMPLETE tasks in two days still said "[WAIT] plugin release",
 * "[WIP] review is running", "[WAIT] next rule", and one buried a real "you decide" in its note and
 * in a reply to another task, where neither its lead nor the user saw it).
 *
 * A corpus of open and closed lines: a new phrase that should count, or a closed line read as open,
 * fails here. The four cases are kept in their shape (their wording made generic).
 */
import { describe, expect, it } from 'vitest'
import { asksToDecide, openNoteLines, readsUnfinished, userQuestionIn } from '../../src/core/sessions/stale-note.js'
import { admitOwnNote } from '../../src/core/sessions/owed-to-user.js'
import { asksDecisionLine } from '../../src/ops/work.js'

const note = (summary: string, progress: string, rest = '') =>
  `## Executive Summary\n${summary}\n\n## User Request\nMake it work. Waiting for nothing. You decide the details.\n\n## Progress\n${progress}\n\n## Work Log\n- did: waited for the review, it is pending no more; the build is running again later\n${rest}`

/** The four COMPLETE tasks of 2026-11-10/11, in their shape. */
const CASES: Record<string, { note: string; lines: string[] }> = {
  'plugin release': {
    note: note(
      'Phase 1 and 2 shipped. Phase 3, pushed and waiting for the plugin build: the server now starts in 5 to 7 s.',
      '- [DONE] Phase 1: wrapper, tests, review, pushed\n- [DONE] Phase 3 fix pushed\n- [WAIT] New plugin version publish, then the plugin update, then confirm the config carries the arg\n- [TODO] Live timing from ~ and /tmp with the installed plugin, reply to the lead, complete the task',
    ),
    lines: [
      'Phase 3, pushed and waiting for the plugin build: the server now starts in 5 to 7 s.',
      '[WAIT] New plugin version publish, then the plugin update, then confirm the config carries the arg',
      '[TODO] Live timing from ~ and /tmp with the installed plugin, reply to the lead, complete the task',
    ],
  },
  'review in progress': {
    note: note(
      'The hook now refuses commit and push in the shared checkout.',
      '- [DONE] Refusal layer in the deny hook\n- [DONE] Tests: the full suite passes, 457 of 457.\n- [WIP] Independent review is running.\n- [TODO] Fix the review findings, rerun the tests, commit only my hunks, push, reply to the lead.',
    ),
    lines: [
      '[WIP] Independent review is running.',
      '[TODO] Fix the review findings, rerun the tests, commit only my hunks, push, reply to the lead.',
    ],
  },
  'standing task': {
    note: note(
      'Owns the agent rule files and merges each new rule.',
      '- [DONE] Initial handoff: verified existing rules\n- [DONE] Rule 21 propagation: 6 files updated\n- [WAIT] Next rule from monitor — standing task',
    ),
    lines: ['[WAIT] Next rule from monitor — standing task'],
  },
  'buried decision': {
    note: note(
      'The other runner was stopped by its owner and stayed quiet.',
      '- [DONE] Locate the runner\n- [DONE] Confirm it stayed quiet\n- [TODO] You: decide whether the user\'s own runner should keep the three groups it took over as standby.',
    ),
    lines: ['[TODO] You: decide whether the user\'s own runner should keep the three groups it took over as standby.'],
  },
}

describe('a note that still reads as unfinished', () => {
  for (const [name, c] of Object.entries(CASES)) {
    it(`${name}: every open line is named, nothing from the request or the log`, () => {
      expect(openNoteLines(c.note).map((l) => l.text)).toEqual(c.lines)
    })
  }

  it('the buried decision is read as a question, the others as open work', () => {
    expect(openNoteLines(CASES['buried decision'].note).map((l) => l.kind)).toEqual(['question'])
    expect(openNoteLines(CASES['review in progress'].note).map((l) => l.kind)).toEqual(['open', 'open'])
    expect(openNoteLines(CASES['plugin release'].note).map((l) => l.kind)).toEqual(['stale', 'open', 'open'])
  })

  it('a finished note names nothing', () => {
    const done = note(
      'Shipped and live on prod; the review passed after two rounds. No longer waiting for the plugin: it was published.',
      '- [DONE] Fix landed\n  - waiting for CI was the slow part\n- [DONE] Review passed\n- **[DONE]** Prod check: the page shows the new row',
    )
    expect(openNoteLines(done)).toEqual([])
    expect(openNoteLines('')).toEqual([])
    expect(openNoteLines(null)).toEqual([])
  })

  it('a note without the usual sections is read only for its labels', () => {
    expect(openNoteLines('Some plan.\nWaiting for the build.\n- [TODO] Ship it\n- [DONE] Write it').map((l) => l.text)).toEqual(['[TODO] Ship it'])
  })

  it('labels in any spelling the Progress contract tolerates', () => {
    const lines = openNoteLines(note('Done.', '- **[WIP]** one\n* [todo]: two\n1. [BLOCKED] three\n[Waiting] four\n- [in progress] five'))
    expect(lines.map((l) => l.text)).toEqual(['[WIP] one', '[TODO] two', '[BLOCKED] three', '[WAITING] four', '[IN PROGRESS] five'])
  })

  it('quoted lines and code are someone else\'s words', () => {
    const quoted = note('Done. The bug: the card said "waiting for you" forever.', '- [DONE] fix\n\n> [TODO] the user\'s own list\n```\n[WIP] log output\n```')
    expect(openNoteLines(quoted)).toEqual([])
  })
})

/** Open and closed sentences, each read on its own. */
const UNFINISHED = [
  'Phase 3, pushed and waiting for the plugin build.',
  'Awaiting review from the lead.',
  'The deploy is pending.',
  'Investigation is in progress.',
  'A final review and the quick tests are running, then commit and land.',
  'The fix is under review.',
  'Not yet deployed.',
  'Still to do: the prod check.',
  'Left to do: the reply to the lead.',
  'Next: land it and check prod.',
  'Still waiting on the controller logs.',
  'The PR was posted, awaiting review.',
]
const FINISHED = [
  'Shipped and checked on prod.',
  'No longer waiting for the plugin.',
  'Nothing pending.',
  'The task was stuck In Progress before the fix.',
  'The draft was pending, then landed.',
  'After waiting for the build, it passed.',
  'The review passed; tests 312 of 312.',
  'The page now says "pending" for a queued row.',
  'Next: none, the task is complete.',
  'Remaining: nothing.',
  'Next steps: n/a.',
  '0 pending, 312 passed.',
  'Fixed the pending-selection bug; tests pass.',
  'Next: no further work.',
]

describe('the phrase list', () => {
  for (const s of UNFINISHED) it(`unfinished: ${s}`, () => expect(readsUnfinished(s)).toBe(true))
  for (const s of FINISHED) it(`finished: ${s}`, () => expect(readsUnfinished(s)).toBe(false))
})

const DECISIONS = [
  'You decide: ship as is (my recommendation) or wait one day.',
  'Your call on the naming.',
  'It is up to you whether we keep it.',
  'Do you want me to unsubscribe them?',
  'Would you like me to land it now?',
  'Shall I push it?',
  'This needs your decision before Friday.',
  'It waits for the user to pick one of three mockups.',
  '\u4f60\u6765\u51b3\u5b9a\u5427\u3002', // "you decide"
  '\u8981\u4e0d\u8981\u53d6\u6d88\u8ba2\u9605\uff1f', // "unsubscribe or not?"
  '\u662f\u5426\u9700\u8981\u6211\u5148\u53d1\u5e03\uff1f', // "do you need me to publish first?"
  '\u8fd9\u4e2a\u9700\u8981\u4f60\u786e\u8ba4\u3002', // "this needs your confirmation"
]
const NOT_DECISIONS = [
  'I decided to keep it.',
  'The lead decided: ship it.',
  'Decision: B, decided by the lead.',
  'The user picked A yesterday.',
  'The button reads "Your call".',
  'You, the lead, already have the logs.',
  'Applied your decision: kept the groups.',
  'Done per your call.',
  'Should I also update the docs?',
  'You: see the attached report.',
  'I asked myself why should I retry, and the answer was the lock.',
  '\u5df2\u7ecf\u51b3\u5b9a\u4e86\u3002', // "already decided"
]

describe('a line that asks for a decision', () => {
  for (const s of DECISIONS) it(`asks: ${s}`, () => expect(asksToDecide(s)).toBe(true))
  for (const s of NOT_DECISIONS) it(`does not ask: ${s}`, () => expect(asksToDecide(s)).toBe(false))

  it('a message: the first asking sentence, from the sender\'s own words only', () => {
    expect(userQuestionIn('The fix is on prod. Two tests flake.\nYou decide: ship as is or wait a day. Logs: x.log')).toBe('You decide: ship as is or wait a day.')
    expect(userQuestionIn('> You decide (the user wrote this)\nDone, shipped.')).toBeUndefined()
    expect(userQuestionIn('```\nshould i retry? [y/N]\n```\nDone.')).toBeUndefined()
    expect(userQuestionIn('Done.', undefined, ['Whether to keep the groups: your call'])).toBe('Whether to keep the groups: your call')
    expect(userQuestionIn('All done, nothing open.')).toBeUndefined()
  })

  it('the line the sender reads back names it and both ways on', () => {
    const line = asksDecisionLine('You decide: keep the groups or unsubscribe them')
    expect(line).toContain('"You decide: keep the groups or unsubscribe them"')
    expect(line).toMatch(/FOR_USER_ASK/)
    expect(line).toMatch(/task_report_set/)
    expect(line).toMatch(/lead already decided it, drop it/)
  })
})

describe('the own-close gate asks once', () => {
  it('names the lines, then lets the same lines through', async () => {
    const t = { id: 'stale-once-1', note: CASES['review in progress'].note }
    const first = await admitOwnNote(t)
    expect(first.ok).toBe(false)
    if (first.ok) return
    expect(first.code).toBe('stale_note')
    expect(first.items.map((i) => i.text)).toEqual(CASES['review in progress'].lines)
    expect(first.message).toContain('1) [WIP] Independent review is running; 2) [TODO] Fix the review findings')
    expect(first.message).toMatch(/task_note_write/)
    expect(first.message).toMatch(/not_done/)
    expect((await admitOwnNote(t)).ok).toBe(true)
    // Still told: a close retried after it failed on its own (a sync push) is not asked again.
    expect((await admitOwnNote(t)).ok).toBe(true)
  })

  it('a new open line is asked about again; an updated note goes through', async () => {
    const t = { id: 'stale-once-2', note: CASES['standing task'].note }
    expect((await admitOwnNote(t)).ok).toBe(false)
    const more = note('Owns the agent rule files.', '- [WAIT] Next rule from monitor — standing task\n- [TODO] One more thing')
    expect((await admitOwnNote({ ...t, note: more })).ok).toBe(false)
    expect((await admitOwnNote({ ...t, note: more })).ok).toBe(true)
    expect((await admitOwnNote({ ...t, note: note('All done.', '- [DONE] everything') })).ok).toBe(true)
  })

  it('a buried decision says how to ask it; a close bringing not_done goes through at once', async () => {
    const t = { id: 'stale-once-3', note: CASES['buried decision'].note }
    const first = await admitOwnNote(t)
    expect(first.ok).toBe(false)
    if (!first.ok) expect(first.message).toMatch(/make it your own ask \(FOR_USER_ASK/)
    expect((await admitOwnNote({ id: 'stale-once-4', note: t.note }, { not_done: ['Whether to keep the groups is the user\'s call'] } as never)).ok).toBe(true)
  })
})
