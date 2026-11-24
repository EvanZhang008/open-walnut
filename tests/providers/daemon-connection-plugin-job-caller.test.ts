/**
 * The leader's half of a plugin job's identity (daemon-connection.ts handleGatewayRequest,
 * core/plugin-jobs/index.ts relayedJobOf): a host's daemon names the job in the
 * `gateway-request` frame's own `caller` (the field its own replica already gets), and the
 * leader keeps it only when the call is anonymous (`external`) and its plugin-jobs manager
 * gives that job to the very host whose link carried the frame now (manager.ts assignedHosts).
 * Its `vouched` (the daemon saw the call's process inside the run) is kept exactly as sent.
 * Everything else reaches the op as plain `external`, as before:
 *
 *   forged      a caller's `caller` / `pluginJob` written into its payload or arguments
 *   wrong host  a host naming a job given to another host, or to none (an unconfigured
 *               plugin's default `__local__` included: the local daemon cannot name any job)
 *   too long    a plugin or job id longer than the 120 characters relayedCallOf keeps
 *   a session   a session's call that names a job
 *
 * A dropped name is logged once per host, job and reason every few minutes, and a check of
 * the host's other names that timed out says so.
 *
 * and an older leader (mac/main before this change: the field parsed, then deleted) takes a
 * frame with the field as the same plain external call. The daemon's half (the field is built
 * from its own run record, never from the caller) is tests/integration/follower-gateway-job-twins.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-plugin-job-caller-test'))

/** Which host aliases are one daemon (oneHost's live pairing); equal names always are. `late`: the check times out. */
const aliases = vi.hoisted(() => ({ pairs: [] as Array<[string, string]>, late: false }))
vi.mock('../../src/core/hosts/session-host-origin.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  oneHost: async (via: string, host: string, onLate?: () => void) => {
    if (via === host) return true
    if (aliases.late) { onLate?.(); return false }
    return aliases.pairs.some(([a, b]) => (a === via && b === host) || (a === host && b === via))
  },
}))
const ops = vi.hoisted(() => ({ calls: [] as Array<{ name: string; args: unknown; opts: Record<string, unknown> }> }))
vi.mock('../../src/ops/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  executeOp: async (name: string, args: unknown, opts: Record<string, unknown>) => { ops.calls.push({ name, args, opts }); return { ok: true, result: { listed: true } } },
}))

import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import * as router from '../../src/core/peers/capability-router.js'
import { relayedCallOf, resetRelayedCallsForTest, serveRelayedCall } from '../../src/core/peers/gateway-answer.js'
import { _setJobAssignmentsForTesting, _setJobSetStateForTesting, relayedJobOf } from '../../src/core/plugin-jobs/index.js'
import { log } from '../../src/logging/index.js'

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

/** Which hosts this Mac's manager gives each `plugin/job` now. */
let given: Record<string, string[]> = {}

beforeEach(() => {
  given = { 'acme-sync/worker': ['devbox'] }
  _setJobAssignmentsForTesting((plugin, job) => given[`${plugin}/${job}`] ?? [])
  aliases.pairs = []
  aliases.late = false
  ops.calls = []
  resetRelayedCallsForTest()
})
afterEach(() => {
  _setJobAssignmentsForTesting(null)
  _setJobSetStateForTesting(null)
  delete process.env.WALNUT_GATEWAY_TIMEOUT_MS
  vi.restoreAllMocks()
  DaemonConnection.resetGatewayRelaysForTest()
})

describe('a plugin job\'s identity on a relay to the leader', () => {
  it('a real job\'s call, from the host its job is given to: the router gets the job', async () => {
    const r = await viaLink('devbox', frame({ caller: JOB }))
    expect(r.meta).toEqual({ pluginJob: { plugin: 'acme-sync', job: 'worker' } })
    expect(r.results).toEqual([{ relayId: relayN, result: { done: 1 } }])
  })

  it('under another name of the same daemon: still that host\'s job', async () => {
    aliases.pairs = [['newdev', 'devbox']]
    const r = await viaLink('newdev', frame({ caller: JOB }))
    expect(r.meta).toEqual({ pluginJob: { plugin: 'acme-sync', job: 'worker' } })
  })

  it('a host naming a job given to another host: dropped, plain external', async () => {
    const r = await viaLink('otherbox', frame({ caller: JOB }))
    expect(r.meta).toEqual({})
    // Another job of the same plugin, not given to devbox: dropped there too.
    expect((await viaLink('devbox', frame({ caller: { ...JOB, job: 'poll' } }))).meta).toEqual({})
  })

  it('an unassigned job: no host names it, this Mac\'s own daemon included', async () => {
    // A plugin with no run_on defaults to this computer, yet only a job the manager gives the local
    // daemon is kept from it: it cannot name any plugin or job it likes.
    given = {}
    expect((await viaLink('__local__', frame({ caller: JOB }))).meta).toEqual({})
    expect((await viaLink('__local__', frame({ caller: { kind: 'plugin-job', plugin: 'never-installed', job: 'x' } }))).meta).toEqual({})
    expect((await viaLink('devbox', frame({ caller: JOB }))).meta).toEqual({})
    // Given to the local daemon: kept from it, and only from it.
    given = { 'acme-sync/worker': ['__local__'] }
    expect((await viaLink('__local__', frame({ caller: JOB }))).meta).toEqual({ pluginJob: { plugin: 'acme-sync', job: 'worker' } })
    expect((await viaLink('devbox', frame({ caller: JOB }))).meta).toEqual({})
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

  it('a server with no plugin-jobs manager (a replica, a test server) keeps no job', async () => {
    _setJobAssignmentsForTesting(null)
    expect(await relayedJobOf({ callerSid: 'external', pluginJob: { plugin: 'acme-sync', job: 'worker' } }, 'devbox')).toBeUndefined()
  })
})

describe('relayedJobOf: what it keeps of a named job', () => {
  const ext = (pluginJob: { plugin: string; job: string; vouched?: unknown }) => ({ callerSid: 'external', pluginJob: pluginJob as { plugin: string; job: string; vouched?: boolean } })

  it('keeps `vouched` exactly as sent: true stays true, anything else is absent', async () => {
    expect(await relayedJobOf(ext({ plugin: 'acme-sync', job: 'worker', vouched: true }), 'devbox')).toEqual({ plugin: 'acme-sync', job: 'worker', vouched: true })
    expect(await relayedJobOf(ext({ plugin: 'acme-sync', job: 'worker' }), 'devbox')).toEqual({ plugin: 'acme-sync', job: 'worker' })
    for (const v of [false, 'true', 1, {}]) {
      const kept = await relayedJobOf(ext({ plugin: 'acme-sync', job: 'worker', vouched: v }), 'devbox')
      expect(kept).toEqual({ plugin: 'acme-sync', job: 'worker' })
      expect(kept).not.toHaveProperty('vouched')
    }
    // Vouched or not, a job not given to the host is dropped.
    expect(await relayedJobOf(ext({ plugin: 'acme-sync', job: 'worker', vouched: true }), 'otherbox')).toBeUndefined()
    // Under another name of the same daemon: kept, vouched with it.
    aliases.pairs = [['newdev', 'devbox']]
    expect(await relayedJobOf(ext({ plugin: 'acme-sync', job: 'worker', vouched: true }), 'newdev')).toEqual({ plugin: 'acme-sync', job: 'worker', vouched: true })
  })

  it('an id longer than the 120 characters a relayed frame keeps is dropped, never kept cut', async () => {
    const long = 'p'.repeat(121)
    given = { [`${long}/worker`]: ['devbox'], [`${'p'.repeat(120)}/worker`]: ['devbox'], [`acme-sync/${'j'.repeat(121)}`]: ['devbox'] }
    expect(await relayedJobOf(ext({ plugin: long, job: 'worker' }), 'devbox')).toBeUndefined()
    expect(await relayedJobOf(ext({ plugin: 'acme-sync', job: 'j'.repeat(121) }), 'devbox')).toBeUndefined()
    expect(await relayedJobOf(ext({ plugin: 'p'.repeat(120), job: 'worker' }), 'devbox')).toEqual({ plugin: 'p'.repeat(120), job: 'worker' })
    // The frame's parser cuts at the same length the leader keeps whole.
    const parsed = relayedCallOf(frame({ caller: { kind: 'plugin-job', plugin: 'p'.repeat(120), job: 'worker' } }))!
    expect(parsed.pluginJob!.plugin).toHaveLength(120)
  })

  it('a dropped name is logged once per host, job and reason every few minutes; a timed-out names check says so', async () => {
    const warn = vi.spyOn(log.session, 'warn')
    const drops = () => warn.mock.calls.filter(([m]) => String(m).startsWith('plugin jobs: a host named a job'))
    // A draining job calling again and again from a host it was moved off: one line.
    for (let i = 0; i < 5; i++) expect(await relayedJobOf(ext({ plugin: 'acme-sync', job: 'drained' }), 'loopbox')).toBeUndefined()
    expect(drops()).toHaveLength(1)
    expect(drops()[0]![1]).toMatchObject({ host: 'loopbox', plugin: 'acme-sync', job: 'drained', why: 'not-given-to-host' })
    // The check of the host's other names timed out: dropped, and the line says why.
    aliases.late = true
    expect(await relayedJobOf(ext({ plugin: 'acme-sync', job: 'worker' }), 'slowbox')).toBeUndefined()
    expect(drops().at(-1)![1]).toMatchObject({ host: 'slowbox', why: 'host-names-check-timed-out', givenTo: ['devbox'] })
    // Too long: its own reason.
    await relayedJobOf(ext({ plugin: 'q'.repeat(121), job: 'worker' }), 'devbox')
    expect(drops().at(-1)![1]).toMatchObject({ host: 'devbox', why: 'id-too-long' })
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

describe('right after this server starts: a job named before it knows the host\'s job set (2026-11-24)', () => {
  // Real use: the Mac's Walnut restarted, and for 14 s, until its first pass on clouddev ended, a
  // vouched job's task_start_check was read as `external` and refused bypass. Unknown is neither
  // kept nor dropped: the call waits within its time, and is refused as one to ask again.
  let known = false
  beforeEach(() => { known = false; _setJobSetStateForTesting(() => known ? 'known' : 'pending') })

  const VOUCHED = { ...JOB, vouched: true }
  const check = (over: Record<string, unknown> = {}) => frame({ caller: VOUCHED, payload: { name: 'task_start_check', args: { mode: 'bypass' } }, ...over })

  async function served(host: string, ev: Record<string, unknown>, conn = new DaemonConnection(host, null)) {
    const results: Array<Record<string, unknown>> = []
    vi.spyOn(conn, 'send').mockImplementation((async (cmd: string, params: Record<string, unknown>) => { if (cmd === 'gateway-result') results.push(params); return { ok: true } }) as never)
    const seen: unknown[][] = []
    vi.spyOn(router, 'handleGatewayCapability').mockImplementation(async (...args: unknown[]) => { seen.push(args); return { ok: true, result: { done: 1 } } })
    const at = Date.now()
    await (conn as unknown as Internals).handleGatewayRequest(ev)
    return { seen, results, ms: Date.now() - at }
  }

  it('the set becomes known within the call\'s time: the call waited and carries the job', async () => {
    given = {}
    setTimeout(() => { known = true; given = { 'acme-sync/worker': ['devbox'] } }, 400)
    const r = await served('devbox', check())
    expect(r.ms).toBeGreaterThanOrEqual(300)
    expect(r.seen).toHaveLength(1)
    expect(r.seen[0]![5]).toEqual({ pluginJob: { plugin: 'acme-sync', job: 'worker', vouched: true } })
    expect(r.results).toEqual([{ relayId: relayN, result: { done: 1 } }])
  })

  it('known, but not given to that host: plain external, as before', async () => {
    setTimeout(() => { known = true }, 200)
    const r = await served('otherbox', check())
    expect(r.seen).toHaveLength(1)
    expect(r.seen[0]![5]).toEqual({})
  })

  it('a match is kept at once while the set is still pending (another name of the same daemon too)', async () => {
    aliases.pairs = [['newdev', 'devbox']]
    for (const host of ['devbox', 'newdev']) {
      const r = await served(host, check())
      expect(r.ms).toBeLessThan(200)
      expect(r.seen[0]![5]).toEqual({ pluginJob: { plugin: 'acme-sync', job: 'worker', vouched: true } })
    }
  })

  it('still unknown when its time is spent: refused as one to ask again, and nothing ran', async () => {
    given = {}
    // The relay's own time (answerInMs) of 5.6 s leaves 0.6 s to wait (5 s are kept for the op).
    const r = await served('devbox', check({ answerInMs: 5600 }))
    expect(r.ms).toBeGreaterThanOrEqual(500)
    expect(r.ms).toBeLessThan(2000)
    expect(r.seen).toEqual([])
    expect(r.results).toHaveLength(1)
    expect(r.results[0]).toMatchObject({ relayId: relayN, errorCode: 'hub_unreachable', detail: { retryAfterMs: 5000, jobsNotKnownYet: true } })
    expect(String(r.results[0]!.error)).toMatch(/still setting up the plugin jobs of devbox.*acme-sync\/worker.*Nothing ran/)
  })

  it('a resend of the same relay shares the first verdict: told "nothing ran", it never runs', async () => {
    given = {}
    const ev = check({ answerInMs: 5600 })
    const first = await served('devbox', ev)
    expect(first.results[0]).toMatchObject({ errorCode: 'hub_unreachable' })
    // Now known and given: the same relay again (its daemon resent it on a new socket) is still refused.
    known = true
    given = { 'acme-sync/worker': ['devbox'] }
    const again = await served('devbox', { ...ev })
    expect(again.seen).toEqual([])
    expect(again.results[0]).toMatchObject({ errorCode: 'hub_unreachable' })
    // The same relay ids on another host's link never take devbox's verdict.
    const elsewhere = await served('otherbox', { ...ev })
    expect(elsewhere.seen).toHaveLength(1)
    expect(elsewhere.seen[0]![5]).toEqual({})
    // A new relay runs with the job.
    const fresh = await served('devbox', check())
    expect(fresh.seen[0]![5]).toEqual({ pluginJob: { plugin: 'acme-sync', job: 'worker', vouched: true } })
  })

  it('never waits: a call that names no job, a session\'s call, an unvouched job, or an op that does not read the job', async () => {
    given = {}
    for (const ev of [
      frame(), frame({ callerSid: 'sess-1', caller: VOUCHED }), check({ caller: JOB }),
      frame({ caller: VOUCHED, payload: { name: 'task_list', args: {} } }),
    ]) {
      const r = await served('devbox', ev)
      expect(r.ms).toBeLessThan(200)
      expect(r.seen).toHaveLength(1)
      expect(r.seen[0]![5]).toEqual({})
    }
  })

  it('relayedJobOf: with a time to wait an unknown set throws once it is spent; without one it reads anonymous at once', async () => {
    given = {}
    const call = { callerSid: 'external', pluginJob: { plugin: 'acme-sync', job: 'worker', vouched: true } }
    await expect(relayedJobOf(call, 'devbox', Date.now() + 50)).rejects.toThrow(/still setting up/)
    expect(await relayedJobOf(call, 'devbox')).toBeUndefined()
  })
})
