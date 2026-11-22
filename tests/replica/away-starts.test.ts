/**
 * A task's start by this host's own `walnut` calls while the Mac is away
 * (replica/away-starts.ts; a message is away-sends.ts's, tests/replica/away-sends*.test.ts):
 * the start only where the task would run (its project's default host is this host, or it has
 * a session here), the live session brake, and a daemon that cannot start it. A device never
 * gets these answers: its row answers needs_leader before the handler (route-table.ts).
 * Only a task this host's journal made starts here alone (the Mac adopts no other's session),
 * a start's session id comes from its op id (a retry is the same start), concurrent starts
 * each take a slot of the brake before they start, and one start of a task runs at a time
 * (held before the task's sessions are read). The mode meets the Mac's start-mode ceiling
 * (start-ceiling.ts): a session starts work at most as loose as its own mode, and a plugin job only
 * its host's daemon vouched for goes uncapped.
 */
import { describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Request, Response } from 'express'
import { awayStarts, startSessionId, type AwayStartsDeps } from '../../src/replica/away-starts.js'
import type { ReplicaWrite, ReplicaWriteResult } from '../../src/replica/dispatch.js'
import type { PortAnswer, WriteActor, WritePort } from '../../src/replica/write-port.js'
import { awayStartCaller, replicaStartCaller, type StartCallerDeps } from '../../src/replica/start-ceiling.js'
import { applyStartModeCeiling } from '../../src/core/sessions/delegated-mode.js'
import { holdRelayJob, _clearRelayJobsForTesting } from '../../src/core/plugin-jobs/job-caller.js'
import { getSelfCallToken, setSelfApiRoot } from '../../src/lib/self-api-root.js'
import { hostOrigin } from '../../src/lib/caller-origin.js'
import type { IncomingMessage } from 'node:http'

const HOST = 'devbox'
const JOB: WriteActor = { kind: 'plugin-job', plugin: 'acme', job: 'sync' }

const SID_1 = startSessionId('op-1', 't1')
/** The job's own daemon vouched for it (its in-process token): no ceiling, as on the Mac. */
const VOUCHED: StartCallerDeps = { sessionMode: async () => undefined, vouchedJob: () => ({ plugin: 'acme', job: 'sync', host: HOST }) }
/** A session of each mode (an unknown one reads none). */
const SESSIONS: StartCallerDeps = { sessionMode: async (sid) => ({ 'sess-default': 'default', 'sess-bypass': 'bypass', 'sess-plan': 'plan' } as Record<string, string>)[sid], vouchedJob: () => null }
const asSession = (sid: string): Partial<AwayStartsDeps> => ({ actorOf: () => ({ kind: 'session', sid }), startCaller: SESSIONS })

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
    startCaller: VOUCHED,
    started: vi.fn(),
    log: () => {},
    ...over,
  }
  const handler = awayStarts(deps)
  async function post(path: string, body: Record<string, unknown>, opId = 'op-1', headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const req = { method: 'POST', path, body, replicaWrite: writeOf(opId), headers } as unknown as Request
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

  describe('the Mac\'s start-mode ceiling', () => {
    const REFUSED = 'A default session cannot start a task in bypass mode. Change the caller\'s mode first.'

    it('a default session asking bypass: the Mac\'s 403 with its words, final, and nothing sent to the daemon', async () => {
      const h = harness(asSession('sess-default'))
      const r = await h.post('/v1/tasks/t1/start', { message: 'go', mode: 'bypass' })
      expect(r).toEqual({ status: 403, body: { error: { code: 'bad_request', message: REFUSED } } })
      expect(h.calls).toEqual([])
      // Also on a task whose session runs here: the ceiling comes before anything else, as on the Mac.
      expect((await h.post('/v1/tasks/t3/start', { message: 'more', mode: 'bypass' })).status).toBe(403)
      expect(h.sends).toEqual([])
    })

    it('a default session naming no mode, its project defaulting to bypass: started in default, named', async () => {
      const h = harness({ ...asSession('sess-default'), freshStart: async () => ({ mode: 'bypass', modeNamed: true, context: 'ctx' }) })
      expect((await h.post('/v1/tasks/t1/start', { message: 'go' })).status).toBe(200)
      expect(h.calls[0]!.params).toMatchObject({ mode: 'default', modeNamed: true })
      expect(h.deps.started).toHaveBeenCalledWith(expect.objectContaining({ mode: 'default' }))
      // The engine's own setting would be bypass: the mode is still named, so the CLI never falls to it.
      const engine = harness({ ...asSession('sess-default'), freshStart: async () => ({ mode: 'bypass', modeNamed: false, context: 'ctx' }) })
      await engine.post('/v1/tasks/t1/start', { message: 'go' })
      expect(engine.calls[0]!.params).toMatchObject({ mode: 'default', modeNamed: true })
      // A stricter session gives its own mode, as the Mac's task start does.
      const plan = harness({ ...asSession('sess-plan'), freshStart: async () => ({ mode: 'bypass', modeNamed: true, context: 'ctx' }) })
      await plan.post('/v1/tasks/t1/start', { message: 'go' })
      expect(plan.calls[0]!.params).toMatchObject({ mode: 'plan', modeNamed: true })
    })

    it('a bypass session asking bypass starts in bypass; naming none, the project\'s own default stands', async () => {
      const h = harness(asSession('sess-bypass'))
      expect((await h.post('/v1/tasks/t1/start', { message: 'go', mode: 'bypass' })).status).toBe(200)
      expect(h.calls[0]!.params).toMatchObject({ mode: 'bypass', modeNamed: true })
      const none = harness({ ...asSession('sess-bypass'), freshStart: async () => ({ mode: 'accept', modeNamed: false, context: 'ctx' }) })
      await none.post('/v1/tasks/t1/start', { message: 'go' })
      expect(none.calls[0]!.params).toMatchObject({ mode: 'accept', modeNamed: false })
    })

    it('a session whose mode cannot be read is a default one (fail closed)', async () => {
      for (const sessionMode of [async () => undefined, async () => { throw new Error('copy unreadable') }]) {
        const deps = { actorOf: () => ({ kind: 'session' as const, sid: 'sess-unknown' }), startCaller: { sessionMode, vouchedJob: () => null } }
        const asks = harness(deps)
        expect(await asks.post('/v1/tasks/t1/start', { message: 'go', mode: 'bypass' })).toEqual({ status: 403, body: { error: { code: 'bad_request', message: REFUSED } } })
        const none = harness({ ...deps, freshStart: async () => ({ mode: 'bypass', modeNamed: true, context: 'ctx' }) })
        await none.post('/v1/tasks/t1/start', { message: 'go' })
        expect(none.calls[0]!.params).toMatchObject({ mode: 'default', modeNamed: true })
      }
    })

    it('a plugin job its daemon vouched for starts in bypass; one it did not (or another job\'s token) is an outside caller', async () => {
      const vouched = harness()
      expect((await vouched.post('/v1/tasks/t1/start', { message: 'go', mode: 'bypass' })).status).toBe(200)
      expect(vouched.calls[0]!.params).toMatchObject({ mode: 'bypass', modeNamed: true })
      for (const vouchedJob of [() => null, () => ({ plugin: 'acme', job: 'other', host: HOST })]) {
        const h = harness({ startCaller: { sessionMode: async () => undefined, vouchedJob } })
        const r = await h.post('/v1/tasks/t1/start', { message: 'go', mode: 'bypass' })
        expect(r).toEqual({ status: 403, body: { error: { code: 'bad_request', message: REFUSED } } })
        expect(h.calls).toEqual([])
      }
    })

    // The host's daemon could not prove the session sid (src/lib/caller-unproven.ts): this replica's
    // own self-calls for the relayed call carry the mark, and the caller is an outside one.
    it('a call marked unproven is an outside caller, even naming a bypass session\'s sid or a vouched job', async () => {
      const UNPROVEN = { 'x-walnut-caller-unproven': '1' }
      const h = harness(asSession('sess-bypass'))
      expect(await h.post('/v1/tasks/t1/start', { message: 'go', mode: 'bypass' }, 'op-1', UNPROVEN)).toEqual({ status: 403, body: { error: { code: 'bad_request', message: REFUSED } } })
      expect(h.calls).toEqual([])
      const none = harness({ ...asSession('sess-bypass'), freshStart: async () => ({ mode: 'bypass', modeNamed: true, context: 'ctx' }) })
      expect((await none.post('/v1/tasks/t1/start', { message: 'go' }, 'op-1', UNPROVEN)).status).toBe(200)
      expect(none.calls[0]!.params).toMatchObject({ mode: 'default', modeNamed: true })
      // The same session without the mark keeps its own ceiling.
      expect((await harness(asSession('sess-bypass')).post('/v1/tasks/t1/start', { message: 'go', mode: 'bypass' }, 'op-2')).status).toBe(200)
      // The vouched job's token counts for nothing beside the mark.
      expect((await harness().post('/v1/tasks/t1/start', { message: 'go', mode: 'bypass' }, 'op-1', UNPROVEN)).status).toBe(403)
      // Before the actor: a device carrying it caps only itself.
      expect(await awayStartCaller({ headers: UNPROVEN } as unknown as IncomingMessage, { kind: 'device', deviceId: 'd1' }, SESSIONS)).toEqual({ kind: 'external' })
    })

    it('a device is the person: no ceiling (it still starts nothing here, needs_leader above)', async () => {
      const caller = await awayStartCaller({ headers: {} } as IncomingMessage, { kind: 'device', deviceId: 'd1' }, SESSIONS)
      expect(caller).toEqual({ kind: 'person' })
      expect(applyStartModeCeiling(caller, 'bypass')).toBe('bypass')
    })

    it('the real read: only this replica\'s own self-call carrying the relay\'s token for that job is vouched', () => {
      setSelfApiRoot('http://127.0.0.1:45998', { credential: true })
      try {
        const token = holdRelayJob({ plugin: 'acme', job: 'sync' }, HOST)!
        const headers = (over: Record<string, string> = {}) => ({
          authorization: `Bearer ${getSelfCallToken()}`, 'x-walnut-caller-sid': 'external', 'x-walnut-origin': hostOrigin(HOST),
          'x-walnut-plugin-id': 'acme', 'x-walnut-plugin-job': 'sync', 'x-walnut-caller-job': token, ...over,
        })
        // Every port of a host replica is a tunnel port: the socket proves nothing, the self-call does.
        const req = (h: Record<string, string>) => ({ headers: h, socket: { remoteAddress: '10.0.0.9' } }) as unknown as IncomingMessage
        expect(replicaStartCaller.vouchedJob(req(headers()))).toEqual({ plugin: 'acme', job: 'sync', host: HOST })
        expect(replicaStartCaller.vouchedJob(req(headers({ authorization: 'Bearer forged' })))).toBeNull()
        expect(replicaStartCaller.vouchedJob(req(headers({ 'x-walnut-caller-job': 'made-up' })))).toBeNull()
        expect(replicaStartCaller.vouchedJob(req(headers({ 'x-walnut-caller-sid': 'sess-1' })))).toBeNull()
        expect(replicaStartCaller.vouchedJob(req(headers({ 'x-walnut-origin': hostOrigin('other-box') })))).toBeNull()
        expect(replicaStartCaller.vouchedJob(req(headers({ 'x-walnut-plugin-job': 'other' })))).toBeNull()
      } finally {
        setSelfApiRoot(null)
        _clearRelayJobsForTesting()
      }
    })
  })
})
