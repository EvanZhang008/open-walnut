/**
 * Class: "a daemon answers a call itself while its host has a follower". The daemon's own away
 * answers (offlineHost.handle, offlineHost.handleLocal) are for a host with no follower; on a host
 * with one, each call goes to that follower (or waits for it within its own time), and every own
 * answer the daemon still gives there is counted, so a run can prove the count is zero.
 *
 * This ratchet enumerates every call site of those two answers in the daemon source and fails when a
 * new one appears that is not behind the follower check and counted. A site added on purpose is
 * added to SITES with its check and its count. The behaviour itself runs on a real daemon in
 * tests/integration/follower-kept-routing-twins.test.ts.
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createFollowerGateway } from '../../src/providers/follower-gateway-core.js'

const ROOT = path.resolve(__dirname, '../..')
const src = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf8')

function fnBody(name: string): { at: number; body: string } {
  const at = src.search(new RegExp(`^function ${name}\\(`, 'm'))
  expect(at, name).toBeGreaterThan(0)
  return { at, body: src.slice(at, src.indexOf('\n}\n', at)) }
}

/** The function a source offset lies in (the last top-level `function` before it). */
function enclosing(offset: number): string {
  const before = src.slice(0, offset)
  const m = [...before.matchAll(/^(?:async )?function (\w+)\(/gm)].at(-1)
  return m ? m[1]! : '(top level)'
}

const OWN = /offlineHost\.(handle|handleLocal)\(/g

/** Each own answer the daemon may still give: where, how many, and the count that goes with it. */
const SITES: Record<string, { handle: number; handleLocal: number }> = {
  // The search after the companion, the away answer (A1), the same-host delivery (handleLocal).
  sendGatewayRequest: { handle: 2, handleLocal: 1 },
  // A read the leader did not answer in time.
  relayAttemptEnded: { handle: 1, handleLocal: 0 },
}

describe('a daemon answers a call itself while its host has a follower', () => {
  it('every own away answer of the daemon is at a known site', () => {
    const found: Record<string, { handle: number; handleLocal: number }> = {}
    for (const m of src.matchAll(OWN)) {
      const fn = enclosing(m.index!)
      found[fn] ??= { handle: 0, handleLocal: 0 }
      found[fn][m[1] as 'handle' | 'handleLocal']++
    }
    expect(found, 'a new offlineHost.handle/handleLocal call: route it to the follower when the host has one (followerHere(home).kept), count it, then add it to SITES').toEqual(SITES)
  })

  it('in sendGatewayRequest, the follower comes first: its hand-off, then its wait, then any own answer', () => {
    const { body } = fnBody('sendGatewayRequest')
    const handOff = body.indexOf('if (home && followers && followerGateway.answers(home)) {')
    const wait = body.indexOf('if (followers && waitForFollower()) return')
    expect(handOff, 'the hand-off').toBeGreaterThan(0)
    expect(wait, 'the wait for a follower kept here').toBeGreaterThan(handOff)
    const own = [...body.matchAll(OWN)].map((m) => m.index!)
    expect(own.length).toBe(3)
    for (const at of own) expect(at, 'an own answer before the follower check').toBeGreaterThan(wait)
    // The wait asks the fact, never "linked right now".
    expect(body).toMatch(/const waitForFollower = \(\): boolean => \{\n\s+if \(!home \|\| plan\.never \|\| plan\.ownServerAsked \|\| !followerHere\(home\)\.kept\) return false/)
    // An outside caller's read is the follower's too (case 1); its writes never reached an own answer.
    expect(body).toContain('const followers = !!home && (!target || offlineHost.pendingHandover(home)) && (!external || readable) && !plan.ownServerAsked')
    expect(body).not.toContain('callerSid !== EXTERNAL_CALLER_SID && !plan.ownServerAsked')
  })

  it('every own answer is counted where it is given', () => {
    const { body } = fnBody('sendGatewayRequest')
    // handle(): each right after noteOwn() (followerGateway.noteOwnOffline: handed_back, follower_linked, follower_away).
    for (const m of body.matchAll(/offlineHost\.handle\(/g)) {
      const lead = body.slice(Math.max(0, m.index! - 200), m.index!)
      expect(lead, 'noteOwn() before offlineHost.handle').toContain('noteOwn()')
    }
    // handleLocal(): the same-host send waits for a follower that takes them, and is counted when this host has one.
    const local = body.indexOf('offlineHost.handleLocal(')
    const lead = body.slice(body.lastIndexOf('// A follower that takes same-host sends', local), local)
    expect(lead).toContain("followerSaidOnline.get(home) === true && offlineHost.localCandidate(home, callerSid, capability, payload) && waitForFollower()) return")
    expect(lead).toContain('const kept = followerHere(home).kept')
    expect(body.slice(local, local + 600)).toContain("if (linked || kept) followerGateway.noteOwnAnswer(payload.name, linked ? 'follower_linked' : followerSaidOnline.get(home) === true ? 'follower_away' : 'same_host', callerSid)")
    // The late read.
    const late = fnBody('relayAttemptEnded').body
    expect(late.indexOf("if (followerHere(call.home).kept) followerGateway.noteOwnAnswer(call.payload.name, 'read_late', call.callerSid)"))
      .toBeGreaterThan(0)
    expect(late.indexOf("followerGateway.noteOwnAnswer(call.payload.name, 'read_late'")).toBeLessThan(late.indexOf('offlineHost.handle('))
  })

  it('"has a follower" is a kept fact (the spec this daemon keeps), not the socket linked now', () => {
    const kept = fnBody('followerHere').body
    expect(kept).toContain('hostServers.answersCalls(spec)')
    expect(kept).toContain('hostServers.keeps(home)')
    expect(src).toMatch(/kept: \(home\) => followerHere\(home\)\.kept,/)
    // A follower saying hello wakes the calls that wait for it (both ways in: a socket, the in-process seat).
    expect(fnBody('cmdFollowerHello').body).toContain('wakeWaitingCalls()')
    expect(src).toContain('setTimeout(wakeWaitingCalls, 0)')
  })
})

describe('own answers counted while a follower is kept but away (follower-gateway-core.ts)', () => {
  const make = (kept: boolean) => createFollowerGateway<object>({
    follower: () => null, mayWrite: () => true, kept: () => kept, now: () => 5, send: () => true, nextRelayId: () => 1, instanceId: 'i',
    attemptMs: () => 1_000, minRelayMs: 8_000, setTimer: () => null, clearTimer: () => {}, log: () => {},
  })

  it('counts follower_away when the host keeps a follower that is not linked; nothing on a host with none', () => {
    const kept = make(true)
    kept.noteOwnOffline('/h', 'tools.call', 's1', { name: 'task_get' })
    expect(kept.ownAnswers()).toMatchObject({ total: 1, byOp: { task_get: 1 }, byWhy: { follower_away: 1 } })
    kept.noteOwnOffline('/h', 'tools.call', 's1', { name: 'task_get' }, true)
    expect(kept.ownAnswers().byWhy).toEqual({ follower_away: 1, handed_back: 1 })
    const none = make(false)
    none.noteOwnOffline('/h', 'tools.call', 's1', { name: 'task_get' })
    expect(none.ownAnswers().total).toBe(0)
  })
})
