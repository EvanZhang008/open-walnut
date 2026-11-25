/**
 * The hand-off of a host's `walnut` calls to its own Walnut server ('follower-gateway-v1',
 * follower-gateway-core.ts) as daemon-standalone.ts wires it. This pins the wiring (the
 * follower's answer on its allowlist, the hello flag, the hand-off before the daemon's own
 * away answer, a plugin job's identity, the socket close, the task start of a follower, the
 * version and build lists).
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ADVERTISED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const src = read('src/providers/daemon-standalone.ts')
const CORE = 'src/providers/follower-gateway-core.ts'

function setLiteral(src: string, name: string): string {
  const start = src.indexOf(name + ' = new Set([')
  expect(start, name).toBeGreaterThan(0)
  return src.slice(start, src.indexOf('])', start)).split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
}

describe('follower gateway daemon wiring', () => {
  it('a follower may send its answer; the bridge may not get one from it', () => {
    expect(setLiteral(src, 'FOLLOWER_ALLOWED_COMMANDS')).toContain("'gateway-result'")
  })

  it('the daemon keeps the hello flag, hands a call over before its own away answer, and end it with the socket', () => {
    expect(src).toMatch(/answersLocal = cmd\.answersLocal === true/)
    // A session's call: the follower first, its hand-back runs the same function again, marked.
    expect(src).toMatch(/\(!external \|\| readable\) && !plan\.ownServerAsked\n/)
    expect(src).toContain('if (home && followers && followerGateway.answers(home)) {')
    expect(src).toContain('ownServerAsked: true')
    // A plugin job's call: handed over with its job named, no fallback. One builder of that name
    // (plugin-jobs-core.ts callerOfRun) for the follower and the leader alike.
    expect(src).toMatch(/pluginJobs\.callerOfRun\(req\.sid\)/)
    expect(src).not.toMatch(/kind: 'plugin-job', plugin: job\.plugin/)
    expect(src).toMatch(/followerGateway\.routeJob\(\{ home(: home)?, capability(: capability)?, callerSid: EXTERNAL_CALLER_SID, payload(: payload)?, caller(: caller)?, deadline(: deadline)?, left(: leftOf)? \}/)
    // A call handed again after a lagging refusal ends as a first hand would: its caller gone, or the daemon stopping.
    expect(src).toMatch(/followerGateway\.handOff\(\{ home(: home)?, capability(: capability)?, callerSid(: callerSid)?, payload(: payload)?, deadline(: deadline)?, readable(: ownReadable)?, fallback(: fallback)?, left(: leftOf)?(, \.\.\.\(noOwn \? \{ noOwnAnswer: true as const \} : \{\}\))? \}/)
    expect(src).toMatch(/stopping: (\(\) => |function \(\) \{ return )daemonCommands\.closed/)
    // Its answer is taken only from that follower socket.
    expect(src).toContain('followerGateway.settle(ws, relayId, followerGateway.responseOf(')
    expect(src).toContain('followerGateway.dropSocket(ws)')
    // One rule for "away": the hand-off asks the same test follower.op applies.
    expect(src).toMatch(/mayWrite: (\(home\) => |function \(home\) \{ return )followerEntry\.mayWrite\(home\)/)
    // A final refusal goes to the companion while it leads, on its link, and is held for the Mac
    // when it takes nothing either: never the daemon's own away answer (follower-gateway-core.ts askElsewhere).
    expect(src).toMatch(/leaderElsewhere: (\(home\) => |function \(home\) \{ return )leaderBook\.backupLead\(home\) !== null/)
    expect(src).toMatch(/relayElsewhere: (\(call, answer, timeoutMs\) => |function \(call, answer, timeoutMs\) \{ return )forwardToBackup\(call\.home, call\.capability, call\.callerSid, call\.payload, answer, timeoutMs\)/)
    // ...waiting for it only what is left of the call's deadline (the hub's own timeout is only the default).
    expect(src).toMatch(/timeoutMs \?\? gatewayHubTimeoutMs\(\)|typeof timeoutMs === 'number' \? timeoutMs : GATEWAY_HUB_TIMEOUT_MS/)
    // Under the gateway's own least relay time nothing is asked of it.
    expect(src).toMatch(/minRelayMs: GATEWAY_MIN_RELAY_MS,/)
    // ...telling the companion that rest (answerInMs), and a timeout says the call may have run.
    expect(src).toMatch(/answerInMs: (timeoutMs|typeof timeoutMs === 'number' \? timeoutMs : undefined),/)
    expect(src).toContain('did not answer in time; the call may have run, read before trying again')
    expect(src).toMatch(/holdForLeader: (\(call\) => \(ownAnswersOff\(call\.home\) \? null : |function \(call\) \{ return )offlineHost\.holdWrite\(call\.home, call\.callerSid, call\.capability, call\.payload\)/)
    // A session's call while the leader still takes this host's journal goes to the follower too, and
    // so does an outside caller's read (D2: never answered from the copy while a follower answers).
    expect(src).toContain('const followers = !!home && (!target || offlineHost.pendingHandover(home)) && (!external || readable) && !plan.ownServerAsked')
    // The daemon's own away answer is counted once per call, a call that waited and came again included.
    expect(src.match(/followerGateway\.noteOwnOffline\(/g)).toHaveLength(1)
    // (the plan a waiting call goes again with: its own, or the one an identify wait moved, `p`)
    expect(src).toMatch(/noted \? (\{ \.\.\.(plan|p), ownAnswerNoted: true \}|Object\.assign\(\{\}, (plan|p), \{ ownAnswerNoted: true \}\)) : (plan|p)\b/)
    // A plugin job's call in the window waits for its leader or the follower, within its own deadline.
    expect(src).toContain('followerGateway.routeJob(')
    // To the leader it names the same job, in the same `caller` frame field, on every attempt.
    expect(src).toMatch(/relayToPrimary\(target, home, capability, EXTERNAL_CALLER_SID, payload, respond, false, deadline, caller\)/)
  })

  it('the daemon ends a same-host send\'s unanswered hand-off at the leader that answers now, else with its own away answer', () => {
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
  })

  it('the daemon ends a plugin job\'s waiting call when its caller left or the daemon stops, and hands it to this host\'s server while a backup leads', () => {
    const fn = src.slice(src.indexOf('function sendPluginJobGatewayRequest('), src.indexOf('\n}\n', src.indexOf('function sendPluginJobGatewayRequest(')))
    const again = fn.slice(fn.indexOf('again = '), fn.indexOf('followerGateway.routeJob('))
    expect(again).toContain('daemonCommands.closed')
    expect(again).toMatch(/gatewayCallerLeft\.get\(respond\)/)
    // Checked before the call is routed again, so a write is never relayed for a caller gone.
    expect(again.indexOf('gatewayCallerLeft')).toBeLessThan(again.indexOf('sendPluginJobGatewayRequest('))
    // 2026-11-25: the companion leading skipped this host's server, and every job call was refused.
    // Its refusal stands: routeJob gets no fallback, so the companion never runs a job's call unnamed.
    expect(fn).toContain('if (caller) {')
    expect(fn).not.toMatch(/if \(caller && !leaderBook\.backupLead/)
    expect(fn.slice(fn.indexOf('followerGateway.routeJob('), fn.indexOf('\n', fn.indexOf('followerGateway.routeJob(')))).not.toContain('fallback')
    // A call that waited and found no one says what it waited for, and that nothing was done.
    expect(fn).toContain('this call waited for it to answer again')
  })

  it('the daemon starts a task\'s plain session for a follower only for a Mac that drains task-start', () => {
    // follower.start runs in the shared follower entry (follower-entry-core.ts start).
    expect(src).toMatch(/followerEntry\.start\(home, cmd\)/)
    expect(src).toMatch(/offline: offlineHost, hostStart(: hostStart)?,/)
    const entry = read('src/providers/follower-entry-core.ts')
    expect(entry).toContain("const taskRun = cmd.run === 'task'")
    expect(entry).toContain('offline.checkTaskStart(home, sid, cmd.actor)')
    expect(entry).toMatch(/taskRun \? hostStart\.planTask\(home, cmd/)
    expect(entry).toContain("cmd.run === 'task' ? offline.checkTaskStart(home, p.sid, cmd.actor) : offline.checkSession(home, p.sid, cmd.actor)")
  })

  it('the daemon reads a gateway result\'s api one way, before either branch: the follower\'s answer too', () => {
    const body = (src: string) => src.slice(src.indexOf('function cmdGatewayResult('), src.indexOf('\n}\n', src.indexOf('function cmdGatewayResult(')))
    const fn = body(src)
    const read = fn.indexOf('gatewayApiAnswerOf(cmd.api)')
    expect(read, 'the api is read through gatewayApiAnswerOf').toBeGreaterThan(0)
    expect(read, 'before the follower branch').toBeLessThan(fn.indexOf("origin === 'follower'"))
    expect(fn).not.toContain('api: cmd.api')
    expect(fn).not.toMatch(/apiAnswer\.status/)
  })

  it('the capability is advertised, and the core is in the version hash list and the binary build list', () => {
    expect(ADVERTISED_DAEMON_CAPABILITIES as readonly string[]).toContain('follower-gateway-v1')
    expect(read('src/providers/daemon-version-check.ts')).toContain(`'${CORE}'`)
    expect(read('scripts/build-daemon.sh')).toContain(CORE)
    expect(src).toContain("from './follower-gateway-core.js'")
  })
})
