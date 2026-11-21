/**
 * A task's start by this host's own `walnut` calls while the Mac is away
 * (replica/away-starts.ts; a message is away-sends.ts's, tests/replica/away-sends*.test.ts):
 * the start only where the task would run (its project's default host is this host, or it has
 * a session here), the live session brake, and a daemon that cannot start it. A device never
 * gets these answers: its row answers needs_leader before the handler (route-table.ts).
 * Only a task this host's journal made starts here alone (the Mac adopts no other's session),
 * a start's session id comes from its op id (a retry is the same start), concurrent starts
 * each take a slot of the brake before they start, and one start of a task runs at a time
 * (held before the task's sessions are read).
 */
import { describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Request, Response } from 'express'
import { awayStarts, startSessionId, type AwayStartsDeps } from '../../src/replica/away-starts.js'
import type { ReplicaWrite, ReplicaWriteResult } from '../../src/replica/dispatch.js'
import type { PortAnswer, WriteActor, WritePort } from '../../src/replica/write-port.js'

const HOST = 'devbox'
const JOB: WriteActor = { kind: 'plugin-job', plugin: 'acme', job: 'sync' }

const SID_1 = startSessionId('op-1', 't1')

function harness(over: Partial<AwayStartsDeps> = {}, o: { start?: ReplicaWriteResult; live?: number; gate?: Promise<void> } = {}) {
  const calls: Array<{ cmd: string; params: Record<string, unknown> }> = []
  const sends: Array<{ sid: string; text: string; framed?: boolean }> = []
  const writeOf = (opId: string): ReplicaWrite => ({
    opId, away: 'host-write', raw: Buffer.from(''),
    submit: vi.fn(),
    call: async (cmd, params) => {
      calls.push({ cmd, params })
      if (o.gate) await o.gate
      return o.start ?? { kind: 'applied', reply: { sid: params.sid } }
    },
  })
  const port = {
    send: async (_w: ReplicaWrite, sid: string, text: string, _m?: string, opts?: { framed?: boolean }): Promise<PortAnswer> => {
      sends.push({ sid, text, framed: opts?.framed })
      return { answered: false, status: 202, body: { delivered: true, messageId: 'qm-1', offline: true } }
    },
  } as unknown as WritePort
  const tasks: Record<string, Record<string, unknown>> = {
    t1: { id: 't1', title: 'Sync the board', project: 'Acme' },
    t2: { id: 't2', title: 'Elsewhere', project: 'Marina' },
    t3: { id: 't3', title: 'Has a session here', project: 'Marina' },
    t4: { id: 't4', title: 'Made on the Mac', project: 'Acme' },
    t5: { id: 't5', title: 'Also made here', project: 'Acme' },
  }
  const deps: AwayStartsDeps = {
    port, actorOf: () => JOB, hostKey: HOST,
    task: async (id) => (tasks[id] ? { ...tasks[id], id } as never : null),
    capabilities: () => ['replica-ops-v1', 'follower-gateway-v1'],
    request: async () => ({ ok: true, sessions: Array.from({ length: o.live ?? 0 }, (_, i) => ({ sid: `s${i}`, state: 'idle' })) }),
    sessionsOfTask: async (id) => (id === 't3' ? [{ sid: 'sid-3', host: HOST, startedAt: '2026-11-18T00:00:00Z' }] : []),
    projectMeta: async (p) => (p === 'Acme' ? { default_host: HOST, default_cwd: '/work/acme' } : { default_host: 'other-box' }),
    madeHere: (id) => id !== 't4',
    sessionExists: (task) => `Task "${task.title ?? ''}" is already started or starting.`,
    liveLimit: () => 4,
    freshStart: async () => ({ mode: 'default', modeNamed: false, context: 'ctx for __WALNUT_ROUTINE_TASK_ID__' }),
    frame: async (text) => `[framed] ${text}`,
    started: vi.fn(),
    log: () => {},
    ...over,
  }
  const handler = awayStarts(deps)
  async function post(path: string, body: Record<string, unknown>, opId = 'op-1'): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const req = { method: 'POST', path, body, replicaWrite: writeOf(opId), headers: {} } as unknown as Request
      let status = 0
      const res = {
        headersSent: false,
        setHeader: () => {},
        status(s: number) { status = s; return this },
        json(b: unknown) { resolve({ status, body: b }); return this },
      } as unknown as Response
      handler(req, res, () => reject(new Error('passed on')))
    })
  }
  return { post, calls, sends, deps }
}

describe('away starts', () => {
  it('a task of a project whose default host is this host starts here from the plain-session template', async () => {
    const h = harness()
    const r = await h.post('/v1/tasks/t1/start', { message: 'go' })
    expect(r).toEqual({ status: 200, body: { taskId: 't1', sessionId: SID_1, started: true, offline: true } })
    expect(h.calls).toEqual([{ cmd: 'follower.start', params: expect.objectContaining({
      run: 'task', sid: SID_1, taskId: 't1', title: 'Sync the board', cwd: '/work/acme', mode: 'default', modeNamed: false,
      context: 'ctx for __WALNUT_ROUTINE_TASK_ID__', taskToken: '__WALNUT_ROUTINE_TASK_ID__', firstMessage: '[framed] go', host: HOST, actor: JOB,
    }) }])
    // Shown here at once: a message right after the start finds the session on this host.
    expect(h.deps.started).toHaveBeenCalledWith({ sid: SID_1, taskId: 't1', cwd: '/work/acme', mode: 'default', title: 'Sync the board', project: 'Acme' })
  })

  it('a task this host did not make (made on the Mac) never starts here alone: the Mac would not adopt its session', async () => {
    const h = harness()
    const r = await h.post('/v1/tasks/t4/start', { message: 'go' })
    expect(r.status).toBe(503)
    expect(r.body.error).toMatchObject({ code: 'needs_leader', why: 'task_made_on_mac' })
    expect(h.calls).toEqual([])
    // One that already has its session here still continues it, wherever it was made.
    const has = harness({ madeHere: () => false })
    expect((await has.post('/v1/tasks/t3/start', { message: 'more' })).body).toMatchObject({ sessionId: 'sid-3', continued: true })
  })

  it('a start\'s session id comes from its op id: the same call asked again is the same start', async () => {
    expect(startSessionId('op-1', 't1')).toBe(SID_1)
    expect(SID_1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(startSessionId('op-2', 't1')).not.toBe(SID_1)
    expect(startSessionId('op-1', 't5')).not.toBe(SID_1)
    // This replica restarted, or the caller resent after a lost answer: the session it started is
    // listed for the task, so nothing is sent or started again.
    const h = harness({ sessionsOfTask: async (id) => (id === 't1' ? [{ sid: SID_1, host: HOST, startedAt: '2026-11-18T00:00:00Z' }] : []) })
    const r = await h.post('/v1/tasks/t1/start', { message: 'go' })
    expect(r.body).toEqual({ taskId: 't1', sessionId: SID_1, started: true, offline: true, duplicate: true })
    expect(h.calls).toEqual([])
    expect(h.sends).toEqual([])
    // Not listed yet (the copy lags): the daemon gets the same id again, and starts one session per id.
    const lag = harness()
    await lag.post('/v1/tasks/t1/start', { message: 'go' })
    await lag.post('/v1/tasks/t1/start', { message: 'go' })
    expect(lag.calls.map((c) => c.params.sid)).toEqual([SID_1, SID_1])
  })

  it('concurrent starts at the limit: each takes its slot before it starts, so only the ones that fit start', async () => {
    let open!: () => void
    const gate = new Promise<void>((r) => { open = r })
    const h = harness({}, { live: 3, gate })
    const a = h.post('/v1/tasks/t1/start', { message: 'go' }, 'op-a')
    const b = h.post('/v1/tasks/t5/start', { message: 'go' }, 'op-b')
    const second = await b
    expect(second.status).toBe(429)
    expect(second.body.error).toMatchObject({ code: 'throttled', why: 'live_limit' })
    open()
    expect((await a).status).toBe(200)
    expect(h.calls.map((c) => c.params.taskId)).toEqual(['t1'])
    // A start that ended gives its slot back.
    expect((await h.post('/v1/tasks/t5/start', { message: 'go' }, 'op-c')).status).toBe(200)
  })

  it('one start of a task at a time: held before its sessions are read, a second under another op id hears 409 and starts nothing', async () => {
    // The first start waits in its read of the task's sessions; the second comes in meanwhile.
    let open!: () => void
    const gate = new Promise<void>((r) => { open = r })
    let reads = 0
    const h = harness({ sessionsOfTask: async () => { if (reads++ === 0) await gate; return [] } })
    const first = h.post('/v1/tasks/t1/start', { message: 'go' }, 'op-a')
    const second = await h.post('/v1/tasks/t1/start', { message: 'go' }, 'op-b')
    expect(second).toEqual({ status: 409, body: { error: { code: 'session_exists', message: 'Task "Sync the board" is already started or starting.' }, existing_session_id: startSessionId('op-a', 't1') } })
    // The same op asked again is the same start: it goes on, and the daemon starts one session per id.
    const same = h.post('/v1/tasks/t1/start', { message: 'go' }, 'op-a')
    open()
    expect((await first).status).toBe(200)
    expect((await same).status).toBe(200)
    expect(h.calls.map((c) => c.params.sid)).toEqual([startSessionId('op-a', 't1'), startSessionId('op-a', 't1')])
    // Released with the start, also when it fails; another task is never held by it.
    const failing = harness({}, { start: { kind: 'refused', code: 'internal', message: 'spawn failed' } })
    expect((await failing.post('/v1/tasks/t1/start', { message: 'go' }, 'op-a')).status).toBe(503)
    expect((await failing.post('/v1/tasks/t1/start', { message: 'go' }, 'op-b')).status).toBe(503)
    expect(failing.calls).toHaveLength(2)
  })

  it('the brake reads this machine\'s memory only, never the Mac\'s copied setting (its local_live_limit, a 0 idle timeout)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/replica/away-starts.ts'), 'utf8')
    expect(src).toContain('liveLimit: () => memoryLiveLimit()')
    expect(src).not.toContain('localLiveLimit')
  })

  it('a retry right after a replica restart: the daemon already runs its session, so it is done, never held by the brake', async () => {
    // The overlay does not list the session yet; the daemon's own list names it, at the limit.
    const sessions = [SID_1, 's1', 's2', 's3'].map((sid) => ({ sid, state: 'working' }))
    const h = harness({ request: async () => ({ ok: true, sessions }) })
    const r = await h.post('/v1/tasks/t1/start', { message: 'go' })
    expect(r).toEqual({ status: 200, body: { taskId: 't1', sessionId: SID_1, started: true, offline: true, duplicate: true } })
    expect(h.calls).toEqual([])
  })

  it('the live count cannot be read: a retryable refusal that says nothing was started', async () => {
    const h = harness({ request: async () => { throw new Error('follower.sessions: timed out') } })
    const r = await h.post('/v1/tasks/t1/start', { message: 'go' })
    expect(r.status).toBe(429)
    expect(r.body.error).toMatchObject({ code: 'throttled', why: 'live_count_unread', retryAfter: 5 })
    expect(r.body.error.message).toContain('nothing was started')
    expect(h.calls).toEqual([])
  })

  it('a first start alone only while this host\'s journal still holds the create (one the Mac took may have been refused there)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/replica/away-starts.ts'), 'utf8')
    expect(src).toContain('madeHere: (taskId) => o.away.overlay.createPending(taskId)')
    expect(src).not.toContain('createdTaskIds')
  })

  it('a start that fails gives its slot back', async () => {
    const h = harness({}, { live: 3, start: { kind: 'refused', code: 'internal', message: 'spawn failed' } })
    expect((await h.post('/v1/tasks/t1/start', { message: 'go' }, 'op-a')).status).toBe(503)
    expect((await h.post('/v1/tasks/t5/start', { message: 'go' }, 'op-b')).status).toBe(503)
    expect(h.calls).toHaveLength(2)
  })

  it('a task that runs elsewhere needs the Mac, with why', async () => {
    const h = harness()
    expect((await h.post('/v1/tasks/t2/start', { message: 'go' })).body.error).toMatchObject({ code: 'needs_leader', why: 'task_runs_elsewhere' })
    expect((await h.post('/v1/tasks/t1/start', { message: 'go', host: 'other-box' })).body.error).toMatchObject({ why: 'task_runs_elsewhere' })
    expect((await h.post('/v1/tasks/t1/start', { message: 'go', expect_reply: true })).body.error).toMatchObject({ why: 'start_needs_mac', fields: ['expect_reply'] })
    expect(h.calls).toEqual([])
  })

  it('a task with its session here continues it: the message goes to that session, which is watched again', async () => {
    const continued = vi.fn()
    const h = harness({ continued })
    const r = await h.post('/v1/tasks/t3/start', { message: 'more' })
    expect(r.body).toMatchObject({ taskId: 't3', sessionId: 'sid-3', continued: true })
    expect(h.sends).toEqual([{ sid: 'sid-3', text: '[framed] more', framed: true }])
    expect(h.calls).toEqual([])
    // Its turn reaches the console and its task's readers, however long it sat idle.
    expect(continued).toHaveBeenCalledWith('sid-3')
  })

  it('the brake: this host runs its live session limit, so the start is refused for now and says why', async () => {
    const h = harness({}, { live: 4 })
    const r = await h.post('/v1/tasks/t1/start', { message: 'go' })
    expect(r.status).toBe(429)
    expect(r.body.error).toMatchObject({ code: 'throttled', why: 'live_limit', retryAfter: 60 })
    expect(h.calls).toEqual([])
  })

  it('a daemon that cannot start a task here, and an older Mac\'s refusal from the daemon, need the Mac', async () => {
    const old = harness({ capabilities: () => ['replica-ops-v1'] })
    expect((await old.post('/v1/tasks/t1/start', { message: 'go' })).body.error).toMatchObject({ code: 'needs_leader', why: 'daemon_needs_upgrade' })
    const olderMac = harness({}, { start: { kind: 'refused', code: 'needs_leader', message: 'your Mac runs an older Walnut', detail: { why: 'mac_too_old' } } })
    const r = await olderMac.post('/v1/tasks/t1/start', { message: 'go' })
    expect(r.status).toBe(503)
    expect(r.body.error).toMatchObject({ code: 'needs_leader', why: 'mac_too_old' })
  })

  it('a device never starts or sends here', async () => {
    const h = harness({ actorOf: () => ({ kind: 'device', deviceId: 'd1' }) })
    expect((await h.post('/v1/tasks/t1/start', { message: 'go' })).body.error).toMatchObject({ code: 'needs_leader' })
    expect(h.calls).toEqual([])
  })
})
