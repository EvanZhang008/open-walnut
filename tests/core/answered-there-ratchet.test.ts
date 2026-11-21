/**
 * An ask about a place outside Walnut is read there again, the user's own replies included, before
 * it is asked, reworded or kept (src/core/answered-there.ts; 2026-11-20: a Slack monitor task asked
 * the user for two hours what he had already answered in the same DM).
 *
 * Every reader of the rule is listed here: the charter every task and lead gets, the needs re-check,
 * the letter re-check and the overdue check of a thread waiting on him. A reader that loses the rule
 * fails, and so does a rule that loses the words that make it work.
 */
import { describe, it, expect } from 'vitest'
import { ANSWERED_THERE_MARKS, ANSWERED_THERE_RECHECK, ANSWERED_THERE_RULE } from '../../src/core/answered-there.js'
import { TEAM_CHARTER } from '../../src/core/team-charter.js'
import { recheckBody } from '../../src/core/sessions/needs-recheck.js'
import { letterRecheckBody } from '../../src/core/sessions/letter-recheck.js'
import { threadRecheckBody, threadsDueRecheck } from '../../src/core/org/thread-recheck.js'
import { NEEDS_QUIET_MS } from '../../src/core/org/thread-view.js'
import { emptyThreads, openThread } from '../../src/core/org/threads-model.js'
import type { LetterRecord } from '../../src/core/human-inbox/types.js'

const T0 = Date.parse('2026-11-20T19:00:00Z')

describe('the answered-there rule', () => {
  it('names the places, the user\'s own messages, and dropping the ask', () => {
    for (const text of [ANSWERED_THERE_RULE, ANSWERED_THERE_RECHECK]) {
      for (const mark of ANSWERED_THERE_MARKS) expect(text).toContain(mark)
      expect(text).toMatch(/Slack/)
      expect(text).toMatch(/mail thread/)
    }
    expect(ANSWERED_THERE_RULE).toMatch(/drop the ask/)
    expect(ANSWERED_THERE_RULE).toMatch(/Ask the user each thing once/)
    expect(ANSWERED_THERE_RULE).toMatch(/A question reads on its own/)
    expect(ANSWERED_THERE_RULE).toMatch(/reviewer subagent on another model/)
    expect(ANSWERED_THERE_RULE).toMatch(/first sentence says what they decide and what you recommend/)
    expect(ANSWERED_THERE_RULE).toMatch(/follows from what they already agreed to .* is yours: do it, then tell them/)
    expect(ANSWERED_THERE_RECHECK).toMatch(/close the thread or set it answered/)
  })

  it('is a bullet of the charter every task and lead gets', () => {
    expect(TEAM_CHARTER).toContain(`- ${ANSWERED_THERE_RULE}`)
    expect(TEAM_CHARTER).toContain('and did they already agree to it? If yes, decide.')
  })

  it('rides the needs re-check', () => {
    expect(recheckBody('Pick 4:00 or 4:30 for the meeting move', new Date(T0 - 5 * 3_600_000).toISOString(), T0)).toContain(ANSWERED_THERE_RECHECK)
  })

  it('rides the letter re-check', () => {
    const letter = { id: 'lt-1', subject: 'Move the meeting?' } as LetterRecord
    expect(letterRecheckBody([letter], T0, () => T0 - 5 * 3_600_000)).toContain(ANSWERED_THERE_RECHECK)
  })

  it('rides the overdue check of a thread that waits on him, and only that one', () => {
    const f = openThread(emptyThreads('vp'), {
      title: 'Meeting move', text: 'Which time?', from: 'node', user_kind: 'user_own', user_kind_why: 'Only he can answer a colleague in his name',
    }, 'task:vp', new Date(T0).toISOString()).file
    const due = threadsDueRecheck(f.threads, T0 + NEEDS_QUIET_MS)
    expect(due.map((d) => d.overdue.why)).toEqual(['needs'])
    expect(threadRecheckBody(due, T0 + NEEDS_QUIET_MS)).toContain(ANSWERED_THERE_RECHECK)
    const reply = due.map((d) => ({ ...d, overdue: { ...d.overdue, why: 'reply' as const } }))
    expect(threadRecheckBody(reply, T0 + NEEDS_QUIET_MS)).not.toContain(ANSWERED_THERE_RECHECK)
  })
})
