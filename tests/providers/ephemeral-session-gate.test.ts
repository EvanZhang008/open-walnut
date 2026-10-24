// The ephemeral session gate (src/providers/ephemeral-session-gate.ts).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  gateSessionCommand,
  InheritedSessionRefusedError,
  refuseRealHomeWrite,
  resetEphemeralSessionGateForTests,
  settleSessionCommand,
  trustFixtureDaemon,
  type GateScope,
} from '../../src/providers/ephemeral-session-gate.js'
import { classifyDeliveryFailure } from '../../src/providers/delivery-failure.js'

const COPIED = 'aaaaaaaa-0000-4000-8000-000000000001'
const NEW = 'bbbbbbbb-0000-4000-8000-000000000002'
const FORK = 'cccccccc-0000-4000-8000-000000000003'
const OTHER = 'dddddddd-0000-4000-8000-000000000004'
const A: GateScope = { host: '__local__', url: 'ws://127.0.0.1:41000', instance: 'd-a' }
const B: GateScope = { host: 'devbox', url: 'ws://127.0.0.1:42000', instance: 'd-b' }
const ADAPTER = ['node', 'adapter-a.mjs']
const ADAPTER2 = ['node', 'adapter-b.mjs']

const gate = (s: GateScope, cmd: string, p: Record<string, unknown>) => gateSessionCommand(s, cmd, p, true)
const settle = (s: GateScope, cmd: string, r: unknown, a: ReturnType<typeof gate>, p: Record<string, unknown> = {}) =>
  settleSessionCommand(s, cmd, p, r, a, true)
const refused = (fn: () => unknown) => expect(fn).toThrow(InheritedSessionRefusedError)
const allowed = (fn: () => unknown) => expect(fn).not.toThrow()

const fresh = (id: string, sid = id) => ({ sid, args: ['claude', '-p', '--session-id', id], resume: false })
const resume = (id: string) => ({ sid: id, args: ['claude', '-p', '--resume', id], resume: true })
const fork = (src: string, id: string, sid = id) =>
  ({ sid, args: ['claude', '-p', '--resume', src, '--fork-session', '--session-id', id], resume: false })
const spawned = (tmp: string, extra: Record<string, unknown> = {}) =>
  ({ ok: true, pid: 4242, outputFile: `/streams/${tmp}.jsonl`, offset: 0, ...extra })

function startOwn(s: GateScope, id: string): void {
  settle(s, 'start', spawned(id), gate(s, 'start', fresh(id)))
}
function acpOwn(s: GateScope, rt: string, thread: string, adapter = ADAPTER): void {
  const p = { sid: rt, adapterCmd: adapter }
  settle(s, 'acpStart', { ok: true, session: { sessionId: thread } }, gate(s, 'acpStart', p))
}

beforeEach(() => resetEphemeralSessionGateForTests([COPIED, 'rt-copied']))

describe('native starts', () => {
  it('a copied session is never resumed, forked, attached to or written to', () => {
    refused(() => gate(A, 'start', resume(COPIED)))
    refused(() => gate(A, 'start', fork(COPIED, FORK)))
    for (const cmd of ['attach', 'send', 'sendRaw', 'appendUserMarker', 'setMode', 'bridgeResume', 'turns.restore']) {
      refused(() => gate(A, cmd, { sid: COPIED }))
    }
    // Supervision of a copied session may be read, never switched.
    allowed(() => gate(A, 'cron.supervision', { sid: COPIED }))
    refused(() => gate(A, 'cron.supervision', { sid: COPIED, enabled: true }))
    refused(() => gate(A, 'cron.supervision', { sid: COPIED, enabled: false }))
  })

  it('malformed or off-contract argv is refused, also with resume:false', () => {
    startOwn(A, NEW)
    const bad: Array<Record<string, unknown>> = [
      { sid: OTHER, args: ['claude', '-p'], resume: false }, // nothing minted
      fresh(COPIED), // copied id minted
      fresh(OTHER, COPIED), // copied sid
      fresh('not-a-uuid'),
      fresh(OTHER, 'tmp-1'), // sid is not the minted id
      fresh(NEW), // already own: a second spawn on one transcript
      { sid: OTHER, args: ['claude', '-p', '--session-id', OTHER], resume: true },
      { sid: COPIED, args: ['claude', '-p', '-r', COPIED], resume: false },
      { sid: COPIED, args: ['claude', '-p', '--resume', COPIED], resume: false },
      { sid: NEW, args: ['claude', '-p', '--resume'], resume: false }, // flag without a value
      { sid: NEW, args: ['claude', '-p', '--resume', '--verbose'], resume: true },
      { sid: NEW, args: ['claude', '-p', `--resume=${NEW}`], resume: true },
      { sid: NEW, args: ['claude', '-p', '--resume', NEW, '--resume', COPIED], resume: true },
      { sid: COPIED, args: ['claude', '-p', '--resume', NEW], resume: true }, // own source under a foreign sid
      { sid: 'other-key', args: ['claude', '-p', '--resume', NEW], resume: true },
      { sid: NEW, args: ['claude', '-p', '--resume', NEW, '--session-id', OTHER], resume: true },
      { sid: FORK, args: ['claude', '-p', '--fork-session', '--session-id', FORK], resume: false }, // fork with no source
    ]
    for (const p of bad) refused(() => gate(A, 'start', p))
    allowed(() => gate(A, 'start', resume(NEW)))
  })

  it('only a well-formed ok spawn reply from the same daemon instance confirms', () => {
    for (const [scope, reply] of [
      [A, { ok: false, error: 'spawn failed' }],
      [A, spawned(NEW, { adopted: true })],
      [A, spawned(NEW, { pid: undefined })],
      [A, spawned(NEW, { pid: 0 })],
      [A, spawned(NEW, { outputFile: `/streams/${COPIED}.jsonl` })],
      [A, { ok: true }],
      [A, null],
      [{ ...A, instance: 'd-restarted' }, spawned(NEW)],
    ] as Array<[GateScope, unknown]>) {
      resetEphemeralSessionGateForTests([COPIED])
      settle(scope, 'start', reply, gate(A, 'start', fresh(NEW)))
      refused(() => gate(A, 'send', { sid: NEW }))
    }
    resetEphemeralSessionGateForTests([COPIED])
    refused(() => gate({ ...A, instance: null }, 'start', fresh(NEW)))
  })

  it('a late reply of an earlier attempt cannot confirm or cancel the newer one', () => {
    const first = gate(A, 'start', fresh(NEW))
    const second = gate(A, 'start', fresh(NEW))
    expect(second).not.toBe(first)
    settle(A, 'start', spawned(NEW), first)
    refused(() => gate(A, 'send', { sid: NEW }))
    settle(A, 'start', { ok: false, error: 'late' }, first)
    settle(A, 'start', spawned(NEW), second)
    allowed(() => gate(A, 'send', { sid: NEW }))
  })

  it('a lost reply allows only the attach probe of that attempt, confirmed only by a running process on the same daemon', () => {
    const lost = gate(A, 'start', fresh(NEW))
    refused(() => gate(A, 'send', { sid: NEW }))
    const probe = gate(A, 'attach', { sid: NEW })
    expect(probe).toBe(lost)
    settle(A, 'attach', spawned(NEW, { alive: false, state: 'dead' }), probe)
    settle(A, 'attach', spawned(NEW, { alive: true }), probe) // no state
    settle({ ...A, instance: 'd-restarted' }, 'attach', spawned(NEW, { alive: true, state: 'running' }), probe)
    refused(() => gate(A, 'send', { sid: NEW }))
    settle(A, 'attach', spawned(NEW, { alive: true, state: 'running' }), probe)
    allowed(() => gate(A, 'send', { sid: NEW }))
    // A probe of a superseded attempt confirms nothing.
    gate(A, 'start', fresh(OTHER))
    const oldProbe = gate(A, 'attach', { sid: OTHER })
    gate(A, 'start', fresh(OTHER))
    settle(A, 'attach', spawned(OTHER, { alive: true, state: 'running' }), oldProbe)
    refused(() => gate(A, 'send', { sid: OTHER }))
  })

  it('an own session resumes; an own source forks and its new id is own; a copied fork target is refused', () => {
    startOwn(A, NEW)
    allowed(() => gate(A, 'start', resume(NEW)))
    settle(A, 'start', spawned(FORK), gate(A, 'start', fork(NEW, FORK)))
    allowed(() => gate(A, 'start', resume(FORK)))
    refused(() => gate(A, 'start', fork(NEW, COPIED)))
  })

  it('an own session the CLI renames stays own under its new id; a copied id is never taken', () => {
    startOwn(A, NEW)
    refused(() => gate(A, 'rename', { oldSid: NEW, newSid: COPIED }))
    refused(() => gate(A, 'rename', { oldSid: NEW, newSid: 'not-a-uuid' }))
    refused(() => gate(A, 'rename', { oldSid: COPIED, newSid: OTHER }))
    refused(() => gate(A, 'send', { sid: OTHER }))
    allowed(() => gate(A, 'rename', { oldSid: NEW, newSid: OTHER }))
    allowed(() => gate(A, 'send', { sid: OTHER }))
  })

  it('ownership is per host', () => {
    startOwn(A, NEW)
    refused(() => gate(B, 'start', resume(NEW)))
    refused(() => gate(B, 'send', { sid: NEW }))
    refused(() => gate(B, 'rename', { oldSid: NEW, newSid: NEW }))
  })

  it('an unarmed gate refuses every start', () => {
    resetEphemeralSessionGateForTests(null)
    refused(() => gate(A, 'start', fresh(NEW)))
    refused(() => gate(A, 'acpStart', { sid: 'rt-1', adapterCmd: ADAPTER }))
  })
})

describe('ACP', () => {
  const load = (rt: string, thread: string, adapter = ADAPTER) => ({ sid: rt, adapterCmd: adapter, providerSessionId: thread })

  it('a copied thread or runtime is never loaded, also from an own runtime', () => {
    refused(() => gate(A, 'acpStart', load('rt-copied', COPIED)))
    refused(() => gate(A, 'acpStart', { sid: 'rt-copied', adapterCmd: ADAPTER }))
    acpOwn(A, 'rt-new', 'thread-new')
    refused(() => gate(A, 'acpStart', load('rt-new', COPIED)))
  })

  it('a fresh start owns nothing unless its ok reply names a usable thread', () => {
    for (const reply of [{ ok: false, error: 'x', session: { sessionId: 'thread-x' } }, { ok: true }, { ok: true, session: {} }, { ok: true, session: { sessionId: COPIED } }]) {
      resetEphemeralSessionGateForTests([COPIED])
      settle(A, 'acpStart', reply, gate(A, 'acpStart', { sid: 'rt-1', adapterCmd: ADAPTER }))
      refused(() => gate(A, 'acpSend', { sid: 'rt-1' }))
      refused(() => gate(A, 'acpStart', load('rt-2', 'thread-x')))
    }
  })

  it('an own thread reloads under its own adapter and host only', () => {
    acpOwn(A, 'rt-new', 'thread-new')
    allowed(() => gate(A, 'acpSend', { sid: 'rt-new' }))
    allowed(() => gate(A, 'acpStart', load('rt-new', 'thread-new')))
    refused(() => gate(A, 'acpStart', load('rt-new', 'thread-new', ADAPTER2)))
    refused(() => gate(B, 'acpStart', load('rt-b', 'thread-new')))
  })

  it('a late reply of an earlier acpStart cannot confirm the newer one', () => {
    const first = gate(A, 'acpStart', { sid: 'rt-1', adapterCmd: ADAPTER })
    const second = gate(A, 'acpStart', { sid: 'rt-1', adapterCmd: ADAPTER2 })
    settle(A, 'acpStart', { ok: true, session: { sessionId: 'thread-1' } }, first)
    refused(() => gate(A, 'acpSend', { sid: 'rt-1' }))
    settle(A, 'acpStart', { ok: true, session: { sessionId: 'thread-2' } }, second)
    allowed(() => gate(A, 'acpStart', load('rt-1', 'thread-2', ADAPTER2)))
    refused(() => gate(A, 'acpStart', load('rt-1', 'thread-1', ADAPTER)))
  })

  it('a failed load keeps an already own runtime for the fresh fallback; a new runtime gains nothing', () => {
    acpOwn(A, 'rt-1', 'thread-1')
    settle(A, 'acpStart', { ok: false, errorKind: 'load_failed' }, gate(A, 'acpStart', load('rt-1', 'thread-1')))
    const fallback = gate(A, 'acpNewSession', { sid: 'rt-1' })
    settle(A, 'acpNewSession', { ok: true, result: { sessionId: 'thread-2' } }, fallback)
    allowed(() => gate(A, 'acpStart', load('rt-1', 'thread-2')))
    settle(A, 'acpStart', { ok: false, errorKind: 'load_failed' }, gate(A, 'acpStart', load('rt-fresh', 'thread-1')))
    refused(() => gate(A, 'acpNewSession', { sid: 'rt-fresh' }))
    refused(() => gate(A, 'acpNewSession', { sid: 'rt-copied' }))
  })

  it('refuses every ACP input command for a runtime it does not own', () => {
    for (const cmd of ['acpSend', 'acpSteer', 'acpRespond', 'acpCancel', 'acpSetConfigOption', 'acpNewSession']) {
      refused(() => gate(A, cmd, { sid: 'rt-copied' }))
    }
  })
})

describe('agent.* frames', () => {
  it('route through the daemon resolver and meet the same rules, native and ACP', () => {
    refused(() => gate(A, 'agent.start', resume(COPIED)))
    refused(() => gate(A, 'agent.start', { ...fresh(COPIED) }))
    for (const op of ['send', 'steer', 'setOption']) refused(() => gate(A, `agent.${op}`, { sid: COPIED }))
    for (const op of ['start', 'send', 'steer', 'respond', 'cancel', 'setOption', 'newSession']) {
      refused(() => gate(A, `agent.${op}`, { engine: 'codex', sid: 'rt-copied', adapterCmd: ADAPTER, providerSessionId: COPIED }))
    }
    // An op the daemon would not run, or does not know, is refused here too.
    refused(() => gate(A, 'agent.newSession', { sid: NEW }))
    refused(() => gate(A, 'agent.bogus', { sid: NEW }))
    // An own session through the alias.
    const a = gate(A, 'agent.start', fresh(NEW))
    settle(A, 'agent.start', spawned(NEW), a, fresh(NEW))
    allowed(() => gate(A, 'agent.send', { sid: NEW }))
    allowed(() => gate(A, 'agent.start', resume(NEW)))
    allowed(() => gate(A, 'agent.stop', { sid: COPIED }))
    allowed(() => gate(A, 'agent.state', { engine: 'codex', sid: 'rt-copied' }))
  })
})

describe('ACP runtime generations', () => {
  it('a late acpNewSession reply from before a restart of the runtime owns nothing', () => {
    acpOwn(A, 'rt-1', 'thread-1')
    const late = gate(A, 'acpNewSession', { sid: 'rt-1' })
    // The runtime is started again, here under another adapter, before the reply lands.
    acpOwn(A, 'rt-1', 'thread-b', ADAPTER2)
    settle(A, 'acpNewSession', { ok: true, result: { sessionId: 'thread-late' } }, late)
    refused(() => gate(A, 'acpStart', { sid: 'rt-1', adapterCmd: ADAPTER, providerSessionId: 'thread-late' }))
    refused(() => gate(A, 'acpStart', { sid: 'rt-1', adapterCmd: ADAPTER2, providerSessionId: 'thread-late' }))
    // Same adapter, restarted: still superseded.
    const late2 = gate(A, 'acpNewSession', { sid: 'rt-1' })
    settle(A, 'acpStart', { ok: true }, gate(A, 'acpStart', { sid: 'rt-1', adapterCmd: ADAPTER2, providerSessionId: 'thread-b' }))
    settle(A, 'acpNewSession', { ok: true, result: { sessionId: 'thread-late2' } }, late2)
    refused(() => gate(A, 'acpStart', { sid: 'rt-1', adapterCmd: ADAPTER2, providerSessionId: 'thread-late2' }))
  })
})

describe('what stays open', () => {
  it('reads and stops are not gated, so copied sessions still display', () => {
    for (const cmd of ['read-history', 'status', 'getState', 'stop', 'fs.read', 'fs.ls', 'acpState', 'acpStop', 'ping']) {
      allowed(() => gate(A, cmd, { sid: COPIED }))
    }
  })

  it('the production server never runs the gate', () => {
    allowed(() => gateSessionCommand(A, 'start', resume(COPIED), false))
    allowed(() => gateSessionCommand(A, 'send', { sid: COPIED }, false))
  })
})

describe('fixture seam', () => {
  const realHome = process.env.HOME
  afterEach(() => { process.env.HOME = realHome })
  const scratchHome = () => { process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-home-')) }

  it('skips only the named MockDaemon instance at that URL', () => {
    scratchHome()
    trustFixtureDaemon('ws://127.0.0.1:41999', 'mock-1', true)
    allowed(() => gate({ host: '__local__', url: 'ws://127.0.0.1:41999', instance: 'mock-1' }, 'start', resume(COPIED)))
    // Same port, another daemon (the mock stopped and a real one took the port).
    refused(() => gate({ host: '__local__', url: 'ws://127.0.0.1:41999', instance: 'real-1' }, 'start', resume(COPIED)))
    refused(() => gate({ host: '__local__', url: 'ws://127.0.0.1:41998', instance: 'mock-1' }, 'start', resume(COPIED)))
    refused(() => gate({ host: '__local__', url: null, instance: null }, 'send', { sid: COPIED }))
  })

  it('refuses a non-loopback URL, a missing instance, a real HOME, or the production server', () => {
    scratchHome()
    expect(() => trustFixtureDaemon('ws://10.0.0.5:41999', 'mock-1', true)).toThrow()
    expect(() => trustFixtureDaemon('ws://127.0.0.1:41999', '', true)).toThrow()
    expect(() => trustFixtureDaemon('ws://127.0.0.1:41999', 'mock-1', false)).toThrow()
    process.env.HOME = '/'
    expect(() => trustFixtureDaemon('ws://127.0.0.1:41999', 'mock-1', true)).toThrow()
  })
})

describe('team inboxes', () => {
  const realHome = process.env.HOME
  afterEach(() => { process.env.HOME = realHome })

  it('a test server on the real HOME never writes one; a scratch HOME may', () => {
    process.env.HOME = '/'
    refused(() => refuseRealHomeWrite('team-send', true))
    allowed(() => refuseRealHomeWrite('team-send', false))
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-home-'))
    allowed(() => refuseRealHomeWrite('team-send', true))
  })
})

describe('a refused delivery is parked, not retried', () => {
  it('classifies the refusal as permanent, also by message alone', () => {
    const err = new InheritedSessionRefusedError(COPIED, 'start')
    expect(classifyDeliveryFailure(err)).toMatchObject({ kind: 'permanent', code: 'inherited_session' })
    expect(classifyDeliveryFailure(new Error(err.message))).toMatchObject({ kind: 'permanent', code: 'inherited_session' })
  })
})
