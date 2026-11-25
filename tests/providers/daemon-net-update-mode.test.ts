/**
 * A host network machine's switch of mode (one-service-mode.ts) goes the way its new builds go:
 * over its own link, by the host network's updater (daemon-net-update.ts), with the same holds and
 * the same `--serve`/`--no-serve` words, the walnut file sent for `--serve`. Never the SSH check:
 * 2026-11-22, a mode due on such a host went to the postponed update's SSH check, which threw
 * "reached over the host network, not SSH" every minute and never switched it.
 *
 * MACHINE SAFETY: no process, socket or host is touched; the link and the host's runner are played.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { followerFact } = vi.hoisted(() => ({ followerFact: vi.fn(() => ({ kind: 'replica' })) }))
vi.mock('../../src/core/host-server/index.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), hostFollowerFact: followerFact }))

import { NetDaemonUpdater, STAGE_TRIES_BEFORE_UNFIT, decideNetUpdate, type NetServiceModeDeps, type NetUpdateFacts, type NetUpdaterDeps, type NetUpdateLink } from '../../src/providers/daemon-net-update.js'
import { updateRemoteDaemonService } from '../../src/providers/daemon-service-update.js'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { resetInProcessDaemonWantedForTests } from '../../src/providers/in-process-daemon.js'
import { WALNUT_HOME } from '../../src/constants.js'
import { log } from '../../src/logging/index.js'
import { MACOS_OFF_WHY } from '../../src/providers/one-service-targets.js'

const OLD = 'walnut-daemon-0ld000000000'
const NEW = 'walnut-daemon-new000000000'
const EXE = '/home/u/.local/share/open-walnut/daemon/versions/a/walnut'
const CAPS = new Set(['host-exec-v1', 'host-exec-v2', 'fs-write-part-v1', 'service-update-v1', 'host-facts-v1', 'net-v1'])
const GZ = { gz: Buffer.from('walnut file gz'), id: 'build-1' }
const BIN = { file: '/srv/dist/daemon-binaries/daemon-linux-x64' }

/** The daemon's link as the updater reads it: only `walnut daemon status` is answered. */
function link(over: Partial<NetUpdateLink> = {}): NetUpdateLink {
  return {
    host: 'olddev', connected: true, daemonVersion: NEW, daemonStartup: 'service', serviceExecutable: EXE,
    hasCapability: (c) => CAPS.has(c),
    async send(cmd, params) {
      const line = Array.isArray(params?.argv) ? String((params.argv as string[])[2]) : String(params?.command)
      if (cmd === 'exec.run' && line.includes('walnut daemon status')) return { ok: true, exitCode: 0, output: JSON.stringify({ installed: true, foreign: false, scope: 'user' }) }
      return { ok: false, error: `unexpected ${cmd}` }
    },
    ...over,
  }
}

function mode(read: Awaited<ReturnType<NetServiceModeDeps['read']>>): NetServiceModeDeps & { asked: ReturnType<typeof vi.fn>; unfit: ReturnType<typeof vi.fn> } {
  return { read: async () => read, asked: vi.fn(), unfit: vi.fn() }
}

function updater(over: Partial<NetUpdaterDeps>, conn = link()) {
  const update = vi.fn(async () => 'applied' as const)
  const source = vi.fn(async (_t: string, _e: string, _say: unknown, o: { walnutFile: boolean }) => (o.walnutFile ? GZ : BIN))
  const deps: NetUpdaterDeps = {
    conn, kind: () => 'net', testServer: () => false, follower: () => false, expectedVersion: () => NEW, hold: () => null, cooldownMs: 600_000,
    busy: async () => null, autofixOff: async () => null, target: async () => 'linux-x64', source: source as never, update: update as never,
    settleMs: 0, recheckMs: 20, env: {}, ...over,
  }
  return { u: new NetDaemonUpdater(deps), update, source }
}

const ON = { home: '/home/u/.open-walnut', on: true }
const OFF = { home: '/home/u/.open-walnut', on: false }

beforeEach(() => {
  vi.spyOn(log.session, 'info').mockImplementation(() => {})
  vi.spyOn(log.session, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('decideNetUpdate with a switch of the mode due', () => {
  const facts = (over: Partial<NetUpdateFacts>): NetUpdateFacts => ({
    kind: 'net', host: 'olddev', testServer: false, follower: false, expected: NEW, running: NEW, startup: 'service', serviceExecutable: EXE,
    has: (c) => CAPS.has(c), autofixOff: null, turnedOff: false, requested: false, lastAttempt: null, now: 1e9, cooldownMs: 600_000,
    target: 'linux-x64', source: GZ, ...over,
  })
  it('the current build is an update when a switch is due, and keeps every hold of a new build', () => {
    expect(decideNetUpdate(facts({}))).toMatchObject({ go: false, skip: 'current' })
    expect(decideNetUpdate(facts({ modeDue: true }))).toMatchObject({ go: true })
    expect(decideNetUpdate(facts({ modeDue: true, autofixOff: 'config' }))).toMatchObject({ go: false, skip: 'held' })
    expect(decideNetUpdate(facts({ modeDue: true, testServer: true }))).toMatchObject({ go: false, skip: 'test-server' })
    expect(decideNetUpdate(facts({ modeDue: true, lastAttempt: { expected: NEW, at: 1e9 - 1 } }))).toMatchObject({ go: false, skip: 'cooldown' })
  })
  it('the gap between builds does not hold a switch of the mode alone (as on the SSH path)', () => {
    const young = { daemonAgeMs: 1_000, minGapMs: 3_600_000 }
    expect(decideNetUpdate(facts({ modeDue: true, ...young }))).toMatchObject({ go: true })
    expect(decideNetUpdate(facts({ running: OLD, ...young }))).toMatchObject({ go: false, skip: 'recent' })
  })
})

describe('NetDaemonUpdater carries the mode', () => {
  it('a Mac with macos_one_service off: no --serve, and nothing marked unfit (the mode decision gives the reason); with it on, the switch goes', async () => {
    const off = mode({ due: true, serve: ON })
    const a = updater({ mode: off, target: async () => 'darwin-arm64', macos: async () => false })
    a.u.schedule(0)
    await vi.waitFor(() => expect(a.u.state).toMatchObject({ phase: 'skipped', skip: 'current' }))
    expect(off.unfit).not.toHaveBeenCalled()
    expect(MACOS_OFF_WHY).toMatch(/is a Mac/)
    expect(a.update).not.toHaveBeenCalled()
    a.u.stop()
    // A new build still goes, as the session daemon.
    const off2 = mode({ due: false, serve: ON })
    const b = updater({ mode: off2, target: async () => 'darwin-arm64', macos: async () => false }, link({ daemonVersion: OLD }))
    b.u.schedule(0)
    await vi.waitFor(() => expect(b.u.state.phase).toBe('updated'))
    expect(b.source.mock.calls[0]![3]).toEqual({ walnutFile: false })
    expect((b.update.mock.calls[0] as unknown as [unknown, unknown, unknown, unknown, { serve?: unknown }])[4].serve).toBeUndefined()
    b.u.stop()
    const on = mode({ due: true, serve: ON })
    const c = updater({ mode: on, target: async () => 'darwin-arm64', macos: async () => true })
    c.u.schedule(0)
    await vi.waitFor(() => expect(c.u.state.phase).toBe('updated'))
    expect((c.update.mock.calls[0] as unknown as [unknown, unknown, unknown, unknown, { serve?: unknown }])[4].serve).toEqual(ON)
    expect(on.unfit).not.toHaveBeenCalled()
    c.u.stop()
  })

  it('a switch on the current build sends the walnut file with --serve, and records the ask', async () => {
    const m = mode({ due: true, serve: ON })
    const { u, update, source } = updater({ mode: m })
    u.schedule(0)
    await vi.waitFor(() => expect(u.state.phase).toBe('updated'))
    expect(source).toHaveBeenCalledTimes(1)
    expect(source.mock.calls[0]![3]).toEqual({ walnutFile: true })
    const [src, version, , scope, opts] = update.mock.calls[0] as unknown as [unknown, string, unknown, string, { serve?: unknown }]
    expect(src).toEqual({ binary: null, gz: GZ.gz, base: EXE })
    expect([version, scope]).toEqual([NEW, 'user'])
    expect(opts.serve).toEqual(ON)
    expect(m.asked).toHaveBeenCalledWith({ expected: NEW, want: 'walnut-serve' })
    u.stop()
  })

  it('the way back carries --no-serve, and the daemon binary may go', async () => {
    const m = mode({ due: true, serve: OFF })
    const { u, update, source } = updater({ mode: m })
    u.schedule(0)
    await vi.waitFor(() => expect(u.state.phase).toBe('updated'))
    expect(source.mock.calls[0]![3]).toEqual({ walnutFile: false })
    const [src, , , , opts] = update.mock.calls[0] as unknown as [unknown, string, unknown, string, { serve?: unknown }]
    expect(src).toEqual({ binary: BIN.file, base: EXE })
    expect(opts.serve).toEqual(OFF)
    expect(m.asked).toHaveBeenCalledWith({ expected: NEW, want: 'daemon' })
    u.stop()
  })

  it('a new build carries the words too; with no mode due and the build current nothing runs', async () => {
    const m = mode({ due: false, serve: ON })
    const { u, update } = updater({ mode: m }, link({ daemonVersion: OLD }))
    u.schedule(0)
    await vi.waitFor(() => expect(u.state.phase).toBe('updated'))
    expect((update.mock.calls[0] as unknown as unknown[])[4]).toMatchObject({ serve: ON })
    u.stop()
    const idle = updater({ mode: mode({ due: false }) })
    idle.u.schedule(0)
    await vi.waitFor(() => expect(idle.u.state).toMatchObject({ phase: 'skipped', skip: 'current' }))
    expect(idle.update).not.toHaveBeenCalled()
    idle.u.stop()
  })

  it('no walnut file for the host: the offer goes for this build; the current build runs nothing, a new one goes without the switch', async () => {
    const missing = vi.fn(async (_t: string, _e: string, _s: unknown, o: { walnutFile: boolean }) => (o.walnutFile ? { missing: 'version 0.0.0 was never released' } : BIN))
    const m = mode({ due: true, serve: ON })
    const { u, update } = updater({ mode: m, source: missing as never })
    u.schedule(0)
    await vi.waitFor(() => expect(u.state).toMatchObject({ phase: 'skipped', skip: 'current' }))
    expect(m.unfit).toHaveBeenCalledWith(NEW, expect.stringContaining('never released'))
    expect(update).not.toHaveBeenCalled()
    u.stop()

    const m2 = mode({ due: false, serve: ON })
    const b = updater({ mode: m2, source: missing as never }, link({ daemonVersion: OLD }))
    b.u.schedule(0)
    await vi.waitFor(() => expect(b.u.state.phase).toBe('updated'))
    const [src, , , , opts] = b.update.mock.calls[0] as unknown as [unknown, string, unknown, string, { serve?: unknown }]
    expect(src).toEqual({ binary: BIN.file, base: EXE })
    expect(opts.serve).toBeUndefined()
    expect(m2.asked).not.toHaveBeenCalled()
    b.u.stop()
  })

  it('a walnut file that could not be staged is tried again; its last try takes the offer away and is no failure; a failure past it is an ask that failed', async () => {
    const stageError = Object.assign(new Error('the file did not answer __daemon --version'), { name: 'DaemonUpdateStageError' })
    const m = mode({ due: true, serve: ON })
    const update = vi.fn(async () => { throw stageError })
    let triesAtUnfit: number | null = null
    // The phase that round ends in, read right after it (the postpone runs in the same turn as unfit),
    // and the updater stopped there: a poll of 50 ms let the next round (a 30 ms cooldown) start first.
    let phaseAfterUnfit: string | null = null
    let stopIt = () => {}
    m.unfit.mockImplementation(() => {
      triesAtUnfit ??= update.mock.calls.length
      queueMicrotask(() => { phaseAfterUnfit ??= u.state.phase; stopIt() })
    })
    const { u } = updater({ mode: m, update: update as never, cooldownMs: 30 })
    stopIt = () => u.stop()
    u.schedule(0)
    await vi.waitFor(() => expect(phaseAfterUnfit).not.toBeNull())
    // Tries 1 and 2 were postponements with the offer kept; the third took it away for this build.
    expect(triesAtUnfit).toBe(STAGE_TRIES_BEFORE_UNFIT)
    expect(m.unfit).toHaveBeenCalledWith(NEW, expect.stringContaining('__daemon --version'))
    expect(phaseAfterUnfit).toBe('postponed')
    expect(m.asked).not.toHaveBeenCalled()

    // A passing fault: the second try puts the file there, and the offer was never taken away.
    const m1 = mode({ due: true, serve: ON })
    let tries = 0
    const once = vi.fn(async () => { if (++tries === 1) throw stageError; return 'applied' as const })
    const t = updater({ mode: m1, update: once as never, cooldownMs: 30 })
    t.u.schedule(0)
    await vi.waitFor(() => expect(m1.asked).toHaveBeenCalledWith({ expected: NEW, want: 'walnut-serve' }))
    expect(once).toHaveBeenCalledTimes(2)
    expect(m1.unfit).not.toHaveBeenCalled()
    t.u.stop()

    const m2 = mode({ due: true, serve: ON })
    const f = updater({ mode: m2, update: vi.fn(async () => { throw new Error('the new daemon did not answer') }) as never })
    f.u.schedule(0)
    await vi.waitFor(() => expect(f.u.state.phase).toBe('failed'))
    expect(m2.asked).toHaveBeenCalledWith({ expected: NEW, want: 'walnut-serve', failed: 'the new daemon did not answer' })
    f.u.stop()
  })
})

describe('DaemonConnection: a host network machine with a mode due', () => {
  let env0: Record<string, string | undefined>
  beforeEach(() => { env0 = { a: process.env.WALNUT_HOST_SERVICE_OFFER, b: process.env.WALNUT_SERVICE_LAUNCHER } })
  afterEach(() => {
    for (const [k, v] of [['WALNUT_HOST_SERVICE_OFFER', env0.a], ['WALNUT_SERVICE_LAUNCHER', env0.b]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
    resetInProcessDaemonWantedForTests()
  })
  function experiments(on: boolean): void {
    process.env.WALNUT_HOST_SERVICE_OFFER = on ? '1' : '0'
    process.env.WALNUT_SERVICE_LAUNCHER = on ? '1' : '0'
    resetInProcessDaemonWantedForTests()
  }

  /** A net host on this build, its daemon a user service under the launcher, as its hello says; every SSH-only step spied. */
  function netHost(serves: { serves: 'daemon' | 'walnut-serve'; serviceHome: string | null }) {
    const c = new DaemonConnection('olddev', { hostname: 'olddev.walnut-net.invalid', via: 'net', endpoint: 'ab'.repeat(32) })
    const st = c as unknown as Record<string, unknown>
    const p = c as unknown as Record<string, (...a: unknown[]) => unknown>
    Object.assign(st, {
      _connected: true, _daemonVersion: NEW, _daemonStartup: 'service', _serviceExecutable: EXE, _capabilities: [...CAPS],
      _launcher: { current: '/v/b/daemon', good: '/v/a/daemon', phase: 'committed', since: 1 }, _platform: 'linux', _servesAs: serves,
    })
    vi.spyOn(p, 'getExpectedDaemonVersion').mockReturnValue(NEW)
    const sshOnly = ['sshExec', 'pipeChunk', 'deployWalnutFile', 'getRemoteDaemonPath', 'shouldUpgradeDaemon', 'updateManagedDaemon', 'serviceDaemonSource', 'runUpgradeRecheck']
      .map((name) => vi.spyOn(p, name).mockImplementation(async () => { throw new Error(`${name} on a host network machine`) }))
    vi.spyOn(c, 'send').mockImplementation((cmd: string, params?: Record<string, unknown>) => link().send(cmd, params) as never)
    // The host's runner is played: the real update line is built, only its run is recorded.
    const lines: string[] = []
    const update = vi.fn((_src: unknown, version: string, _io: unknown, scope: never, opts: never) => updateRemoteDaemonService({ binary: null, existing: '/slot/walnut' }, version, {
      run: async (cmd: string) => (cmd.includes('__daemon --version') ? `${NEW}\n` : ''),
      chunk: async () => true,
      serviceUpdate: async (u: { command: string }) => { lines.push(u.command); return { output: '{"ok":true}', tail: null } },
    }, scope, opts))
    const source = vi.fn(async (_t: string, _e: string, _s: unknown, o: { walnutFile: boolean }) => (o.walnutFile ? GZ : BIN))
    const u = (st as { netUpdater: NetDaemonUpdater }).netUpdater
    Object.assign((u as unknown as { d: NetUpdaterDeps }).d, {
      busy: async () => null, autofixOff: async () => null, follower: () => false, target: async () => 'linux-x64', source, update, recheckMs: 20,
    })
    return { c, st, u, lines, source, sshOnly }
  }

  it.each([
    ['on: --serve with the walnut file', true, { serves: 'daemon' as const, serviceHome: null }, ' --launcher --serve ', true, 'walnut-serve'],
    ['back: --no-serve', false, { serves: 'walnut-serve' as const, serviceHome: WALNUT_HOME }, ' --no-serve ', false, 'daemon'],
  ])('%s, over the link, never the SSH check', async (_label, on, serves, words, walnutFile, want) => {
    experiments(on)
    const { c, st, u, lines, source, sshOnly } = netHost(serves)
    try {
      // The host-server manager settled the host (manager.ts serviceModeChanged), and the minute's postponed recheck.
      await c.checkServiceMode()
      await (st as { recheckPostponedUpgrade(): Promise<void> }).recheckPostponedUpgrade()
      await vi.waitFor(() => expect(u.state.phase).toBe('updated'))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain(words)
      expect(lines[0]).toContain(WALNUT_HOME)
      expect(source.mock.calls[0]![3]).toEqual({ walnutFile })
      expect(st._modeAsked).toEqual({ expected: NEW, want })
      for (const spy of sshOnly) expect(spy, spy.getMockName()).not.toHaveBeenCalled()
    } finally {
      st._connected = false
      c.disconnect()
    }
  })
})
