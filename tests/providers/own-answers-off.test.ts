/**
 * A host's one Walnut service without a copy of the leader's data never calls the daemon's own away
 * answers (daemon-standalone.ts ownAnswersOff; docs: the copyless service design, guard G1):
 *   - every call site of those answers (offlineHost.handle, handleLocal, holdWrite, deliverTrigger)
 *     and of their counters (noteOwnAnswer, noteOwnOffline) is classified here, each behind the
 *     check; a new one fails until it is;
 *   - the gateway core gives the follower's refusal to the caller (noOwnAnswer), never hands it back;
 *   - a call before the service is seated answers `needs_leader` `service_starting`, which the
 *     `walnut` CLI and the MCP server send again within the call's own time (requestRidingRestart);
 *   - a read relayed to a leader that went silent under it falls to the service when its attempt
 *     ends, and passes that leader by until it is heard again (readFallsToService, passesSilentLeader;
 *     over real processes: tests/e2e/copyless-away-cut-e2e.test.ts R3).
 * The same count over real processes is tests/e2e/copyless-service-e2e.test.ts (G1).
 */
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { call, setup } from '../helpers/follower-gateway-harness.js'
import { requestRidingRestart, serviceStartingAnswer } from '../../src/providers/wn-cli.js'
import { GATEWAY_ANSWER_SLACK_MS, gatewayLineAgain, toolsCallLine } from '../../src/providers/gateway-request.js'
import { GATEWAY_MIN_RELAY_MS, passesSilentLeader, readFallsToService, type GatewayResponse } from '../../src/providers/gateway-core.js'
import { RESTART_POLL_MS } from '../../src/providers/daemon-restart-mark.js'

const SRC = fs.readFileSync(path.join(__dirname, '../../src/providers/daemon-standalone.ts'), 'utf8')
const STARTING: GatewayResponse = { ok: false, error: { code: 'needs_leader', message: 'starting', retryAfterMs: 1_000, detail: { why: 'service_starting', retryable: true } } }

describe('every own away answer of the daemon is behind ownAnswersOff', () => {
  it('each call site is classified and guarded', () => {
    const sites = [...SRC.matchAll(/offlineHost\.(handle|handleLocal|holdWrite|deliverTrigger)\(|followerGateway\.(noteOwnAnswer|noteOwnOffline)\(/g)]
    // The guard each site sits behind: on its own line, or in the lines just above it.
    const guarded = (at: number, re: RegExp, lines = 1): boolean => {
      let start = at
      for (let i = 0; i < lines; i++) start = SRC.lastIndexOf('\n', start - 1)
      return re.test(SRC.slice(start, SRC.indexOf('\n', at)))
    }
    const verdicts = sites.map((m) => {
      const at = m.index!
      const name = m[1] ?? m[2]!
      const line = SRC.slice(SRC.lastIndexOf('\n', at) + 1, SRC.indexOf('\n', at)).trim()
      if (/^holdForLeader:/.test(line)) return `${name}: holdForLeader ${guarded(at, /ownAnswersOff\(call\.home\) \? null :/)}`
      if (/^ownAnswerUsed:/.test(line)) return `${name}: ownAnswerUsed ${guarded(at, /if \(!ownAnswersOff\(fire\.home\)\)/)}`
      if (name === 'deliverTrigger') return `${name}: deliverFireOwn ${guarded(at, /if \(ownAnswersOff\(fire\.home\) && followerEntry\.mayWrite\(fire\.home\)\) return/, 2)}`
      // A relay's `readable` is sendGatewayRequest's, which is never true without a copy (asserted below).
      if (/read_late|reading from the copy/.test(SRC.slice(at - 900, at + 100))) return `${name}: read_late ${/if \(call\.readable && call\.home\) \{/.test(SRC.slice(at - 900, at))}`
      if (name === 'handleLocal' || /follower_linked/.test(line)) return `${name}: same_host ${/if \(noOwn\) return relayToPrimary\(/.test(SRC.slice(at - 1200, at))}`
      // The rest: sendGatewayRequest's own away answer, which a block of its own ends first.
      const fn = SRC.lastIndexOf('\nfunction sendGatewayRequest(', at)
      const block = SRC.indexOf('  if (home && noOwn && (!target || (offlineHost.pendingHandover(home) && !external))) {', fn)
      const away = SRC.indexOf('  if (home && (!target || (offlineHost.pendingHandover(home) && (!external || readable))) && offlineHost.hasHome(home)) {', fn)
      return `${name}: away ${fn > 0 && block > fn && away > block && (name === 'noteOwnOffline' || at > away)}`
    })
    expect(verdicts.sort()).toEqual([
      'deliverTrigger: deliverFireOwn true',
      'handle: away true',
      'handle: away true',
      'handle: read_late true',
      'handleLocal: same_host true',
      'holdWrite: away true',
      'holdWrite: holdForLeader true',
      'noteOwnAnswer: ownAnswerUsed true',
      'noteOwnAnswer: read_late true',
      'noteOwnAnswer: same_host true',
      'noteOwnOffline: away true',
    ])
    // The away block of a service without a copy always ends the call, and a read is never the copy's.
    const fn = SRC.indexOf('\nfunction sendGatewayRequest(')
    const block = SRC.slice(SRC.indexOf('  if (home && noOwn && (!target', fn), SRC.indexOf('  // Answer here while the Walnut is away', fn))
    expect(block).toMatch(/return respond\(serviceStartingAnswer\(\)\)/)
    expect(block.trimEnd()).toMatch(/return respond\(gatewayNoServerError\(home\)\)\n {2}\}$/)
    expect(SRC).toMatch(/const readable = !noOwn && /)
    // The follower's refusal is final there: the hand-off says so.
    expect(SRC).toMatch(/noOwn \? \{ noOwnAnswer: true as const \} : \{\}/)
  })
})

describe('the gateway core with no own answer', () => {
  it('a hand-back code is the caller\'s answer; the lag and the companion still route it on', () => {
    for (const code of ['needs_leader', 'unsupported_replica', 'unsupported_version']) {
      const s = setup()
      const respond = vi.fn()
      const fallback = vi.fn()
      s.g.handOff(call({ fallback, noOwnAnswer: true }), respond)
      const refused = { ok: false as const, error: { code, message: 'no' } }
      s.g.settle(s.sock, 101, refused)
      expect(fallback).not.toHaveBeenCalled()
      expect(respond).toHaveBeenCalledWith(refused)
    }
  })
})

describe('service_starting, sent again by the client', () => {
  function clock() {
    let t = 1_800_000_000_000
    const slept: number[] = []
    return { slept, d: { restarting: () => false, sleep: async (ms: number) => { slept.push(ms); t += ms }, now: () => t, tell: () => {} } }
  }

  it('a waiting call is sent again with what is left of its time, until it is answered', async () => {
    const line = toolsCallLine('s1', { name: 'task_get', args: { id: 't1' } }, 20_000)
    const sent: number[] = []
    const answers = [STARTING, STARTING, { ok: true, result: { ok: 1 } } as GatewayResponse]
    const c = clock()
    const r = await requestRidingRestart('/x/s', line, { ...c.d, request: async (_p, l) => { sent.push(Number(l.req.waitMs)); return answers.shift()! } })
    expect(r).toEqual({ ok: true, result: { ok: 1 } })
    expect(c.slept).toEqual([1_000, 1_000])
    expect(sent).toEqual([20_000, 19_000, 18_000])
    expect(serviceStartingAnswer(STARTING)).toBe(true)
  })

  it('past the call\'s own time, and for a call that waits for nothing, the answer comes back as it is', async () => {
    const c = clock()
    let asks = 0
    const short = toolsCallLine('s1', { name: 'task_get', args: {} }, GATEWAY_MIN_RELAY_MS)
    const r = await requestRidingRestart('/x/s', short, { ...c.d, request: async () => { asks++; return STARTING } })
    expect(r).toEqual(STARTING)
    expect(asks).toBeLessThanOrEqual(Math.ceil(GATEWAY_MIN_RELAY_MS / 1_000) + 1)
    let once = 0
    const none = toolsCallLine('s1', { name: 'task_get', args: {} }, 'none')
    expect(await requestRidingRestart('/x/s', none, { ...clock().d, request: async () => { once++; return STARTING } })).toEqual(STARTING)
    expect(once).toBe(1)
  })

  it('gatewayLineAgain keeps the call\'s wait within what is left', () => {
    const line = toolsCallLine('s1', { name: 'x', args: {} }, 30_000)
    expect(gatewayLineAgain(line, 12_000)).toEqual({ req: { ...line.req, waitMs: 12_000 }, timeoutMs: 12_000 + GATEWAY_ANSWER_SLACK_MS })
    expect(gatewayLineAgain(line, 60_000).req.waitMs).toBe(30_000)
    expect(gatewayLineAgain(line, GATEWAY_MIN_RELAY_MS - 1)).toEqual({ req: { ...line.req, waitMs: 0 }, timeoutMs: GATEWAY_MIN_RELAY_MS - 1 })
    expect(RESTART_POLL_MS).toBeLessThanOrEqual(1_000)
  })
})

describe('a read whose leader went silent falls to the service without a copy', () => {
  const base = { readOnly: true, withoutCopy: true, leaderHeardSinceSent: false, leftMs: 10_000, minRelayMs: GATEWAY_MIN_RELAY_MS }

  it('a read-only op, its leader not heard since it went out (or its socket gone), time left: the service answers it', () => {
    expect(readFallsToService(base)).toBe(true)
  })

  it('never a write, never with a copy, never while the leader is heard, never past the call\'s time', () => {
    expect(readFallsToService({ ...base, readOnly: false })).toBe(false)
    expect(readFallsToService({ ...base, withoutCopy: false })).toBe(false)
    expect(readFallsToService({ ...base, leaderHeardSinceSent: true })).toBe(false)
    expect(readFallsToService({ ...base, leftMs: GATEWAY_MIN_RELAY_MS - 1 })).toBe(false)
  })

  it('the call passes its leader by only while that leader stays silent', () => {
    expect(passesSilentLeader(1_000, 900)).toBe(true)
    expect(passesSilentLeader(1_000, 1_000)).toBe(true)
    expect(passesSilentLeader(1_000, 1_500)).toBe(false)
    expect(passesSilentLeader(undefined, 900)).toBe(false)
  })

  it('the daemon asks it when an attempt ends, before sending the read to the leader again, and routes by it', () => {
    const at = SRC.indexOf('function relayAttemptEnded(')
    const ended = SRC.slice(at, SRC.indexOf('function cmdGatewayResult(', at))
    expect(ended.indexOf('relayFellToService(relayId)')).toBeGreaterThan(-1)
    expect(ended.indexOf('relayFellToService(relayId)')).toBeLessThan(ended.indexOf('relayResendTarget(call)'))
    const fell = SRC.slice(SRC.indexOf('function relayFellToService('), SRC.indexOf('function relayAttemptEnded('))
    expect(fell).toMatch(/const heard = !!call\.sentOn && \(call\.sentOn\.data\?\.lastHeardAt \?\? 0\) > call\.sentAt/)
    expect(fell).toMatch(/if \(!entry \|\| !call \|\| !call\.home \|\| call\.caller/)
    expect(fell).toMatch(/silentSince: call\.sentAt/)
    const send = SRC.slice(SRC.indexOf('function sendGatewayRequest('), SRC.indexOf('function waitForPrimary('))
    expect(send).toMatch(/if \(target && passesSilentLeader\(plan\.silentSince, target\.data\?\.lastHeardAt\)\) target = null/)
  })
})
