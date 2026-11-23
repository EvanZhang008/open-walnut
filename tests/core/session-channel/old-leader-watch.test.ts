/**
 * A host stops judging its own sessions when its leader is an older Walnut without the session
 * channel (src/core/session-channel/old-leader-watch.ts), and only then:
 *
 *   old leader     it answers and never opens the channel: after OLD_LEADER_MS in a row the host
 *                  stands down once (judge-of.ts judgedHere false for its own rows, the one gate of
 *                  the resend family), so exactly one judge acts: the leader
 *   leader away    it does not answer: the host never stands down, however long (the feature's point)
 *   new leader     it opens the channel: the host stands up again at once, and a flap of "answers"
 *                  under the bound never counts
 */
import { afterEach, describe, expect, it } from 'vitest'
import { oldLeaderMs, startOldLeaderWatch } from '../../../src/core/session-channel/old-leader-watch.js'
import { _resetJudgeOfForTesting, hostStandsDown, judgedHere, judgedHereRecords, setHostStandsDown } from '../../../src/core/sessions/judge-of.js'
import { _resetServerRoleForTesting } from '../../../src/core/server-role.js'

function harness(o: { answers: boolean; linked: boolean }) {
  let t = 1_000_000
  const calls: string[] = []
  const w = startOldLeaderWatch({
    leaderAnswers: () => o.answers,
    channelLinked: () => o.linked,
    standDown: () => { calls.push('down') },
    standUp: () => { calls.push('up') },
    afterMs: 60_000,
    now: () => t,
  }, { timer: false })
  return { w, calls, advance: async (ms: number, step = 10_000) => { for (let i = 0; i < ms; i += step) { t += step; await w.tick() } } }
}

describe('the old-leader watch', () => {
  it('an old leader (answers, no channel) makes the host stand down once, after the bound', async () => {
    const s = { answers: true, linked: false }
    const { w, calls, advance } = harness(s)
    await w.tick()
    await advance(50_000)
    expect(w.standingDown()).toBe(false)
    await advance(20_000)
    expect(w.standingDown()).toBe(true)
    await advance(300_000)
    expect(calls).toEqual(['down'])
  })

  it('a leader that is away never makes it stand down, however long', async () => {
    const s = { answers: false, linked: false }
    const { w, calls, advance } = harness(s)
    await advance(24 * 3_600_000, 600_000)
    expect(w.standingDown()).toBe(false)
    expect(calls).toEqual([])
  })

  it('answers that flap under the bound never add up; away resets the count', async () => {
    const s = { answers: true, linked: false }
    const { w, calls, advance } = harness(s)
    for (let i = 0; i < 10; i++) {
      s.answers = true; await advance(40_000)
      s.answers = false; await advance(10_000)
    }
    expect(calls).toEqual([])
  })

  it('a leader that opens the channel again makes it stand up at once; the link resets the count', async () => {
    const s = { answers: true, linked: false }
    const { w, calls, advance } = harness(s)
    await advance(70_000)
    expect(w.standingDown()).toBe(true)
    s.linked = true
    await advance(10_000)
    expect(w.standingDown()).toBe(false)
    s.linked = false
    await advance(50_000)
    expect(w.standingDown()).toBe(false)
    expect(calls).toEqual(['down', 'up'])
  })

  it('standing down stays while the old leader is away; only the channel brings it back', async () => {
    const s = { answers: true, linked: false }
    const { w, advance } = harness(s)
    await advance(70_000)
    s.answers = false
    await advance(600_000)
    expect(w.standingDown()).toBe(true)
  })

  it('the bound is minutes by default, settable for one process', () => {
    expect(oldLeaderMs({})).toBe(180_000)
    expect(oldLeaderMs({ WALNUT_HOST_OLD_LEADER_MS: '4000' })).toBe(4000)
    expect(oldLeaderMs({ WALNUT_HOST_OLD_LEADER_MS: 'x' })).toBe(180_000)
  })
})

describe('standing down in judge-of: a host judges none of its own rows, the leader is untouched', () => {
  const env = { ...process.env }
  afterEach(() => {
    setHostStandsDown(false)
    for (const k of ['WALNUT_ROLE', 'WALNUT_HOST_KEY', 'WALNUT_HOST_SERVER', 'WALNUT_PLACEMENT']) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k] }
    _resetServerRoleForTesting()
    _resetJudgeOfForTesting()
  })

  it('on a host replica, its own rows are judged here until it stands down', () => {
    process.env.WALNUT_ROLE = 'replica'
    process.env.WALNUT_HOST_KEY = 'devbox'
    _resetServerRoleForTesting()
    const own = { claudeSessionId: 'own', judge: 'host' as const, host: 'devbox' }
    const copied = { claudeSessionId: 'copy', host: 'devbox' }
    expect(judgedHereRecords([own, copied]).map((r) => r.claudeSessionId)).toEqual(['own'])
    setHostStandsDown(true)
    expect(hostStandsDown()).toBe(true)
    expect(judgedHereRecords([own, copied])).toEqual([])
    expect(judgedHere('own')).toBe(false)
  })

  it('on the leader it changes nothing (a leader never stands down)', () => {
    for (const k of ['WALNUT_ROLE', 'WALNUT_HOST_KEY']) delete process.env[k]
    _resetServerRoleForTesting()
    setHostStandsDown(true)
    const legacy = { claudeSessionId: 'l', host: 'devbox' }
    expect(judgedHereRecords([legacy])).toEqual([legacy])
  })
})
