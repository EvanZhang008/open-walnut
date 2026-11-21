/**
 * A relayed plugin job's credential (core/plugin-jobs/job-caller.ts, on lib/relay-hold.ts): the
 * route reads the job only by a token this process held, only on a self-call made for the same
 * anonymous caller from the same host, for a minute. The job's own labels vouch for nothing.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { _clearRelayJobsForTesting, holdRelayJob, storedVouchedJob, vouchedPluginJob } from '../../src/core/plugin-jobs/job-caller.js'
import { createRelayHold } from '../../src/lib/relay-hold.js'

const JOB = { plugin: 'ticket-investigator', job: 'poll' }
const loopback = { remoteAddress: '127.0.0.1', localPort: 3456 }

function req(headers: Record<string, string | string[]>) {
  return { socket: loopback, headers }
}

function selfCall(token: string | undefined, extra: Record<string, string> = {}) {
  return req({
    'x-walnut-caller-sid': 'external', 'x-walnut-origin': 'host:devbox',
    'x-walnut-plugin-id': JOB.plugin, 'x-walnut-plugin-job': JOB.job,
    ...(token ? { 'x-walnut-caller-job': token } : {}), ...extra,
  })
}

describe('a relayed plugin job, held for the op\'s self-calls', () => {
  afterEach(() => _clearRelayJobsForTesting())

  it('is read back on the self-call it was held for, for a minute', () => {
    const t = holdRelayJob(JOB, 'devbox', 1_000)!
    expect(t).toMatch(/^[0-9a-f]{48}$/)
    expect(vouchedPluginJob(selfCall(t), 2_000)).toEqual({ ...JOB, host: 'devbox' })
    // The labels are optional: a self-call made by an op the plugin id did not ride on still reads.
    expect(vouchedPluginJob(req({ 'x-walnut-caller-sid': 'external', 'x-walnut-origin': 'host:devbox', 'x-walnut-caller-job': t }), 2_000)).toEqual({ ...JOB, host: 'devbox' })
    expect(vouchedPluginJob(selfCall(t), 61_001)).toBeNull()
  })

  it('names no job for labels alone, a token nobody held, or a real one on another call', () => {
    const t = holdRelayJob(JOB, 'devbox', 1_000)!
    expect(vouchedPluginJob(selfCall(undefined), 2_000)).toBeNull()
    expect(vouchedPluginJob(selfCall('f'.repeat(48)), 2_000)).toBeNull()
    expect(vouchedPluginJob(selfCall('not-a-token'), 2_000)).toBeNull()
    // Another caller: a session's sid, a plugin's server half, no caller at all.
    expect(vouchedPluginJob(selfCall(t, { 'x-walnut-caller-sid': 'sid-1' }), 2_000)).toBeNull()
    expect(vouchedPluginJob(selfCall(t, { 'x-walnut-caller-sid': 'plugin:ticket-investigator' }), 2_000)).toBeNull()
    const noSid = selfCall(t); delete (noSid.headers as Record<string, unknown>)['x-walnut-caller-sid']
    expect(vouchedPluginJob(noSid, 2_000)).toBeNull()
    // Another host's origin, this Mac's own, or a header sent twice.
    expect(vouchedPluginJob(selfCall(t, { 'x-walnut-origin': 'host:otherbox' }), 2_000)).toBeNull()
    expect(vouchedPluginJob(selfCall(t, { 'x-walnut-origin': '__local__' }), 2_000)).toBeNull()
    expect(vouchedPluginJob(selfCall(t, { 'x-walnut-origin': 'host:devbox, host:devbox' }), 2_000)).toBeNull()
    // Another plugin or another job named beside it.
    expect(vouchedPluginJob(selfCall(t, { 'x-walnut-plugin-id': 'other' }), 2_000)).toBeNull()
    expect(vouchedPluginJob(selfCall(t, { 'x-walnut-plugin-job': 'other' }), 2_000)).toBeNull()
    // Off this machine: the origin header is not taken at all.
    expect(vouchedPluginJob({ ...selfCall(t), socket: { remoteAddress: '203.0.113.9', localPort: 3456 } }, 2_000)).toBeNull()
  })

  it('holds none for a malformed job or no relaying host', () => {
    expect(holdRelayJob(undefined, 'devbox')).toBeUndefined()
    expect(holdRelayJob({ plugin: '', job: 'poll' }, 'devbox')).toBeUndefined()
    expect(holdRelayJob({ plugin: 'p', job: ' ' }, 'devbox')).toBeUndefined()
    expect(holdRelayJob({ plugin: 'p q', job: 'poll' }, 'devbox')).toBeUndefined()
    expect(holdRelayJob({ plugin: 'p'.repeat(121), job: 'poll' }, 'devbox')).toBeUndefined()
    expect(holdRelayJob({ plugin: 7, job: 'poll' } as never, 'devbox')).toBeUndefined()
    expect(holdRelayJob(JOB, '')).toBeUndefined()
  })

  it('a stored job reads back only whole', () => {
    expect(storedVouchedJob({ ...JOB, host: 'devbox' })).toEqual({ ...JOB, host: 'devbox' })
    expect(storedVouchedJob({ ...JOB })).toBeNull()
    expect(storedVouchedJob({ plugin: 'p', job: '', host: 'devbox' })).toBeNull()
    expect(storedVouchedJob('ticket-investigator')).toBeNull()
    expect(storedVouchedJob(null)).toBeNull()
  })
})

describe('one hold for every relayed word (lib/relay-hold.ts)', () => {
  it('a flood never drops a live token: once full it holds no new one, and expired ones make room', () => {
    const hold = createRelayHold<number>({ ttlMs: 1_000, max: 3 })
    const first = hold.hold(1, 0)!
    hold.hold(2, 0); hold.hold(3, 0)
    expect(hold.hold(4, 500)).toBeUndefined()
    expect(hold.get(first, 500)).toBe(1)
    expect(hold.hold(5, 1_000)).toBeDefined()
    expect(hold.get(first, 1_000)).toBeUndefined()
  })

  it('reads a header\'s first value, trimmed, and nothing that is not a token', () => {
    const hold = createRelayHold<string>({ ttlMs: 1_000, max: 10 })
    const t = hold.hold('x', 0)!
    expect(hold.get([` ${t} `, 'other'], 1)).toBe('x')
    expect(hold.get(undefined, 1)).toBeUndefined()
    expect(hold.get(42, 1)).toBeUndefined()
    hold.clear()
    expect(hold.get(t, 1)).toBeUndefined()
  })
})

describe('only an op that can start a task holds the job', () => {
  it('task_create, task_start and org_send (which declares the start route) do; reads and other writes do not', async () => {
    const { getOp } = await import('../../src/ops/index.js')
    const { opStartsTask } = await import('../../src/core/plugin-jobs/job-caller.js')
    for (const name of ['task_create', 'task_start', 'org_send']) expect(opStartsTask(getOp(name)!), name).toBe(true)
    for (const name of ['task_list', 'task_get', 'task_send', 'task_update', 'api']) expect(opStartsTask(getOp(name)!), name).toBe(false)
  })
})

describe('a plugin relay never passes on a relayed call\'s tokens', () => {
  it('drops the caller proof, trigger and job tokens beside Authorization', async () => {
    const { relayedPluginHeaders } = await import('../../src/core/plugins/plugin-http-rules.js')
    const out = relayedPluginHeaders({
      'X-Walnut-Caller-Job': 'a'.repeat(48), 'x-walnut-caller-proof': 'b'.repeat(48), 'x-walnut-caller-trigger': 'c'.repeat(48),
      authorization: 'Bearer x', 'x-walnut-plugin-id': 'ticket-investigator', accept: 'application/json',
    }, 'drop')
    expect(out).toEqual({ 'x-walnut-plugin-id': 'ticket-investigator', accept: 'application/json' })
  })
})

describe('a relayed frame keeps `vouched` only as the literal true (core/peers/gateway-answer.ts)', () => {
  it('true is kept; a string, a number, an object or no field reads as not vouched', async () => {
    const { relayedCallOf } = await import('../../src/core/peers/gateway-answer.js')
    const frame = (vouched?: unknown) => ({ relayId: 1, capability: 'tools.call', callerSid: 'external', payload: {}, caller: { kind: 'plugin-job', ...JOB, ...(vouched === undefined ? {} : { vouched }) } })
    expect(relayedCallOf(frame(true))!.pluginJob).toEqual({ ...JOB, vouched: true })
    for (const v of [undefined, 'true', 1, {}, false]) expect(relayedCallOf(frame(v))!.pluginJob, JSON.stringify(v)).toEqual(JOB)
  })
})
