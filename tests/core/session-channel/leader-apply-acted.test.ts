/**
 * The one rule of leader-apply.ts actedOnAlready: a host's record this leader has nothing left to act
 * on is applied and never said on its bus. A fact the host kept while it stood down for an older
 * leader (`judgedBy: 'leader'`, fact-log.ts) is such a record: that leader acted on the turn itself,
 * so no turn-end consumer (usage, triage, notices, session:ended, the queue, the phase) runs for it
 * again here, and its turn end only supersedes an older phase mark (turn-ends.ts). A record a link
 * before this one applied is the other kind, as before.
 */
import { describe, expect, it } from 'vitest'
import { STARTED_SLACK_MS, actedOnAlready, createLeaderApply, markOf } from '../../../src/core/session-channel/leader-apply.js'
import type { AppliedFact } from '../../../src/core/session-channel/channel.js'

const HOST = 'devbox'
const SID = '11111111-1111-4111-8111-111111111111'

function rec(seq: number, name: string, data: Record<string, unknown>, extra: Partial<AppliedFact> = {}): AppliedFact {
  return { v: 2, seq, opId: `sf-L-${seq}`, rev: 1, at: 1_000 + seq, kind: 'session-fact', sid: SID, sseq: seq, name, data, late: false, happenedAt: 1_000 + seq, ...extra } as AppliedFact
}

function harness(appliedBefore = 0) {
  const said: Array<{ name: string; result?: unknown }> = []
  const batches: Array<{ turnEnds?: Array<{ sid: string; edge: string | null; seq: number }> }> = []
  const logs: string[] = []
  const deps = {
    applyBatch: async (b: { turnEnds?: Array<{ sid: string; edge: string | null; seq: number }> }) => { batches.push(b); return { written: [SID], after: appliedBefore } },
    noteHostJudged: () => {}, noteLive: () => {}, noteRename: () => {}, log: (_level: string, msg: string) => { logs.push(msg) },
    ownerOf: () => HOST,
    emit: (name: string, data: unknown) => { said.push({ name, result: (data as { result?: unknown } | null)?.result }) },
  }
  const apply = createLeaderApply(deps as never, { askResync: () => {}, refuseRevoked: () => {}, isRevoked: () => false, taskOf: () => 'task-1' })
  return { apply, said, batches, logs }
}

describe('a turn end the other judge acted on is acted on once', () => {
  it('the rule: applied before, or a bus fact judged by the leader the host stood down for, before this process', () => {
    const started = 1_000_000
    const fact = { seq: 3, name: 'session:result', happenedAt: started - 60_000 }
    expect(actedOnAlready(fact, 0, started)).toBe(false)
    expect(actedOnAlready({ ...fact, judgedBy: 'leader' }, 0, started)).toBe(true)
    expect(actedOnAlready(fact, 3, started)).toBe(true)
    expect(actedOnAlready({ ...fact, seq: 4 }, 3, started)).toBe(false)
    // S1: a mark of this process's time (a misjudged stand-down) is not honoured, nor one with no time.
    expect(actedOnAlready({ ...fact, judgedBy: 'leader', happenedAt: started + 1 }, 0, started)).toBe(false)
    expect(actedOnAlready({ ...fact, judgedBy: 'leader', happenedAt: started - 1_000 }, 0, started)).toBe(false)
    expect(actedOnAlready({ seq: 3, name: 'session:result', judgedBy: 'leader' }, 0, started)).toBe(false)
    expect(markOf({ ...fact, judgedBy: 'leader', happenedAt: started + 1 }, started)).toBe('this-leader')
    // N4: the old leader's link did not close cleanly, so the host still read it answering for the quiet
    // window after it went away: a turn that ended in the 30 s before this process started is acted on
    // here (a duplicate at worst, never a loss). One older than the slack is honoured.
    expect(STARTED_SLACK_MS).toBeGreaterThanOrEqual(30_000 + 5_000)
    for (const ago of [1, 10_000, 29_999, 30_000, STARTED_SLACK_MS]) {
      expect(markOf({ ...fact, judgedBy: 'leader', happenedAt: started - ago }, started)).toBe('this-leader')
    }
    expect(markOf({ ...fact, judgedBy: 'leader', happenedAt: started - STARTED_SLACK_MS - 1 }, started)).toBe('honoured')
    // N1: the mark means something on a bus fact only.
    for (const name of ['row', 'rename', 'drop', 'live']) expect(markOf({ ...fact, name, judgedBy: 'leader' }, started)).toBe('none')
  })

  it('a mark of this leader\'s own time: the fact is said, its turn end keeps its phase edge, and it is logged', async () => {
    const h = harness()
    const now = Date.now()
    await h.apply.applyRecs(HOST, [rec(1, 'session:result', { sessionId: SID, result: 'misjudged' }, { judgedBy: 'leader', happenedAt: now })], { logId: 'L', seq: 1 })
    expect(h.said).toEqual([{ name: 'session:result', result: 'misjudged' }])
    expect(h.batches[0].turnEnds).toEqual([{ sid: SID, edge: 'session:result', seq: 1 }])
    expect(h.logs.some((l) => l.includes('as judged by an older leader'))).toBe(true)
  })

  it('facts of a stand-down are applied and never said; their turn end marks no phase; the turn after is said once', async () => {
    const h = harness()
    await h.apply.applyRecs(HOST, [
      rec(1, 'session:user-line', { sessionId: SID, text: 'older' }, { judgedBy: 'leader' }),
      rec(2, 'session:result', { sessionId: SID, result: 'judged by the older leader' }, { judgedBy: 'leader' }),
      rec(3, 'session:batch-completed', { sessionId: SID }, { judgedBy: 'leader' }),
      rec(4, 'session:ended', { sessionId: SID }, { judgedBy: 'leader' }),
      rec(5, 'session:result', { sessionId: SID, result: 'after the upgrade' }),
    ], { logId: 'L', seq: 5 })
    expect(h.said).toEqual([{ name: 'session:result', result: 'after the upgrade' }])
    expect(h.batches[0].turnEnds).toEqual([
      { sid: SID, edge: null, seq: 2 },
      { sid: SID, edge: 'session:result', seq: 5 },
    ])
  })

  it('a record a link before this one applied is not said again (the same rule)', async () => {
    const h = harness(5)
    await h.apply.applyRecs(HOST, [rec(5, 'session:result', { sessionId: SID, result: 'said by the link before' }), rec(6, 'session:result', { sessionId: SID, result: 'new' })], { logId: 'L', seq: 6 })
    expect(h.said).toEqual([{ name: 'session:result', result: 'new' }])
  })
})
