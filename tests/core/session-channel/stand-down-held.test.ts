/**
 * Review round 1, S2: while a host stands down for what it takes for an older leader, its resend
 * family skips every turn end and the emitter stamps none as taken; when it stands up, the turn ends
 * skipped meanwhile go to the family's own subscribers only (stand-down-held.ts, host-resend.ts
 * replay, event-bus.ts deliverTo), so a misjudged stand-down never leaves a turn end acted on by no one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

// The host's store: one own row, `own` (judged here unless the host stands down).
vi.mock('../../../src/core/session-db.js', async (orig) => ({
  ...(await orig<object>()),
  sessionJudgeInStore: (sid: string) => (sid === 'own' ? { judgedByHost: true, host: 'devbox' } : null),
}))
import { createStandDownHeld, HELD_MAX_AGE_MS, isStandDownHeldEnd } from '../../../src/core/session-channel/stand-down-held.js'
import { __setTurnRetrierForTesting } from '../../../src/core/sessions/turn-run.js'
import { turnEndStamp } from '../../../src/core/session-channel/host-resend.js'
import { bus } from '../../../src/core/event-bus.js'
import { _resetJudgeOfForTesting, judgedHere, judgedHereOnly, setHostStandsDown } from '../../../src/core/sessions/judge-of.js'
import { _resetServerRoleForTesting } from '../../../src/core/server-role.js'

const env = { ...process.env }
afterEach(() => {
  setHostStandsDown(false)
  for (const k of ['WALNUT_ROLE', 'WALNUT_HOST_KEY']) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k] }
  _resetServerRoleForTesting()
  _resetJudgeOfForTesting()
  for (const n of ['test-family-member', 'test-emitter', 'test-held']) bus.unsubscribe(n)
})

describe('the turn ends kept while standing down', () => {
  it('keeps only the newest end of each own session, only while standing down; the session going on drops it', () => {
    let down = true
    const held = createStandDownHeld({ standingDown: () => down, owns: (sid) => sid !== 'theirs' })
    held.note({ name: 'session:result', data: { sessionId: 'a', result: 'one' } })
    held.note({ name: 'session:error', data: { sessionId: 'a', error: 'two' } })
    held.note({ name: 'session:result', data: { sessionId: 'theirs' } })
    held.note({ name: 'session:result', data: { sessionId: 'b' } })
    held.note({ name: 'session:send', data: { sessionId: 'b' } })
    held.note({ name: 'session:status-changed', data: { sessionId: 'a' } })
    down = false
    held.note({ name: 'session:result', data: { sessionId: 'c' } })
    expect(held.take().replay.map((e) => [e.name, (e.data as { sessionId: string }).sessionId])).toEqual([['session:error', 'a']])
    expect(held.size()).toBe(0)
  })
})

describe('the emitter stamps no turn end as taken while standing down', () => {
  it('hostTakenBy is null while standing down', async () => {
    const stamp = await turnEndStamp()
    setHostStandsDown(true)
    const stamped = stamp('session:result', { sessionId: 's', isError: true, result: 'usage limit reached' })
    expect(stamped).toMatchObject({ hostTakenBy: null, standDownHeld: true })
    expect(isStandDownHeldEnd('session:result', stamped)).toBe(true)
    setHostStandsDown(false)
    expect(isStandDownHeldEnd('session:result', stamp('session:result', { sessionId: 's', isError: false, result: 'done' }))).toBe(false)
  })
})

describe('the stand-up hands the skipped turn ends to the family only', () => {
  it('a family member skipped it while standing down and gets it once at the stand-up; the emitter never sees it twice', () => {
    process.env.WALNUT_ROLE = 'replica'
    process.env.WALNUT_HOST_KEY = 'devbox'
    _resetServerRoleForTesting()
    const member: string[] = []
    const emitter: string[] = []
    bus.subscribe('test-family-member', judgedHereOnly((e: { name: string; data: unknown }) => { member.push(e.name) }), { global: true, interest: ['session:result'] })
    bus.subscribe('test-emitter', (e) => { emitter.push(e.name) }, { global: true, interest: ['session:'] })
    const held = createStandDownHeld({ standingDown: () => true, owns: () => true })
    bus.subscribe('test-held', (e) => held.note(e), { global: true, interest: ['session:'] })
    setHostStandsDown(true)
    expect(judgedHere('own')).toBe(false)
    bus.emit('session:result', { sessionId: 'own', isError: true }, ['*'], { source: 'session-runner' })
    expect(member).toEqual([])
    expect(emitter).toEqual(['session:result'])
    setHostStandsDown(false)
    const ends = held.take().replay
    for (const e of ends) bus.deliverTo(['test-family-member'], e.name, e.data, { source: e.source })
    expect(member).toEqual(['session:result'])
    expect(emitter).toEqual(['session:result'])
  })
})

describe('round 2, S1: a held end is replayed only while it is fresh and its transcript has not grown', () => {
  it('one past the age bound, or whose consumed offset moved past where it settled, is dropped; a fresh still one goes', () => {
    let t = 1_000_000
    const offsets: Record<string, number> = { fresh: 100, old: 100, grew: 100 }
    const settle: Array<() => void> = []
    const logs: string[] = []
    const held = createStandDownHeld({
      standingDown: () => true, owns: () => true, offsetOf: (sid) => offsets[sid], now: () => t,
      later: (fn) => { settle.push(fn) }, maxAgeMs: 60_000, log: (_l, msg) => { logs.push(msg) },
    })
    held.note({ name: 'session:result', data: { sessionId: 'old' } })
    t += 50_000
    held.note({ name: 'session:result', data: { sessionId: 'fresh' } })
    held.note({ name: 'session:error', data: { sessionId: 'grew' } })
    // The trailing lines of each turn end land before it settles: that is not growth.
    offsets.fresh = 120; offsets.grew = 130; offsets.old = 110
    for (const fn of settle) fn()
    // Later an older leader ran a turn of `grew` the host's bus never saw.
    offsets.grew = 900
    t += 20_000
    const taken = held.take()
    expect(taken.replay.map((e) => (e.data as { sessionId: string }).sessionId)).toEqual(['fresh'])
    expect(taken.dropped.map((e) => (e.data as { sessionId: string }).sessionId).sort()).toEqual(['grew', 'old'])
    expect(logs).toHaveLength(2)
    expect(held.size()).toBe(0)
  })

  it('the default bound is minutes, and a session whose offset is not known is judged by age alone', () => {
    let t = 0
    const held = createStandDownHeld({ standingDown: () => true, owns: () => true, now: () => t, later: () => {} })
    held.note({ name: 'session:result', data: { sessionId: 'x' } })
    t += HELD_MAX_AGE_MS - 1
    expect(held.take().replay).toHaveLength(1)
    held.note({ name: 'session:result', data: { sessionId: 'y' } })
    t += HELD_MAX_AGE_MS + 1
    expect(held.take()).toMatchObject({ replay: [], dropped: [{ name: 'session:result' }] })
    expect(HELD_MAX_AGE_MS).toBeGreaterThanOrEqual(5 * 60_000)
  })
})

describe('round 2, N4: the replay goes to a fixed list of the family\'s turn-end subscribers', () => {
  it('the list is exactly the names the family\'s members subscribe a judgedHereOnly handler with', async () => {
    const fsp = await import('node:fs/promises')
    const path = await import('node:path')
    const root = new URL('../../../src/core/session-channel/', import.meta.url).pathname
    const src = await fsp.readFile(path.join(root, 'host-resend.ts'), 'utf8')
    const body = src.slice(src.indexOf('export async function startHostResendFamily'))
    const mods = [...new Set([...body.matchAll(/import\('(\.\.\/[^']+\.js)'\)/g)].map((m) => m[1]))]
    const found = new Set<string>()
    for (const m of mods) {
      const file = path.join(root, m.replace(/\.js$/, '.ts'))
      const text = await fsp.readFile(file, 'utf8').catch(() => '')
      const consts = new Map([...text.matchAll(/const (\w+) = '([^']+)'/g)].map((x) => [x[1], x[2]]))
      for (const s of text.matchAll(/bus\.subscribe\((?:'([^']+)'|(\w+)),\s*judgedHereOnly/g)) found.add(s[1] ?? consts.get(s[2]) ?? `?${s[2]}`)
    }
    const { RESEND_TURN_END_SUBSCRIBERS } = await import('../../../src/core/session-channel/host-resend.js')
    expect([...found].sort()).toEqual([...RESEND_TURN_END_SUBSCRIBERS].sort())
  })
})

describe('land 6 N5: a turn end of the stand-down is said again to the leader once judged, and only to a leader that waits for it', () => {
  const sids = (said: Array<{ data: unknown }>) => said.map((e) => (e.data as { sessionId: string }).sessionId)
  const leader = (o: { linked: boolean; reads: boolean }, said: Array<{ name: string; data: unknown }>) => ({
    leaderLinked: () => o.linked, leaderReadsHeld: () => o.reads, say: (name: string, data: unknown) => { said.push({ name, data }) },
  })

  it('the stand-up replays the fresh end, then owes it stamped as the retrier took it in that tick; a dropped end is owed as taken by no one', async () => {
    process.env.WALNUT_ROLE = 'replica'
    process.env.WALNUT_HOST_KEY = 'devbox'
    _resetServerRoleForTesting()
    // A retrier that takes the turn end once the family member saw it (as auto-continue arms at the end).
    const armed = new Set<string>()
    await __setTurnRetrierForTesting('auto_continue', { reason: 'auto_continue', sources: [], takes: (end: { sessionId: string }) => armed.has(end.sessionId), wait: () => null } as never)
    try {
      bus.subscribe('test-family-member', judgedHereOnly((e: { data: unknown }) => { armed.add((e.data as { sessionId: string }).sessionId) }), { global: true, interest: ['session:result'] })
      const stamp = await turnEndStamp()
      let t = 1_000_000
      const held = createStandDownHeld({ standingDown: () => true, owns: () => true, now: () => t, later: () => {}, maxAgeMs: 60_000 })
      bus.subscribe('test-held', (e) => held.note(e), { global: true, interest: ['session:'] })
      setHostStandsDown(true)
      bus.emit('session:result', { sessionId: 'stale', isError: true, result: 'API Error: overloaded' }, ['*'], { source: 'session-runner' })
      t += 61_000
      bus.emit('session:result', { sessionId: 'own', isError: true, result: 'API Error: overloaded' }, ['*'], { source: 'session-runner' })
      // Standing down, the family took nothing.
      expect(armed.size).toBe(0)
      setHostStandsDown(false)
      const replayed = held.standUp({ replay: (ends) => { for (const e of ends) bus.deliverTo(['test-family-member'], e.name, e.data, { source: e.source }) }, stamp })
      expect(replayed).toBe(1)
      expect([...armed]).toEqual(['own'])
      expect(held.owedSize()).toBe(2)
      const said: Array<{ name: string; data: unknown }> = []
      expect(held.payOwed(leader({ linked: true, reads: true }, said))).toBe(2)
      const byId = Object.fromEntries(said.map((e) => [(e.data as { sessionId: string }).sessionId, e.data as Record<string, unknown>]))
      expect(byId.own).toMatchObject({ hostTakenBy: 'auto_continue' })
      expect(byId.stale).toMatchObject({ hostTakenBy: null })
      // Said again as judged: no longer the held mark, so the leader acts on it.
      expect(said.every((e) => !isStandDownHeldEnd(e.name, e.data))).toBe(true)
      expect(held.owedSize()).toBe(0)
    } finally {
      await __setTurnRetrierForTesting('auto_continue', null)
    }
  })

  it('waits while no leader is linked; a leader that does not read the mark applied the ends as they came, so they are forgotten', () => {
    const held = createStandDownHeld({ standingDown: () => true, owns: () => true, later: () => {} })
    held.note({ name: 'session:result', data: { sessionId: 'a' } })
    held.standUp({ replay: () => {}, stamp: (_n, d) => ({ ...(d as object), hostTakenBy: null }) })
    const said: Array<{ name: string; data: unknown }> = []
    expect(held.payOwed(leader({ linked: false, reads: true }, said))).toBe(0)
    expect(held.owedSize()).toBe(1)
    expect(held.payOwed(leader({ linked: true, reads: false }, said))).toBe(0)
    expect(held.owedSize()).toBe(0)
    expect(said).toEqual([])
  })

  it('an owed end is dropped when the session goes on or ends a later turn before a leader hears it', () => {
    let down = true
    const held = createStandDownHeld({ standingDown: () => down, owns: () => true, later: () => {} })
    for (const sid of ['went-on', 'later-end', 'kept']) held.note({ name: 'session:result', data: { sessionId: sid } })
    down = false
    held.standUp({ replay: () => {}, stamp: (_n, d) => d })
    held.note({ name: 'session:send', data: { sessionId: 'went-on' } })
    held.note({ name: 'session:result', data: { sessionId: 'later-end' } })
    const said: Array<{ name: string; data: unknown }> = []
    held.payOwed(leader({ linked: true, reads: true }, said))
    expect(sids(said)).toEqual(['kept'])
  })
})
