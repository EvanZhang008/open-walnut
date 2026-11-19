/**
 * A host replica's answer to its host's own `walnut` calls (replica/local-calls.ts), through
 * the leader's own path (core/peers/gateway-answer.ts): the capability router runs once per
 * relay, a plugin job is named to it, a route's `needs_leader` goes back with that code (the
 * daemon then answers a session's call itself), and nothing runs while the Mac answers.
 * A full journal and the brake go back as their own retryable codes with the route's wait; a
 * big answer goes gzipped as the leader's does; and with no host key nothing runs at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { gunzipSync } from 'node:zlib'

const router = vi.hoisted(() => ({ calls: [] as unknown[][], answerBy: [] as Array<number | undefined>, outcome: { ok: true, result: { done: 1 } } as Record<string, unknown> }))
vi.mock('../../src/core/peers/capability-router.js', async () => {
  const { ambientAnswerBy } = await import('../../src/lib/answer-by.js')
  return {
    handleGatewayCapability: async (...args: unknown[]) => { router.calls.push(args); router.answerBy.push(ambientAnswerBy()); return router.outcome },
  }
})

import { CALL_LEFT_MS, START_LEFT_MS, createLocalCalls } from '../../src/replica/local-calls.js'
import { resetRelayedCallsForTest } from '../../src/core/peers/gateway-answer.js'

function setup(o: { leader?: boolean; hostKey?: string | null; caps?: string[] } = {}) {
  const sent: Array<Record<string, unknown>> = []
  const handle = createLocalCalls({
    request: async (cmd, params) => { sent.push({ cmd, ...params }); return { ok: true } },
    hostKey: o.hostKey === undefined ? 'devbox' : o.hostKey,
    capabilities: () => o.caps ?? ['caller-proof-v1'],
    leaderAnswers: () => o.leader === true,
  })
  const settled = () => new Promise((r) => setTimeout(r, 20))
  return { handle, sent, settled }
}

const event = (over: Record<string, unknown> = {}) => ({
  ev: 'gateway-request', relayId: 7, instanceId: 'inst-a', capability: 'tools.call', callerSid: 'sess-1',
  payload: { name: 'task_update', args: { id: 't1', tags: ['team:acme'] } }, ...over,
})

beforeEach(() => {
  router.calls = []
  router.outcome = { ok: true, result: { done: 1 } }
  resetRelayedCallsForTest()
})

describe('local calls', () => {
  it('runs the call through the capability router as this host\'s, and answers with gateway-result', async () => {
    const s = setup()
    s.handle(event())
    await s.settled()
    expect(router.calls).toHaveLength(1)
    expect(router.calls[0]!.slice(0, 4)).toEqual(['tools.call', 'sess-1', { name: 'task_update', args: { id: 't1', tags: ['team:acme'] } }, 'devbox'])
    expect(s.sent).toEqual([{ cmd: 'gateway-result', relayId: 7, result: { done: 1 } }])
  })

  it('a plugin job is named to the router; a relay asked again runs once', async () => {
    const s = setup()
    s.handle(event({ callerSid: 'external', caller: { kind: 'plugin-job', plugin: 'acme', job: 'sync' } }))
    await s.settled()
    s.handle(event({ callerSid: 'external', caller: { kind: 'plugin-job', plugin: 'acme', job: 'sync' } }))
    await s.settled()
    expect(router.calls).toHaveLength(1)
    expect(router.calls[0]![5]).toEqual({ pluginJob: { plugin: 'acme', job: 'sync' } })
    expect(s.sent).toHaveLength(2)
  })

  it('a route\'s needs_leader goes back with that code, so a session\'s call gets the daemon\'s own answer', async () => {
    router.outcome = { ok: false, error: { code: 'internal', message: 'This needs your Mac', api: { status: 503, code: 'needs_leader' }, detail: { error: { why: 'fields' } } }, opStatus: 503 }
    const s = setup()
    s.handle(event())
    await s.settled()
    expect(s.sent[0]).toMatchObject({ cmd: 'gateway-result', relayId: 7, errorCode: 'needs_leader', error: 'This needs your Mac' })
  })

  it('while the Mac answers nothing runs: needs_leader', async () => {
    const s = setup({ leader: true })
    s.handle(event())
    await s.settled()
    expect(router.calls).toEqual([])
    expect(s.sent[0]).toMatchObject({ relayId: 7, errorCode: 'needs_leader' })
  })

  it('a full journal and the live session brake go back as their own codes, with the route\'s wait', async () => {
    for (const [code, status] of [['queue_full', 503], ['throttled', 429]] as const) {
      resetRelayedCallsForTest()
      router.outcome = { ok: false, error: { code: 'internal', message: `Walnut API error (${code}): this host already holds 5000 records`, api: { status, code }, retryAfterMs: 60_000 }, opStatus: status }
      const s = setup()
      s.handle(event())
      await s.settled()
      expect(s.sent[0]).toMatchObject({ cmd: 'gateway-result', relayId: 7, errorCode: code, detail: { retryAfterMs: 60_000 } })
    }
  })

  it('a big answer goes gzipped to a daemon that reads it, a small one and an older daemon\'s plain', async () => {
    const big = { rows: Array.from({ length: 2000 }, (_, i) => ({ id: `task-${i}`, title: 'Sync the acme board' })) }
    router.outcome = { ok: true, result: big }
    const s = setup({ caps: ['caller-proof-v1', 'gateway-result-gz-v1'] })
    s.handle(event())
    await s.settled()
    expect(s.sent[0]).not.toHaveProperty('result')
    expect(JSON.parse(gunzipSync(Buffer.from(String(s.sent[0]!.resultGz), 'base64')).toString('utf8'))).toEqual(big)
    resetRelayedCallsForTest()
    const old = setup()
    old.handle(event())
    await old.settled()
    expect(old.sent[0]).toMatchObject({ result: big })
    expect(old.sent[0]).not.toHaveProperty('resultGz')
  })

  it('with no host key nothing runs: an empty key would act as the Mac\'s own origin', async () => {
    for (const hostKey of [null, '']) {
      const s = setup({ hostKey })
      s.handle(event())
      await s.settled()
      expect(router.calls).toEqual([])
      expect(s.sent[0]).toMatchObject({ relayId: 7, errorCode: 'needs_leader' })
    }
  })

  // A plugin job's call the daemon held while the Mac went quiet comes with little of its time
  // left: a start then would outlive the daemon's wait, and the job would hear "may have run".
  it('a call handed over with too little time left for its op is refused before anything runs, retryable', async () => {
    for (const [name, args] of [['task_start', { id: 't1' }], ['task_create', { title: 'x' }]] as const) {
      resetRelayedCallsForTest()
      router.calls = []
      const s = setup()
      s.handle(event({ payload: { name, args }, answerInMs: START_LEFT_MS - 1_000 }))
      await s.settled()
      expect(router.calls, name).toEqual([])
      expect(s.sent[0]).toMatchObject({ relayId: 7, errorCode: 'hub_unreachable', detail: { why: 'too_little_time', retryAfterMs: 1_000 } })
      expect(String(s.sent[0]!.error)).toContain('nothing was done')
    }
    // The same time is enough for a plain write, and a placeholder create starts nothing.
    for (const payload of [{ name: 'task_update', args: { id: 't1' } }, { name: 'task_create', args: { title: 'x', record_only: true } }]) {
      resetRelayedCallsForTest()
      router.calls = []
      const s = setup()
      s.handle(event({ payload, answerInMs: START_LEFT_MS - 1_000 }))
      await s.settled()
      expect(router.calls, payload.name).toHaveLength(1)
    }
    // Under the plain call's own need: refused too.
    const s = setup()
    s.handle(event({ relayId: 8, answerInMs: CALL_LEFT_MS }))
    await s.settled()
    expect(s.sent[0]).toMatchObject({ relayId: 8, errorCode: 'hub_unreachable' })
  })

  it('runs within what the daemon still waits for; an older daemon that names none gets the hub timeout', async () => {
    router.answerBy = []
    const at = Date.now()
    const s = setup()
    s.handle(event({ payload: { name: 'task_start', args: { id: 't1' } }, answerInMs: 15_000 }))
    await s.settled()
    resetRelayedCallsForTest()
    const old = setup()
    old.handle(event({ relayId: 9, payload: { name: 'task_start', args: { id: 't1' } } }))
    await old.settled()
    expect(router.calls).toHaveLength(2)
    // Answered before the daemon's own timer: what is left, less a margin; the hub timeout (20 s) otherwise.
    expect(router.answerBy[0]! - at).toBeGreaterThan(13_000)
    expect(router.answerBy[0]! - at).toBeLessThan(15_000)
    expect(router.answerBy[1]! - at).toBeGreaterThan(19_000)
  })

  it('an event that is no relay is ignored', async () => {
    const s = setup()
    s.handle({ ev: 'gateway-request', relayId: 'x' })
    await s.settled()
    expect(s.sent).toEqual([])
  })
})
