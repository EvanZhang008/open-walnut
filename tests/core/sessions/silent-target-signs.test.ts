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
import { TARGET_SIGNS, isResendOf, targetSignSince, type TargetFacts, type TargetSign } from '../../../src/core/sessions/session-request-notify.js'
import type { SessionRequest } from '../../../src/core/session-requests.js'

const ASKED = Date.parse('2026-11-07T22:00:00Z')
const iso = (ms: number): string => new Date(ms).toISOString()
const after = iso(ASKED + 30 * 60_000)
const before = iso(ASKED - 30 * 60_000)
const SID = 'target-session'
const ASK = 'Look at the 11-07 load spikes on the Mac and say what caused them.'

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
  'the ask reached its session': { rows: [row({ id: 'rq-this', toTaskId: 'target-task', createdAt: iso(ASKED), reachedAt: iso(ASKED + 3_000) })] },
  'it has an earlier ask of the same asker': {
    rows: [
      row({ id: 'rq-first', fromSessionId: 'asker', toTaskId: 'target-task', createdAt: before, reachedAt: before, preview: ASK }),
      row({ id: 'rq-this', fromSessionId: 'asker', toTaskId: 'target-task', createdAt: iso(ASKED), preview: ASK }),
    ],
  },
  'its host says it is at work': { host: { alive: true, working: true } },
  'a turn running now': { inTurn: true },
  'work of it running after its turn': { outliving: ['background'] },
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

  it('2026-11-07 23:47: idle between turns, background jobs and a review running, a turn ended after the ask', () => {
    const askedAt = Date.parse('2026-11-07T22:32:18Z')
    const facts: TargetFacts = {
      since: askedAt, inTurn: false, processStatus: 'running', outliving: ['background'],
      report: { at: '2026-11-07T23:46:43Z', turn_ended_at: '2026-11-07T23:46:29Z' }, taskId: 'target-task', sessionIds: [SID],
      rows: [row({ id: 'rq-this', toTaskId: 'target-task', createdAt: iso(askedAt) }), row({ fromSessionId: SID, toTaskId: 'its-reviewer', createdAt: '2026-11-07T23:44:51Z' })],
      requestId: 'rq-this',
    }
    expect(targetSignSince(facts)).not.toBeNull()
    // Each of them alone keeps it from reading silent.
    expect(targetSignSince({ ...facts, report: { at: before, turn_ended_at: before }, rows: facts.rows.slice(0, 1) })).toBe('work of it running after its turn')
    expect(targetSignSince({ ...facts, outliving: [], rows: facts.rows.slice(0, 1) })).toBe('a turn ended since the ask')
    expect(targetSignSince({ ...facts, outliving: [], report: { at: before, turn_ended_at: before } })).toBe('a message it sent since the ask')
    // A /loop between its fires runs nothing.
    expect(targetSignSince({ ...quiet, outliving: ['loop'] })).toBeNull()
  })

  it('2026-11-07 23:39: idle, with the review round it sent out after the ask', () => {
    const askedAt = Date.parse('2026-11-07T22:32:11Z')
    expect(targetSignSince({
      ...quiet, since: askedAt, processStatus: 'idle', inTurn: null, turnStartedAt: undefined, report: undefined,
      rows: [
        row({ id: 'rq-this', toTaskId: 'target-task', createdAt: iso(askedAt) }),
        row({ fromSessionId: SID, toTaskId: 'its-reviewer', status: 'replied', createdAt: '2026-11-07T23:01:42Z' }),
        row({ fromSessionId: SID, toTaskId: 'its-reviewer', createdAt: '2026-11-07T23:36:06Z' }),
      ],
    })).toBe('a message it sent since the ask')
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

  it('2026-11-08 04:57: read in 10 s and mid-turn, but the restarted server\'s runner read no turn', () => {
    // rq-20eca396c5e9: asked 04:02:13, read 04:02:22, one turn until 05:43. The runner, reattached
    // after a restart and then a dropped daemon link, said not in a turn; no report was written.
    const askedAt = Date.parse('2026-11-08T04:02:13Z')
    const stale: TargetFacts = {
      since: askedAt, inTurn: false, processStatus: 'running', outliving: [], taskId: 'target-task', sessionIds: [SID],
      rows: [row({ id: 'rq-this', fromSessionId: 'asker', toTaskId: 'target-task', createdAt: iso(askedAt) })], requestId: 'rq-this',
    }
    // What the server held then: no sign at all. Its host still knew.
    expect(targetSignSince(stale)).toBeNull()
    expect(targetSignSince({ ...stale, host: { alive: true, working: true } })).toBe('its host says it is at work')
    // Now the delivery stamps the request, which no restart forgets.
    expect(targetSignSince({ ...stale, rows: [{ ...stale.rows[0], reachedAt: '2026-11-08T04:02:16Z' }] })).toBe('the ask reached its session')
  })

  it('2026-11-08 05:43: a resend while the target works on the first ask is never told "not taken"', () => {
    // rq-9df5f31752c5: the same asker resent at 04:58:50; the record read stopped after a dropped daemon link.
    const first = row({ id: 'rq-first', fromSessionId: 'asker', toTaskId: 'target-task', createdAt: '2026-11-08T04:02:13Z', reachedAt: '2026-11-08T04:02:16Z', preview: ASK })
    const resend = row({ id: 'rq-this', fromSessionId: 'asker', toTaskId: 'target-task', createdAt: '2026-11-08T04:58:50Z', preview: ASK })
    const facts: TargetFacts = {
      since: Date.parse(resend.createdAt), inTurn: false, processStatus: 'stopped', outliving: [], taskId: 'target-task',
      sessionIds: [SID], rows: [first, resend], requestId: 'rq-this',
    }
    expect(targetSignSince(facts)).toBe('it has an earlier ask of the same asker')
    // Another asker's earlier ask, one the target never got, or one asked after it, is not that.
    expect(targetSignSince({ ...facts, rows: [{ ...first, fromSessionId: 'someone-else' }, resend] })).toBeNull()
    expect(targetSignSince({ ...facts, rows: [{ ...first, reachedAt: undefined }, resend] })).toBeNull()
    expect(targetSignSince({ ...facts, rows: [{ ...first, createdAt: '2026-11-08T05:00:00Z' }, resend] })).toBeNull()
    // An earlier ask already settled before this one is a closed matter.
    expect(targetSignSince({ ...facts, rows: [{ ...first, status: 'replied', settledAt: '2026-11-08T04:30:00Z' }, resend] })).toBeNull()
  })

  // Review of 2026-11-09: the earlier ask speaks only for a resend, never for an independent ask.
  it('an independent new ask of the same asker is not a resend; a resend in other words around the same ask is', () => {
    const first = row({ id: 'rq-first', fromSessionId: 'asker', toTaskId: 'target-task', createdAt: before, reachedAt: before, preview: ASK })
    const facts = (preview: string): TargetFacts => ({ ...quiet, rows: [first, row({ id: 'rq-this', fromSessionId: 'asker', toTaskId: 'target-task', createdAt: iso(ASKED), preview })] })
    expect(targetSignSince(facts('Also rotate the disk logs on the build box.'))).toBeNull()
    expect(targetSignSince(facts(`Resending in case it was lost: ${ASK}`))).toBe('it has an earlier ask of the same asker')
    expect(isResendOf(`${ASK.slice(0, 40)}\u2026`, ASK)).toBe(true)
    expect(isResendOf('  look AT the 11-07 load spikes on the mac and say what caused them. ', ASK)).toBe(true)
    // A short line inside a long one proves nothing.
    expect(isResendOf('the Mac', ASK)).toBe(false)
    expect(isResendOf('', '')).toBe(false)
  })

  it('a stamp whose queue row waits to go out again (taken back, unread) is no sign, for this ask or an earlier one', () => {
    const self = row({ id: 'rq-this', fromSessionId: 'asker', toTaskId: 'target-task', createdAt: iso(ASKED), reachedAt: iso(ASKED + 3_000), messageId: 'qm-this', preview: ASK })
    expect(targetSignSince({ ...quiet, rows: [self] })).toBe('the ask reached its session')
    expect(targetSignSince({ ...quiet, rows: [self], takenBack: new Set(['qm-this']) })).toBeNull()
    const first = row({ id: 'rq-first', fromSessionId: 'asker', toTaskId: 'target-task', createdAt: before, reachedAt: before, messageId: 'qm-first', preview: ASK })
    const resend = { ...self, reachedAt: undefined, messageId: 'qm-resend' }
    expect(targetSignSince({ ...quiet, rows: [first, resend] })).toBe('it has an earlier ask of the same asker')
    expect(targetSignSince({ ...quiet, rows: [first, resend], takenBack: new Set(['qm-first']) })).toBeNull()
  })

  it('the host saying idle or stopped is no sign, and neither is a host that does not answer', () => {
    expect(targetSignSince({ ...quiet, host: { alive: true, working: false } })).toBeNull()
    expect(targetSignSince({ ...quiet, host: { alive: false, working: false } })).toBeNull()
    expect(targetSignSince({ ...quiet, host: null })).toBeNull()
  })

  it('a process not running, or an unknown runner of a stopped one, is no turn', () => {
    expect(targetSignSince({ ...quiet, processStatus: 'error', inTurn: false })).toBeNull()
    expect(targetSignSince({ ...quiet, processStatus: 'stopped', inTurn: null })).toBeNull()
    // Running with no runner here: it may be in a turn, as before.
    expect(targetSignSince({ ...quiet, inTurn: null })).toBe('a turn running now')
  })
})
