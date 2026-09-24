/**
 * Boot / process fence in daemon-core: a pid only means something inside the
 * boot that recorded it, so neither reconcileRegistry nor reapSession may probe,
 * adopt, or signal a pid whose identity it cannot prove.
 *
 * The second half covers the OTHER fence around the same processes: the per-sid
 * start gate in both daemon twins, i.e. which stop may cancel a queued start and
 * which stop may kill a supervised CLI.
 *
 * Everything is stubbed — no real process.kill, no child_process, no real fs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import nodeFs from 'node:fs'
import nodePath from 'node:path'
import ts from 'typescript'
import {
  createDaemonCore,
  type CoreSessionData,
  type DaemonCoreDeps,
  type RegistryEntry,
} from '../../src/providers/daemon-core.js'
import { DaemonSessionGate } from '../../src/providers/daemon-cron-controller.js'
import { createDaemonCommandDrain } from '../../src/providers/daemon-command-drain.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

interface TestSession extends CoreSessionData {
  watchers: Map<unknown, unknown>
}

const REGISTRY_FILE = '/fake/daemon/sessions.json'
const STREAMS_DIR = '/fake/streams'

function enoent(): NodeJS.ErrnoException {
  const err = new Error('ENOENT') as NodeJS.ErrnoException
  err.code = 'ENOENT'
  return err
}

function makeSession(sid: string, overrides: Partial<TestSession> = {}): TestSession {
  return {
    pid: 4242,
    pipePath: `/fake/streams/${sid}.pipe`,
    jsonlPath: `/fake/streams/${sid}.jsonl`,
    pgidPath: `/fake/streams/${sid}.pgid`,
    state: 'running',
    exitCode: null,
    exitReason: null,
    exitedAt: null,
    parented: true,
    startTime: '900',
    cwd: '/fake/cwd',
    args: ['claude', '-p'],
    orphanPollTimer: null,
    mode: 'default',
    pendingCtrl: null,
    watchers: new Map(),
    ...overrides,
  }
}

function makeEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    pid: 4242,
    startTime: '900',
    pipePath: '/fake/streams/s.pipe',
    jsonlPath: '/fake/streams/s.jsonl',
    pgidPath: '/fake/streams/s.pgid',
    cwd: '/fake/cwd',
    args: ['claude', '-p'],
    spawnedAt: '2026-01-01T00:00:00.000Z',
    parented: false,
    ...overrides,
  }
}

interface Harness {
  deps: DaemonCoreDeps<TestSession>
  sessions: Map<string, TestSession>
  registry: Record<string, RegistryEntry>
  /** pids the fake kernel considers alive (kill(pid,0) succeeds). */
  pidAlive: Set<number>
  /** pid → start time the fake /proc reports; absent ⇒ readStartTimeFn null. */
  pidStartTime: Map<number, string>
  /** pid → errno kill(pid,0) should throw (null ⇒ throw without a code). */
  killErrorCode: Map<number, string | null>
  /** every killFn call (liveness probes + signals). */
  killCalls: Array<{ pid: number; sig: number | string }>
  /** every process-GROUP signal. */
  groupCalls: Array<{ pid: number; sig: string }>
  /** every fs.unlinkSync path. */
  unlinked: string[]
  /** every hook evaluation (session.reap). */
  hookCalls: Array<{ point: string; cwd: unknown }>
  broadcasts: Array<Record<string, unknown>>
  intervals: Array<() => void>
  timeouts: Array<() => void>
  writes: Array<{ path: string; body: string }>
  setBootId: (id: string | undefined) => void
  runTimeouts: () => void
}

function makeHarness(initialBootId?: string): Harness {
  const sessions = new Map<string, TestSession>()
  const registry: Record<string, RegistryEntry> = {}
  const pidAlive = new Set<number>()
  const pidStartTime = new Map<number, string>()
  const killErrorCode = new Map<number, string | null>()
  const killCalls: Array<{ pid: number; sig: number | string }> = []
  const groupCalls: Array<{ pid: number; sig: string }> = []
  const unlinked: string[] = []
  const hookCalls: Array<{ point: string; cwd: unknown }> = []
  const broadcasts: Array<Record<string, unknown>> = []
  const intervals: Array<() => void> = []
  const timeouts: Array<() => void> = []
  const writes: Array<{ path: string; body: string }> = []
  let bootId = initialBootId

  const fakeFs = {
    readFileSync: (p: unknown) => {
      if (String(p) === REGISTRY_FILE) return JSON.stringify({ version: 1, sessions: registry })
      throw enoent()
    },
    writeFileSync: (p: unknown, body: unknown) => { writes.push({ path: String(p), body: String(body) }) },
    renameSync: () => {},
    openSync: () => 7,
    closeSync: () => {},
    fsyncSync: () => {},
    readSync: () => 0,
    statSync: () => { throw enoent() },
    unlinkSync: (p: unknown) => { unlinked.push(String(p)) },
    appendFileSync: () => {},
    readdirSync: () => [] as string[],
    mkdirSync: () => undefined,
  } as unknown as typeof import('node:fs')

  const deps: DaemonCoreDeps<TestSession> = {
    fs: fakeFs,
    clock: () => 1_700_000_000_000,
    killFn: (pid, sig) => {
      killCalls.push({ pid, sig })
      if (sig !== 0 && sig !== '0') return
      if (killErrorCode.has(pid)) {
        const code = killErrorCode.get(pid)
        const err = new Error(code ?? 'unclassified') as NodeJS.ErrnoException
        if (code) err.code = code
        throw err
      }
      if (!pidAlive.has(pid)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    },
    readStartTimeFn: (pid) => pidStartTime.get(pid) ?? null,
    killProcessGroupFn: (pid, sig) => { groupCalls.push({ pid, sig }); return true },
    setIntervalFn: ((cb: () => void) => {
      intervals.push(cb)
      return intervals.length as unknown as ReturnType<typeof setInterval>
    }) as unknown as typeof setInterval,
    clearIntervalFn: (() => {}) as unknown as typeof clearInterval,
    setTimeoutFn: ((cb: () => void) => {
      timeouts.push(cb)
      return timeouts.length as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout,
    streamsDir: STREAMS_DIR,
    registryFile: REGISTRY_FILE,
    logger: () => {},
    broadcastSessionStateFn: (payload) => { broadcasts.push(payload) },
    broadcastExitToWatchersFn: () => {},
    sessions,
    createAdoptedSession: (sid, entry) => makeSession(sid, {
      pid: entry.pid,
      startTime: entry.startTime,
      pipePath: entry.pipePath,
      jsonlPath: entry.jsonlPath,
      pgidPath: entry.pgidPath,
      cwd: entry.cwd,
      args: entry.args,
      parented: false,
    }),
    hookActionsFn: (point, ctx) => {
      hookCalls.push({ point, cwd: ctx.cwd })
      return ['strip-own-rows']
    },
    // Read at each run point, exactly like the service caller's late-probed getter.
    get bootId() { return bootId },
  }

  return {
    deps,
    sessions,
    registry,
    pidAlive,
    pidStartTime,
    killErrorCode,
    killCalls,
    groupCalls,
    unlinked,
    hookCalls,
    broadcasts,
    intervals,
    timeouts,
    writes,
    setBootId: (id) => { bootId = id },
    runTimeouts: () => { for (const cb of [...timeouts]) cb() },
  }
}

const BOOT = 'boot-current'

let h: Harness
beforeEach(() => { h = makeHarness(BOOT) })

// ════════════════════════════════════════════════════════════════════
//  reconcileRegistry — boot fence
// ════════════════════════════════════════════════════════════════════

describe('reconcileRegistry boot fence', () => {
  it('a record from a previous boot is neither probed, adopted, nor signalled', () => {
    const core = createDaemonCore(h.deps)
    h.registry['sid-old'] = makeEntry({ pid: 5000, bootId: 'boot-previous' })
    h.pidAlive.add(5000)
    h.pidStartTime.set(5000, '900')

    core.reconcileRegistry()

    const sess = h.sessions.get('sid-old')!
    expect(sess.state).toBe('dead')
    expect(sess.exitReason).toBe('reconcile-previous-boot')
    // Fence runs BEFORE the liveness probe: the pid is never touched at all.
    expect(h.killCalls).toEqual([])
    expect(h.groupCalls).toEqual([])
    h.runTimeouts()
    expect(h.groupCalls).toEqual([])
    // Not adopted: no running broadcast, no orphan poll.
    expect(h.broadcasts.filter((b) => b.state === 'running')).toEqual([])
    expect(h.intervals).toHaveLength(0)
  })

  it('a record with no bootId is identity-unknown in service mode (not assumed current)', () => {
    const core = createDaemonCore(h.deps)
    h.registry['sid-legacy'] = makeEntry({ pid: 5100 })
    h.pidAlive.add(5100)
    h.pidStartTime.set(5100, '900')

    core.reconcileRegistry()

    expect(h.sessions.get('sid-legacy')!.exitReason).toBe('reconcile-identity-unknown')
    expect(h.killCalls).toEqual([])
    h.runTimeouts()
    expect(h.groupCalls).toEqual([])
    expect(h.broadcasts.filter((b) => b.state === 'running')).toEqual([])
  })

  it('same boot but a recycled pid is reaped without any group signal', () => {
    const core = createDaemonCore(h.deps)
    h.registry['sid-recycled'] = makeEntry({ pid: 5200, startTime: '900', bootId: BOOT })
    h.pidAlive.add(5200)
    h.pidStartTime.set(5200, '7777')   // kernel handed the pid to somebody else

    core.reconcileRegistry()

    expect(h.sessions.get('sid-recycled')!.exitReason).toBe('reconcile-pid-recycled')
    // Probed (sig 0) but never signalled.
    expect(h.killCalls).toEqual([{ pid: 5200, sig: 0 }])
    h.runTimeouts()
    expect(h.groupCalls).toEqual([])
    expect(h.broadcasts.filter((b) => b.state === 'running')).toEqual([])
  })

  it('same boot but an unreadable start time refuses to adopt the live pid', () => {
    const core = createDaemonCore(h.deps)
    h.registry['sid-unknown'] = makeEntry({ pid: 5300, startTime: '900', bootId: BOOT })
    h.pidAlive.add(5300)
    // no pidStartTime entry ⇒ readStartTimeFn returns null

    core.reconcileRegistry()

    expect(h.sessions.get('sid-unknown')!.exitReason).toBe('reconcile-identity-unknown')
    h.runTimeouts()
    expect(h.groupCalls).toEqual([])
    expect(h.intervals).toHaveLength(0)
  })

  it('same boot with a missing recorded start time is also identity-unknown', () => {
    const core = createDaemonCore(h.deps)
    h.registry['sid-nostart'] = makeEntry({ pid: 5400, startTime: null, bootId: BOOT })
    h.pidAlive.add(5400)
    h.pidStartTime.set(5400, '900')

    core.reconcileRegistry()

    expect(h.sessions.get('sid-nostart')!.exitReason).toBe('reconcile-identity-unknown')
    h.runTimeouts()
    expect(h.groupCalls).toEqual([])
  })

  it('same boot with a proven identity is adopted and polled', () => {
    const core = createDaemonCore(h.deps)
    h.registry['sid-live'] = makeEntry({ pid: 5500, startTime: '900', bootId: BOOT })
    h.pidAlive.add(5500)
    h.pidStartTime.set(5500, '900')

    core.reconcileRegistry()

    const sess = h.sessions.get('sid-live')!
    expect(sess.state).toBe('running')
    expect(sess.bootId).toBe(BOOT)
    expect(h.broadcasts).toEqual([{ sid: 'sid-live', state: 'running', pid: 5500, adopted: true }])
    expect(h.intervals).toHaveLength(1)
    expect(h.groupCalls).toEqual([])
  })

  it('bootId is read at the run point, not cached when the core is created', () => {
    const late = makeHarness(undefined)         // probe has not resolved yet
    const core = createDaemonCore(late.deps)
    late.setBootId(BOOT)                        // probe resolves after construction
    late.registry['sid-late'] = makeEntry({ pid: 5600, bootId: 'boot-previous' })
    late.pidAlive.add(5600)
    late.pidStartTime.set(5600, '900')

    core.reconcileRegistry()

    expect(late.sessions.get('sid-late')!.exitReason).toBe('reconcile-previous-boot')
    expect(late.killCalls).toEqual([])
  })

  it('an unclassified kill errno is identity-unknown, never guessed as dead', () => {
    const core = createDaemonCore(h.deps)
    h.registry['sid-einval'] = makeEntry({ pid: 5800, startTime: '900', bootId: BOOT })
    h.killErrorCode.set(5800, 'EINVAL')

    core.reconcileRegistry()

    expect(h.sessions.get('sid-einval')!.exitReason).toBe('reconcile-identity-unknown')
    h.runTimeouts()
    expect(h.groupCalls).toEqual([])
  })

  it('an errno-less kill failure is identity-unknown too', () => {
    const core = createDaemonCore(h.deps)
    h.registry['sid-weird'] = makeEntry({ pid: 5900, startTime: '900', bootId: BOOT })
    h.killErrorCode.set(5900, null)

    core.reconcileRegistry()

    expect(h.sessions.get('sid-weird')!.exitReason).toBe('reconcile-identity-unknown')
  })

  it('ESRCH is still reported as dead', () => {
    const core = createDaemonCore(h.deps)
    h.registry['sid-dead'] = makeEntry({ pid: 5950, startTime: '900', bootId: BOOT })

    core.reconcileRegistry()

    expect(h.sessions.get('sid-dead')!.exitReason).toBe('reconcile-dead')
  })

  it('legacy mode (no bootId) still adopts a live un-fenced record', () => {
    const legacy = makeHarness(undefined)
    const core = createDaemonCore(legacy.deps)
    legacy.registry['sid-legacy-live'] = makeEntry({ pid: 5700, startTime: '900' })
    legacy.pidAlive.add(5700)
    legacy.pidStartTime.set(5700, '900')

    core.reconcileRegistry()

    expect(legacy.sessions.get('sid-legacy-live')!.state).toBe('running')
    expect(legacy.broadcasts.filter((b) => b.state === 'running')).toHaveLength(1)
  })
})

// ════════════════════════════════════════════════════════════════════
//  reapSession — residual process-group cleanup
// ════════════════════════════════════════════════════════════════════

describe('reapSession group-signal fence', () => {
  it('a confirmed empty process group is reaped without scheduling another signal', () => {
    const core = createDaemonCore(h.deps)
    h.sessions.set('stopped', makeSession('stopped', { bootId: BOOT }))
    h.pidStartTime.set(4242, '900')
    core.reapSession('stopped', 0, 'stop-confirmed', true)
    expect(h.sessions.get('stopped')?.state).toBe('dead')
    expect(JSON.parse(h.writes.at(-1)!.body).sessions).toEqual({})
    expect(h.groupCalls).toEqual([])
    h.runTimeouts()
    expect(h.groupCalls).toEqual([])
  })

  it('signals the group when the identity still matches, both now and 2s later', () => {
    const core = createDaemonCore(h.deps)
    const sess = makeSession('sid-clean', { pid: 6000, startTime: '900', bootId: BOOT })
    h.sessions.set('sid-clean', sess)
    h.pidAlive.add(6000)
    h.pidStartTime.set(6000, '900')

    core.reapSession('sid-clean', 1, 'proc-exit')

    expect(h.groupCalls).toEqual([{ pid: 6000, sig: 'SIGTERM' }])
    h.runTimeouts()
    expect(h.groupCalls).toEqual([
      { pid: 6000, sig: 'SIGTERM' },
      { pid: 6000, sig: 'SIGKILL' },
    ])
  })

  it('the delayed SIGKILL is dropped when the sid was replaced meanwhile', () => {
    const core = createDaemonCore(h.deps)
    const sess = makeSession('sid-replaced', { pid: 6100, startTime: '900', bootId: BOOT })
    h.sessions.set('sid-replaced', sess)
    h.pidAlive.add(6100)
    h.pidStartTime.set(6100, '900')

    core.reapSession('sid-replaced', 1, 'proc-exit')
    expect(h.groupCalls).toEqual([{ pid: 6100, sig: 'SIGTERM' }])

    // cmdStart respawned under the same sid before the 2s timer fired.
    const replacement = makeSession('sid-replaced', { pid: 6199, startTime: '4242', bootId: BOOT })
    h.sessions.set('sid-replaced', replacement)
    h.pidStartTime.set(6199, '4242')
    h.pidAlive.add(6199)

    h.runTimeouts()

    expect(h.groupCalls).toEqual([{ pid: 6100, sig: 'SIGTERM' }])
    expect(replacement.state).toBe('running')
  })

  it('a pid recycled between reap and the delayed kill is not signalled again', () => {
    const core = createDaemonCore(h.deps)
    const sess = makeSession('sid-drift', { pid: 6200, startTime: '900', bootId: BOOT })
    h.sessions.set('sid-drift', sess)
    h.pidAlive.add(6200)
    h.pidStartTime.set(6200, '900')

    core.reapSession('sid-drift', 1, 'proc-exit')
    expect(h.groupCalls).toEqual([{ pid: 6200, sig: 'SIGTERM' }])

    h.pidStartTime.set(6200, '8888')   // pid handed to a stranger
    h.runTimeouts()

    expect(h.groupCalls).toEqual([{ pid: 6200, sig: 'SIGTERM' }])
  })

  it.each([
    'reconcile-not-ours',
    'reconcile-pid-recycled',
    'reconcile-previous-boot',
    'reconcile-identity-unknown',
  ])('reason %s never signals any group', (reason) => {
    const core = createDaemonCore(h.deps)
    const sid = 'sid-' + reason
    h.sessions.set(sid, makeSession(sid, { pid: 6300, startTime: '900', bootId: BOOT }))
    h.pidAlive.add(6300)
    h.pidStartTime.set(6300, '900')

    core.reapSession(sid, -1, reason)
    h.runTimeouts()

    expect(h.groupCalls).toEqual([])
  })

  it('service mode refuses to signal a group whose start identity is unprovable', () => {
    const core = createDaemonCore(h.deps)
    h.sessions.set('sid-noproof', makeSession('sid-noproof', { pid: 6400, startTime: null }))
    h.pidAlive.add(6400)

    core.reapSession('sid-noproof', 1, 'proc-exit')
    h.runTimeouts()

    expect(h.groupCalls).toEqual([])
  })

  it('service mode refuses to signal a session carrying no boot stamp', () => {
    const core = createDaemonCore(h.deps)
    h.sessions.set('sid-noboot', makeSession('sid-noboot', { pid: 6450, startTime: '900' }))
    h.pidAlive.add(6450)
    h.pidStartTime.set(6450, '900')   // identity provable, boot not

    core.reapSession('sid-noboot', 1, 'proc-exit')
    h.runTimeouts()

    expect(h.groupCalls).toEqual([])
  })

  it('never signals a pid that is not a safe integer', () => {
    const core = createDaemonCore(h.deps)
    const bogus = Number.MAX_SAFE_INTEGER + 2
    h.sessions.set('sid-bogus', makeSession('sid-bogus', {
      pid: bogus, startTime: '900', bootId: BOOT,
    }))
    h.pidStartTime.set(bogus, '900')

    core.reapSession('sid-bogus', 1, 'proc-exit')
    h.runTimeouts()

    expect(h.groupCalls).toEqual([])
  })

  it('service mode refuses to signal a session stamped with a different boot', () => {
    const core = createDaemonCore(h.deps)
    h.sessions.set('sid-otherboot', makeSession('sid-otherboot', {
      pid: 6500, startTime: '900', bootId: 'boot-previous',
    }))
    h.pidAlive.add(6500)
    h.pidStartTime.set(6500, '900')

    core.reapSession('sid-otherboot', 1, 'proc-exit')
    h.runTimeouts()

    expect(h.groupCalls).toEqual([])
  })

  it('legacy mode still cleans up, but never signals pid <= 1', () => {
    const legacy = makeHarness(undefined)
    const core = createDaemonCore(legacy.deps)
    legacy.sessions.set('sid-init', makeSession('sid-init', { pid: 1, startTime: '900' }))
    legacy.sessions.set('sid-ok', makeSession('sid-ok', { pid: 6600, startTime: '900' }))
    legacy.pidAlive.add(6600)
    legacy.pidStartTime.set(6600, '900')

    core.reapSession('sid-init', 1, 'proc-exit')
    core.reapSession('sid-ok', 1, 'proc-exit')
    legacy.runTimeouts()

    expect(legacy.groupCalls.some((c) => c.pid === 1)).toBe(false)
    expect(legacy.groupCalls.filter((c) => c.pid === 6600)).toEqual([
      { pid: 6600, sig: 'SIGTERM' },
      { pid: 6600, sig: 'SIGKILL' },
    ])
  })

  it('legacy mode drops the delayed kill once the sid was replaced', () => {
    const legacy = makeHarness(undefined)
    const core = createDaemonCore(legacy.deps)
    legacy.sessions.set('sid-legacy-replaced', makeSession('sid-legacy-replaced', { pid: 6700 }))
    legacy.pidAlive.add(6700)

    core.reapSession('sid-legacy-replaced', 1, 'proc-exit')
    expect(legacy.groupCalls).toEqual([{ pid: 6700, sig: 'SIGTERM' }])

    legacy.sessions.set('sid-legacy-replaced', makeSession('sid-legacy-replaced', { pid: 6777 }))
    legacy.runTimeouts()

    expect(legacy.groupCalls).toEqual([{ pid: 6700, sig: 'SIGTERM' }])
  })
})

// ════════════════════════════════════════════════════════════════════
//  reapSession — side effects that belong to a process we own
// ════════════════════════════════════════════════════════════════════

describe('reapSession side effects on an unowned pid', () => {
  it.each([
    'reconcile-not-ours',
    'reconcile-pid-recycled',
    'reconcile-previous-boot',
    'reconcile-identity-unknown',
  ])('%s touches neither the pipe nor the cwd durable crons', (reason) => {
    const core = createDaemonCore(h.deps)
    const sid = 'sid-side-' + reason
    const sess = makeSession(sid, { pid: 8000, startTime: '900', bootId: BOOT })
    h.sessions.set(sid, sess)
    h.pidAlive.add(8000)
    h.pidStartTime.set(8000, '900')

    core.reapSession(sid, -1, reason)
    h.runTimeouts()

    expect(h.unlinked).toEqual([])
    expect(h.hookCalls).toEqual([])
    expect(h.groupCalls).toEqual([])
    // Status and notification still happen.
    expect(sess.state).toBe('dead')
    expect(sess.exitReason).toBe(reason)
    expect(h.broadcasts).toEqual([
      { sid, state: 'dead', exitCode: -1, reason, stderr: undefined },
    ])
  })

  it('an owned death still unlinks the pipe and evaluates the reap hook', () => {
    const core = createDaemonCore(h.deps)
    const sess = makeSession('sid-owned', { pid: 8100, startTime: '900', bootId: BOOT })
    h.sessions.set('sid-owned', sess)
    h.pidAlive.add(8100)
    h.pidStartTime.set(8100, '900')

    core.reapSession('sid-owned', 1, 'proc-exit')

    expect(h.unlinked).toEqual([sess.pipePath])
    expect(h.hookCalls).toEqual([{ point: 'session.reap', cwd: '/fake/cwd' }])
  })
})

// ════════════════════════════════════════════════════════════════════
//  persistRegistry — the fence must survive a restart
// ════════════════════════════════════════════════════════════════════

describe('persistRegistry bootId', () => {
  it.each(['{"version":2,"sessions":{}}', '{"version":1,"sessions":[]}', 'invalid'])('refuses invalid managed registry %s', (text) => {
    h.deps.fs.readFileSync = (() => text) as typeof h.deps.fs.readFileSync
    expect(() => createDaemonCore(h.deps).readRegistry()).toThrow()
  })

  it('persists both the file and containing directory before returning', () => {
    const synced: number[] = []
    const opened: string[] = []
    h.deps.fs.openSync = ((p: unknown) => { opened.push(String(p)); return opened.length }) as typeof h.deps.fs.openSync
    h.deps.fs.fsyncSync = (fd: number) => { synced.push(fd) }
    createDaemonCore(h.deps).persistRegistry()
    expect(opened).toEqual([REGISTRY_FILE + '.tmp', '/fake/daemon'])
    expect(synced).toEqual([1, 2])
  })

  it('does not hide a managed registry sync failure', () => {
    h.deps.fs.fsyncSync = () => { throw new Error('sync failed') }
    expect(() => createDaemonCore(h.deps).persistRegistry()).toThrow('sync failed')
  })

  it('writes the session bootId, and leaves it absent when untracked', () => {
    const core = createDaemonCore(h.deps)
    h.sessions.set('sid-a', makeSession('sid-a', { pid: 7000, bootId: BOOT }))
    h.sessions.set('sid-b', makeSession('sid-b', { pid: 7001 }))

    core.persistRegistry()

    const last = h.writes[h.writes.length - 1]
    expect(last.path).toBe(REGISTRY_FILE + '.tmp')
    const parsed = JSON.parse(last.body) as { sessions: Record<string, RegistryEntry> }
    expect(parsed.sessions['sid-a'].bootId).toBe(BOOT)
    expect(parsed.sessions['sid-b'].bootId).toBeUndefined()
  })

  it('a reconciled session carries the record bootId forward', () => {
    const core = createDaemonCore(h.deps)
    h.registry['sid-carry'] = makeEntry({ pid: 7100, startTime: '900', bootId: BOOT })
    h.pidAlive.add(7100)
    h.pidStartTime.set(7100, '900')

    core.reconcileRegistry()
    core.persistRegistry()

    const last = h.writes[h.writes.length - 1]
    const parsed = JSON.parse(last.body) as { sessions: Record<string, RegistryEntry> }
    expect(parsed.sessions['sid-carry'].bootId).toBe(BOOT)
  })
})

// ════════════════════════════════════════════════════════════════════
//  cmdStart / cmdStop — the per-sid gate contract, from each twin's own text
// ════════════════════════════════════════════════════════════════════
// Neither twin is importable (one is a bun entry point with top-level side
// effects, the other a string template deployed over SSH), so each command is
// sliced out of its own source and evaluated with every free identifier injected.
// No process primitive is reachable: startSessionProcess / stopSessionProcess are
// stubs and process.kill is spied on and asserted never called.

const REPO_ROOT = nodePath.resolve(__dirname, '../..')
const GATE_SID = '11111111-2222-4333-8444-555555555555'

type GateRunner = { run<T>(sid: string, work: () => Promise<T>): Promise<T> }
type CommandFn = (ws: unknown, id: number, cmd: Record<string, unknown>) => Promise<unknown>
interface Reply { id: number; ok: boolean; error?: string; data?: Record<string, unknown> }

interface GateTwin {
  cmdStart: CommandFn
  cmdStop: CommandFn
  cmdSend: CommandFn
  cmdBridgeResume: CommandFn
  fireTurnRetry(sid: string, attempt: number, error: string): Promise<void>
  checkTurnRetry(sid: string, session: unknown, line: string, offset: number): void
  runtimeSessions: Map<string, { state: string; cwd: string; args: string[]; mode: string }>
  stopIds: Map<string, string>
  sent: string[]
  gate: GateRunner
  stopVersions: Map<string, number>
  supervision: Map<string, { enabled: boolean; state: string }>
  starts: string[]
  stops: string[]
  disables: string[]
  replies: Reply[]
}

/** Slice a top-level `function`/`async function` out of a twin (closing `}` at column 0). */
function sliceTopLevelFn(src: string, name: string): string {
  const at = src.search(new RegExp('(?:async )?function ' + name + '\\('))
  expect(at, `${name} not found`).toBeGreaterThan(-1)
  const end = src.indexOf('\n}', at)
  expect(end).toBeGreaterThan(at)
  return src.slice(at, end + 2)
}

/** The template carries its OWN inlined copy of the gate; that copy is what runs here. */
function sliceTemplateGate(src: string): string {
  const at = src.indexOf('let sessionStartGate = (function () {')
  expect(at, 'template gate not found').toBeGreaterThan(-1)
  const end = src.indexOf('})();', at)
  expect(end).toBeGreaterThan(at)
  return src.slice(at, end + 5)
}

function buildGateTwin(kind: 'standalone' | 'template'): GateTwin {
  const stopVersions = new Map<string, number>()
  const supervision = new Map<string, { enabled: boolean; state: string }>()
  const starts: string[] = []
  const sent: string[] = []
  const stopIds = new Map<string, string>()
  const stops: string[] = []
  const disables: string[] = []
  const replies: Reply[] = []
  const runtimeSessions = new Map([[GATE_SID, { state: 'running', cwd: '/fixture', args: ['claude', '-p'], mode: 'default' }]])
  const injected: Record<string, unknown> = {
    sessions: runtimeSessions,
    fs: { existsSync: (file: string) => !file.includes('cancelled-starts') },
    cancelledStartPath: (sid: string) => `/fixture/cancelled-starts/${sid}`,
    path: nodePath,
    STREAMS_DIR: '/fixture',
    MODE_CLI: { default: 'default' },
    logMsg: () => {},
    TURN_RETRY_CFG: { enabled: true },
    turnRetryMessage: () => 'retry',
    parseTurnErrorLine: () => { throw new Error('Supervised turn must not enter retry policy') },
    RETRY_WS_SINK: {},
    daemonCommands: createDaemonCommandDrain(),
    sessionStopVersions: stopVersions,
    cronRuntime: {
      get: (sid: string) => supervision.get(sid) ?? null,
      deliveryAllowed: (sid: string, fence: unknown) => !stopIds.has(sid) || stopIds.get(sid) === fence,
      disable: async (sid: string, stopId?: string) => { disables.push(sid); if (stopId) stopIds.set(sid, stopId) },
      // enable() takes the same per-sid gate, so a stop that called it from
      // inside the gate would deadlock. Nothing here may reach it.
      enable: async () => { throw new Error('a stop must never enable supervision') },
    },
    sendSessionMessage: async (_ws: unknown, _id: number, cmd: { sid: string }) => { sent.push(cmd.sid) },
    startSessionProcess: async (cmd: { sid: string }) => {
      starts.push(cmd.sid)
      return { pid: 4242, outputFile: '/fixture/stream.jsonl', offset: 0 }
    },
    stopSessionProcess: async (_ws: unknown, id: number, sid: string) => {
      stops.push(sid)
      replies.push({ id, ok: true, data: { stopped: true } })
    },
    addSubscriber: () => {},
    sendOk: (_ws: unknown, id: number, data: Record<string, unknown>) => { replies.push({ id, ok: true, data }) },
    sendError: (_ws: unknown, id: number, error: string) => { replies.push({ id, ok: false, error }) },
  }
  const names = Object.keys(injected)
  const args = names.map((n) => injected[n])

  const src = kind === 'standalone'
    ? nodeFs.readFileSync(nodePath.join(REPO_ROOT, 'src/providers/daemon-standalone.ts'), 'utf-8')
    : getDaemonSource()
  const commands = ['cmdStart', 'cmdStop', 'cmdSend', 'cmdBridgeResume', 'fireTurnRetry', 'checkTurnRetry'].map((name) => sliceTopLevelFn(src, name)).join('\n')
  const exports = '\nreturn { cmdStart, cmdStop, cmdSend, cmdBridgeResume, fireTurnRetry, checkTurnRetry, gate: sessionStartGate };'
  const gateCode = kind === 'template' ? sliceTemplateGate(src) : ''
  const js = ts.transpileModule(gateCode + '\n' + commands + exports, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const built = kind === 'standalone'
    ? new Function(...names, 'sessionStartGate', js)(...args, new DaemonSessionGate())
    : new Function(...names, js)(...args)

  return { ...built, runtimeSessions, stopVersions, stopIds, supervision, starts, sent, stops, disables, replies }

}

/** Hold the sid's gate (a running turn) and return the release. */
function occupyGate(twin: GateTwin, sid: string): () => void {
  let release = () => {}
  const blocker = new Promise<void>((resolve) => { release = () => resolve() })
  void twin.gate.run(sid, () => blocker)
  return release
}

const GATE_TWINS: Array<['standalone' | 'template']> = [['standalone'], ['template']]

describe.each(GATE_TWINS)('%s twin: cmdStop / cmdStart gate contract', (kind) => {
  let twin: GateTwin
  let killSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    twin = buildGateTwin(kind)
  })

  afterEach(() => {
    expect(killSpy, 'the gate harness must never signal a real process').not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('a user stop cancels a start that is still queued, and nothing is spawned', async () => {
    const release = occupyGate(twin, GATE_SID)
    const start = twin.cmdStart({}, 1, { sid: GATE_SID, args: ['claude'], cwd: '/fixture' })
    const stop = twin.cmdStop({}, 2, { sid: GATE_SID, reason: 'user' })

    // Both happen before the stop's first await, i.e. while it is still queued:
    // the version (so the queued start sees it) and the supervision stop intent.
    expect(twin.stopVersions.get(GATE_SID)).toBe(1)
    expect(twin.disables).toEqual([GATE_SID])
    expect(twin.stops).toEqual([])

    const superseded = start.then(() => {
      expect(twin.replies).toContainEqual(expect.objectContaining({ data: expect.objectContaining({ ok: false, reason: 'session_stopped' }) }))
    })
    release()
    await stop
    await superseded

    expect(twin.starts).toEqual([])
    expect(twin.stops).toEqual([GATE_SID])
  })

  it('an invalid reason stops nothing and leaves a queued start alone', async () => {
    const release = occupyGate(twin, GATE_SID)
    const start = twin.cmdStart({}, 1, { sid: GATE_SID, args: ['claude'], cwd: '/fixture' })
    await twin.cmdStop({}, 2, { sid: GATE_SID, reason: 'bogus' })

    expect(twin.replies).toEqual([{ id: 2, ok: false, error: 'stop: invalid reason' }])
    expect(twin.stopVersions.get(GATE_SID) ?? 0).toBe(0)

    release()
    await start

    expect(twin.starts).toEqual([GATE_SID])
    expect(twin.stops).toEqual([])
    expect(twin.disables).toEqual([])
  })

  it('a refused idle stop leaves a queued start alone', async () => {
    twin.supervision.set(GATE_SID, { enabled: true, state: 'checking' })
    const release = occupyGate(twin, GATE_SID)
    const start = twin.cmdStart({}, 1, { sid: GATE_SID, args: ['claude'], cwd: '/fixture' })
    const stop = twin.cmdStop({}, 2, { sid: GATE_SID, reason: 'idle' })

    release()
    await start
    await stop

    expect(twin.starts).toEqual([GATE_SID])
    expect(twin.stops).toEqual([])
    expect(twin.stopVersions.get(GATE_SID) ?? 0).toBe(0)
    expect(twin.replies).toContainEqual({ id: 2, ok: true, data: { stopped: false, reason: 'cron_supervised' } })
  })

  it('supervision enabled while the idle stop waits for the gate still refuses it', async () => {
    const release = occupyGate(twin, GATE_SID)
    const stop = twin.cmdStop({}, 1, { sid: GATE_SID, reason: 'idle' })   // unsupervised when it arrived

    twin.supervision.set(GATE_SID, { enabled: true, state: 'restarting' }) // cron.supervision enabled meanwhile
    release()
    await stop

    expect(twin.stops).toEqual([])
    expect(twin.stopVersions.get(GATE_SID) ?? 0).toBe(0)
    expect(twin.replies).toEqual([{ id: 1, ok: true, data: { stopped: false, reason: 'cron_supervised' } }])
  })

  it('an accepted idle stop bumps the version and supersedes a start queued behind it', async () => {
    twin.supervision.set(GATE_SID, { enabled: true, state: 'inactive' })  // supervised but idle-eligible
    const release = occupyGate(twin, GATE_SID)
    const stop = twin.cmdStop({}, 1, { sid: GATE_SID, reason: 'idle' })
    const start = twin.cmdStart({}, 2, { sid: GATE_SID, args: ['claude'], cwd: '/fixture' })

    // Not yet: an idle stop may only bump the version once it owns the gate.
    expect(twin.stopVersions.get(GATE_SID) ?? 0).toBe(0)

    const superseded = start.then(() => {
      expect(twin.replies).toContainEqual(expect.objectContaining({ data: expect.objectContaining({ ok: false, reason: 'session_stopped' }) }))
    })
    release()
    await stop
    await superseded

    expect(twin.stops).toEqual([GATE_SID])
    expect(twin.starts).toEqual([])
    expect(twin.stopVersions.get(GATE_SID)).toBe(1)
    expect(twin.disables).toEqual([])   // an idle stop never disables supervision
  })

  it('rejects a delayed start and send on a new connection after stop was already confirmed', async () => {
    const stopId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    await twin.cmdStop({}, 1, { sid: GATE_SID, reason: 'user', stopRequestId: stopId })
    twin.stopVersions.clear()
    await twin.cmdStart({}, 2, { sid: GATE_SID, stopFence: null })
    await twin.cmdSend({}, 3, { sid: GATE_SID, stopFence: null, message: 'old' })
    expect(twin.starts).toEqual([])
    expect(twin.sent).toEqual([])
    expect(twin.replies.filter((reply) => reply.data?.reason === 'session_stopped')).toHaveLength(2)
    await twin.cmdStart({}, 4, { sid: GATE_SID, stopFence: stopId })
    await twin.cmdSend({}, 5, { sid: GATE_SID, stopFence: stopId, message: 'new' })
    expect(twin.starts).toEqual([GATE_SID])
    expect(twin.sent).toEqual([GATE_SID])
  })

  it('rejects a queued send when a later accepted stop takes priority', async () => {
    const release = occupyGate(twin, GATE_SID)
    const sending = twin.cmdSend({}, 1, { sid: GATE_SID, message: 'old' })
    const stopping = twin.cmdStop({}, 2, { sid: GATE_SID, reason: 'user' })
    release()
    await Promise.all([sending, stopping])
    expect(twin.sent).toEqual([])
    expect(twin.replies).toContainEqual(expect.objectContaining({ data: expect.objectContaining({ reason: 'session_stopped' }) }))
  })

  it.each(['running', 'dead'])('bridge resume forwards the fence for a %s CLI', async (state) => {
    twin.runtimeSessions.get(GATE_SID)!.state = state
    twin.stopIds.set(GATE_SID, 'confirmed-stop')
    await twin.cmdBridgeResume({}, 1, { sid: GATE_SID, message: 'old', stopFence: null })
    expect(twin.starts).toEqual([])
    expect(twin.sent).toEqual([])
    await twin.cmdBridgeResume({}, 2, { sid: GATE_SID, message: 'new', stopFence: 'confirmed-stop' })
    expect(state === 'running' ? twin.sent : twin.starts).toEqual([GATE_SID])
  })

  it.each(['checking', 'disabled', 'blocked', 'inactive'])('a supervised %s session never gets a synthetic continue', async (state) => {
    twin.supervision.set(GATE_SID, { enabled: state !== 'disabled', state })
    twin.checkTurnRetry(GATE_SID, {}, 'error', 1)
    await twin.fireTurnRetry(GATE_SID, 1, 'timeout')
    expect(twin.starts).toEqual([])
    expect(twin.sent).toEqual([])
  })

  it('an ordinary turn retry queued before stop cannot write to the FIFO afterward', async () => {
    const release = occupyGate(twin, GATE_SID)
    const retry = twin.fireTurnRetry(GATE_SID, 1, 'timeout')
    const stopping = twin.cmdStop({}, 2, { sid: GATE_SID, reason: 'user' })
    release()
    await Promise.all([retry, stopping])
    expect(twin.sent).toEqual([])
    expect(twin.starts).toEqual([])
  })

  it('an ordinary retry uses the regular resume-or-adopt path', async () => {
    await twin.fireTurnRetry(GATE_SID, 1, 'timeout')
    expect(twin.starts).toEqual([GATE_SID])
  })

  it('a cron registered while retry waits at the gate cancels the synthetic turn', async () => {
    const release = occupyGate(twin, GATE_SID)
    const retry = twin.fireTurnRetry(GATE_SID, 1, 'timeout')
    twin.supervision.set(GATE_SID, { enabled: true, state: 'checking' })
    release()
    await retry
    expect(twin.sent).toEqual([])
    expect(twin.starts).toEqual([])
  })

  it('a maintenance stop bumps the version but leaves supervision untouched', async () => {
    const release = occupyGate(twin, GATE_SID)
    const stop = twin.cmdStop({}, 1, { sid: GATE_SID, reason: 'maintenance' })

    expect(twin.stopVersions.get(GATE_SID)).toBe(1)
    expect(twin.disables).toEqual([])

    release()
    await stop

    expect(twin.stops).toEqual([GATE_SID])
  })
})

function buildProcessStopTwin(kind: 'standalone' | 'template') {
  const sessions = new Map<string, Record<string, unknown>>()
  const replies: Reply[] = []
  const liveness = vi.fn((_pid: number, _signal: number) => true)
  const groupSignal = vi.fn((_pid: number, _signal: string) => true)
  const groupAlive = vi.fn((_pid: number) => true)
  const startTime = vi.fn((_pid: number) => '900')
  const saved = { process: null as { pid: number; bootId: string; startTime: string } | null }
  const reaped = vi.fn()
  const persist = vi.fn()
  const env = {
    sessions, SERVICE_MODE: true, daemonBootId: BOOT,
    cronRuntime: { get: () => saved },
    process: { kill: liveness },
    readStartTime: startTime,
    killProcessGroup: groupSignal,
    isProcessGroupAlive: groupAlive,
    reapSession: reaped, persistRegistry: persist,
    cancelTurnRetry: vi.fn(), clearTurnRetryStreak: vi.fn(), logMsg: vi.fn(),
    setTimeout,
    sendOk: (_ws: unknown, id: number, data: Record<string, unknown>) => { replies.push({ id, ok: true, data }) },
    sendError: (_ws: unknown, id: number, error: string) => { replies.push({ id, ok: false, error }) },
  }
  const source = kind === 'standalone'
    ? nodeFs.readFileSync(nodePath.join(REPO_ROOT, 'src/providers/daemon-standalone.ts'), 'utf8')
    : getDaemonSource()
  const js = ts.transpileModule(sliceTopLevelFn(source, 'stopSessionProcess') + '\nreturn stopSessionProcess;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  const stop = new Function(...Object.keys(env), js)(...Object.values(env)) as (ws: unknown, id: number, sid: string) => Promise<void>
  return { sessions, replies, liveness, groupSignal, groupAlive, startTime, saved, reaped, persist, stop: () => stop({}, 1, GATE_SID) }
}

describe.each(GATE_TWINS)('%s twin: stop waits for confirmed process death', (kind) => {
  let twin: ReturnType<typeof buildProcessStopTwin>
  beforeEach(() => { vi.useFakeTimers(); twin = buildProcessStopTwin(kind) })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('does not confirm a saved process that is alive but not adopted', async () => {
    twin.saved.process = { pid: 4242, bootId: BOOT, startTime: '900' }
    await twin.stop()
    expect(twin.replies).toEqual([{ id: 1, ok: false, error: expect.stringContaining('not adopted') }])
    expect(twin.liveness).toHaveBeenCalledExactlyOnceWith(4242, 0)
    expect(twin.groupSignal).not.toHaveBeenCalled()
  })

  it.each(['ESRCH', 'EPERM'])('treats saved-process %s as dead or unknown respectively', async (code) => {
    twin.saved.process = { pid: 4242, bootId: BOOT, startTime: '900' }
    twin.liveness.mockImplementation(() => { throw Object.assign(new Error(code), { code }) })
    await twin.stop()
    expect(twin.replies[0].ok).toBe(code === 'ESRCH')
    expect(twin.groupSignal).not.toHaveBeenCalled()
  })

  it('does not probe a saved PID from another boot', async () => {
    twin.saved.process = { pid: 4242, bootId: 'old-boot', startTime: '900' }
    await twin.stop()
    expect(twin.replies[0]).toMatchObject({ ok: true, data: { stopped: true } })
    expect(twin.liveness).not.toHaveBeenCalled()
    expect(twin.groupSignal).not.toHaveBeenCalled()
  })

  it('refuses a reused PID without signalling it', async () => {
    twin.sessions.set(GATE_SID, { pid: 4242, bootId: BOOT, startTime: '800' })
    await twin.stop()
    expect(twin.replies[0].ok).toBe(false)
    expect(twin.groupSignal).not.toHaveBeenCalled()
  })

  it('does not acknowledge until the whole process group has exited and the registry is persisted', async () => {
    twin.sessions.set(GATE_SID, { pid: 4242, bootId: BOOT, startTime: '900' })
    twin.persist.mockImplementation(() => {
      expect(twin.reaped).toHaveBeenCalledExactlyOnceWith(GATE_SID, 0, 'stop-confirmed', true)
      expect(twin.replies).toEqual([])
    })
    const stopping = twin.stop()
    expect(twin.replies).toEqual([])
    await vi.advanceTimersByTimeAsync(200)
    expect(twin.replies).toEqual([])
    twin.groupAlive.mockReturnValue(false)
    await vi.advanceTimersByTimeAsync(200)
    await stopping
    expect(twin.replies[0]).toMatchObject({ ok: true, data: { stopped: true } })
    expect(twin.groupSignal.mock.calls).toEqual([[4242, 'SIGINT']])
  })

  it('retries registry persistence after the process has already exited', async () => {
    twin.sessions.set(GATE_SID, { pid: 4242, bootId: BOOT, startTime: '900' })
    twin.liveness.mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    twin.groupAlive.mockReturnValue(false)
    twin.persist.mockImplementationOnce(() => { throw new Error('disk full') })
    await twin.stop()
    expect(twin.replies[0].ok).toBe(false)
    await twin.stop()
    expect(twin.persist).toHaveBeenCalledTimes(2)
    expect(twin.replies[1]).toMatchObject({ ok: true, data: { stopped: true } })
    expect(twin.groupSignal).not.toHaveBeenCalled()
  })

  it('a missing leader does not prove that its descendants exited', async () => {
    twin.sessions.set(GATE_SID, { pid: 4242, bootId: BOOT, startTime: '900' })
    twin.liveness.mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    await twin.stop()
    expect(twin.replies[0]).toMatchObject({ ok: false, error: expect.stringContaining('without its original leader') })
    expect(twin.reaped).not.toHaveBeenCalled()
    expect(twin.groupSignal).not.toHaveBeenCalled()
  })

  it('does not confirm death when registry persistence fails', async () => {
    twin.sessions.set(GATE_SID, { pid: 4242, bootId: BOOT, startTime: '900' })
    twin.persist.mockImplementation(() => { throw new Error('disk full') })
    const stopping = twin.stop()
    twin.groupAlive.mockReturnValue(false)
    await vi.advanceTimersByTimeAsync(200)
    await stopping
    expect(twin.replies[0]).toMatchObject({ ok: false, error: expect.stringContaining('registry persistence failed') })
    expect(twin.groupSignal.mock.calls).toEqual([[4242, 'SIGINT']])
  })

  it('leaves an unexited process pending without SIGKILL', async () => {
    twin.sessions.set(GATE_SID, { pid: 4242, bootId: BOOT, startTime: '900' })
    const stopping = twin.stop()
    await vi.runAllTimersAsync()
    await stopping
    expect(twin.replies[0]).toMatchObject({ ok: false, error: expect.stringContaining('did not exit') })
    expect(twin.groupSignal.mock.calls).toEqual([[4242, 'SIGINT'], [4242, 'SIGTERM']])
  })

  it('does not escalate against a replacement process', async () => {
    twin.sessions.set(GATE_SID, { pid: 4242, bootId: BOOT, startTime: '900' })
    const stopping = twin.stop()
    twin.sessions.set(GATE_SID, { pid: 4242, bootId: BOOT, startTime: '901' })
    await vi.runAllTimersAsync()
    await stopping
    expect(twin.replies[0]).toMatchObject({ ok: false, error: expect.stringContaining('identity changed') })
    expect(twin.groupSignal.mock.calls).toEqual([[4242, 'SIGINT']])
  })
})
