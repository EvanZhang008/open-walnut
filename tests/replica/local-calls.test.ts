/**
 * A host replica's answer to its host's own `walnut` calls (replica/local-calls.ts), through
 * the leader's own path (core/peers/gateway-answer.ts): the capability router runs once per
 * relay, a plugin job is named to it, a route's `needs_leader` goes back with that code (the
 * daemon then answers a session's call itself), and nothing runs while the Mac answers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const router = vi.hoisted(() => ({ calls: [] as unknown[][], outcome: { ok: true, result: { done: 1 } } as Record<string, unknown> }))
vi.mock('../../src/core/peers/capability-router.js', () => ({
  handleGatewayCapability: async (...args: unknown[]) => { router.calls.push(args); return router.outcome },
}))

import { createLocalCalls } from '../../src/replica/local-calls.js'
import { resetRelayedCallsForTest } from '../../src/core/peers/gateway-answer.js'

function setup(o: { leader?: boolean } = {}) {
  const sent: Array<Record<string, unknown>> = []
  const handle = createLocalCalls({
    request: async (cmd, params) => { sent.push({ cmd, ...params }); return { ok: true } },
    hostKey: 'devbox',
    capabilities: () => ['caller-proof-v1'],
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

  it('an event that is no relay is ignored', async () => {
    const s = setup()
    s.handle({ ev: 'gateway-request', relayId: 'x' })
    await s.settled()
    expect(s.sent).toEqual([])
  })
})
