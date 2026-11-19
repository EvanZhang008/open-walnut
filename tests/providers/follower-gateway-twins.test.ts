/**
 * The hand-off of a host's `walnut` calls to its own Walnut server ('follower-gateway-v1',
 * follower-gateway-core.ts) is wired the same way in both daemon twins: the bun binary
 * imports the core, the JS source twin inlines its factory as text. This pins the wiring
 * (the follower's answer on its allowlist, the hello flag, the hand-off before the daemon's
 * own away answer, a plugin job's identity, the socket close, the task start of a follower,
 * the version and build lists) and runs the INLINED text, so a factory that grew a
 * module-scope reference fails here instead of on a host.
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createFollowerGateway } from '../../src/providers/follower-gateway-core.js'
import { ADVERTISED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const standalone = read('src/providers/daemon-standalone.ts')
const source = read('src/providers/daemon-source.ts')
const CORE = 'src/providers/follower-gateway-core.ts'

function setLiteral(src: string, name: string): string {
  const start = src.indexOf(name + ' = new Set([')
  expect(start, name).toBeGreaterThan(0)
  return src.slice(start, src.indexOf('])', start)).split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
}

describe('follower gateway twin wiring', () => {
  it('a follower may send its answer; the bridge may not get one from it', () => {
    for (const src of [standalone, source]) {
      expect(setLiteral(src, 'FOLLOWER_ALLOWED_COMMANDS')).toContain("'gateway-result'")
    }
  })

  it('both twins keep the hello flag, hand a call over before their own away answer, and end it with the socket', () => {
    for (const src of [standalone, source]) {
      expect(src).toMatch(/answersLocal = cmd\.answersLocal === true/)
      // A session's call: the follower first, its hand-back runs the same function again, marked.
      expect(src).toMatch(/!plan\.ownServerAsked && followerGateway\.answers\(home\)/)
      expect(src).toContain('ownServerAsked: true')
      // A plugin job's call: handed over with its job named, no fallback.
      expect(src).toMatch(/pluginJobs\.jobOfRun\(req\.sid\)/)
      expect(src).toMatch(/followerGateway\.routeJob\(\{ home(: home)?, capability(: capability)?, callerSid: EXTERNAL_CALLER_SID, payload(: payload)?, caller(: caller)?, deadline(: deadline)? \}/)
      // Its answer is taken only from that follower socket.
      expect(src).toContain('followerGateway.settle(ws, relayId, followerGateway.responseOf(')
      expect(src).toContain('followerGateway.dropSocket(ws)')
      // One rule for "away": the hand-off asks the same test follower.op applies.
      expect(src).toMatch(/mayWrite: (\(home\) => |function \(home\) \{ return )followerMayWrite\(home\)/)
      // A plugin job's call in the window waits for its leader or the follower, within its own deadline.
      expect(src).toContain('followerGateway.routeJob(')
      expect(src).toMatch(/relayToPrimary\(target, home, capability, EXTERNAL_CALLER_SID, payload, respond, false, deadline\)/)
    }
  })

  it('both twins start a task\'s plain session for a follower only for a Mac that drains task-start', () => {
    for (const src of [standalone, source]) {
      expect(src).toContain("cmd.run === 'task'")
      expect(src).toContain('offlineHost.checkTaskStart(home, sid, cmd.actor)')
      expect(src).toMatch(/taskRun \? hostStart\.planTask\(home, cmd/)
      expect(src).toContain("cmd.run === 'task' ? offlineHost.checkTaskStart(home, p.sid, cmd.actor) : offlineHost.checkSession(home, p.sid, cmd.actor)")
    }
  })

  it('the capability is advertised by both, and the core is in the version hash list and the binary build list', () => {
    expect(ADVERTISED_DAEMON_CAPABILITIES as readonly string[]).toContain('follower-gateway-v1')
    expect(read('src/providers/daemon-version-check.ts')).toContain(`'${CORE}'`)
    expect(read('scripts/build-daemon.sh')).toContain(CORE)
    expect(standalone).toContain("from './follower-gateway-core.js'")
  })

  it('the source twin carries the inlined factory, and the inlined text runs alone', () => {
    const generated = getDaemonSource()
    expect(generated).not.toContain('__CREATE_FOLLOWER_GATEWAY__')
    expect(generated).toContain('var followerGateway = (')
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const make = new Function(`"use strict"; return (${createFollowerGateway.toString()})`)() as typeof createFollowerGateway
    const sent: unknown[] = []
    const sock = { id: 1 }
    const g = make<typeof sock>({
      follower: () => sock, mayWrite: () => true, now: () => 0, send: (_ws, ev, data) => { sent.push({ ev, data }); return true }, nextRelayId: () => 9, instanceId: 'i',
      attemptMs: () => 1_000, setTimer: () => 0, clearTimer: () => {}, log: () => {},
    })
    let answer: unknown = null
    expect(g.handOff({ home: '/h', capability: 'tools.call', callerSid: 's', payload: { name: 'task_get' }, deadline: 0 }, (r) => { answer = r })).toBe(true)
    expect(g.settle(sock, 9, g.responseOf({ result: { ok: 1 } }))).toBe('ok')
    expect(answer).toEqual({ ok: true, result: { ok: 1 } })
    expect(sent).toHaveLength(1)
  })
})
