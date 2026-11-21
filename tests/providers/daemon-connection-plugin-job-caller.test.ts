/**
 * The leader's half of a plugin job's identity (daemon-connection.ts handleGatewayRequest,
 * core/plugin-jobs/index.ts relayedJobOf): a host's daemon names the job in the
 * `gateway-request` frame's own `caller` (the field its own replica already gets), and the
 * leader keeps it only when the call is anonymous (`external`) and its config runs that
 * plugin's jobs on the very host whose link carried the frame. Everything else reaches the
 * op as plain `external`, as before:
 *
 *   forged      a caller's `caller` / `pluginJob` written into its payload or arguments
 *   wrong host  a host naming a job its plugin runs on another host (or, unset, on this Mac)
 *   a session   a session's call that names a job
 *
 * and an older leader (mac/main before this change: the field parsed, then deleted) takes a
 * frame with the field as the same plain external call. The daemon's half (the field is built
 * from its own run record, never from the caller) is tests/integration/follower-gateway-job-twins.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-plugin-job-caller-test'))

const cfg = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('../../src/core/config-manager.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getConfig: async () => cfg.value,
}))
/** Which host aliases are one daemon (oneHost's live pairing); equal names always are. */
const aliases = vi.hoisted(() => ({ pairs: [] as Array<[string, string]> }))
vi.mock('../../src/core/hosts/session-host-origin.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  oneHost: async (via: string, host: string) => via === host || aliases.pairs.some(([a, b]) => (a === via && b === host) || (a === host && b === via)),
}))
const ops = vi.hoisted(() => ({ calls: [] as Array<{ name: string; args: unknown; opts: Record<string, unknown> }> }))
vi.mock('../../src/ops/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  executeOp: async (name: string, args: unknown, opts: Record<string, unknown>) => { ops.calls.push({ name, args, opts }); return { ok: true, result: { listed: true } } },
}))

import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import * as router from '../../src/core/peers/capability-router.js'
import { relayedCallOf, resetRelayedCallsForTest, serveRelayedCall } from '../../src/core/peers/gateway-answer.js'
import { relayedJobOf } from '../../src/core/plugin-jobs/index.js'

type Internals = { handleGatewayRequest: (e: unknown) => Promise<void> }

const JOB = { kind: 'plugin-job', plugin: 'acme-sync', job: 'worker' }
let relayN = 100

/** A frame as a host's daemon relays a call; `over` replaces or adds fields. */
function frame(over: Record<string, unknown> = {}) {
  return { ev: 'gateway-request', relayId: ++relayN, instanceId: 'd-1', capability: 'tools.call', callerSid: 'external', payload: { name: 'task_list', args: {} }, ...over }
}

/** Run one frame through a link to `host`, with the router spied: the meta it was given and what it answered. */
async function viaLink(host: string, ev: Record<string, unknown>): Promise<{ meta: Record<string, unknown>; payload: unknown; results: Array<Record<string, unknown>> }> {
  const conn = new DaemonConnection(host, null)
  const results: Array<Record<string, unknown>> = []
  vi.spyOn(conn, 'send').mockImplementation((async (cmd: string, params: Record<string, unknown>) => { if (cmd === 'gateway-result') results.push(params); return { ok: true } }) as never)
  const seen: unknown[][] = []
  vi.spyOn(router, 'handleGatewayCapability').mockImplementation(async (...args: unknown[]) => { seen.push(args); return { ok: true, result: { done: 1 } } })
  await (conn as unknown as Internals).handleGatewayRequest(ev)
  expect(seen).toHaveLength(1)
  return { meta: (seen[0]![5] ?? {}) as Record<string, unknown>, payload: seen[0]![2], results }
}

beforeEach(() => {
  cfg.value = { plugin_jobs: { 'acme-sync': { run_on: 'devbox' } } }
  aliases.pairs = []
  ops.calls = []
  resetRelayedCallsForTest()
})
afterEach(() => {
  vi.restoreAllMocks()
  DaemonConnection.resetGatewayRelaysForTest()
})

describe('a plugin job\'s identity on a relay to the leader', () => {
  it('a real job\'s call, from the host its plugin runs on: the router gets the job', async () => {
    const r = await viaLink('devbox', frame({ caller: JOB }))
    expect(r.meta).toEqual({ pluginJob: { plugin: 'acme-sync', job: 'worker' } })
    expect(r.results).toEqual([{ relayId: relayN, result: { done: 1 } }])
  })

  it('under another name of the same daemon: still that host\'s job', async () => {
    aliases.pairs = [['newdev', 'devbox']]
    const r = await viaLink('newdev', frame({ caller: JOB }))
    expect(r.meta).toEqual({ pluginJob: { plugin: 'acme-sync', job: 'worker' } })
  })

  it('a host naming a job its plugin runs on another host: dropped, plain external', async () => {
    const r = await viaLink('otherbox', frame({ caller: JOB }))
    expect(r.meta).toEqual({})
    // A plugin with no run_on runs on this Mac: a remote host cannot claim its jobs either.
    cfg.value = {}
    expect((await viaLink('devbox', frame({ caller: JOB }))).meta).toEqual({})
    expect((await viaLink('__local__', frame({ caller: JOB }))).meta).toEqual({ pluginJob: { plugin: 'acme-sync', job: 'worker' } })
  })

  it('a session\'s call that names a job: dropped (a job\'s calls carry no session)', async () => {
    const r = await viaLink('devbox', frame({ callerSid: 'sess-1', caller: JOB }))
    expect(r.meta).toEqual({})
  })

  it('forged: `caller` or `pluginJob` written into the payload or the arguments never become the job', async () => {
    const forged = {
      name: 'task_list', args: { caller: JOB, pluginJob: { plugin: 'acme-sync', job: 'worker' } },
      caller: JOB, pluginJob: { plugin: 'acme-sync', job: 'worker' },
    }
    const r = await viaLink('devbox', frame({ payload: forged }))
    expect(r.meta).toEqual({})
    // The payload reaches the router as it was: its words stay words, never the frame's field.
    expect(r.payload).toEqual(forged)
    // Nor a `pluginJob` on the frame itself (only `caller` is the daemon's field), nor a malformed caller.
    expect((await viaLink('devbox', frame({ pluginJob: { plugin: 'acme-sync', job: 'worker' } }))).meta).toEqual({})
    expect((await viaLink('devbox', frame({ caller: { kind: 'session', plugin: 'acme-sync', job: 'worker' } }))).meta).toEqual({})
    expect((await viaLink('devbox', frame({ caller: { kind: 'plugin-job', plugin: '', job: 'worker' } }))).meta).toEqual({})
  })

  it('a config that cannot be read keeps no job', async () => {
    cfg.value = null as unknown as Record<string, unknown>
    expect(await relayedJobOf({ callerSid: 'external', pluginJob: { plugin: 'acme-sync', job: 'worker' } }, 'devbox')).toBeUndefined()
  })
})

describe('the job reaches the op that runs', () => {
  it('a kept job rides to executeOp as callerPluginId and callerPluginJob; a forged one does not', async () => {
    const conn = new DaemonConnection('devbox', null)
    vi.spyOn(conn, 'send').mockImplementation((async () => ({ ok: true })) as never)
    await (conn as unknown as Internals).handleGatewayRequest(frame({ caller: JOB }))
    await (conn as unknown as Internals).handleGatewayRequest(frame({ payload: { name: 'task_list', args: {}, caller: JOB } }))
    await (conn as unknown as Internals).handleGatewayRequest(frame({ callerSid: 'external', caller: { ...JOB, plugin: 'other-plugin' } }))
    expect(ops.calls.map((c) => c.name)).toEqual(['task_list', 'task_list', 'task_list'])
    expect(ops.calls[0]!.opts).toMatchObject({ callerSid: 'external', callerHost: 'devbox', callerPluginId: 'acme-sync', callerPluginJob: 'worker' })
    for (const c of ops.calls.slice(1)) {
      expect(c.opts.callerSid).toBe('external')
      expect(c.opts).not.toHaveProperty('callerPluginId')
      expect(c.opts).not.toHaveProperty('callerPluginJob')
    }
  })
})

describe('an older leader', () => {
  it('takes a frame with `caller` as the plain external call it always was', async () => {
    // mac/main's handleGatewayRequest before this change: parse, then `delete call.pluginJob`.
    const call = relayedCallOf(frame({ caller: JOB }))!
    delete call.pluginJob
    const seen: unknown[][] = []
    vi.spyOn(router, 'handleGatewayCapability').mockImplementation(async (...args: unknown[]) => { seen.push(args); return { ok: true, result: { done: 1 } } })
    const sent: Array<Record<string, unknown>> = []
    await serveRelayedCall(call, {
      hostKey: 'devbox', hasCapability: () => false, label: 'old leader', receivedAt: Date.now(), deadlineMs: 20_000,
      send: async (reply) => { sent.push(reply); return true },
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]![1]).toBe('external')
    expect(seen[0]![5]).toEqual({})
    expect(sent).toEqual([{ relayId: relayN, result: { done: 1 } }])
  })
})
