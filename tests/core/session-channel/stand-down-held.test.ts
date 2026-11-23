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
import { createStandDownHeld } from '../../../src/core/session-channel/stand-down-held.js'
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
    expect(held.take().map((e) => [e.name, (e.data as { sessionId: string }).sessionId])).toEqual([['session:error', 'a']])
    expect(held.size()).toBe(0)
  })
})

describe('the emitter stamps no turn end as taken while standing down', () => {
  it('hostTakenBy is null while standing down', async () => {
    const stamp = await turnEndStamp()
    setHostStandsDown(true)
    expect((stamp('session:result', { sessionId: 's', isError: true, result: 'usage limit reached' }) as { hostTakenBy: unknown }).hostTakenBy).toBeNull()
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
    const ends = held.take()
    for (const e of ends) bus.deliverTo(['test-family-member'], e.name, e.data, { source: e.source })
    expect(member).toEqual(['session:result'])
    expect(emitter).toEqual(['session:result'])
  })
})
