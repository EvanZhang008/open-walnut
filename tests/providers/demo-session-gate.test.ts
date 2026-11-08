// The session gate on a demo server (src/providers/ephemeral-session-gate.ts with IS_DEMO): what its
// own confirmed spawns minted survives a restart through the real ownership file
// (src/providers/demo-session-ownership.ts), and nothing else does. The file lives in a scratch
// data home; only the constants are mocked, never the persistence.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
import { WALNUT_HOME } from '../../src/constants.js'
import {
  armEphemeralSessionGate,
  gateSessionCommand,
  InheritedSessionRefusedError,
  refuseRealHomeWrite,
  resetEphemeralSessionGateForTests,
  settleSessionCommand,
  type GateScope,
} from '../../src/providers/ephemeral-session-gate.js'
import { readDemoOwnership } from '../../src/providers/demo-session-ownership.js'
import { closeDemoAdmission, resetDemoAdmissionForTests } from '../../src/core/sessions/demo-admission.js'

vi.mock('../../src/constants.js', async () => {
  const nodeFs = await import('node:fs')
  const nodePath = await import('node:path')
  const { createMockConstants } = await import('../helpers/mock-constants.js')
  const constants = createMockConstants('walnut-demo-gate', { IS_DEMO: true, IS_EPHEMERAL: true })
  const home = nodePath.join(constants.WALNUT_HOME, 'open-walnut-demo', 'data', 'generation')
  nodeFs.mkdirSync(home, { recursive: true })
  return { ...constants, WALNUT_HOME: home }
})

const COPIED = 'aaaaaaaa-0000-4000-8000-000000000001'
const NEW = 'bbbbbbbb-0000-4000-8000-000000000002'
const FORK = 'cccccccc-0000-4000-8000-000000000003'
const OTHER = 'dddddddd-0000-4000-8000-000000000004'
const A: GateScope = { host: '__local__', url: 'ws://127.0.0.1:41000', instance: 'd-a' }
const B: GateScope = { host: 'devbox', url: 'ws://127.0.0.1:42000', instance: 'd-b' }
const ADAPTER = ['node', 'adapter-a.mjs']
const ADAPTER2 = ['node', 'adapter-b.mjs']
const NATIVE_INPUT = ['send', 'sendRaw', 'appendUserMarker', 'setMode', 'bridgeResume', 'turns.restore']
const ACP_INPUT = ['acpSend', 'acpSteer', 'acpRespond', 'acpCancel', 'acpSetConfigOption']

const FILE = path.join(WALNUT_HOME, 'local', 'demo-session-ownership.json')
const local = (...parts: string[]) => ['__local__', ...parts].join('\u0000')

// The gate's defaults (enabled = IS_EPHEMERAL) are used on purpose: the mocked constants drive it.
const gate = (s: GateScope, cmd: string, p: Record<string, unknown>) => gateSessionCommand(s, cmd, p)
const settle = (s: GateScope, cmd: string, r: unknown, a: ReturnType<typeof gate>, p: Record<string, unknown> = {}) =>
  settleSessionCommand(s, cmd, p, r, a)
const refused = (fn: () => unknown) => expect(fn).toThrow(InheritedSessionRefusedError)
const allowed = (fn: () => unknown) => expect(fn).not.toThrow()

const fresh = (id: string, sid = id) => ({ sid, args: ['claude', '-p', '--session-id', id], resume: false })
const resume = (id: string) => ({ sid: id, args: ['claude', '-p', '--resume', id], resume: true })
const fork = (src: string, id: string) =>
  ({ sid: id, args: ['claude', '-p', '--resume', src, '--fork-session', '--session-id', id], resume: false })
const spawned = (id: string, extra: Record<string, unknown> = {}) =>
  ({ ok: true, pid: 4242, outputFile: `/streams/${id}.jsonl`, offset: 0, ...extra })
const load = (rt: string, thread: string, adapter = ADAPTER) => ({ sid: rt, adapterCmd: adapter, providerSessionId: thread })

/** A restarted demo server: its memory is gone, and it arms on what its copied store lists. */
async function restart(ids: string[]): Promise<void> {
  resetEphemeralSessionGateForTests(null)
  await armEphemeralSessionGate(ids)
}
const saved = () => readDemoOwnership(WALNUT_HOME)
function plant(value: unknown): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(value), { mode: 0o600 })
}

beforeAll(() => {
  // The data home is a scratch dir, never the account's own Walnut home.
  expect(fs.realpathSync(WALNUT_HOME).startsWith(fs.realpathSync(os.tmpdir()) + path.sep)).toBe(true)
  expect(WALNUT_HOME).not.toBe(path.join(os.homedir(), '.open-walnut'))
})

beforeEach(async () => {
  resetDemoAdmissionForTests()
  vi.stubEnv('HOME', fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-demo-gate-home-')))
  fs.rmSync(path.join(WALNUT_HOME, 'local'), { recursive: true, force: true })
  await restart([COPIED, 'rt-copied'])
})

afterEach(() => {
  resetDemoAdmissionForTests()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('the final Demo daemon command boundary while stopping', () => {
  it('refuses a pending launch or write but still permits ownership reads and stops', async () => {
    await settle(A, 'start', spawned(NEW), gate(A, 'start', fresh(NEW)))
    closeDemoAdmission()
    for (const [cmd, params] of [
      ['start', fresh(OTHER)], ['acpStart', { sid: 'new-rt', adapterCmd: ADAPTER }],
      ['acpNewSession', { sid: NEW }], ['send', { sid: NEW }],
      ['oneshot.run', {}], ['exec.run', {}],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(() => gate(A, cmd, params)).toThrow(/Demo is stopping/)
      expect(() => gateSessionCommand(A, cmd, params, false)).toThrow(/Demo is stopping/)
    }
    for (const cmd of ['stop', 'acpStop', 'list', 'exec.list', 'acpState']) allowed(() => gate(A, cmd, { sid: NEW }))
  })
})

describe('Demo team inbox HOME write permission', () => {
  it('permits only its generation HOME paired with its own data directory', () => {
    const generation = path.basename(WALNUT_HOME)
    const root = path.resolve(WALNUT_HOME, '../..')
    const home = path.join(root, 'homes', generation)
    fs.mkdirSync(home, { recursive: true })
    vi.stubEnv('WALNUT_DEMO_ROOT', root)
    vi.stubEnv('WALNUT_DEMO_GENERATION', generation)
    vi.stubEnv('HOME', home)
    vi.spyOn(os, 'tmpdir').mockReturnValue('/outside-the-test-temp')
    vi.spyOn(fs, 'realpathSync').mockImplementation(file => String(file))
    allowed(() => refuseRealHomeWrite('team inbox'))
    vi.stubEnv('WALNUT_DEMO_GENERATION', 'another-generation')
    vi.stubEnv('HOME', path.join(root, 'homes', 'another-generation'))
    fs.mkdirSync(process.env.HOME!, { recursive: true })
    refused(() => refuseRealHomeWrite('team inbox'))
  })

  it('refuses invalid generation and unavailable HOME without an errno', () => {
    vi.stubEnv('WALNUT_DEMO_ROOT', path.join(WALNUT_HOME, 'open-walnut-demo'))
    vi.stubEnv('WALNUT_DEMO_GENERATION', '../escape')
    vi.stubEnv('HOME', '/unavailable-demo-home')
    refused(() => refuseRealHomeWrite('team inbox'))
  })
})

describe('a confirmed native start', () => {
  it('is written before settle resolves and lets the restarted server resume and write into it', async () => {
    const pending = settle(A, 'start', spawned(NEW), gate(A, 'start', fresh(NEW)))
    expect(pending).toBeInstanceOf(Promise)
    await pending
    expect((await saved()).own).toEqual([local(NEW)])
    if (process.platform !== 'win32') expect(fs.statSync(FILE).mode & 0o777).toBe(0o600)

    // Memory alone is gone after a restart: nothing is allowed until the gate is armed again.
    resetEphemeralSessionGateForTests(null)
    refused(() => gate(A, 'start', resume(NEW)))
    // The restarted server's copied store lists the session too; the file says it was its own.
    await armEphemeralSessionGate([COPIED, NEW])
    allowed(() => gate(A, 'start', resume(NEW)))
    for (const cmd of [...NATIVE_INPUT, 'attach']) allowed(() => gate(A, cmd, { sid: NEW }))
    allowed(() => gate(A, 'cron.supervision', { sid: NEW, enabled: true }))
    // Still one transcript per id, and a copied session stays copied.
    refused(() => gate(A, 'start', fresh(NEW)))
    refused(() => gate(A, 'start', resume(COPIED)))
    refused(() => gate(A, 'send', { sid: COPIED }))
  })

  it('ownership adds up across restarts: a fork of a restored session is own after the next one', async () => {
    await settle(A, 'start', spawned(NEW), gate(A, 'start', fresh(NEW)))
    await restart([COPIED, NEW])
    await settle(A, 'start', spawned(FORK), gate(A, 'start', fork(NEW, FORK)))
    expect((await saved()).own.sort()).toEqual([local(NEW), local(FORK)].sort())
    await restart([COPIED, NEW, FORK])
    allowed(() => gate(A, 'start', resume(NEW)))
    allowed(() => gate(A, 'start', resume(FORK)))
    allowed(() => gate(A, 'send', { sid: FORK }))
  })

  it('a start confirmed by the attach probe of a lost reply is written too', async () => {
    const lost = gate(A, 'start', fresh(NEW))
    const probe = gate(A, 'attach', { sid: NEW })
    expect(probe).toBe(lost)
    await settle(A, 'attach', spawned(NEW, { alive: true, state: 'running' }), probe)
    await restart([COPIED, NEW])
    allowed(() => gate(A, 'start', resume(NEW)))
  })
})

describe('a spawn that failed or was malformed', () => {
  const badReplies: Array<[string, GateScope, unknown]> = [
    ['not ok', A, { ok: false, error: 'spawn failed' }],
    ['adopted', A, spawned(NEW, { adopted: true })],
    ['no pid', A, spawned(NEW, { pid: undefined })],
    ['zero pid', A, spawned(NEW, { pid: 0 })],
    ['negative pid', A, spawned(NEW, { pid: -1 })],
    ['another transcript', A, spawned(NEW, { outputFile: `/streams/${COPIED}.jsonl` })],
    ['no output file', A, { ok: true, pid: 4242 }],
    ['empty', A, { ok: true }],
    ['null', A, null],
    ['another daemon instance', { ...A, instance: 'd-restarted' }, spawned(NEW)],
  ]

  it.each(badReplies)('never persists a permit (%s)', async (_name, scope, reply) => {
    await settle(scope, 'start', reply, gate(A, 'start', fresh(NEW)))
    expect((await saved()).own).not.toContain(local(NEW))
    await restart([COPIED, NEW])
    for (const cmd of [...NATIVE_INPUT, 'attach']) refused(() => gate(A, cmd, { sid: NEW }))
    // A resume is no permit: the id is this Demo's own fresh one (minted, never a copied
    // conversation), so the start goes through only as an attempt its daemon must confirm.
    expect(gate(A, 'start', resume(NEW))).toMatchObject({ kind: 'start', sid: NEW })
    refused(() => gate(A, 'send', { sid: NEW }))
  })

  it('a failure after a success keeps only the success', async () => {
    await settle(A, 'start', spawned(NEW), gate(A, 'start', fresh(NEW)))
    await settle(A, 'start', { ok: false, error: 'spawn failed' }, gate(A, 'start', fresh(OTHER)))
    expect((await saved()).own).toEqual([local(NEW)])
    await restart([COPIED, NEW, OTHER])
    allowed(() => gate(A, 'send', { sid: NEW }))
    refused(() => gate(A, 'send', { sid: OTHER }))
  })

  it('a start the gate refused writes nothing', async () => {
    for (const p of [
      fresh(COPIED),
      fresh('not-a-uuid'),
      fresh(OTHER, NEW),
      { sid: NEW, args: ['claude', '-p'], resume: false },
      { sid: NEW, args: ['claude', '-p', `--session-id=${NEW}`], resume: false },
      { sid: NEW, args: ['claude', '-p', '--session-id', NEW], resume: true },
      { sid: FORK, args: ['claude', '-p', '--fork-session', '--session-id', FORK], resume: false },
    ]) refused(() => gate(A, 'start', p))
    refused(() => gate({ ...A, instance: null }, 'start', fresh(NEW)))
    expect(fs.existsSync(FILE)).toBe(false)
  })

  it('a reply that never came, or a probe of a dead process, permits nothing after a restart', async () => {
    const lost = gate(A, 'start', fresh(NEW))
    await settle(A, 'attach', spawned(NEW, { alive: false, state: 'dead' }), gate(A, 'attach', { sid: NEW }))
    expect(lost).toBeDefined()
    expect((await saved()).own).toEqual([])
    await restart([COPIED, NEW])
    refused(() => gate(A, 'attach', { sid: NEW }))
    // Its own minted id: a resume is only an attempt, never a write permit.
    expect(gate(A, 'start', resume(NEW))).toMatchObject({ kind: 'start', sid: NEW })
    refused(() => gate(A, 'send', { sid: NEW }))
  })
})

describe('copied sessions and other hosts', () => {
  it('a copied session with no ownership file is never resumed, forked, attached to or written to', async () => {
    expect(fs.existsSync(FILE)).toBe(false)
    refused(() => gate(A, 'start', resume(COPIED)))
    refused(() => gate(A, 'start', fork(COPIED, FORK)))
    for (const cmd of [...NATIVE_INPUT, 'attach']) refused(() => gate(A, cmd, { sid: COPIED }))
    refused(() => gate(A, 'acpStart', { sid: 'rt-copied', adapterCmd: ADAPTER }))
    for (const cmd of ACP_INPUT) refused(() => gate(A, cmd, { sid: 'rt-copied' }))
  })

  it('an ownership file copied from another data home is refused, and grants nothing', async () => {
    plant({ v: 1, home: path.join(os.tmpdir(), 'walnut-some-other-home'), own: [local(COPIED)], threads: [], adapters: [] })
    resetEphemeralSessionGateForTests(null)
    await expect(armEphemeralSessionGate([COPIED])).rejects.toThrow(/invalid/)
    refused(() => gate(A, 'start', resume(COPIED)))
    refused(() => gate(A, 'send', { sid: COPIED }))
  })

  it('an ownership file naming a remote host is refused, and grants nothing on any host', async () => {
    plant({ v: 1, home: WALNUT_HOME, own: [['devbox', COPIED].join('\u0000')], threads: [], adapters: [] })
    resetEphemeralSessionGateForTests(null)
    await expect(armEphemeralSessionGate([COPIED])).rejects.toThrow(/invalid/)
    refused(() => gate(B, 'start', resume(COPIED)))
    refused(() => gate(A, 'start', resume(COPIED)))
  })

  it.skipIf(process.platform === 'win32')('an ownership file behind a symlink is refused', async () => {
    const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-demo-gate-link-')), 'own.json')
    fs.writeFileSync(target, JSON.stringify({ v: 1, home: WALNUT_HOME, own: [local(COPIED)], threads: [], adapters: [] }))
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    fs.symlinkSync(target, FILE)
    resetEphemeralSessionGateForTests(null)
    await expect(armEphemeralSessionGate([COPIED])).rejects.toMatchObject({ code: 'ELOOP' })
    refused(() => gate(A, 'start', resume(COPIED)))
  })

  it('the written record carries only local keys, also when a remote host owns sessions in memory', async () => {
    await settle(B, 'start', spawned(NEW), gate(B, 'start', fresh(NEW)))
    await settle(B, 'acpStart', { ok: true, session: { sessionId: 'thread-b' } }, gate(B, 'acpStart', { sid: 'rt-b', adapterCmd: ADAPTER }))
    await settle(A, 'start', spawned(OTHER), gate(A, 'start', fresh(OTHER)))
    const rec = await saved()
    expect(rec.own).toEqual([local(OTHER)])
    expect(rec.threads).toEqual([])
    expect(rec.adapters).toEqual([])
    const raw = fs.readFileSync(FILE, 'utf8')
    expect(raw).not.toContain('devbox')
    expect(raw).not.toContain(NEW)
    // The record it wrote is one the next boot accepts.
    await restart([COPIED, NEW, OTHER])
    allowed(() => gate(A, 'send', { sid: OTHER }))
    refused(() => gate(B, 'send', { sid: NEW }))
  })

  it('a restored local session id is not own on another host', async () => {
    await settle(A, 'start', spawned(NEW), gate(A, 'start', fresh(NEW)))
    await restart([COPIED, NEW])
    allowed(() => gate(A, 'start', resume(NEW)))
    refused(() => gate(B, 'start', resume(NEW)))
    for (const cmd of [...NATIVE_INPUT, 'attach']) refused(() => gate(B, cmd, { sid: NEW }))
    refused(() => gate(B, 'rename', { oldSid: NEW, newSid: OTHER }))
  })

  it('a start confirmed on a remote host is never written, so it is gone after a restart', async () => {
    const result = settle(B, 'start', spawned(NEW), gate(B, 'start', fresh(NEW)))
    expect(result).toBeUndefined()
    allowed(() => gate(B, 'send', { sid: NEW }))
    expect(fs.existsSync(FILE)).toBe(false)
    await restart([COPIED, NEW])
    refused(() => gate(B, 'start', resume(NEW)))
    refused(() => gate(A, 'start', resume(NEW)))
  })
})

describe('ACP runtimes and threads', () => {
  const startFresh = (rt: string, thread: string, adapter = ADAPTER, scope = A) =>
    settle(scope, 'acpStart', { ok: true, session: { sessionId: thread } }, gate(scope, 'acpStart', { sid: rt, adapterCmd: adapter }))

  it('an own thread is written with its adapter and reloads after a restart only under that adapter and host', async () => {
    await startFresh('rt-1', 'thread-1')
    const rec = await saved()
    expect(rec.own).toEqual([local('rt-1')])
    expect(rec.threads).toEqual([local(JSON.stringify(ADAPTER), 'thread-1')])
    expect(rec.adapters).toEqual([[local('rt-1'), JSON.stringify(ADAPTER)]])

    await restart([COPIED, 'rt-copied', 'rt-1', 'thread-1'])
    for (const cmd of ACP_INPUT) allowed(() => gate(A, cmd, { sid: 'rt-1' }))
    refused(() => gate(A, 'acpStart', load('rt-1', 'thread-1', ADAPTER2)))
    refused(() => gate(B, 'acpStart', load('rt-1', 'thread-1')))
    refused(() => gate(B, 'acpSend', { sid: 'rt-1' }))
    refused(() => gate(A, 'acpStart', load('rt-copied', 'thread-1')))
    allowed(() => gate(A, 'acpStart', load('rt-1', 'thread-1')))
  })

  it('a new provider thread on a restored runtime keeps the restored adapter and survives the next restart', async () => {
    await startFresh('rt-1', 'thread-1')
    await restart(['rt-1', 'thread-1'])
    const next = gate(A, 'acpNewSession', { sid: 'rt-1' })
    expect(next).toMatchObject({ kind: 'acpNew', adapter: JSON.stringify(ADAPTER) })
    await settle(A, 'acpNewSession', { ok: true, result: { sessionId: 'thread-2' } }, next)
    expect((await saved()).threads.sort()).toEqual([
      local(JSON.stringify(ADAPTER), 'thread-1'),
      local(JSON.stringify(ADAPTER), 'thread-2'),
    ].sort())
    await restart(['rt-1', 'thread-1', 'thread-2'])
    allowed(() => gate(A, 'acpStart', load('rt-1', 'thread-2')))
    refused(() => gate(A, 'acpStart', load('rt-1', 'thread-2', ADAPTER2)))
  })

  it('a reload of an own thread under another adapter is refused and writes nothing new', async () => {
    await startFresh('rt-1', 'thread-1')
    const before = fs.readFileSync(FILE, 'utf8')
    await restart(['rt-1', 'thread-1'])
    refused(() => gate(A, 'acpStart', load('rt-1', 'thread-1', ADAPTER2)))
    refused(() => gate(A, 'acpStart', load('rt-2', 'thread-1', ADAPTER2)))
    expect(fs.readFileSync(FILE, 'utf8')).toBe(before)
  })

  it.each([
    ['not ok', { ok: false, error: 'x', session: { sessionId: 'thread-1' } }],
    ['no session', { ok: true }],
    ['no thread id', { ok: true, session: {} }],
    ['a copied thread id', { ok: true, session: { sessionId: COPIED } }],
  ])('a fresh start that failed persists no runtime, thread or adapter (%s)', async (_name, reply) => {
    await settle(A, 'acpStart', reply, gate(A, 'acpStart', { sid: 'rt-1', adapterCmd: ADAPTER }))
    const rec = await saved()
    expect(rec.own).toEqual([])
    expect(rec.threads).toEqual([])
    expect(rec.adapters).toEqual([])
    await restart([COPIED, 'rt-1', 'thread-1'])
    for (const cmd of [...ACP_INPUT, 'acpNewSession']) refused(() => gate(A, cmd, { sid: 'rt-1' }))
    refused(() => gate(A, 'acpStart', load('rt-2', 'thread-1')))
  })

  it('a hand-written record restores only the adapter it names for each thread', async () => {
    plant({
      v: 1,
      home: WALNUT_HOME,
      own: [local('rt-1')],
      threads: [local(JSON.stringify(ADAPTER2), 'thread-1')],
      adapters: [[local('rt-1'), JSON.stringify(ADAPTER2)]],
    })
    await restart(['rt-1', 'thread-1'])
    refused(() => gate(A, 'acpStart', load('rt-1', 'thread-1', ADAPTER)))
    allowed(() => gate(A, 'acpStart', load('rt-1', 'thread-1', ADAPTER2)))
  })

  it('an ACP start on a remote host is never written', async () => {
    expect(startFresh('rt-b', 'thread-b', ADAPTER, B)).toBeUndefined()
    allowed(() => gate(B, 'acpSend', { sid: 'rt-b' }))
    expect(fs.existsSync(FILE)).toBe(false)
    await restart(['rt-b', 'thread-b'])
    refused(() => gate(B, 'acpSend', { sid: 'rt-b' }))
    refused(() => gate(B, 'acpStart', load('rt-b', 'thread-b')))
  })
})

describe('a rename', () => {
  it('confirmed by an ok reply is written, so the new id takes input after a restart', async () => {
    await settle(A, 'start', spawned(NEW), gate(A, 'start', fresh(NEW)))
    const attempt = gate(A, 'rename', { oldSid: NEW, newSid: OTHER })
    expect(attempt).toMatchObject({ kind: 'rename', host: '__local__', from: NEW, to: OTHER })
    // Nothing is own under the new id until the daemon says the rename happened.
    refused(() => gate(A, 'send', { sid: OTHER }))
    await settle(A, 'rename', { ok: true }, attempt)
    allowed(() => gate(A, 'send', { sid: OTHER }))
    expect((await saved()).own.sort()).toEqual([local(NEW), local(OTHER)].sort())
    await restart([COPIED, NEW, OTHER])
    allowed(() => gate(A, 'start', resume(OTHER)))
    for (const cmd of [...NATIVE_INPUT, 'attach']) allowed(() => gate(A, cmd, { sid: OTHER }))
  })

  it.each([
    ['not ok', { ok: false, error: 'rename failed' }],
    ['empty', {}],
    ['null', null],
  ])('that failed grants nothing, now or after a restart (%s)', async (_name, reply) => {
    await settle(A, 'start', spawned(NEW), gate(A, 'start', fresh(NEW)))
    await settle(A, 'rename', reply, gate(A, 'rename', { oldSid: NEW, newSid: OTHER }))
    refused(() => gate(A, 'send', { sid: OTHER }))
    expect((await saved()).own).toEqual([local(NEW)])
    await restart([COPIED, NEW, OTHER])
    refused(() => gate(A, 'send', { sid: OTHER }))
    refused(() => gate(A, 'start', resume(OTHER)))
    allowed(() => gate(A, 'send', { sid: NEW }))
  })

  it('is refused before it is sent for a copied or malformed target', async () => {
    await settle(A, 'start', spawned(NEW), gate(A, 'start', fresh(NEW)))
    refused(() => gate(A, 'rename', { oldSid: NEW, newSid: COPIED }))
    refused(() => gate(A, 'rename', { oldSid: NEW, newSid: 'not-a-uuid' }))
    refused(() => gate(A, 'rename', { oldSid: COPIED, newSid: OTHER }))
    expect((await saved()).own).toEqual([local(NEW)])
  })
})

describe('a record write that fails', () => {
  // A real write failure, no mock: `local` is a file, so the record's directory cannot be made.
  const LOCAL_DIR = path.join(WALNUT_HOME, 'local')
  const blockWrites = () => {
    fs.rmSync(LOCAL_DIR, { recursive: true, force: true })
    fs.writeFileSync(LOCAL_DIR, 'blocks the record directory')
  }
  const unblockWrites = () => fs.rmSync(LOCAL_DIR, { recursive: true, force: true })
  const running = (id: string, extra: Record<string, unknown> = {}) => spawned(id, { alive: true, state: 'running', ...extra })
  const startFresh = (rt: string, thread: string, adapter = ADAPTER) =>
    settle(A, 'acpStart', { ok: true, session: { sessionId: thread } }, gate(A, 'acpStart', { sid: rt, adapterCmd: adapter }))

  it('takes back a native start but keeps its attach probe, which writes it once the disk works', async () => {
    const attempt = gate(A, 'start', fresh(NEW))
    blockWrites()
    await expect(settle(A, 'start', spawned(NEW), attempt)).rejects.toThrow()
    refused(() => gate(A, 'start', resume(NEW)))
    for (const cmd of NATIVE_INPUT) refused(() => gate(A, cmd, { sid: NEW }))
    unblockWrites()

    const probe = gate(A, 'attach', { sid: NEW })
    expect(probe).toBe(attempt)
    // The probe proves only what the start would have: same daemon instance, a pid, its own
    // transcript, a running process.
    for (const [scope, reply] of [
      [{ ...A, instance: 'd-restarted' }, running(NEW)],
      [A, running(NEW, { pid: 0 })],
      [A, running(NEW, { outputFile: `/streams/${COPIED}.jsonl` })],
      [A, running(NEW, { adopted: true })],
      [A, spawned(NEW, { alive: false, state: 'dead' })],
      [A, { ok: false, error: 'no such session' }],
    ] as Array<[GateScope, unknown]>) {
      await settle(scope, 'attach', reply, probe)
      refused(() => gate(A, 'send', { sid: NEW }))
      expect(gate(A, 'attach', { sid: NEW })).toBe(attempt)
    }
    expect((await saved()).own).toEqual([])

    await settle(A, 'attach', running(NEW), probe)
    allowed(() => gate(A, 'send', { sid: NEW }))
    expect((await saved()).own).toEqual([local(NEW)])
    await restart([COPIED, NEW])
    allowed(() => gate(A, 'start', resume(NEW)))
  })

  it('a probe of the taken-back start on another host confirms nothing', async () => {
    const attempt = gate(A, 'start', fresh(NEW))
    blockWrites()
    await expect(settle(A, 'start', spawned(NEW), attempt)).rejects.toThrow()
    unblockWrites()
    refused(() => gate(B, 'attach', { sid: NEW }))
    refused(() => gate(B, 'send', { sid: NEW }))
  })

  it('a first ACP start whose write fails owns no runtime, thread or adapter', async () => {
    blockWrites()
    await expect(startFresh('rt-1', 'thread-1')).rejects.toThrow()
    for (const cmd of [...ACP_INPUT, 'acpNewSession']) refused(() => gate(A, cmd, { sid: 'rt-1' }))
    refused(() => gate(A, 'acpStart', load('rt-2', 'thread-1')))
    unblockWrites()
    await restart(['rt-1', 'thread-1'])
    refused(() => gate(A, 'acpSend', { sid: 'rt-1' }))
    refused(() => gate(A, 'acpStart', load('rt-1', 'thread-1')))
  })

  it('an ACP restart whose write fails keeps what the runtime owned before, under its old adapter', async () => {
    await startFresh('rt-1', 'thread-1')
    blockWrites()
    await expect(startFresh('rt-1', 'thread-2', ADAPTER2)).rejects.toThrow()
    allowed(() => gate(A, 'acpSend', { sid: 'rt-1' }))
    expect(gate(A, 'acpNewSession', { sid: 'rt-1' })).toMatchObject({ kind: 'acpNew', adapter: JSON.stringify(ADAPTER) })
    refused(() => gate(A, 'acpStart', load('rt-1', 'thread-2', ADAPTER2)))
    refused(() => gate(A, 'acpStart', load('rt-1', 'thread-2', ADAPTER)))
    allowed(() => gate(A, 'acpStart', load('rt-1', 'thread-1', ADAPTER)))
    unblockWrites()
  })

  it('takes back a new provider thread', async () => {
    await startFresh('rt-1', 'thread-1')
    const next = gate(A, 'acpNewSession', { sid: 'rt-1' })
    blockWrites()
    await expect(settle(A, 'acpNewSession', { ok: true, result: { sessionId: 'thread-2' } }, next)).rejects.toThrow()
    refused(() => gate(A, 'acpStart', load('rt-1', 'thread-2')))
    allowed(() => gate(A, 'acpSend', { sid: 'rt-1' }))
    unblockWrites()
  })

  it('takes back a rename, and a later rename writes once the disk works', async () => {
    await settle(A, 'start', spawned(NEW), gate(A, 'start', fresh(NEW)))
    const attempt = gate(A, 'rename', { oldSid: NEW, newSid: OTHER })
    blockWrites()
    await expect(settle(A, 'rename', { ok: true }, attempt)).rejects.toThrow()
    refused(() => gate(A, 'send', { sid: OTHER }))
    allowed(() => gate(A, 'send', { sid: NEW }))
    unblockWrites()
    await settle(A, 'rename', { ok: true }, gate(A, 'rename', { oldSid: NEW, newSid: OTHER }))
    allowed(() => gate(A, 'send', { sid: OTHER }))
    expect((await saved()).own.sort()).toEqual([local(NEW), local(OTHER)].sort())
  })

  it('two concurrent settles: the second never writes what the first added and could not store', async () => {
    const firstAttempt = gate(A, 'start', fresh(NEW))
    const secondAttempt = gate(A, 'start', fresh(OTHER))
    blockWrites()
    const first = settle(A, 'start', spawned(NEW), firstAttempt) as Promise<void>
    // Registered before the second settle queues behind the first, so this reaction runs first:
    // the disk works again by the time the second one settles and writes.
    const firstFailed = first.then(() => false, () => { unblockWrites(); return true })
    const second = settle(A, 'start', spawned(OTHER), secondAttempt) as Promise<void>
    expect(await firstFailed).toBe(true)
    await expect(first).rejects.toThrow()
    await expect(second).resolves.toBeUndefined()

    const rec = await saved()
    expect(rec.own).toEqual([local(OTHER)])
    expect(fs.readFileSync(FILE, 'utf8')).not.toContain(NEW)
    refused(() => gate(A, 'send', { sid: NEW }))
    allowed(() => gate(A, 'send', { sid: OTHER }))
    // The first start keeps its attach probe for a retry.
    expect(gate(A, 'attach', { sid: NEW })).toBe(firstAttempt)
    await restart([COPIED, NEW, OTHER])
    refused(() => gate(A, 'start', resume(NEW)))
    allowed(() => gate(A, 'start', resume(OTHER)))
  })

  it('two concurrent ACP settles: a failed first thread is in neither the memory nor the second write', async () => {
    const firstAttempt = gate(A, 'acpStart', { sid: 'rt-1', adapterCmd: ADAPTER })
    const secondAttempt = gate(A, 'acpStart', { sid: 'rt-2', adapterCmd: ADAPTER2 })
    blockWrites()
    const first = settle(A, 'acpStart', { ok: true, session: { sessionId: 'thread-1' } }, firstAttempt) as Promise<void>
    const firstFailed = first.then(() => false, () => { unblockWrites(); return true })
    const second = settle(A, 'acpStart', { ok: true, session: { sessionId: 'thread-2' } }, secondAttempt) as Promise<void>
    expect(await firstFailed).toBe(true)
    await expect(second).resolves.toBeUndefined()
    const rec = await saved()
    expect(rec.own).toEqual([local('rt-2')])
    expect(rec.threads).toEqual([local(JSON.stringify(ADAPTER2), 'thread-2')])
    expect(rec.adapters).toEqual([[local('rt-2'), JSON.stringify(ADAPTER2)]])
    refused(() => gate(A, 'acpSend', { sid: 'rt-1' }))
    refused(() => gate(A, 'acpStart', load('rt-3', 'thread-1')))
    allowed(() => gate(A, 'acpSend', { sid: 'rt-2' }))
  })

  it('two concurrent successful settles both end up in the record, in order', async () => {
    const a = settle(A, 'start', spawned(NEW), gate(A, 'start', fresh(NEW)))
    const b = settle(A, 'start', spawned(OTHER), gate(A, 'start', fresh(OTHER)))
    await Promise.all([a, b])
    expect((await saved()).own).toEqual([local(NEW), local(OTHER)])
  })

  it('a failed write does not hold up the writes after it', async () => {
    blockWrites()
    const first = settle(A, 'start', spawned(NEW), gate(A, 'start', fresh(NEW)))
    await expect(first).rejects.toThrow()
    unblockWrites()
    await settle(A, 'start', spawned(OTHER), gate(A, 'start', fresh(OTHER)))
    expect((await saved()).own).toEqual([local(OTHER)])
  })
})

// Review round 2, D08: a Demo task sent before Claude Code was installed. Its start reached the
// daemon and was refused (nothing spawned), and a later delivery after the install was refused as
// "inherited_session: this test server did not start session ...". The id is the Demo's own fresh
// one: its next start under that id passes, fresh or a resume (ephemeral-session-gate.ts mintedHere), also
// across a restart, as an attempt its daemon must confirm; a write still is not.
describe('a start the daemon refused before anything ran (Claude Code not installed)', () => {
  const refusedStart = { ok: false, error: 'Claude Code is not installed on this host.', errorKind: 'claude_missing' }

  it('starts fresh under the same id once Claude Code is there, in this run', async () => {
    await settle(A, 'start', refusedStart, gate(A, 'start', fresh(NEW)))
    // Nothing ran: no write into it. A resume (the runner keeps one when the stream answered)
    // is let through as an attempt, since the id is this Demo's own; it owns nothing yet.
    refused(() => gate(A, 'send', { sid: NEW }))
    expect(gate(A, 'start', resume(NEW))).toMatchObject({ kind: 'start', sid: NEW })
    refused(() => gate(A, 'send', { sid: NEW }))
    // The retry that starts the conversation under its id passes, and its confirmation owns it.
    const attempt = gate(A, 'start', fresh(NEW))
    expect(attempt).toMatchObject({ kind: 'start', sid: NEW })
    await settle(A, 'start', spawned(NEW), attempt)
    allowed(() => gate(A, 'send', { sid: NEW }))
  })

  it('stays this Demo\'s own id across a restart, which lists it in its store', async () => {
    await settle(A, 'start', refusedStart, gate(A, 'start', fresh(NEW)))
    expect((await saved()).minted).toEqual([local(NEW)])
    expect((await saved()).own).toEqual([])
    await restart([COPIED, NEW])
    allowed(() => gate(A, 'start', fresh(NEW)))
    expect(gate(A, 'start', resume(NEW))).toMatchObject({ kind: 'start', sid: NEW })
    refused(() => gate(A, 'send', { sid: NEW }))
  })

  it('does not weaken the gate for copied ids: a copied id is never minted, and the file cannot make it so', async () => {
    refused(() => gate(A, 'start', fresh(COPIED)))
    // A minted entry another home wrote is refused with the whole file.
    plant({ v: 1, home: path.join(os.tmpdir(), 'walnut-some-other-home'), own: [], threads: [], adapters: [], minted: [local(COPIED)] })
    await expect(restart([COPIED])).rejects.toThrow(/invalid/)
    // One with a non-local key is refused too.
    plant({ v: 1, home: WALNUT_HOME, own: [], threads: [], adapters: [], minted: [['devbox', COPIED].join('\u0000')] })
    await expect(restart([COPIED])).rejects.toThrow(/invalid/)
  })

  it('a remote host\'s refused start is never written to the Demo file', async () => {
    await settle(B, 'start', refusedStart, gate(B, 'start', fresh(OTHER)))
    await settle(A, 'start', refusedStart, gate(A, 'start', fresh(NEW)))
    expect((await saved()).minted).toEqual([local(NEW)])
  })
})
