/**
 * The host call entry ('host-call-entry-v1') and the count of the daemon's own away answers are
 * wired into the daemon: the follower's entry socket kept from its hello and
 * report (through the shared core's socketOf), new sessions, ACP workers and plugin jobs given the
 * entry beside the socket (the core's envFor, a job's run retired when it ends), `follower.gateway`
 * checked for the caller's run token and run through the socket's own handleGatewayLine (never
 * serialized, never with a socket peer), and every own away answer given while a follower was
 * there counted (the gateway core's noteOwnOffline, one copy). The counter itself runs here.
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createFollowerGateway } from '../../src/providers/follower-gateway-core.js'
import { ADVERTISED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'
import { HOST_CALL_CAPABILITY } from '../../src/replica/host-call-entry.js'
import { daemonRuntimeText } from '../helpers/daemon-runtime-text.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const src = daemonRuntimeText()

function fnBody(src: string, name: string): string {
  const at = src.search(new RegExp(`^(async )?function ${name}\\(`, 'm'))
  expect(at, name).toBeGreaterThan(0)
  return src.slice(at, src.indexOf('\n}\n', at))
}

describe('host call entry daemon wiring', () => {
  it('is advertised, its cores are in the version hash and the binary build', () => {
    expect(ADVERTISED_DAEMON_CAPABILITIES as readonly string[]).toContain(HOST_CALL_CAPABILITY)
    for (const core of ['src/providers/host-call-token-core.ts', 'src/providers/host-call-client-core.ts']) {
      expect(read('src/providers/daemon-version-check.ts')).toContain(`'${core}'`)
      expect(read('scripts/build-daemon.sh')).toContain(core)
    }
    expect(src).toContain("from './host-call-token-core.js'")
    expect(read('src/providers/wn-cli.ts')).toContain("from './host-call-client-core.js'")
  })

  it('a follower may send follower.gateway, dispatched outside the serial queue', () => {
    const allowed = src.slice(src.indexOf('FOLLOWER_ALLOWED_COMMANDS = new Set(['), src.indexOf('])', src.indexOf('FOLLOWER_ALLOWED_COMMANDS = new Set([')))
    expect(allowed).toContain("'follower.gateway'")
    const line = src.split('\n').find((l) => l.includes("case 'follower.gateway':"))!
    expect(line).toBeTruthy()
    expect(line).not.toContain('daemonCommands.run')
  })

  it('the entry socket comes from the hello and the report, only for a follower that answers local calls, checked by the shared core', () => {
    expect(fnBody(src, 'cmdFollowerHello')).toMatch(/callSocket = cmd\.answersLocal === true \? hostCallTokens\.socketOf\(cmd\.callSocket\) : undefined/)
    const report = fnBody(src, 'cmdFollowerReport')
    expect(report).toMatch(/answersLocal === true \? hostCallTokens\.socketOf\(report\.callSocket\) : undefined/)
    // The core is given the follower's socket of a home, only for one that answers local calls.
    // A host server's own data dir names its leader's Walnut (walnutOfHome): its ACP and job starts name that dir.
    expect(src).toMatch(/socketFor: \(home\) => \{ const ws = followerHere\(home\)\.linked; return ws\?\.data\?\.answersLocal === true \? ws\.data\.callSocket : undefined/)
    expect(src).toMatch(/const linked = home \? followerSockets\.get\(home\) \?\? followerSockets\.get\(walnutOfHome\(home\)\) : undefined/)
    // No copy of the socket check or the env of its own in the daemon.
    for (const gone of ['function hostCallUrlOf(', 'function hostCallEnv(', 'function noteOwnOfflineAnswer(', 'WALNUT_CALL_URL']) expect(src, gone).not.toContain(gone)
  })

  it('follower.gateway checks the token for the line\'s sid, then runs the socket\'s handleGatewayLine', () => {
    const fn = fnBody(src, 'cmdFollowerGateway')
    const verify = fn.indexOf('hostCallTokens.verify(sid, cmd.token)')
    expect(verify).toBeGreaterThan(0)
    expect(fn).toContain("errorKind: 'bad_token'")
    expect(fn.indexOf('handleGatewayLine(line, respond')).toBeGreaterThan(verify)
    expect(fn).toMatch(/gatewayCallerLeft\.set\(respond/)
  })

  it('the daemon proves an approval\'s caller only from its gateway socket\'s kernel peer, never a pid a follower names', () => {
    expect(fnBody(src, 'sendSessionGatewayLine')).toContain('gatewayCallerProof(socketPeerPid(socket?.fd), callerSid, socket?.openedAt ?? Date.now())')
    const gw = fnBody(src, 'cmdFollowerGateway')
    // null: no socket, the token proved the sid (the line's session is not read off a process).
    expect(gw).toContain('handleGatewayLine(line, respond, null, openedAt)')
    expect(gw).not.toContain('peerPid')
  })

  // 2026-11-23: a plugin job started after its host's service named its entry posted every call
  // there; with no socket peer the daemon could not vouch for its run, so the leader capped each
  // bypass start at default. Only the gateway socket's kernel peer vouches for a job's run
  // (jobCallerVouched), so every other door into handleGatewayLine hands a job's line back first.
  // The whole class: every caller whose proof is the kernel's word on the process holding the
  // gateway socket. A door with no socket peer (the host call entry) cannot give that word, so each
  // read of the peer is listed here with its rule for such a door. A new read fails until it is.
  it('every read of a caller\'s process names its rule for a door with no socket peer', () => {
    const reads = [...src.matchAll(/(\w+)\(socketPeerPid\(/g)].map((m) => m[1]).sort()
    expect(reads, 'a new proof read from the socket peer: give it a rule for the host call entry and list it here').toEqual([
      'gatewayCallerIdentity', // a session's sid: the entry's run token proves it instead (fd null skips the read)
      'gatewayCallerProof', // an approval's caller proof: the entry hands the line back (caller_proof_on_socket)
      'jobCallerVouched', // a plugin job's run: follower.gateway hands the line back (job_on_socket)
    ])
    const gw = fnBody(src, 'handleGatewayLine')
    expect(gw.indexOf('if (fd === null) return sendSessionGatewayLine(')).toBeGreaterThan(0)
    expect(gw.indexOf('if (fd === null) return sendSessionGatewayLine(')).toBeLessThan(gw.indexOf('gatewayCallerIdentity(socketPeerPid(fd)'))
    const entry = read('src/replica/host-call-entry.ts')
    const proofBack = entry.indexOf("unavailable(res, 503, 'caller_proof_on_socket'")
    expect(proofBack).toBeGreaterThan(0)
    expect(proofBack).toBeLessThan(entry.indexOf("deps.request('follower.gateway'"))
    expect(fnBody(src, 'cmdFollowerGateway')).toContain("errorKind: 'job_on_socket'")
  })

  it('the daemon hands a plugin job\'s line back from every door that has no gateway socket peer', () => {
    // Every call, whatever its arguments are named (the definition left out): its third is the peer.
    const calls = [...src.matchAll(/(?<!function )handleGatewayLine\(\s*[^,()]+,\s*[^,()]+,\s*([^,)]+)/g)]
      .map((m) => Object.assign(m, { 1: m[1].trim() }))
    // Exactly the doors known today: the gateway socket and the host call entry. A new one fails here
    // until it is read for this rule and counted.
    expect(calls.map((c) => c[1]).sort()).toEqual(['null', 'socket.fd'])
    let doors = 0
    for (const call of calls) {
      if (call[1] === 'socket.fd') continue
      doors++
      const fnAt = src.lastIndexOf('\nfunction ', call.index)
      const body = src.slice(fnAt, call.index)
      const name = body.slice('\nfunction '.length, body.indexOf('('))
      const back = body.indexOf('if (pluginJobs.isRunSid(sid)) {')
      expect(back, `${name} runs a line with no socket peer (${call[1]}): it must hand a plugin job's line back first`).toBeGreaterThan(0)
      expect(body.slice(back, body.indexOf('\n  }\n', back)), name).toContain("errorKind: 'job_on_socket'")
    }
    // The socket's own door, and at least the host call entry's.
    expect(doors).toBeGreaterThanOrEqual(1)
    // The entry answers that refusal as `entry_unavailable` (nothing ran), which its client sends on the socket.
    const entry = read('src/replica/host-call-entry.ts')
    expect(entry).toContain("typeof reply.errorKind === 'string' ? reply.errorKind : 'refused'")
    expect(read('src/providers/host-call-client-core.ts')).toContain("parsed.code === 'entry_unavailable'")
  })

  it('a new session, an ACP worker and a plugin job get the entry beside the socket, and never an inherited one', () => {
    // Native spawn: cleared first, then this run's own, keyed by the Walnut's first home here
    // (a resumed record may still name a home that is now its alias: walnut-scope-core.ts), and a
    // host server's own data dir by the Walnut it follows (walnutOfHome).
    expect(src).toMatch(/WALNUT_CALL_SOCKET: undefined,\n\s+WALNUT_CALL_TOKEN: undefined,\n\s+\.\.\.hostCallTokens\.envFor\(startHome, sid\),/)
    expect(src).toMatch(/const startHome = spawnInfo\.home (\?\?|\|\|) \(?resumeRec/)
    // ACP worker: '' unsets, then the worker's own WALNUT_SESSION_ID.
    expect(src).toMatch(/WALNUT_CALL_SOCKET: '',\n\s+WALNUT_CALL_TOKEN: '',/)
    expect(src).toMatch(/const startHome = \(cmd as \{ home\?: unknown \}\)\.home\n/)
    expect(src).toMatch(/hostCallTokens\.envFor\(startHome, /)
    // Plugin jobs: the run id's own token, ended with the run.
    expect(src).toMatch(/callEnv: (\(home, sid\) => |function \(home, sid\) \{ return )hostCallTokens\.envFor\(home, sid\)/)
    expect(src).toMatch(/callEnvEnd: (\(sid\) => |function \(sid\) \{ )hostCallTokens\.retire\(sid\)/)
  })

  it('every own away answer is counted where it is given, and shown in follower.status and server.status', () => {
    const send = fnBody(src, 'sendGatewayRequest')
    const handles = send.split('offlineHost.handle(home, callerSid, capability, payload)').length - 1
    // One counter for the call (noteOwn), counted once even when the call waits and comes again.
    expect(send.split('followerGateway.noteOwnOffline(home, capability, callerSid, payload, plan.ownServerAsked)').length - 1).toBe(1)
    const notes = send.split(/noteOwn\(\);?\n/).length - 1
    expect(handles).toBeGreaterThanOrEqual(2)
    expect(notes).toBe(handles)
    // The own same-host delivery (handleLocal) too, while this host has a follower (linked or kept); an
    // online hand-back relayed to the leader is never counted (its fallback is relayToPrimary).
    expect(send).toContain("if (linked || kept) followerGateway.noteOwnAnswer(payload.name, linked ? 'follower_linked' : followerSaidOnline.get(home) === true ? 'follower_away' : 'same_host', callerSid)")
    // follower.status: the shared follower entry's view (follower-entry-core.ts) says what the daemon hands it.
    expect(src).toMatch(/offlineAnswers: (\(\) => |function \(\) \{ return )followerGateway\.ownAnswers\(\)/)
    expect(read('src/providers/follower-entry-core.ts')).toContain('offlineAnswers: deps.offlineAnswers(),')
    expect(fnBody(src, 'cmdServerStatus')).toContain('offlineAnswers: followerGateway.ownAnswers()')
  })
})

describe('own away answers counted', () => {
  const make = createFollowerGateway
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

  it('noteOwnOffline counts a hand-back, or a call while a follower may write, and nothing with no follower', () => {
    let linked = false
    const g = make<object>({
      follower: () => (linked ? {} : null), mayWrite: () => true, now: () => 0, send: () => true, nextRelayId: () => 1, instanceId: 'i',
      attemptMs: () => 1_000, setTimer: () => 0, clearTimer: () => {}, log: () => {},
    })
    g.noteOwnOffline('/h', 'tools.call', 's', { name: 'task_list' })
    expect(g.ownAnswers().total).toBe(0)
    g.noteOwnOffline('/h', 'tools.call', 's', { name: 'task_list' }, true)
    linked = true
    g.noteOwnOffline('/h', 'tools.call', 's', { name: 'search' })
    g.noteOwnOffline('/h', 'sessions.list', 's', {})
    expect(g.ownAnswers()).toMatchObject({ total: 3, byOp: { task_list: 1, search: 1, 'sessions.list': 1 }, byWhy: { handed_back: 1, follower_linked: 2 } })
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
