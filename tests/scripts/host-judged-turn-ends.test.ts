/**
 * The host-judged rollback rehearsal's accounting of what a newer leader owes after an upgrade
 * (scripts/release-rehearsal/host-judged-turn-ends.mjs). The records are shaped as a real run's
 * (2026-11-25, 0.6.37 as the older leader): a turn end held while the host stood down is said
 * again as a second record of the same turn end, and a marked fact inside the new leader's start
 * slack is acted on again by design (leader-apply.ts markOf).
 */
import { describe, expect, it } from 'vitest'
import { markOf, owedOf } from '../../scripts/release-rehearsal/host-judged-turn-ends.mjs'

const START = 1_000_000
const proc = { startedAt: START, startedSlackMs: 11_000 }
let seq = 0
const rec = (name: string, at: number, data: Record<string, unknown> = {}, judgedBy?: 'leader') =>
  ({ seq: ++seq, opId: `o${seq}`, at: START + at, sid: 's', sseq: seq, name, data: { sessionId: 's', ...data }, ...(judgedBy ? { judgedBy } : {}) })
const result = (text: string, extra: Record<string, unknown> = {}) => ({ isError: false, result: text, hostTakenBy: null, ...extra })

describe('owedOf', () => {
  it('a turn end held while no leader answered and its said-again record are one turn end, acted on once by the new leader', () => {
    const recs = [
      rec('session:usage-update', -129),
      rec('session:result', -128, result('echo: released a', { standDownHeld: true })),
      rec('session:batch-completed', -128),
      rec('session:ended', -119),
      rec('session:result', -128, result('echo: released a')),
    ]
    const o = owedOf(recs, proc)
    expect(o.ends).toHaveLength(1)
    expect(o.ends[0]).toMatchObject({ held: true, mark: 'none', saidAgainAt: recs[4].seq })
    expect(o.actsNew).toBe(1)
    expect(o.actsOld).toBe(0)
    // The held record is never said (leader-apply.ts awaitHeld); every other record is heard.
    expect(o.owedRecs.map((r: { seq: number }) => r.seq)).toEqual([recs[0].seq, recs[2].seq, recs[3].seq, recs[4].seq])
    expect(o.unsaidHeld).toEqual([])
  })

  it('marks before the slack are honoured, marks inside it are acted on again (the slack duplicate)', () => {
    const recs = [
      rec('session:usage-update', -18_436, {}, 'leader'),
      rec('session:result', -18_425, result('echo: released', { standDownHeld: true }), 'leader'),
      rec('session:user-line', -7_776, {}, 'leader'),
      rec('session:result', -7_473, result('echo: round', { standDownHeld: true }), 'leader'),
      rec('session:ended', -7_455, {}, 'leader'),
      rec('session:result', -7_473, result('echo: round'), 'leader'),
      rec('session:user-line', 7_016),
      rec('session:result', 7_322, result('echo: after')),
    ]
    const o = owedOf(recs, proc)
    expect(o.ends.map((e: { mark: string }) => e.mark)).toEqual(['honoured', 'slack', 'none'])
    expect(o.saidAgain).toEqual([recs[5].seq])
    expect(o.actsNew).toBe(2)
    expect(o.actsOld).toBe(2)
    expect(o.slackDuplicates).toBe(1)
    expect(o.owedRecs.map((r: { seq: number }) => r.seq)).toEqual([recs[2].seq, recs[4].seq, recs[5].seq, recs[6].seq, recs[7].seq])
  })

  it('a later turn with other words is its own turn end, never taken for a said-again record', () => {
    const recs = [
      rec('session:result', -100, result('echo: one', { standDownHeld: true })),
      rec('session:result', -50, result('echo: two')),
    ]
    const o = owedOf(recs, proc)
    expect(o.ends).toHaveLength(2)
    expect(o.saidAgain).toEqual([])
  })

  it('a held last turn end nobody said again is reported', () => {
    const recs = [rec('session:result', -100, result('echo: one', { standDownHeld: true }))]
    expect(owedOf(recs, proc).unsaidHeld).toEqual([recs[0].seq])
  })

  it('markOf follows the leader: only a judgedBy mark counts, honoured before the slack', () => {
    expect(markOf({ at: START - 20_000 }, { startedAt: START, slackMs: 11_000 })).toBe('none')
    expect(markOf({ at: START - 20_000, judgedBy: 'leader' }, { startedAt: START, slackMs: 11_000 })).toBe('honoured')
    expect(markOf({ at: START - 5_000, judgedBy: 'leader' }, { startedAt: START, slackMs: 11_000 })).toBe('slack')
  })
})
