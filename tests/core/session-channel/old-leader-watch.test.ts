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

function harness(o: { answers: boolean; linked: boolean; says?: boolean; since?: number }) {
  let t = 1_000_000
  const calls: string[] = []
  const w = startOldLeaderWatch({
    leaderAnswers: () => o.answers,
    ...(o.since !== undefined ? { presenceSince: () => o.since! } : {}),
    channelLinked: () => o.linked,
    ...(o.says !== undefined ? { leaderSaysChannel: async () => !!o.says } : {}),
    standDown: () => { calls.push('down') },
    standUp: () => { calls.push('up') },
    afterMs: 60_000,
    now: () => t,
  }, { timer: false })
  return { w, calls, now: () => t, advance: async (ms: number, step = 10_000) => { for (let i = 0; i < ms; i += step) { t += step; await w.tick() } } }
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

  it('S2: a leader that says it speaks the channel never makes the host stand down on the timeout; the state says it waits', async () => {
    const s = { answers: true, linked: false, says: true }
    const { w, calls, advance } = harness(s)
    await advance(24 * 3_600_000, 600_000)
    expect(w.standingDown()).toBe(false)
    expect(calls).toEqual([])
    expect(w.state().state).toBe('waiting')
    s.linked = true
    await advance(10_000)
    expect(w.state()).toEqual({ state: 'judging', since: null })
  })

  it('S2: a leader whose copy stops saying it (a downgrade) falls back to the timeout; the state says stood-down', async () => {
    const s = { answers: true, linked: false, says: true }
    const { w, calls, advance } = harness(s)
    await advance(70_000)
    expect(w.state().state).toBe('waiting')
    s.says = false
    await advance(10_000)
    expect(calls).toEqual(['down'])
    expect(w.state().state).toBe('stood-down')
  })

  it('S3: a look asked for while one runs runs right after it (a link event during a tick is never lost)', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const s = { answers: true, linked: false }
    let t = 0
    const calls: string[] = []
    const w = startOldLeaderWatch({
      leaderAnswers: () => s.answers, channelLinked: () => s.linked,
      standDown: async () => { calls.push('down'); await gate }, standUp: () => { calls.push('up') },
      afterMs: 1000, now: () => t,
    }, { timer: false })
    await w.tick(); t = 2000
    const first = w.tick()
    // The channel links while the stand-down still runs; its look must not be dropped.
    s.linked = true
    void w.tick()
    release(); await first
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toEqual(['down', 'up'])
    expect(w.standingDown()).toBe(false)
  })

  it('S3: the host looks at once when a leader links (host-boot.ts onLeaderLinked ticks the watch)', async () => {
    const fsp = await import('node:fs/promises')
    const src = await fsp.readFile(new URL('../../../src/core/session-channel/host-boot.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/onLeaderLinked: \(\) => \{[^}]*watchRef\?\.tick\(\)/)
  })

  it('the bound is minutes by default, settable for one process', () => {
    expect(oldLeaderMs({})).toBe(180_000)
    expect(oldLeaderMs({ WALNUT_HOST_OLD_LEADER_MS: '4000' })).toBe(4000)
    expect(oldLeaderMs({ WALNUT_HOST_OLD_LEADER_MS: 'x' })).toBe(180_000)
  })
})

describe('B1: a fact is marked as judged by the older leader only while that leader still answers', () => {
  it('through a whole downgrade and upgrade: before, during, the old leader stopped, a new leader before its channel, the channel', async () => {
    // The older leader begins answering at the start: its presence began then.
    const s: { answers: boolean; linked: boolean; says: boolean; since: number } = { answers: true, linked: false, says: false, since: 1_000_000 }
    const { w, calls, now, advance } = harness(s)
    await w.tick()
    // The first afterMs: the host still judges (a known duplicate after the upgrade), nothing is marked.
    await advance(50_000)
    expect([w.standingDown(), w.oldLeaderJudgesNow()]).toEqual([false, false])
    await advance(20_000)
    expect(calls).toEqual(['down'])
    // Stood down for it, it answers: its turns are its own.
    expect(w.oldLeaderJudgesNow()).toBe(true)
    await advance(600_000)
    expect(w.oldLeaderJudgesNow()).toBe(true)
    // Window A: the older leader stops for its update (or the computer sleeps): nobody judges.
    s.answers = false
    s.since = now()
    await advance(30_000)
    expect([w.standingDown(), w.oldLeaderJudgesNow()]).toEqual([true, false])
    // Window B: the new leader answers, its channel not open yet, its copy not heard yet: not marked.
    s.answers = true
    s.since = now()
    await advance(10_000)
    expect([w.standingDown(), w.oldLeaderJudgesNow()]).toEqual([true, false])
    // Its copy says it speaks the channel: the host judges again before the channel opens.
    s.says = true
    await advance(10_000)
    expect(calls).toEqual(['down', 'up'])
    expect([w.standingDown(), w.oldLeaderJudgesNow(), w.state().state]).toEqual([false, false, 'waiting'])
    // The channel opens.
    s.linked = true
    await advance(10_000)
    expect([w.standingDown(), w.oldLeaderJudgesNow(), w.state().state]).toEqual([false, false, 'judging'])
  })

  it('the same older leader back after a flap (a presence that began after the stand-down): not marked', async () => {
    const s = { answers: true, linked: false, says: false, since: 1_000_000 }
    const { w, now, advance } = harness(s)
    await advance(70_000)
    expect(w.oldLeaderJudgesNow()).toBe(true)
    s.answers = false; s.since = now()
    await advance(10_000)
    s.answers = true; s.since = now()
    await advance(10_000)
    // When in doubt, not marked: a duplicate at worst, never a lost turn end.
    expect([w.standingDown(), w.oldLeaderJudgesNow()]).toEqual([true, false])
  })

  it('S1: a misjudged stand-down (a leader that speaks the channel, its copy heard only later) ends at its copy', async () => {
    const s = { answers: true, linked: false, says: false, since: 1_000_000 }
    const { w, calls, advance } = harness(s)
    await advance(70_000)
    expect(calls).toEqual(['down'])
    s.says = true
    await advance(10_000)
    expect(calls).toEqual(['down', 'up'])
    expect(w.oldLeaderJudgesNow()).toBe(false)
  })

  it('with no presence time to read, never marked', async () => {
    const { w, advance } = harness({ answers: true, linked: false })
    await advance(70_000)
    expect([w.standingDown(), w.oldLeaderJudgesNow()]).toEqual([true, false])
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

describe('N1: the stop of the switch following waits for a late start and stops what it brought up', () => {
  it('a stop while a start is in flight leaves nothing up', async () => {
    const { followSwitch } = await import('../../../src/core/session-channel/host-boot.js')
    let up = false
    let on = false
    let change: (() => void) | null = null
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const calls: string[] = []
    const stop = await followSwitch({
      isOn: async () => on,
      isUp: () => up,
      start: async () => { calls.push('start'); await gate; up = true },
      stop: async () => { calls.push('stop'); up = false },
      onChange: (fn) => { change = fn; return () => { change = null } },
    })
    expect(up).toBe(false)
    on = true
    change!()
    await new Promise((r) => setTimeout(r, 0))
    // The server stops while the start still runs.
    const stopping = stop()
    release()
    await stopping
    expect(calls).toEqual(['start', 'stop'])
    expect(up).toBe(false)
    expect(change).toBeNull()
  })

  it('a stop with nothing started stops nothing', async () => {
    const { followSwitch } = await import('../../../src/core/session-channel/host-boot.js')
    const calls: string[] = []
    const stop = await followSwitch({ isOn: async () => false, isUp: () => false, start: async () => { calls.push('start') }, stop: async () => { calls.push('stop') }, onChange: () => () => {} })
    await stop()
    expect(calls).toEqual([])
  })
})

describe('round 2, N1: only a leader_capabilities row heard since the leader that answers now began counts', () => {
  it('a row an earlier leader left says nothing; one heard after the presence began says the channel', async () => {
    const { leaderSaysChannelNow } = await import('../../../src/core/session-channel/host-boot.js')
    const caps = async () => ['session-channel-v1']
    expect(await leaderSaysChannelNow({ caps, heardAt: async () => 1000, presenceSince: () => 2000 })).toBe(false)
    expect(await leaderSaysChannelNow({ caps, heardAt: async () => 3000, presenceSince: () => 2000 })).toBe(true)
    expect(await leaderSaysChannelNow({ caps: async () => undefined, heardAt: async () => 3000, presenceSince: () => 2000 })).toBe(false)
    expect(await leaderSaysChannelNow({ caps: async () => ['other'], heardAt: async () => 3000, presenceSince: () => 2000 })).toBe(false)
  })

  it('host-boot.ts reads the copy\'s heard time and the presence for it', async () => {
    const fsp = await import('node:fs/promises')
    const src = await fsp.readFile(new URL('../../../src/core/session-channel/host-boot.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/leaderSaysChannel: async \(\) => leaderSaysChannelNow\(/)
    expect(src).toMatch(/configCopyHeardAt\(\)/)
    expect(src).toMatch(/presenceSince: \(\) => leaderPresence\(\)\.since/)
  })
})
