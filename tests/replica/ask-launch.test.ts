/**
 * The host replica's new-ask launch while the Mac is away (src/replica/ask-launch.ts, WP12):
 * which launches it takes, the refusals in words, the fields it hands `follower.start`, the
 * answers in both routes' shapes, and the rows and events it gives the console after.
 * Pure: the write port, the follower link and the broadcast are fakes.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import { createMockConstants } from '../helpers/mock-constants.js'

// ask-launch-plan.ts (the Mac's rule, read for its default tier) imports the constants.
vi.mock('../../src/constants.js', () => createMockConstants('walnut-ask-launch'))

import { createAskLaunch, createMeta, ASK_DEFAULT_TIER, FOLLOWER_START_TIMEOUT_MS, type AskLaunch, type AskLaunchDeps, type PersonaCopy } from '../../src/replica/ask-launch.js'
import { ASK_DEFAULT_TIER as MAC_ASK_DEFAULT_TIER } from '../../src/core/sessions/ask-launch-plan.js'
import type { ReplicaWrite, ReplicaWriteResult } from '../../src/replica/dispatch.js'
import type { PortAnswer, WritePort } from '../../src/replica/write-port.js'

const SID = 'cccccccc-3333-4333-8333-000000000001'
const PERSONA: PersonaCopy = {
  agentId: 'general', name: 'Walnut', systemPrompt: 'You are Walnut, the marina assistant.', systemPromptMode: 'append',
  allowedTools: ['Bash(walnut:*)'], effort: 'medium', launchModel: 'sonnet',
}

interface Harness {
  deps: AskLaunchDeps
  calls: Array<{ cmd: string; params: Record<string, unknown>; timeoutMs?: number }>
  creates: Array<Record<string, unknown>>
  events: Array<{ name: string; data: any }>
  sessions: Array<Record<string, unknown>>
}

function harness(over: Partial<AskLaunchDeps> = {}): Harness {
  const h: Harness = { calls: [], creates: [], events: [], sessions: [], deps: null as unknown as AskLaunchDeps }
  const port = {
    async taskCreate(_w: ReplicaWrite, _actor: unknown, input: Record<string, unknown>): Promise<PortAnswer> {
      h.creates.push(input)
      return { answered: false, status: 201, body: { queued: true, task: { id: 'mtask-ask-1', ...input, replica_sync: 'pending' } } }
    },
  } as unknown as WritePort
  h.deps = {
    port,
    actorOf: () => ({ kind: 'device', deviceId: 'dev-acme-phone', name: 'Acme phone' }),
    hostKey: 'devbox',
    persona: async (id) => (id === 'general' ? PERSONA : null),
    capabilities: () => ['replica-start-v1'],
    request: async () => ({ sessions: h.sessions }),
    broadcast: (name, data) => { h.events.push({ name, data }) },
    sessionContext: async (task) => `## Your task\n${task.title} (id ${task.id})`,
    randomUUID: () => SID,
    now: () => 1_760_000_000_000,
    log: () => {},
    ...over,
  }
  return h
}

/** One request through the handler: the answer (status and body), or `next` (not this module's). */
async function send(h: Harness, launch: AskLaunch, path: string, body: Record<string, unknown>, result?: (cmd: string, params: Record<string, unknown>) => ReplicaWriteResult): Promise<{ status: number; body: any } | 'next'> {
  const w: ReplicaWrite = {
    opId: 'op-ask-1', away: 'queue:ask', raw: Buffer.from(JSON.stringify(body)),
    submit: async () => ({ kind: 'applied', reply: {} }),
    call: async (cmd, params, opts) => {
      h.calls.push({ cmd, params, ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) })
      return result ? result(cmd, params) : { kind: 'applied', reply: { sid: params.sid, taskId: params.taskId, mode: 'default', cwd: '/srv/marina/data', messageId: 'qm-ask-1' } }
    },
  }
  const req = { method: 'POST', path, body, replicaWrite: w, headers: {}, get: () => undefined } as unknown as Request
  return new Promise((resolve) => {
    const res = {
      headersSent: false,
      status(code: number) { return { json: (b: unknown) => resolve({ status: code, body: b }) } },
    } as unknown as Response
    launch.handler(req, res, () => resolve('next'))
  })
}

const ASK = { walnutAgent: true, message: 'Why is the marina build red?', cwd: '', project: 'Ask Walnut', taskMeta: { unread: false, priority: 'none', pinTier: null } }

describe('a new ask while the Mac is away', () => {
  it('the console\'s launch: the task is journaled under Ask Walnut, then the host starts it with the copied persona and the task\'s context', async () => {
    const h = harness()
    const launch = createAskLaunch(h.deps)
    const r = await send(h, launch, '/sessions/quick-start', ASK)
    expect(r).toEqual({ status: 200, body: { taskId: 'mtask-ask-1', sessionId: SID, task: expect.objectContaining({ id: 'mtask-ask-1', project: 'Ask Walnut', walnut_agent: true }) } })
    // The slot's "do not pin" (pinTier null) is kept, as the Mac's quick-start keeps it.
    expect(h.creates).toEqual([{ title: 'Ask Walnut', project: 'Ask Walnut', pinned: false }])
    // The daemon's checks first (nothing journaled), then the task, then the start. Tool
    // lists never ride: the daemon takes them from the Mac's template.
    const fields = {
      sid: SID, agentId: 'general', title: 'Ask Walnut', model: 'sonnet', effort: 'medium',
      firstMessage: ASK.message, host: 'devbox', actor: { kind: 'device', deviceId: 'dev-acme-phone', name: 'Acme phone' },
    }
    expect(h.calls).toEqual([
      { cmd: 'follower.start', params: { ...fields, check: true, persona: { text: PERSONA.systemPrompt, mode: 'append', context: '## Your task\nAsk Walnut (id 00000000-0000000000000000)' } } },
      {
        cmd: 'follower.start', timeoutMs: FOLLOWER_START_TIMEOUT_MS,
        params: { ...fields, taskId: 'mtask-ask-1', persona: { text: PERSONA.systemPrompt, mode: 'append', context: '## Your task\nAsk Walnut (id mtask-ask-1)' } },
      },
    ])
    // The console shows it at once: its row (on this host), and a running status.
    expect(launch.rows()).toEqual([expect.objectContaining({ claudeSessionId: SID, taskId: 'mtask-ask-1', host: 'devbox', cwd: '/srv/marina/data', process_status: 'running', project: 'Ask Walnut' })])
    expect(h.events).toContainEqual({ name: 'session:status-changed', data: expect.objectContaining({ sessionId: SID, status: 'running', taskId: 'mtask-ask-1' }) })
    launch.stop()
  })

  it('the phone\'s launch answers 201 in the frozen v1 shape; a picked model, effort and mode ride along', async () => {
    const h = harness()
    const launch = createAskLaunch(h.deps)
    const r = await send(h, launch, '/v1/sessions', { walnutAgent: true, message: 'hello', model: 'haiku', effort: 'low', mode: 'plan' })
    expect(r).toEqual({ status: 201, body: { sessionId: SID, taskId: 'mtask-ask-1', title: 'Ask Walnut' } })
    expect(h.calls[1]!.params).toMatchObject({ model: 'haiku', effort: 'low', mode: 'plan' })
    // The phone's ask is born in Focus, as the Mac files it (mobile-launch.ts askLaunchTier).
    expect(h.creates).toEqual([{ title: 'Ask Walnut', project: 'Ask Walnut', focus_tier: 'focus' }])
    launch.stop()
  })

  it('the launch\'s task meta becomes the create\'s fields as the Mac files an ask', () => {
    expect(ASK_DEFAULT_TIER).toBe(MAC_ASK_DEFAULT_TIER)
    // No tier named: Focus. null: not pinned. A retired name: its successor.
    expect(createMeta(undefined)).toEqual({ focus_tier: 'focus' })
    expect(createMeta({ pinTier: null, priority: 'none', unread: true })).toEqual({ pinned: false, unread: true })
    expect(createMeta({ pinTier: 'focus', priority: 'important', due_date: '2026-10-20' })).toEqual({ focus_tier: 'focus', priority: 'important', due_date: '2026-10-20' })
    expect(createMeta({ pinTier: 'backlog' })).toEqual({ focus_tier: 'wait' })
    // Satellite, or a custom tier this host cannot check: Satellite (the Mac's fallback for an unknown one).
    expect(createMeta({ pinTier: 'satellite', due_date: 'tomorrow; rm -rf /' })).toEqual({ pinned: true })
    expect(createMeta({ pinTier: 'ct_acme', unread: 'yes' })).toEqual({ pinned: true })
    // Never a tier or a priority: refused, as the Mac answers 400.
    expect(createMeta({ pinTier: 'urgent' })).toBeNull()
    expect(createMeta({ pinTier: 3 })).toBeNull()
    expect(createMeta({ pinTier: null, priority: 'urgent' })).toBeNull()
    // The phone's launch takes no meta: Focus whatever it sends.
    expect(createMeta({ pinTier: null, priority: 'important' }, true)).toEqual({ focus_tier: 'focus' })
  })

  it('every refusal says why, and nothing is journaled or started before the checks pass', async () => {
    const cases: Array<[string, Record<string, unknown>, Partial<AskLaunchDeps>, number, string]> = [
      ['a folder session', { message: 'hi', cwd: '/w' }, {}, 503, 'session_writes_need_mac'],
      ['a retry on its task', { ...ASK, taskId: 'mtask-old' }, {}, 503, 'ask_needs_mac'],
      ['pictures', { ...ASK, images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }] }, {}, 503, 'images_need_mac'],
      ['another engine', { ...ASK, engine: 'codex' }, {}, 503, 'ask_needs_mac'],
      ['an older daemon', ASK, { capabilities: () => ['replica-ops-v1'] }, 503, 'daemon_needs_upgrade'],
      ['the daemon not known yet', ASK, { capabilities: () => null }, 503, 'daemon_needs_upgrade'],
      ['an unknown device', ASK, { actorOf: () => null }, 503, 'device_changes_need_mac'],
      ['no persona copy', { ...ASK, agentId: 'mentor' }, {}, 503, 'persona_not_copied'],
    ]
    for (const [label, body, over, status, why] of cases) {
      const h = harness(over)
      const launch = createAskLaunch(h.deps)
      const r = await send(h, launch, '/sessions/quick-start', body)
      expect(r, label).toMatchObject({ status, body: { error: { code: 'needs_leader', why } } })
      expect(h.creates, label).toEqual([])
      expect(h.calls, label).toEqual([])
      launch.stop()
    }
    // A host is never named (an ask runs where Walnut runs), a tier that is not one, a project too long.
    for (const [label, body] of [
      ['a host', { ...ASK, host: 'other-box' }],
      ['a tier that is not one', { ...ASK, taskMeta: { pinTier: 'urgent' } }],
      ['a project too long', { ...ASK, project: 'a'.repeat(257) }],
    ] as Array<[string, Record<string, unknown>]>) {
      const h = harness()
      const r = await send(h, createAskLaunch(h.deps), '/sessions/quick-start', body)
      expect(r, label).toMatchObject({ status: 400, body: { error: { code: 'bad_request' } } })
      expect(h.creates, label).toEqual([])
      expect(h.calls, label).toEqual([])
    }
  })

  it('a turn the first look already finds over is still told to the console: its answer refetched, Idle', async () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      h.sessions.push({ sid: SID, state: 'idle', lastActiveAt: '2026-10-17T07:00:00.000Z' })
      const launch = createAskLaunch(h.deps)
      await send(h, launch, '/sessions/quick-start', ASK)
      h.events.length = 0
      await vi.advanceTimersByTimeAsync(1_100)
      expect(h.events).toEqual([
        { name: 'session:batch-completed', data: { sessionId: SID } },
        { name: 'session:result', data: { sessionId: SID } },
        { name: 'session:status-changed', data: { sessionId: SID, status: 'idle', process_status: 'idle' } },
      ])
      expect(launch.rows()[0]).toMatchObject({ process_status: 'idle', lastActiveAt: '2026-10-17T07:00:00.000Z' })
      // Nothing new on the next look: nothing told again.
      h.events.length = 0
      await vi.advanceTimersByTimeAsync(1_100)
      expect(h.events).toEqual([])
      launch.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a session started here counts its messages as the Mac does: one at its start, one more for each turn that ended', async () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      const launch = createAskLaunch(h.deps)
      await send(h, launch, '/sessions/quick-start', ASK)
      expect(launch.rows()[0]).toMatchObject({ messageCount: 1 })
      // The first look finds the start's turn already over (a write after the start): counted
      // once the next look still sees it so.
      h.sessions.push({ sid: SID, state: 'idle', lastActiveAt: '2026-10-17T07:00:00.000Z' })
      await vi.advanceTimersByTimeAsync(1_100)
      expect(launch.rows()[0]).toMatchObject({ messageCount: 1 })
      await vi.advanceTimersByTimeAsync(1_100)
      expect(launch.rows()[0]).toMatchObject({ messageCount: 2 })
      // Nothing new: the count stands.
      await vi.advanceTimersByTimeAsync(1_100)
      expect(launch.rows()[0]).toMatchObject({ messageCount: 2 })
      // A message (a turn seen working, then over), and one whose whole turn fell between two looks.
      launch.watch(SID)
      h.sessions[0] = { sid: SID, state: 'working', lastActiveAt: '2026-10-17T07:01:00.000Z' }
      await vi.advanceTimersByTimeAsync(1_100)
      expect(launch.rows()[0]).toMatchObject({ messageCount: 2, process_status: 'running' })
      h.sessions[0] = { sid: SID, state: 'idle', lastActiveAt: '2026-10-17T07:02:00.000Z' }
      await vi.advanceTimersByTimeAsync(1_100)
      expect(launch.rows()[0]).toMatchObject({ messageCount: 3 })
      // A write while idle with no message sent (a hook's line) counts nothing.
      h.sessions[0] = { sid: SID, state: 'idle', lastActiveAt: '2026-10-17T07:03:00.000Z' }
      await vi.advanceTimersByTimeAsync(2_200)
      expect(launch.rows()[0]).toMatchObject({ messageCount: 3 })
      launch.watch(SID)
      h.sessions[0] = { sid: SID, state: 'idle', lastActiveAt: '2026-10-17T07:05:00.000Z' }
      await vi.advanceTimersByTimeAsync(2_200)
      expect(launch.rows()[0]).toMatchObject({ messageCount: 4 })
      launch.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a look before a message\'s turn begins, or while its transcript is still being folded, counts the turn once', async () => {
    vi.useFakeTimers()
    try {
      let t = Date.parse('2026-10-17T07:00:00.000Z')
      const h = harness({ now: () => t })
      const launch = createAskLaunch(h.deps)
      await send(h, launch, '/sessions/quick-start', ASK)
      h.sessions.push({ sid: SID, state: 'working', lastActiveAt: '2026-10-17T07:00:01.000Z' })
      await launch.fresh(0)
      h.sessions[0] = { sid: SID, state: 'idle', lastActiveAt: '2026-10-17T07:00:30.000Z' }
      await launch.fresh(0)
      expect(launch.rows()[0]).toMatchObject({ messageCount: 2 })
      // A message is sent; a reader looks before the daemon sees its turn: idle, the old write.
      t = Date.parse('2026-10-17T07:01:00.000Z')
      launch.watch(SID)
      await launch.fresh(0)
      await launch.fresh(0)
      expect(launch.rows()[0]).toMatchObject({ messageCount: 2 })
      // Its first line lands before the daemon folds it (idle, a new write), then the turn runs and ends.
      h.sessions[0] = { sid: SID, state: 'idle', lastActiveAt: '2026-10-17T07:01:00.500Z' }
      await launch.fresh(0)
      h.sessions[0] = { sid: SID, state: 'working', lastActiveAt: '2026-10-17T07:01:01.000Z' }
      await launch.fresh(0)
      h.sessions[0] = { sid: SID, state: 'idle', lastActiveAt: '2026-10-17T07:01:20.000Z' }
      await launch.fresh(0)
      await launch.fresh(0)
      // One message, one turn: counted once, as the Mac counts it.
      expect(launch.rows()[0]).toMatchObject({ messageCount: 3 })
      launch.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('the session list reads every session of this host through the same look: one read for readers at once, none again within a second', async () => {
    let t = 1_760_000_000_000
    let asked = 0
    let fail = false
    const h = harness({
      now: () => t,
      request: async () => { asked++; if (fail) throw new Error('daemon gone'); return { sessions: [{ sid: 'other-sid', state: 'working', lastActiveAt: '2026-10-17T07:00:00.000Z' }] } },
    })
    const launch = createAskLaunch(h.deps)
    // No ask started here: the list still reads the host's sessions.
    const [a, b] = await Promise.all([launch.hostSessions(), launch.hostSessions()])
    expect(asked).toBe(1)
    expect(a).toBe(b)
    expect(a?.get('other-sid')).toEqual({ state: 'working', lastActiveAt: '2026-10-17T07:00:00.000Z' })
    await launch.hostSessions()
    expect(asked).toBe(1)
    // A daemon that does not answer: null, and asked again only after a second.
    t += 1_500
    fail = true
    expect(await launch.hostSessions()).toBeNull()
    expect(await launch.hostSessions()).toBeNull()
    expect(asked).toBe(2)
    launch.stop()
  })

  it('the caller\'s project is kept, as the Mac keeps it (askLaunchProject)', async () => {
    const h = harness()
    const launch = createAskLaunch(h.deps)
    await send(h, launch, '/sessions/quick-start', { ...ASK, project: '  Marina asks  ' })
    expect(h.creates).toEqual([{ title: 'Ask Walnut', project: 'Marina asks', pinned: false }])
    launch.stop()
  })

  it('the daemon\'s refusal reaches the console in words, and leaves no task (its checks run before the create)', async () => {
    // Every refusal the daemon makes of a start: each answered before anything is journaled.
    const refusals: Array<[string, string, Record<string, unknown> | undefined, number]> = [
      ['needs_leader', 'no template', { why: 'no_spawn_template' }, 503],
      ['needs_leader', 'an older Mac', { why: 'mac_too_old' }, 503],
      ['throttled', 'other sessions are starting', undefined, 429],
      ['bad_request', 'that permission mode is not allowed', undefined, 400],
      ['bad_request', 'a model must be one CLI value', undefined, 400],
      ['bad_request', 'the persona is too large', { why: 'persona_too_large' }, 400],
    ]
    for (const [code, message, detail, status] of refusals) {
      const h = harness()
      const launch = createAskLaunch(h.deps)
      const r = await send(h, launch, '/sessions/quick-start', ASK, (_cmd, params) => (params.check === true
        ? { kind: 'refused', code, message, ...(detail ? { detail } : {}), ...(code === 'throttled' ? { retryAfterMs: 5_000 } : {}) }
        : { kind: 'applied', reply: { sid: params.sid } }))
      expect(r, message).toMatchObject({ status, body: { error: { code, ...(detail ? { why: detail.why } : {}) } } })
      expect(h.creates, message).toEqual([])
      expect(h.calls.map((c) => c.params.check), message).toEqual([true])
      expect(launch.rows()).toEqual([])
      launch.stop()
    }
  })

  it('a start that passed the checks and still fails (its CLI did not start) answers in words', async () => {
    const h = harness()
    const launch = createAskLaunch(h.deps)
    const r = await send(h, launch, '/sessions/quick-start', ASK, (_cmd, params) => (params.check === true
      ? { kind: 'applied', reply: { sid: params.sid, checked: true } }
      : { kind: 'refused', code: 'internal', message: 'follower.start: start: cwd does not exist on this host' }))
    expect(r).toMatchObject({ status: 503, body: { error: { code: 'internal' } } })
    // The task stays, as a failed start on the Mac leaves its task; no session row is shown.
    expect(h.creates).toHaveLength(1)
    expect(launch.rows()).toEqual([])
    launch.stop()
  })

  it('the client\'s own session id for the launch is the session\'s id (its lost-answer reconcile finds it)', async () => {
    const CLIENT = 'eeeeeeee-5555-4555-8555-000000000001'
    const h = harness()
    const launch = createAskLaunch(h.deps)
    const r = await send(h, launch, '/sessions/quick-start', { ...ASK, sessionId: CLIENT })
    expect(r).toMatchObject({ status: 200, body: { sessionId: CLIENT } })
    expect(h.calls.map((c) => c.params.sid)).toEqual([CLIENT, CLIENT])
    expect(launch.rows()[0]).toMatchObject({ claudeSessionId: CLIENT })
    // Not a v4 id (or not a string): this host mints one.
    for (const bad of ['not-a-uuid', 'EEEEEEEE-5555-4555-8555-000000000001', 42]) {
      const h2 = harness()
      const l2 = createAskLaunch(h2.deps)
      await send(h2, l2, '/sessions/quick-start', { ...ASK, sessionId: bad })
      expect(h2.calls.map((c) => c.params.sid), String(bad)).toEqual([SID, SID])
      l2.stop()
    }
    launch.stop()
  })

  it('each try of the start waits longer than a CLI start; a non-Walnut agent\'s ask shows its agent', async () => {
    expect(FOLLOWER_START_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000)
    const MENTOR: PersonaCopy = { agentId: 'mentor', name: 'Mentor', systemPrompt: 'You are Mentor.', systemPromptMode: 'append' }
    const h = harness({ persona: async (id) => (id === 'mentor' ? MENTOR : null) })
    const launch = createAskLaunch(h.deps)
    const r = await send(h, launch, '/sessions/quick-start', { ...ASK, project: undefined, agentId: 'mentor' })
    expect(r).toMatchObject({ status: 200, body: { task: { walnut_agent: true, agent_id: 'mentor', project: 'Ask Mentor' } } })
    expect(h.calls[1]).toMatchObject({ timeoutMs: FOLLOWER_START_TIMEOUT_MS, params: { agentId: 'mentor' } })
    launch.stop()
  })

  it('a task\'s session started here by a local call shows at once, on this host, and its status reaches the console', () => {
    const h = harness()
    const launch = createAskLaunch(h.deps)
    const sid = 'dddddddd-4444-4444-8444-000000000002'
    launch.noteStarted({ sid, taskId: 'mtask-job-1', cwd: '/work/acme', mode: 'default', title: 'Sync the board', project: 'Acme' })
    expect(launch.rows()).toEqual([expect.objectContaining({
      claudeSessionId: sid, taskId: 'mtask-job-1', host: 'devbox', cwd: '/work/acme', project: 'Acme', process_status: 'running', title: 'Sync the board',
    })])
    expect(h.events).toContainEqual({ name: 'session:status-changed', data: expect.objectContaining({ sessionId: sid, status: 'running', taskId: 'mtask-job-1' }) })
    launch.stop()
  })

  it('another route is not this module\'s, and a request the dispatcher did not mark is passed on', async () => {
    const h = harness()
    const launch = createAskLaunch(h.deps)
    expect(await send(h, launch, '/sessions/other', ASK)).toBe('next')
    const res = {} as Response
    let passed = false
    launch.handler({ method: 'POST', path: '/sessions/quick-start', body: ASK } as unknown as Request, res, () => { passed = true })
    expect(passed).toBe(true)
    launch.stop()
  })
})
