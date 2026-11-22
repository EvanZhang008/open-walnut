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
import { gatewayApiAnswerOf } from '../../src/providers/gateway-core.js'

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
      // A plugin job's call: handed over with its job named, no fallback. One builder of that name
      // (plugin-jobs-core.ts callerOfRun) for the follower and the leader alike.
      expect(src).toMatch(/pluginJobs\.callerOfRun\(req\.sid\)/)
      expect(src).not.toMatch(/kind: 'plugin-job', plugin: job\.plugin/)
      expect(src).toMatch(/followerGateway\.routeJob\(\{ home(: home)?, capability(: capability)?, callerSid: EXTERNAL_CALLER_SID, payload(: payload)?, caller(: caller)?, deadline(: deadline)? \}/)
      // Its answer is taken only from that follower socket.
      expect(src).toContain('followerGateway.settle(ws, relayId, followerGateway.responseOf(')
      expect(src).toContain('followerGateway.dropSocket(ws)')
      // One rule for "away": the hand-off asks the same test follower.op applies.
      expect(src).toMatch(/mayWrite: (\(home\) => |function \(home\) \{ return )followerEntry\.mayWrite\(home\)/)
      // A final refusal goes on to the companion while it leads (its forward is on the daemon's path).
      expect(src).toMatch(/leaderElsewhere: (\(home\) => |function \(home\) \{ return )leaderBook\.backupLead\(home\) !== null/)
      // A plugin job's call in the window waits for its leader or the follower, within its own deadline.
      expect(src).toContain('followerGateway.routeJob(')
      // To the leader it names the same job, in the same `caller` frame field, on every attempt.
      expect(src).toMatch(/relayToPrimary\(target, home, capability, EXTERNAL_CALLER_SID, payload, respond, false, deadline, caller\)/)
    }
  })

  it('both twins end a same-host send\'s unanswered hand-off at the leader that answers now, else with their own away answer', () => {
    for (const src of [standalone, source]) {
      const at = src.indexOf('offlineHost.endOnline(home, payload)')
      expect(at, 'the online hand-off\'s end').toBeGreaterThan(0)
      const end = src.slice(at, src.indexOf('followerGateway.handOff(', at))
      // Never the leader captured when the call came (its link may have closed during the hand-off:
      // a relay there, with the hand-off's time spent, was lost; tests/e2e/replica-cluster-handoff-cut-e2e.test.ts).
      expect(end).not.toMatch(/relay\(\)/)
      expect(end).toMatch(/(const|var) leader = gatewayTargetFor\(home\)/)
      expect(end).toMatch(/relayToPrimary\(leader, home, capability, callerSid, payload, respond, readable, deadline\)/)
      // No leader: the same function again, marked, so the follower (whose hand-off ended) is not asked.
      expect(end).toMatch(/sendGatewayRequest\(capability, callerSid, payload, respond, (\{ \.\.\.plan, ownServerAsked: true \}|Object\.assign\(\{\}, plan, \{ ownServerAsked: true \}\))\)/)
    }
  })

  it('both twins end a plugin job\'s waiting call when its caller left or the daemon stops, and never wait while a backup leads', () => {
    for (const src of [standalone, source]) {
      const fn = src.slice(src.indexOf('function sendPluginJobGatewayRequest('), src.indexOf('\n}\n', src.indexOf('function sendPluginJobGatewayRequest(')))
      const again = fn.slice(fn.indexOf('again = '), fn.indexOf('followerGateway.routeJob('))
      expect(again).toContain('daemonCommands.closed')
      expect(again).toMatch(/gatewayCallerLeft\.get\(respond\)/)
      // Checked before the call is routed again, so a write is never relayed for a caller gone.
      expect(again.indexOf('gatewayCallerLeft')).toBeLessThan(again.indexOf('sendPluginJobGatewayRequest('))
      expect(fn).toContain('if (caller && !leaderBook.backupLead(home))')
      // A call that waited and found no one says what it waited for, and that nothing was done.
      expect(fn).toContain('this call waited for it to answer again')
    }
  })

  it('both twins start a task\'s plain session for a follower only for a Mac that drains task-start', () => {
    // follower.start runs in the follower entry both twins share (follower-entry-core.ts start).
    for (const src of [standalone, source]) {
      expect(src).toMatch(/followerEntry\.start\(home, cmd\)/)
      expect(src).toMatch(/offline: offlineHost, hostStart(: hostStart)?,/)
    }
    const entry = read('src/providers/follower-entry-core.ts')
    expect(entry).toContain("const taskRun = cmd.run === 'task'")
    expect(entry).toContain('offline.checkTaskStart(home, sid, cmd.actor)')
    expect(entry).toMatch(/taskRun \? hostStart\.planTask\(home, cmd/)
    expect(entry).toContain("cmd.run === 'task' ? offline.checkTaskStart(home, p.sid, cmd.actor) : offline.checkSession(home, p.sid, cmd.actor)")
  })

  it('both twins read a gateway result\'s api one way, before either branch: the follower\'s answer too', () => {
    const body = (src: string) => src.slice(src.indexOf('function cmdGatewayResult('), src.indexOf('\n}\n', src.indexOf('function cmdGatewayResult(')))
    for (const src of [standalone, source]) {
      const fn = body(src)
      const read = fn.indexOf('gatewayApiAnswerOf(cmd.api)')
      expect(read, 'the api is read through gatewayApiAnswerOf').toBeGreaterThan(0)
      expect(read, 'before the follower branch').toBeLessThan(fn.indexOf("origin === 'follower'"))
      expect(fn).not.toContain('api: cmd.api')
      expect(fn).not.toMatch(/apiAnswer\.status/)
    }
    // The source twin runs the very function the bun twin imports.
    const generated = getDaemonSource()
    expect(generated).not.toContain('__GATEWAY_API_ANSWER_OF__')
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const inlined = new Function(`"use strict"; return (${gatewayApiAnswerOf.toString()})`)() as typeof gatewayApiAnswerOf
    for (const raw of [{ status: 503, code: 'needs_leader' }, { status: 503, code: 'Not A Code!' }, { status: 99 }, { status: '507' }, null, 'x', { status: 507, code: 'disk_full', extra: 1 }]) {
      expect(inlined(raw)).toEqual(gatewayApiAnswerOf(raw))
    }
    expect(generated).toContain(`var gatewayApiAnswerOf = (${gatewayApiAnswerOf.toString()})`)
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
