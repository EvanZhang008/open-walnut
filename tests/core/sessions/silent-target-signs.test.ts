/**
 * The silent-target notice (remindSilent) goes only when a target shows no sign of taking up the
 * work since the ask (targetSignSince, TARGET_SIGNS). 2026-11-07: three notices said "has shown
 * nothing ... its session has not taken up the work" of tasks at work: one whose turn began before
 * the ask and ended 45 minutes after it with a status report naming the ask, and one that had
 * messaged its asker an hour before.
 *
 * Every sign is listed here with facts that show only it; a new sign fails until it is.
 */
import { describe, it, expect } from 'vitest'
import { TARGET_SIGNS, targetSignSince, type TargetFacts, type TargetSign } from '../../../src/core/sessions/session-request-notify.js'
import type { SessionRequest } from '../../../src/core/session-requests.js'

const ASKED = Date.parse('2026-11-07T22:00:00Z')
const iso = (ms: number): string => new Date(ms).toISOString()
const after = iso(ASKED + 30 * 60_000)
const before = iso(ASKED - 30 * 60_000)
const SID = 'target-session'

const row = (over: Partial<SessionRequest>): SessionRequest => ({
  id: 'rq-other', fromSessionId: 'someone', preview: '', status: 'pending', createdAt: before, deadlineAt: ASKED, ...over,
} as SessionRequest)

/** Idle since before the ask: no sign. */
const quiet: TargetFacts = {
  since: ASKED, inTurn: false, processStatus: 'running', turnStartedAt: ASKED - 60 * 60_000,
  report: { at: before, turn_ended_at: before }, taskId: 'target-task', sessionIds: [SID],
  rows: [row({ id: 'rq-this', toTaskId: 'target-task', createdAt: iso(ASKED) })], requestId: 'rq-this',
}

/** Each sign, alone. */
const ONLY: Record<TargetSign, Partial<TargetFacts>> = {
  'a turn running now': { inTurn: true },
  'a turn begun since the ask': { turnStartedAt: ASKED + 60_000 },
  'a turn ended since the ask': { report: { at: before, turn_ended_at: after } },
  'its status report since the ask': { report: { at: after, turn_ended_at: before, by: 'self' } },
  'an answer it sent since the ask': { rows: [...quiet.rows, row({ toTaskId: 'target-task', status: 'replied', settledAt: after })] },
  'a message it sent since the ask': { rows: [...quiet.rows, row({ fromSessionId: SID, toTaskId: 'its-lead', createdAt: after })] },
}

describe('a target at work is never told silent: every sign since the ask counts', () => {
  it('lists every sign', () => {
    expect(Object.keys(ONLY).sort()).toEqual([...TARGET_SIGNS].sort())
  })

  it('with none, it is silent', () => {
    expect(targetSignSince(quiet)).toBeNull()
  })

  for (const sign of TARGET_SIGNS) {
    it(`${sign}: not silent`, () => {
      expect(targetSignSince({ ...quiet, ...ONLY[sign] })).toBe(sign)
    })
  }

  it('the 2026-11-07 case: a turn begun before the ask, ended after it with a report, reads as at work', () => {
    expect(targetSignSince({ ...quiet, turnStartedAt: ASKED - 60_000, report: { at: after, turn_ended_at: after } })).not.toBeNull()
  })

  it('a sign from before the ask, or its own request, says nothing of the ask', () => {
    expect(targetSignSince({ ...quiet, rows: [
      ...quiet.rows,
      row({ fromSessionId: SID, createdAt: before }),
      row({ toTaskId: 'target-task', status: 'replied', settledAt: before }),
    ] })).toBeNull()
    expect(targetSignSince({ ...quiet, rows: [row({ id: 'rq-this', fromSessionId: SID, createdAt: after })] })).toBeNull()
  })

  it('a line a person or another task set, or Walnut asking an idle session, is not the target at work', () => {
    // report-set dates both fields when the setter sets the line.
    expect(targetSignSince({ ...quiet, report: { at: after, turn_ended_at: after, by: 'human' } })).toBeNull()
    expect(targetSignSince({ ...quiet, report: { at: after, turn_ended_at: after, by: 'task:its-lead' } })).toBeNull()
    // A status ask answered between turns: a new `at`, the last turn's end unchanged.
    expect(targetSignSince({ ...quiet, report: { at: after, turn_ended_at: before } })).toBeNull()
  })

  it('a process not running, or an unknown runner of a stopped one, is no turn', () => {
    expect(targetSignSince({ ...quiet, processStatus: 'error', inTurn: false })).toBeNull()
    expect(targetSignSince({ ...quiet, processStatus: 'stopped', inTurn: null })).toBeNull()
    // Running with no runner here: it may be in a turn, as before.
    expect(targetSignSince({ ...quiet, inTurn: null })).toBe('a turn running now')
  })
})
