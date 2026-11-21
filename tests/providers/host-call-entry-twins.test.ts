/**
 * The host call entry ('host-call-entry-v1') and the count of the daemon's own away answers are
 * wired the same way in both daemon twins: the follower's address kept from its hello and report,
 * new sessions, ACP workers and plugin jobs given the entry beside the socket, `follower.gateway`
 * checked for the caller's token and run through the socket's own handleGatewayLine (never
 * serialized), and every own away answer given while a follower was there counted. The counter
 * itself runs here as imported and as the inlined text.
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createFollowerGateway } from '../../src/providers/follower-gateway-core.js'
import { ADVERTISED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'
import { HOST_CALL_CAPABILITY } from '../../src/replica/host-call-entry.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const standalone = read('src/providers/daemon-standalone.ts')
const source = read('src/providers/daemon-source.ts')
const TWINS = [['standalone', standalone], ['source', source]] as const

function fnBody(src: string, name: string): string {
  const at = src.search(new RegExp(`^(async )?function ${name}\\(`, 'm'))
  expect(at, name).toBeGreaterThan(0)
  return src.slice(at, src.indexOf('\n}\n', at))
}

describe('host call entry twin wiring', () => {
  it('is advertised, its cores are in the version hash and the binary build', () => {
    expect(ADVERTISED_DAEMON_CAPABILITIES as readonly string[]).toContain(HOST_CALL_CAPABILITY)
    for (const core of ['src/providers/host-call-token-core.ts', 'src/providers/host-call-client-core.ts']) {
      expect(read('src/providers/daemon-version-check.ts')).toContain(`'${core}'`)
      expect(read('scripts/build-daemon.sh')).toContain(core)
    }
    expect(standalone).toContain("from './host-call-token-core.js'")
    expect(read('src/providers/wn-cli.ts')).toContain("from './host-call-client-core.js'")
  })

  it.each(TWINS)('%s: a follower may send follower.gateway, dispatched outside the serial queue', (_n, src) => {
    const allowed = src.slice(src.indexOf('FOLLOWER_ALLOWED_COMMANDS = new Set(['), src.indexOf('])', src.indexOf('FOLLOWER_ALLOWED_COMMANDS = new Set([')))
    expect(allowed).toContain("'follower.gateway'")
    const line = src.split('\n').find((l) => l.includes("case 'follower.gateway':"))!
    expect(line).toBeTruthy()
    expect(line).not.toContain('daemonCommands.run')
  })

  it.each(TWINS)('%s: the entry address comes from the hello and the report, only for a follower that answers local calls', (_n, src) => {
    expect(fnBody(src, 'cmdFollowerHello')).toMatch(/callUrl = cmd\.answersLocal === true \? hostCallUrlOf\(cmd\.callUrl\) : undefined/)
    const report = fnBody(src, 'cmdFollowerReport')
    expect(report).toMatch(/answersLocal === true \? hostCallUrlOf\(report\.callUrl\) : undefined/)
    const env = fnBody(src, 'hostCallEnv')
    expect(env).toMatch(/answersLocal === true/)
    expect(env).toContain('hostCallTokens.tokenFor(sid)')
    expect(env).toContain('WALNUT_CALL_URL: url, WALNUT_CALL_TOKEN: token')
  })

  it.each(TWINS)('%s: follower.gateway checks the token for the line\'s sid, then runs the socket\'s handleGatewayLine', (_n, src) => {
    const fn = fnBody(src, 'cmdFollowerGateway')
    const verify = fn.indexOf('hostCallTokens.verify(sid, cmd.token)')
    expect(verify).toBeGreaterThan(0)
    expect(fn).toContain("errorKind: 'bad_token'")
    expect(fn.indexOf('handleGatewayLine(line, respond')).toBeGreaterThan(verify)
    expect(fn).toMatch(/gatewayCallerLeft\.set\(respond/)
  })

  it('the bun twin proves an approval\'s caller from the pid the entry found, as from a socket peer', () => {
    expect(fnBody(standalone, 'handleGatewayLine')).toContain('const peer = fd !== undefined ? socketPeerPid(fd) : peerPid')
    expect(fnBody(standalone, 'cmdFollowerGateway')).toContain('handleGatewayLine(line, respond, undefined, openedAt, peerPid)')
  })

  it.each(TWINS)('%s: a new session, an ACP worker and a plugin job get the entry beside the socket, and never an inherited one', (_n, src) => {
    // Native spawn: cleared first, then this session's own.
    expect(src).toMatch(/WALNUT_CALL_URL: undefined,\n\s+WALNUT_CALL_TOKEN: undefined,\n\s+\.\.\.hostCallEnv\(spawnInfo\.home (\?\?|\|\|) \(?resumeRec/)
    // ACP worker: '' unsets, then the worker's own WALNUT_SESSION_ID.
    expect(src).toMatch(/WALNUT_CALL_URL: '',\n\s+WALNUT_CALL_TOKEN: '',/)
    expect(src).toMatch(/hostCallEnv\(\(?cmd(?: as \{ home\?: unknown \}\))?\.home, /)
    // Plugin jobs: the run id's own token.
    expect(src).toMatch(/callEnv: (\(home, sid\) => |function \(home, sid\) \{ return )hostCallEnv\(home, sid\)/)
  })

  it.each(TWINS)('%s: every own away answer is counted where it is given, and shown in follower.status and server.status', (_n, src) => {
    const send = fnBody(src, 'sendGatewayRequest')
    const handles = send.split('offlineHost.handle(home, callerSid, capability, payload)').length - 1
    const notes = send.split('noteOwnOfflineAnswer(home, capability, callerSid, payload, plan.ownServerAsked)').length - 1
    expect(handles).toBeGreaterThanOrEqual(2)
    expect(notes).toBe(handles)
    expect(fnBody(src, 'noteOwnOfflineAnswer')).toMatch(/handedBack \? 'handed_back' : followerGateway\.answers\(home\) \? 'follower_linked' : null/)
    // The own same-host delivery (handleLocal) too, while a follower that takes those is linked; an
    // online hand-back relayed to the leader is never counted (its fallback is relayToPrimary).
    expect(send).toContain("if (followerGateway.answersOnline(home)) followerGateway.noteOwnAnswer(payload.name, 'follower_linked', callerSid)")
    expect(fnBody(src, 'followerView')).toContain('offlineAnswers: followerGateway.ownAnswers()')
    expect(fnBody(src, 'cmdServerStatus')).toContain('offlineAnswers: followerGateway.ownAnswers()')
  })
})

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const inlined = new Function(`"use strict"; return (${createFollowerGateway.toString()})`)() as typeof createFollowerGateway

describe.each([['imported', createFollowerGateway], ['inlined', inlined]] as const)('own away answers counted (%s)', (_label, make) => {
  it('counts per op and per reason, with a log line each, and a snapshot the caller cannot change', () => {
    const logs: Array<{ msg: string; data?: Record<string, unknown> }> = []
    const g = make<object>({
      follower: () => null, mayWrite: () => false, now: () => 77, send: () => true, nextRelayId: () => 1, instanceId: 'i',
      attemptMs: () => 1_000, setTimer: () => 0, clearTimer: () => {}, log: (_l, msg, data) => { logs.push({ msg, data }) },
    })
    expect(g.ownAnswers()).toEqual({ total: 0, byOp: {}, byWhy: {}, last: null })
    g.noteOwnAnswer('task_send', 'handed_back', 'sid-1')
    g.noteOwnAnswer('task_send', 'handed_back', 'sid-1')
    g.noteOwnAnswer('search', 'follower_linked')
    const snap = g.ownAnswers()
    expect(snap).toEqual({ total: 3, byOp: { task_send: 2, search: 1 }, byWhy: { handed_back: 2, follower_linked: 1 }, last: { op: 'search', why: 'follower_linked', at: 77 } })
    snap.byOp.task_send = 99
    expect(g.ownAnswers().byOp.task_send).toBe(2)
    expect(logs.filter((l) => l.msg === 'gateway: daemon offline answer used')).toHaveLength(3)
    expect(logs[0]!.data).toMatchObject({ op: 'task_send', why: 'handed_back', callerSid: 'sid-1', total: 1 })
  })

  it('a hand-back of a session\'s call runs its fallback, which is where the daemon counts it', () => {
    const sock = { id: 1 }
    const g = make<typeof sock>({
      follower: () => sock, mayWrite: () => true, now: () => 0, send: () => true, nextRelayId: () => 5, instanceId: 'i',
      attemptMs: () => 1_000, setTimer: () => 0, clearTimer: () => {}, log: () => {},
    })
    let fellBack = 0
    g.handOff({ home: '/h', capability: 'tools.call', callerSid: 's', payload: { name: 'agent_memory_write' }, deadline: 0, fallback: () => { fellBack++; g.noteOwnAnswer('agent_memory_write', 'handed_back', 's') } }, () => {})
    expect(g.settle(sock, 5, g.responseOf({ error: 'needs the Mac', errorCode: 'needs_leader' }))).toBe('ok')
    expect(fellBack).toBe(1)
    expect(g.ownAnswers()).toMatchObject({ total: 1, byOp: { agent_memory_write: 1 }, byWhy: { handed_back: 1 } })
  })

  it('op names past the cap share one row, so the snapshot stays small', () => {
    const g = make<object>({
      follower: () => null, mayWrite: () => false, now: () => 0, send: () => true, nextRelayId: () => 1, instanceId: 'i',
      attemptMs: () => 1_000, setTimer: () => 0, clearTimer: () => {}, log: () => {},
    })
    for (let i = 0; i < 250; i++) g.noteOwnAnswer(`op_${i}`, 'follower_linked')
    const snap = g.ownAnswers()
    expect(Object.keys(snap.byOp)).toHaveLength(201)
    expect(snap.byOp['(other)']).toBe(50)
    expect(snap.total).toBe(250)
  })
})
