/**
 * The host's session routes (src/core/session-channel/host-routes.ts) on the leader door
 * (src/replica/leader-door.ts), reached the way the Mac's streams reach it (sockets handed to
 * door.accept): the switch off refuses a new start (every route, with no routes at boot); `/call` runs only
 * members of HOST_CALL_ALLOWLIST; a start carries its bundle and its large prompt; the channel's
 * WebSocket carries the channel's frames.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from '#ws'
import { createLeaderDoor, type LeaderDoor } from '../../../src/replica/leader-door.js'
import { SPILL_TTL_MS, createHostSessionRoutes, type HostRunnerLike, type HostSessionRoutes } from '../../../src/core/session-channel/host-routes.js'
import { StartBundles } from '../../../src/core/session-channel/host-port.js'
import { FactLog } from '../../../src/core/session-channel/fact-log.js'
import { HostChannel, type ChannelFrame } from '../../../src/core/session-channel/channel.js'
import type { StartBundle } from '../../../src/core/session-channel/host-api.js'

let dir = ''
let door: LeaderDoor
let server: net.Server
let port = 0
let enabled = true
let routes: HostSessionRoutes | null
let log: FactLog
let channel: HostChannel
let bundles: StartBundles
const emitted: Array<{ name: string; data: unknown; source: string }> = []
const runnerCalls: string[] = []
let seenAtStart: { bundle: StartBundle | null; data: Record<string, unknown> } | null = null
let undone = 0
const dropped: string[][] = []
const terminated: Array<{ sid: string; opts: unknown }> = []

const session = {
  getUsage: async (n: number) => ({ tokens: n * 2 }),
  markExpectedTeardown: (reason: string) => { runnerCalls.push(`mark:${reason}`); return () => { undone++ } },
  bashCallMatching: (matches: (c: string) => boolean, taken: ReadonlySet<string>) => (matches('walnut task_update') && !taken.has('tu-1') ? 'tu-1' : undefined),
  transport: { prepareOutbound: async (t: string) => `${t} [prepared]` },
  secretMember: () => 'never',
}
const acp = { setModel: async (m: string) => { runnerCalls.push(`acp:${m}`); return { ok: true } } }
const runner: HostRunnerLike & Record<string, unknown> = {
  startSession: async (data) => {
    seenAtStart = { bundle: bundles.get(data.taskId), data }
    if (data.message === 'fail') throw Object.assign(new Error('no claude here'), { why: 'cli_missing' })
    if (data.message === 'up-then-throw') throw new Error('a step after the spawn failed')
    return { claudeSessionId: 'sid-started-1', title: 'Started' }
  },
  findSessionByClaudeId: (sid) => (sid === 'sid-1' || sid === '50000000-0000-4000-8000-0000000000b1' ? session : undefined),
  findAcpSession: (sid) => (sid === 'sid-acp' ? acp : undefined),
  syncTask: (sid: string, taskId: string) => { runnerCalls.push(`sync:${sid}:${taskId}`) },
  reinitialize: async () => 'reinit',
}

async function post(p: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() as Record<string, unknown> }
}

async function startDoor(withRoutes: boolean): Promise<void> {
  routes = withRoutes ? createHostSessionRoutes({
    enabled: async () => enabled, runner: async () => runner, bundles, channel: () => channel,
    emit: (name, data, source) => emitted.push({ name, data, source }),
    enqueue: async (sid, lines, source) => { emitted.push({ name: 'enqueue', data: { sid, lines }, source }) },
    spillDir: path.join(dir, 'prompts'),
    commandRunsOp: (c, op) => c.includes(op),
    drop: async (sids) => { dropped.push(sids); return sids.length },
    lifecycle: { terminateSession: async (sid, opts) => { terminated.push({ sid, opts }); return { status: 'terminated', sessionId: sid } } },
    owns: async (sid) => sid !== 'sid-leaders',
  }) : null
  door = createLeaderDoor({ devices: {} as never, sessions: () => routes })
  server = net.createServer((sock) => door.accept(sock))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as net.AddressInfo).port
}

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'host-routes-'))
  enabled = true
  emitted.length = 0
  runnerCalls.length = 0
  seenAtStart = null
  undone = 0
  dropped.length = 0
  terminated.length = 0
  bundles = new StartBundles()
  log = await FactLog.open({ dir: path.join(dir, 'log'), walnutId: 'w1', flushMs: 1, durable: false })
  channel = new HostChannel({ log, walnutId: 'w1', hostId: 'marina-box', ownRows: async () => [] })
})
afterEach(async () => {
  routes?.close()
  await door.close()
  await new Promise<void>((r) => server.close(() => r()))
  await log.close()
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('the switch off', () => {
  const offAnswer = { status: 503, body: { ok: false, error: 'host_runs_sessions_off' } }
  const channelStatus = async (): Promise<number> => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/host-api/session-channel`)
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      ws.on('open', () => resolve(101))
      ws.on('error', () => {})
    })
    ws.terminate()
    return status
  }

  it('with no routes at boot answers every route host_runs_sessions_off', async () => {
    enabled = false
    await startDoor(false)
    for (const op of ['start', 'send', 'interrupt', 'call']) {
      const r = await post(`/host-api/sessions/${op}`, { taskId: 't', message: 'm', sessionId: 's', sid: 's', target: 'session', member: 'getUsage' })
      expect(r).toEqual(offAnswer)
    }
    expect(emitted).toEqual([])
    expect(seenAtStart).toBeNull()
    expect(await channelStatus()).toBe(503)
  })

  it('switched off while the host runs sessions: refuses a new start, the sessions it runs keep their routes and the channel', async () => {
    enabled = false
    await startDoor(true)
    expect(await post('/host-api/sessions/start', { taskId: 't', message: 'm' })).toEqual(offAnswer)
    expect(seenAtStart).toBeNull()
    expect(await post('/host-api/sessions/send', { sessionId: 's', message: 'm' })).toEqual({ status: 200, body: { ok: true } })
    expect(await post('/host-api/sessions/interrupt', { sessionId: 's' })).toEqual({ status: 200, body: { ok: true } })
    expect(emitted.map((e) => e.name).filter((n) => n.startsWith('session:'))).toEqual(['session:send', 'session:interrupt'])
    expect(await channelStatus()).toBe(101)
  })

  it('the door\'s other routes answer as before', async () => {
    enabled = false
    await startDoor(true)
    const r = await fetch(`http://127.0.0.1:${port}/host-api/status`, { headers: { connection: 'close' } })
    expect(r.status).toBe(200)
    const x = await fetch(`http://127.0.0.1:${port}/elsewhere`, { headers: { connection: 'close' } })
    expect(x.status).toBe(404)
  })
})

describe('/call', () => {
  beforeEach(async () => { await startDoor(true) })

  it('runs only a member of the allowlist', async () => {
    expect(await post('/host-api/sessions/call', { sid: 'sid-1', target: 'session', member: 'secretMember' })).toEqual({ status: 403, body: { ok: false, error: 'not_allowed' } })
    expect((await post('/host-api/sessions/call', { sid: 'sid-1', target: 'runner', member: 'startSession', args: [{}] })).body).toEqual({ ok: false, error: 'not_allowed' })
    expect((await post('/host-api/sessions/call', { sid: 'sid-1', target: 'nowhere', member: 'getUsage' })).body).toEqual({ ok: false, error: 'not_allowed' })
    expect((await post('/host-api/sessions/call', { sid: 'sid-1', target: 'session', member: 'getUsage', args: [21] })).body).toEqual({ ok: true, value: { tokens: 42 } })
    expect((await post('/host-api/sessions/call', { sid: 'sid-acp', target: 'acp', member: 'setModel', args: ['opus'] })).body).toEqual({ ok: true, value: { ok: true } })
    // A runner member gets the body's sid first (host-calls.ts hostCallArgs): args never carry it.
    expect((await post('/host-api/sessions/call', { sid: 'sid-1', target: 'runner', member: 'syncTask', args: ['task-1'] })).body).toEqual({ ok: true, value: null })
    expect((await post('/host-api/sessions/call', { sid: 'sid-gone', target: 'session', member: 'getUsage' })).body).toEqual({ ok: false, error: 'no_live_session' })
    expect(runnerCalls).toEqual(['acp:opus', 'sync:sid-1:task-1'])
  })

  it('a call or an interrupt of a session this host does not own is refused before it reaches a process', async () => {
    expect(await post('/host-api/sessions/call', { sid: 'sid-leaders', target: 'session', member: 'getUsage', args: [1] })).toEqual({ status: 403, body: { ok: false, error: 'not_own_session' } })
    expect(await post('/host-api/sessions/call', { sid: 'sid-leaders', target: 'lifecycle', member: 'terminateSession', args: [{}] })).toEqual({ status: 403, body: { ok: false, error: 'not_own_session' } })
    expect((await post('/host-api/sessions/interrupt', { sessionId: 'sid-leaders' })).status).toBe(403)
    expect(terminated).toEqual([])
    expect(emitted.filter((e) => e.name === 'session:interrupt')).toEqual([])
  })

  it('MF2: a send to a session this host does not have is refused and queues nothing; one starting here is taken', async () => {
    const r = await post('/host-api/sessions/send', { sessionId: 'sid-leaders', queued: [{ id: 'qm-1', message: 'hi' }] })
    expect(r).toEqual({ status: 403, body: { ok: false, error: 'not_own_session' } })
    expect(emitted).toEqual([])
    // The same id while a start of it runs here (its bundle names it): the lines wait for it.
    bundles.put('start-1', 'task-1', { task: { id: 'task-1' } } as never, 'sid-leaders')
    expect(await post('/host-api/sessions/send', { sessionId: 'sid-leaders', queued: [{ id: 'qm-2', message: 'hi' }] })).toEqual({ status: 200, body: { ok: true } })
    expect(emitted.map((e) => e.name)).toEqual(['enqueue', 'session:send'])
  })

  it('an expected teardown gives back an undo the leader calls once', async () => {
    const r = await post('/host-api/sessions/call', { sid: 'sid-1', target: 'session', member: 'markExpectedTeardown', args: ['respawn'] })
    const undoId = (r.body.value as { undoId: string }).undoId
    expect(undoId).toMatch(/^[0-9a-f]{24}$/)
    expect((await post('/host-api/sessions/call', { sid: 'sid-1', target: 'session', member: 'undoExpectedTeardown', args: [undoId] })).body).toEqual({ ok: true, value: true })
    expect((await post('/host-api/sessions/call', { sid: 'sid-1', target: 'session', member: 'undoExpectedTeardown', args: [undoId] })).body).toEqual({ ok: true, value: false })
    expect(undone).toBe(1)
  })

  it('bashCallMatchingOp and prepareOutbound', async () => {
    expect((await post('/host-api/sessions/call', { sid: 'sid-1', target: 'session', member: 'bashCallMatchingOp', args: [{ op: 'task_update', taken: [] }] })).body).toEqual({ ok: true, value: 'tu-1' })
    expect((await post('/host-api/sessions/call', { sid: 'sid-1', target: 'session', member: 'bashCallMatchingOp', args: [{ op: 'task_update', taken: ['tu-1'] }] })).body).toEqual({ ok: true, value: null })
    expect((await post('/host-api/sessions/call', { sid: 'sid-1', target: 'session', member: 'prepareOutbound', args: ['hello'] })).body).toEqual({ ok: true, value: 'hello [prepared]' })
  })
})

describe('lifecycle and drop', () => {
  beforeEach(async () => { await startDoor(true) })

  it('a lifecycle control runs whole on this host for the session named, also with no live object of it', async () => {
    expect((await post('/host-api/sessions/call', { sid: 'sid-gone', target: 'lifecycle', member: 'terminateSession', args: [{ force: true }] })).body)
      .toEqual({ ok: true, value: { status: 'terminated', sessionId: 'sid-gone' } })
    expect(terminated).toEqual([{ sid: 'sid-gone', opts: { force: true } }])
    expect((await post('/host-api/sessions/call', { sid: 'sid-1', target: 'lifecycle', member: 'changeSessionMode', args: [] })).body).toEqual({ ok: false, error: 'not_allowed' })
  })

  it('drop hands the leader\'s deletes to this host, also with the switch off', async () => {
    enabled = false
    expect(await post('/host-api/sessions/drop', { sids: ['a', 'b', 7] })).toEqual({ status: 200, body: { ok: true, dropped: 2 } })
    expect(dropped).toEqual([['a', 'b']])
    expect((await post('/host-api/sessions/drop', {})).status).toBe(400)
  })
})

describe('start, send, interrupt', () => {
  beforeEach(async () => { await startDoor(true) })

  it('a start answers from its bundle, spills its large prompt here and never names a host to dial', async () => {
    const r = await post('/host-api/sessions/start', {
      taskId: 'task-1', message: 'hi', host: 'marina-box', largePrompt: 'L'.repeat(5000), preassignedSessionId: '50000000-0000-4000-8000-0000000000a1',
      startBundle: { sessionContext: { systemPrompt: 'leader prompt' }, hintsApplied: true }, busSource: 'chat',
    })
    expect(r.body).toEqual({ ok: true, sessionId: 'sid-started-1', title: 'Started' })
    expect(seenAtStart!.bundle).toEqual({ sessionContext: { systemPrompt: 'leader prompt' }, hintsApplied: true })
    expect(seenAtStart!.data.host).toBeUndefined()
    const spill = seenAtStart!.data.largePromptFile as { localPath: string; originalLength: number }
    expect(spill.originalLength).toBe(5000)
    expect(fs.readFileSync(spill.localPath, 'utf8')).toBe('L'.repeat(5000))
    expect(fs.statSync(spill.localPath).mode & 0o777).toBe(0o600)
    expect(bundles.get('task-1')).toBeNull()
  })

  it('a large prompt\'s message points at the host\'s own file, and old spilled prompts are swept', async () => {
    const dirOf = path.join(dir, 'prompts')
    fs.mkdirSync(dirOf, { recursive: true })
    const stale = path.join(dirOf, 'prompt-00aa.txt')
    fs.writeFileSync(stale, 'old')
    const old = (Date.now() - SPILL_TTL_MS - 60_000) / 1000
    fs.utimesSync(stale, old, old)
    const fresh = path.join(dirOf, 'prompt-00bb.txt')
    fs.writeFileSync(fresh, 'recent')
    const leaderPath = '/tmp/walnut-quick-start-1700000000000-abcd1234.md'
    await post('/host-api/sessions/start', {
      taskId: 'task-1', message: `User's full context has been saved to: ${leaderPath}\n(5,000 chars).`, largePrompt: 'L'.repeat(5000), largePromptPath: leaderPath,
    })
    const spill = seenAtStart!.data.largePromptFile as { localPath: string }
    expect(seenAtStart!.data.message).toBe(`User's full context has been saved to: ${spill.localPath}\n(5,000 chars).`)
    expect(String(seenAtStart!.data.message)).not.toContain(leaderPath)
    expect(seenAtStart!.data.largePromptPath).toBeUndefined()
    expect(fs.existsSync(stale)).toBe(false)
    expect(fs.existsSync(fresh)).toBe(true)
  })

  it('a preassigned session id that is not a v4 UUID is refused (it names a file here)', async () => {
    expect((await post('/host-api/sessions/start', { taskId: 'task-1', message: 'hi', preassignedSessionId: '../../etc/x' })).body).toMatchObject({ ok: false, why: 'bad_request' })
    expect(seenAtStart).toBeNull()
  })

  it('R2-H2: a start waits for its CLI\'s own word, and one that threw after its session came up is answered as taken', async () => {
    await post('/host-api/sessions/start', { taskId: 'task-1', message: 'hi' })
    expect(seenAtStart!.data.waitForSpawn).toBe(true)
    const up = '50000000-0000-4000-8000-0000000000b1'
    expect((await post('/host-api/sessions/start', { taskId: 'task-1', message: 'up-then-throw', preassignedSessionId: up })).body).toEqual({ ok: true, sessionId: up, title: '' })
    // With no session up, it is a refusal as before.
    expect((await post('/host-api/sessions/start', { taskId: 'task-1', message: 'up-then-throw', preassignedSessionId: '50000000-0000-4000-8000-0000000000b2' })).body).toMatchObject({ ok: false })
  })

  it('R2-M5: two starts of one task at once each read their own bundle, and the end of one leaves the other', async () => {
    const seen: Array<string | undefined> = []
    let releaseA: () => void = () => {}
    const slowA = new Promise<void>((r) => { releaseA = r })
    const original = runner.startSession
    runner.startSession = async (data) => {
      if (data.message === 'a') await slowA
      seen.push(`${data.message}:${bundles.get(data.taskId)?.sessionContext?.systemPrompt}`)
      if (data.message === 'b') { releaseA(); await new Promise((r) => setTimeout(r, 20)); seen.push(`b-after-a:${bundles.get(data.taskId)?.sessionContext?.systemPrompt}`) }
      return { claudeSessionId: String(data.preassignedSessionId), title: '' }
    }
    try {
      const a = post('/host-api/sessions/start', { taskId: 'task-two', message: 'a', preassignedSessionId: '50000000-0000-4000-8000-0000000000c1', startBundle: { sessionContext: { systemPrompt: 'A' }, hintsApplied: true } })
      await new Promise((r) => setTimeout(r, 30))
      const b = post('/host-api/sessions/start', { taskId: 'task-two', message: 'b', preassignedSessionId: '50000000-0000-4000-8000-0000000000c2', startBundle: { sessionContext: { systemPrompt: 'B' }, hintsApplied: true } })
      await Promise.all([a, b])
    } finally {
      runner.startSession = original
    }
    expect(seen).toContain('a:A')
    expect(seen).toContain('b:B')
    expect(seen).toContain('b-after-a:B')
    expect(bundles.get('task-two')).toBeNull()
  })

  it('R2-L2: an id that names a file or a session here is one plain name, never a path', async () => {
    for (const k of ['runtimeId', 'forkedFromSessionId', 'fromPlanSessionId']) {
      seenAtStart = null
      expect((await post('/host-api/sessions/start', { taskId: 'task-1', message: 'hi', [k]: '../../etc/passwd' })).body, k).toMatchObject({ ok: false, why: 'bad_request' })
      expect(seenAtStart).toBeNull()
    }
    expect((await post('/host-api/sessions/start', { taskId: 'task-1', message: 'hi', runtimeId: 'acp-0123abcd', forkedFromSessionId: '50000000-0000-4000-8000-0000000000a1' })).body).toMatchObject({ ok: true })
  })

  it('a failed start answers why', async () => {
    expect((await post('/host-api/sessions/start', { taskId: 'task-1', message: 'fail' })).body).toEqual({ ok: false, error: 'no claude here', why: 'cli_missing' })
    expect((await post('/host-api/sessions/start', { message: 'x' })).status).toBe(400)
  })

  it('send and interrupt are this host\'s bus events, with the leader\'s source; a send\'s lines are queued here first', async () => {
    expect((await post('/host-api/sessions/send', { sessionId: 'sid-1', message: 'go', busSource: 'chat' })).body).toEqual({ ok: true })
    expect((await post('/host-api/sessions/interrupt', { sessionId: 'sid-1' })).body).toEqual({ ok: true })
    // The leader's queued lines go to this host's queue under their ids; a kick with none queues nothing.
    const lines = [{ id: 'qm-1', message: 'go [hinted]', sentBy: 'person' }]
    expect((await post('/host-api/sessions/send', { sessionId: 'sid-1', message: 'go', queued: lines, busSource: 'chat' })).body).toEqual({ ok: true })
    expect((await post('/host-api/sessions/send', { sessionId: 'sid-1', message: '', queued: [] })).body).toEqual({ ok: true })
    expect(emitted).toEqual([
      // Made on this host (no lines from a leader): its own message is the line.
      { name: 'enqueue', data: { sid: 'sid-1', lines: [{ message: 'go' }] }, source: 'chat' },
      { name: 'session:send', data: { sessionId: 'sid-1', message: 'go' }, source: 'chat' },
      { name: 'session:interrupt', data: { sessionId: 'sid-1' }, source: 'host-api' },
      { name: 'enqueue', data: { sid: 'sid-1', lines }, source: 'chat' },
      { name: 'session:send', data: { sessionId: 'sid-1', message: 'go' }, source: 'chat' },
      { name: 'session:send', data: { sessionId: 'sid-1', message: '' }, source: 'host-api' },
    ])
  })
})

describe('the channel WebSocket', () => {
  it('carries the channel\'s frames: hello, a resume, the facts', async () => {
    await startDoor(true)
    log.append('sid-1', 'session:result', { sessionId: 'sid-1', result: 'before' })
    await log.flush()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/host-api/session-channel`)
    const frames: ChannelFrame[] = []
    ws.on('message', (raw) => frames.push(JSON.parse(String(raw)) as ChannelFrame))
    await new Promise<void>((r, j) => { ws.once('open', () => r()); ws.once('error', j) })
    const until = async (n: number) => { const end = Date.now() + 5000; while (frames.length < n) { if (Date.now() > end) throw new Error('no frames'); await new Promise((r) => setTimeout(r, 5)) } }
    await until(1)
    const hello = frames[0] as Extract<ChannelFrame, { op: 'hello' }>
    expect(hello).toMatchObject({ op: 'hello', walnutId: 'w1', hostId: 'marina-box', head: 1 })
    ws.send(JSON.stringify({ ch: 'sf', op: 'resume', walnutId: 'w1', hostId: 'marina-box', permitNumber: 1, logId: hello.logId, after: 0 }))
    await until(2)
    log.append('sid-1', 'session:result', { sessionId: 'sid-1', result: 'live' })
    await until(3)
    const facts = frames.slice(1).flatMap((f) => (f.op === 'facts' ? f.recs.map((r) => (r.data as { result: string }).result) : []))
    expect(facts).toEqual(['before', 'live'])
    ws.close()
  })
})
