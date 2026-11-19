/**
 * A task's start and a message to a task by this host's own `walnut` calls while the Mac is
 * away (replica/away-starts.ts): the start only where the task would run (its project's
 * default host is this host, or it has a session here), the live session brake, a daemon
 * that cannot start it, and a message only to a task whose session runs here. A device never
 * gets these answers: its row answers needs_leader before the handler (route-table.ts).
 */
import { describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import { awayStarts, type AwayStartsDeps } from '../../src/replica/away-starts.js'
import type { ReplicaWrite, ReplicaWriteResult } from '../../src/replica/dispatch.js'
import type { PortAnswer, WriteActor, WritePort } from '../../src/replica/write-port.js'

const HOST = 'devbox'
const JOB: WriteActor = { kind: 'plugin-job', plugin: 'acme', job: 'sync' }

function harness(over: Partial<AwayStartsDeps> = {}, o: { start?: ReplicaWriteResult; live?: number } = {}) {
  const calls: Array<{ cmd: string; params: Record<string, unknown> }> = []
  const sends: Array<{ sid: string; text: string; framed?: boolean }> = []
  const w: ReplicaWrite = {
    opId: 'op-1', away: 'host-write', raw: Buffer.from(''),
    submit: vi.fn(),
    call: async (cmd, params) => { calls.push({ cmd, params }); return o.start ?? { kind: 'applied', reply: { sid: params.sid } } },
  }
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
  }
  const deps: AwayStartsDeps = {
    port, actorOf: () => JOB, hostKey: HOST,
    task: async (id) => (tasks[id] ? { ...tasks[id], id } as never : null),
    capabilities: () => ['replica-ops-v1', 'follower-gateway-v1'],
    request: async () => ({ ok: true, sessions: Array.from({ length: o.live ?? 0 }, (_, i) => ({ sid: `s${i}`, state: 'idle' })) }),
    sessionsOfTask: async (id) => (id === 't3' ? [{ sid: 'sid-3', host: HOST, startedAt: '2026-11-18T00:00:00Z' }] : []),
    projectMeta: async (p) => (p === 'Acme' ? { default_host: HOST, default_cwd: '/work/acme' } : { default_host: 'other-box' }),
    liveLimit: async () => 4,
    freshStart: async () => ({ mode: 'default', modeNamed: false, context: 'ctx for __WALNUT_ROUTINE_TASK_ID__' }),
    frame: async (text) => `[framed] ${text}`,
    watch: vi.fn(),
    randomUUID: () => '11111111-2222-4333-8444-555555555555',
    log: () => {},
    ...over,
  }
  const handler = awayStarts(deps)
  async function post(path: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const req = { method: 'POST', path, body, replicaWrite: w, headers: {} } as unknown as Request
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
    expect(r).toEqual({ status: 200, body: { taskId: 't1', sessionId: '11111111-2222-4333-8444-555555555555', started: true, offline: true } })
    expect(h.calls).toEqual([{ cmd: 'follower.start', params: expect.objectContaining({
      run: 'task', taskId: 't1', title: 'Sync the board', cwd: '/work/acme', mode: 'default', modeNamed: false,
      context: 'ctx for __WALNUT_ROUTINE_TASK_ID__', taskToken: '__WALNUT_ROUTINE_TASK_ID__', firstMessage: '[framed] go', host: HOST, actor: JOB,
    }) }])
    expect(h.deps.watch).toHaveBeenCalledWith('11111111-2222-4333-8444-555555555555', 't1')
  })

  it('a task that runs elsewhere needs the Mac, with why', async () => {
    const h = harness()
    expect((await h.post('/v1/tasks/t2/start', { message: 'go' })).body.error).toMatchObject({ code: 'needs_leader', why: 'task_runs_elsewhere' })
    expect((await h.post('/v1/tasks/t1/start', { message: 'go', host: 'other-box' })).body.error).toMatchObject({ why: 'task_runs_elsewhere' })
    expect((await h.post('/v1/tasks/t1/start', { message: 'go', expect_reply: true })).body.error).toMatchObject({ why: 'start_needs_mac', fields: ['expect_reply'] })
    expect(h.calls).toEqual([])
  })

  it('a task with its session here continues it: the message goes to that session', async () => {
    const h = harness()
    const r = await h.post('/v1/tasks/t3/start', { message: 'more' })
    expect(r.body).toMatchObject({ taskId: 't3', sessionId: 'sid-3', continued: true })
    expect(h.sends).toEqual([{ sid: 'sid-3', text: '[framed] more', framed: true }])
    expect(h.calls).toEqual([])
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

  it('a message to a task whose session runs here is delivered, framed as its sender\'s', async () => {
    const h = harness()
    const r = await h.post('/v1/messages', { to: 't3', text: 'tags changed' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ delivered: true, targetTaskId: 't3', targetSessionId: 'sid-3' })
    expect(h.sends).toEqual([{ sid: 'sid-3', text: '[framed] tags changed', framed: true }])
  })

  it('a message to a task with no session here, or one that asks for a reply, needs the Mac', async () => {
    const h = harness()
    expect((await h.post('/v1/messages', { to: 't1', text: 'hi' })).body.error).toMatchObject({ code: 'needs_leader', why: 'session_on_mac' })
    expect((await h.post('/v1/messages', { to: 't3', text: 'hi', expect_reply: true })).body.error).toMatchObject({ why: 'reply_needs_mac' })
    expect((await h.post('/v1/messages', { to: 't3', text: 'hi', in_reply_to: 'rq-abcdef' })).body.error).toMatchObject({ why: 'message_needs_mac' })
    expect(h.sends).toEqual([])
  })

  it('a device never starts or sends here', async () => {
    const h = harness({ actorOf: () => ({ kind: 'device', deviceId: 'd1' }) })
    expect((await h.post('/v1/tasks/t1/start', { message: 'go' })).body.error).toMatchObject({ code: 'needs_leader' })
    expect(h.calls).toEqual([])
  })
})
