/**
 * Unit tests for daemon-core.ts — the shared primitives used by both
 * daemon-source.ts (SSH-deployed Node script) and daemon-standalone.ts
 * (compiled Bun binary). Because the core is fully DI'd, we can exercise
 * every death path, idempotency guard, and broadcast with synthetic deps.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createDaemonCore,
  type CoreSessionData,
  type DaemonCoreDeps,
  type RegistryEntry,
} from '../../src/providers/daemon-core.js'

interface TestSession extends CoreSessionData {
  watchers: Map<unknown, unknown>
  proc: unknown
  offset: number
}

/** Build a fake session record. */
function makeSession(sid: string, overrides: Partial<TestSession> = {}): TestSession {
  return {
    pid: 12345,
    pipePath: `/tmp/${sid}.pipe`,
    jsonlPath: `/tmp/${sid}.jsonl`,
    pgidPath: `/tmp/${sid}.pgid`,
    offset: 0,
    state: 'running',
    exitCode: null,
    exitReason: null,
    exitedAt: null,
    parented: true,
    startTime: '100',
    cwd: '/tmp',
    args: ['/bin/sleep', '60'],
    orphanPollTimer: null,
    mode: 'default',
    pendingCtrl: null,
    watchers: new Map(),
    proc: null,
    ...overrides,
  }
}

interface Harness {
  deps: DaemonCoreDeps<TestSession>
  sessions: Map<string, TestSession>
  broadcasts: Array<Record<string, unknown>>
  watcherExits: Array<{ sid: string; code: number; stderrTail: string | undefined }>
  killHistory: Array<{ pid: number; sig: number | string }>
  logs: Array<{ level: string; msg: string; meta?: Record<string, unknown> }>
  pidAlive: Set<number>
  pidStartTime: Map<number, string>
  tmpDir: string
  registryFile: string
  streamsDir: string
  now: number
  /** Advance fake clock & fire due interval/timer callbacks. */
  tick: (ms: number) => void
  /** Cancel all pending timers so they don't leak into later tests. */
  dispose: () => void
}

function makeHarness(opts: { tmpDir: string }): Harness {
  const sessions = new Map<string, TestSession>()
  const broadcasts: Array<Record<string, unknown>> = []
  const watcherExits: Array<{ sid: string; code: number; stderrTail: string | undefined }> = []
  const killHistory: Array<{ pid: number; sig: number | string }> = []
  const logs: Array<{ level: string; msg: string; meta?: Record<string, unknown> }> = []
  const pidAlive = new Set<number>()
  const pidStartTime = new Map<number, string>()
  const intervals = new Map<number, { cb: () => void; ms: number; lastFire: number }>()
  const timeouts = new Map<number, { cb: () => void; dueAt: number }>()
  let idCounter = 1
  let now = 1_000_000

  const fakeSetInterval = ((cb: (...args: unknown[]) => void, ms: number) => {
    const id = idCounter++
    intervals.set(id, { cb: cb as () => void, ms, lastFire: now })
    return id as unknown as ReturnType<typeof setInterval>
  }) as unknown as typeof setInterval

  const fakeClearInterval = ((id: ReturnType<typeof setInterval>) => {
    intervals.delete(id as unknown as number)
  }) as unknown as typeof clearInterval

  const fakeSetTimeout = ((cb: (...args: unknown[]) => void, ms: number) => {
    const id = idCounter++
    timeouts.set(id, { cb: cb as () => void, dueAt: now + ms })
    return id as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

  const streamsDir = path.join(opts.tmpDir, 'streams')
  fs.mkdirSync(streamsDir, { recursive: true })
  const registryFile = path.join(opts.tmpDir, 'sessions.json')

  const deps: DaemonCoreDeps<TestSession> = {
    fs,
    clock: () => now,
    killFn: (pid, sig) => {
      killHistory.push({ pid, sig })
      if (sig === 0 || sig === '0') {
        if (!pidAlive.has(pid)) {
          const err = new Error('ESRCH') as NodeJS.ErrnoException
          err.code = 'ESRCH'
          throw err
        }
      }
    },
    readStartTimeFn: (pid) => pidStartTime.get(pid) ?? null,
    killProcessGroupFn: (pid, sig) => {
      killHistory.push({ pid: -pid, sig })
      return true
    },
    setIntervalFn: fakeSetInterval,
    clearIntervalFn: fakeClearInterval,
    setTimeoutFn: fakeSetTimeout,
    streamsDir,
    registryFile,
    orphanPollIntervalMs: 1000,
    logger: (level, msg, meta) => { logs.push({ level, msg, meta }) },
    broadcastSessionStateFn: (payload) => { broadcasts.push(payload) },
    broadcastExitToWatchersFn: (session, code, stderrTail) => {
      const sidEntry = [...sessions.entries()].find(([, s]) => s === session)
      watcherExits.push({ sid: sidEntry?.[0] ?? '?', code, stderrTail })
    },
    sessions,
    createAdoptedSession: (sid, entry) => makeSession(sid, {
      pid: entry.pid,
      pipePath: entry.pipePath,
      jsonlPath: entry.jsonlPath,
      pgidPath: entry.pgidPath,
      startTime: entry.startTime,
      cwd: entry.cwd,
      args: entry.args,
      parented: false,
    }),
  }

  const harness: Harness = {
    deps,
    sessions,
    broadcasts,
    watcherExits,
    killHistory,
    logs,
    pidAlive,
    pidStartTime,
    tmpDir: opts.tmpDir,
    registryFile,
    streamsDir,
    get now() { return now },
    set now(v: number) { now = v },
    tick(ms) {
      now += ms
      for (const [id, iv] of intervals) {
        while (now - iv.lastFire >= iv.ms) {
          iv.lastFire += iv.ms
          try { iv.cb() } catch {}
          if (!intervals.has(id)) break
        }
      }
      for (const [id, to] of [...timeouts]) {
        if (now >= to.dueAt) {
          timeouts.delete(id)
          try { to.cb() } catch {}
        }
      }
    },
    dispose() {
      intervals.clear()
      timeouts.clear()
    },
  }
  return harness
}

// ════════════════════════════════════════════════════════════════════════
//  Setup
// ════════════════════════════════════════════════════════════════════════

let tmpDir: string
let h: Harness

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'daemon-core-unit-'))
  h = makeHarness({ tmpDir })
})

// ════════════════════════════════════════════════════════════════════════
//  reapSession — single death funnel
// ════════════════════════════════════════════════════════════════════════

describe('reapSession', () => {
  it('sets state=dead + fires broadcast + watcher exit + unlinks FIFO', () => {
    const core = createDaemonCore(h.deps)
    const sid = 'reap-basic'
    const sess = makeSession(sid, { pid: 111 })
    h.pidAlive.add(111)
    h.sessions.set(sid, sess)
    // Touch FIFO file so unlink has something to remove
    fs.writeFileSync(sess.pipePath, '')
    expect(fs.existsSync(sess.pipePath)).toBe(true)

    core.reapSession(sid, 42, 'test')

    expect(sess.state).toBe('dead')
    expect(sess.exitCode).toBe(42)
    expect(sess.exitReason).toBe('test')
    expect(fs.existsSync(sess.pipePath)).toBe(false)
    expect(h.broadcasts).toHaveLength(1)
    expect(h.broadcasts[0]).toMatchObject({ sid, state: 'dead', exitCode: 42, reason: 'test' })
    expect(h.watcherExits).toHaveLength(1)
    // SIGTERM to the process group must fire
    expect(h.killHistory.some(k => k.pid === -111 && k.sig === 'SIGTERM')).toBe(true)
  })

  it('is idempotent — second call is a no-op', () => {
    const core = createDaemonCore(h.deps)
    const sid = 'reap-idem'
    h.sessions.set(sid, makeSession(sid, { pid: 222 }))
    h.pidAlive.add(222)

    core.reapSession(sid, 1, 'first')
    core.reapSession(sid, 9, 'second')
    core.reapSession(sid, 9, 'third')

    expect(h.broadcasts).toHaveLength(1)
    expect(h.broadcasts[0].reason).toBe('first')
    expect(h.sessions.get(sid)!.exitCode).toBe(1) // first wins
  })

  it('clears orphan poll timer on reap', () => {
    const core = createDaemonCore(h.deps)
    const sid = 'reap-poll'
    h.sessions.set(sid, makeSession(sid, { pid: 333 }))
    h.pidAlive.add(333)

    core.startOrphanPoll(sid)
    expect(h.sessions.get(sid)!.orphanPollTimer).not.toBeNull()

    core.reapSession(sid, 0, 'x')
    expect(h.sessions.get(sid)!.orphanPollTimer).toBeNull()
  })

  it('no-op for unknown sid', () => {
    const core = createDaemonCore(h.deps)
    core.reapSession('does-not-exist', 0, 'x')
    expect(h.broadcasts).toHaveLength(0)
  })

  it('SIGKILL backup fires after 2s even if SIGTERM does not kill', () => {
    const core = createDaemonCore(h.deps)
    const sid = 'reap-sigkill'
    h.sessions.set(sid, makeSession(sid, { pid: 444 }))
    h.pidAlive.add(444)

    core.reapSession(sid, 0, 'x')
    // SIGTERM immediately
    expect(h.killHistory.some(k => k.pid === -444 && k.sig === 'SIGTERM')).toBe(true)
    // SIGKILL not yet
    expect(h.killHistory.some(k => k.pid === -444 && k.sig === 'SIGKILL')).toBe(false)

    h.tick(2001)

    expect(h.killHistory.some(k => k.pid === -444 && k.sig === 'SIGKILL')).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════════
//  registry — write-ahead persistence
// ════════════════════════════════════════════════════════════════════════

describe('registry read/persist', () => {
  it('persists only running sessions; roundtrips through readRegistry', () => {
    const core = createDaemonCore(h.deps)
    h.sessions.set('alive', makeSession('alive', { pid: 100, state: 'running' }))
    h.sessions.set('dead', makeSession('dead', { pid: 200, state: 'dead' }))
    h.sessions.set('nopid', makeSession('nopid', { pid: 0, state: 'running' }))

    core.persistRegistry()

    const entries = core.readRegistry()
    expect(Object.keys(entries)).toEqual(['alive'])
    expect(entries.alive.pid).toBe(100)
  })

  it('uses atomic rename — registry tmp file does not leak', () => {
    const core = createDaemonCore(h.deps)
    h.sessions.set('a', makeSession('a', { pid: 1 }))
    core.persistRegistry()

    expect(fs.existsSync(h.registryFile)).toBe(true)
    expect(fs.existsSync(h.registryFile + '.tmp')).toBe(false)
  })

  it('readRegistry returns {} on missing file', () => {
    const core = createDaemonCore(h.deps)
    expect(core.readRegistry()).toEqual({})
  })

  it('readRegistry returns {} on malformed JSON', () => {
    fs.writeFileSync(h.registryFile, 'not json at all ][')
    const core = createDaemonCore(h.deps)
    expect(core.readRegistry()).toEqual({})
  })

  it('readRegistry ignores file without .sessions object', () => {
    fs.writeFileSync(h.registryFile, JSON.stringify({ version: 1 }))
    const core = createDaemonCore(h.deps)
    expect(core.readRegistry()).toEqual({})
  })
})

// ════════════════════════════════════════════════════════════════════════
//  reconcileRegistry — startup scenarios
// ════════════════════════════════════════════════════════════════════════

describe('reconcileRegistry', () => {
  function seedRegistry(entries: Record<string, RegistryEntry>): void {
    fs.writeFileSync(
      h.registryFile,
      JSON.stringify({ version: 1, sessions: entries }),
    )
  }

  it('adopts a live session (kill(pid,0) succeeds, start_time matches)', () => {
    const entry: RegistryEntry = {
      pid: 1000, startTime: '100',
      pipePath: '/tmp/x.pipe', jsonlPath: '/tmp/x.jsonl', pgidPath: '/tmp/x.pgid',
      cwd: '/tmp', args: ['/bin/sleep', '60'], spawnedAt: new Date().toISOString(), parented: true,
    }
    seedRegistry({ live: entry })
    h.pidAlive.add(1000)
    h.pidStartTime.set(1000, '100')

    const core = createDaemonCore(h.deps)
    core.reconcileRegistry()

    expect(h.sessions.has('live')).toBe(true)
    expect(h.sessions.get('live')!.state).toBe('running')
    expect(h.broadcasts).toContainEqual(expect.objectContaining({
      sid: 'live', state: 'running', adopted: true,
    }))
  })

  it('reaps a dead pid (ESRCH) as reconcile-dead', () => {
    const entry: RegistryEntry = {
      pid: 1001, startTime: '100',
      pipePath: '/tmp/d.pipe', jsonlPath: '/tmp/d.jsonl', pgidPath: '/tmp/d.pgid',
      cwd: '/tmp', args: [], spawnedAt: new Date().toISOString(), parented: true,
    }
    seedRegistry({ gone: entry })
    // pid 1001 not in pidAlive → kill throws ESRCH

    const core = createDaemonCore(h.deps)
    core.reconcileRegistry()

    expect(h.sessions.get('gone')!.state).toBe('dead')
    expect(h.sessions.get('gone')!.exitReason).toContain('reconcile-dead')
    expect(h.broadcasts).toContainEqual(expect.objectContaining({
      sid: 'gone', state: 'dead',
    }))
  })

  it('detects pid recycling (different start_time) and reaps', () => {
    const entry: RegistryEntry = {
      pid: 1002, startTime: '100', // original
      pipePath: '/tmp/r.pipe', jsonlPath: '/tmp/r.jsonl', pgidPath: '/tmp/r.pgid',
      cwd: '/tmp', args: [], spawnedAt: new Date().toISOString(), parented: true,
    }
    seedRegistry({ recycled: entry })
    h.pidAlive.add(1002)
    h.pidStartTime.set(1002, '999') // different — kernel handed pid to someone else

    const core = createDaemonCore(h.deps)
    core.reconcileRegistry()

    expect(h.sessions.get('recycled')!.state).toBe('dead')
    expect(h.sessions.get('recycled')!.exitReason).toBe('reconcile-pid-recycled')
  })

  it('is re-entrant — does not overwrite existing session', () => {
    const entry: RegistryEntry = {
      pid: 1003, startTime: '100',
      pipePath: '/tmp/e.pipe', jsonlPath: '/tmp/e.jsonl', pgidPath: '/tmp/e.pgid',
      cwd: '/tmp', args: [], spawnedAt: new Date().toISOString(), parented: true,
    }
    seedRegistry({ existing: entry })
    h.pidAlive.add(1003)

    // Pre-populate with a freshly-spawned parented session of the same sid
    const preExisting = makeSession('existing', { pid: 9999, parented: true })
    h.sessions.set('existing', preExisting)

    const core = createDaemonCore(h.deps)
    core.reconcileRegistry()

    // Existing session must be preserved, NOT replaced with the registry entry
    expect(h.sessions.get('existing')).toBe(preExisting)
    expect(h.sessions.get('existing')!.pid).toBe(9999)
  })
})

// ════════════════════════════════════════════════════════════════════════
//  startOrphanPoll — 1s watchdog
// ════════════════════════════════════════════════════════════════════════

describe('startOrphanPoll', () => {
  it('detects pid death via kill(pid,0) and fires reapSession', () => {
    const core = createDaemonCore(h.deps)
    const sid = 'poll-dead'
    h.sessions.set(sid, makeSession(sid, { pid: 2001 }))
    h.pidAlive.add(2001)

    core.startOrphanPoll(sid)
    expect(h.sessions.get(sid)!.state).toBe('running')

    // Process dies externally
    h.pidAlive.delete(2001)

    h.tick(1000)
    expect(h.sessions.get(sid)!.state).toBe('dead')
    expect(h.sessions.get(sid)!.exitReason).toBe('orphan-poll-dead')
  })

  it('detects pid recycling (different start_time) in-poll', () => {
    const core = createDaemonCore(h.deps)
    const sid = 'poll-recycle'
    h.sessions.set(sid, makeSession(sid, { pid: 2002, startTime: '100' }))
    h.pidAlive.add(2002)
    h.pidStartTime.set(2002, '100')

    core.startOrphanPoll(sid)
    expect(h.sessions.get(sid)!.state).toBe('running')

    // Original process died, kernel reassigned pid 2002 to another process
    h.pidStartTime.set(2002, '777')

    h.tick(1000)
    expect(h.sessions.get(sid)!.state).toBe('dead')
    expect(h.sessions.get(sid)!.exitReason).toBe('pid-recycled')
  })

  it('is idempotent — second call does not start a second timer', () => {
    const core = createDaemonCore(h.deps)
    const sid = 'poll-idem'
    h.sessions.set(sid, makeSession(sid, { pid: 2003 }))
    h.pidAlive.add(2003)

    core.startOrphanPoll(sid)
    const t1 = h.sessions.get(sid)!.orphanPollTimer

    core.startOrphanPoll(sid)
    const t2 = h.sessions.get(sid)!.orphanPollTimer

    expect(t1).toBe(t2)
  })
})

// ════════════════════════════════════════════════════════════════════════
//  handleSendCommand — strict ack contract
// ════════════════════════════════════════════════════════════════════════

describe('handleSendCommand', () => {
  function setupLiveSession(sid: string, opts: { pid: number }): TestSession {
    const sess = makeSession(sid, { pid: opts.pid })
    h.sessions.set(sid, sess)
    h.pidAlive.add(opts.pid)
    // Create a real FIFO so fs.openSync(O_WRONLY) works
    try { fs.unlinkSync(sess.pipePath) } catch {}
    sess.pipePath = path.join(h.streamsDir, `${sid}.pipe`)
    // We can't easily mkfifo from Node; use exec
    require('node:child_process').execSync(`mkfifo ${JSON.stringify(sess.pipePath)}`)
    // Open read end to prevent ENXIO
    const readFd = fs.openSync(sess.pipePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    // Keep fd open for test lifetime — close in teardown? attach to session
    ;(sess as unknown as { _readFd: number })._readFd = readFd
    return sess
  }

  it('returns not_found for unknown sid', () => {
    const core = createDaemonCore(h.deps)
    const r = core.handleSendCommand('nope', 'hi')
    expect(r).toEqual({ ok: false, reason: 'not_found' })
  })

  it('returns error for missing sid/message', () => {
    const core = createDaemonCore(h.deps)
    expect(core.handleSendCommand(undefined, 'x')).toHaveProperty('error')
    expect(core.handleSendCommand('sid', undefined)).toHaveProperty('error')
  })

  it('returns session_dead if state=dead', () => {
    const core = createDaemonCore(h.deps)
    h.sessions.set('s', makeSession('s', { state: 'dead', exitCode: 7 }))
    const r = core.handleSendCommand('s', 'hi')
    expect(r).toEqual({ ok: false, reason: 'session_dead', exitCode: 7 })
  })

  it('precheck-dead: kill(pid,0) throws → reap + return session_dead', () => {
    const core = createDaemonCore(h.deps)
    const sid = 'precheck-dead'
    h.sessions.set(sid, makeSession(sid, { pid: 3001, exitCode: null }))
    // pidAlive does NOT include 3001 → kill throws

    const r = core.handleSendCommand(sid, 'hi')
    expect(r).toMatchObject({ ok: false, reason: 'session_dead' })
    expect(h.sessions.get(sid)!.state).toBe('dead')
    expect(h.sessions.get(sid)!.exitReason).toBe('send-precheck-dead')
  })

  it('ENXIO: FIFO with no reader → reap + return ENXIO', () => {
    const core = createDaemonCore(h.deps)
    const sid = 'enxio'
    // Create FIFO but DO NOT open for reading
    const pipePath = path.join(h.streamsDir, 'enxio.pipe')
    try { fs.unlinkSync(pipePath) } catch {}
    require('node:child_process').execSync(`mkfifo ${JSON.stringify(pipePath)}`)
    h.sessions.set(sid, makeSession(sid, { pid: 3002, pipePath }))
    h.pidAlive.add(3002)  // pass precheck

    const r = core.handleSendCommand(sid, 'hi')
    expect(r).toMatchObject({ ok: false, reason: 'ENXIO' })
    expect(h.sessions.get(sid)!.state).toBe('dead')
    expect(h.sessions.get(sid)!.exitReason).toBe('send-enxio')
  })

  it('ok: writes to FIFO when reader exists', () => {
    const core = createDaemonCore(h.deps)
    const sess = setupLiveSession('ok', { pid: 3003 })

    const r = core.handleSendCommand('ok', 'hi there')
    expect(r).toEqual({ ok: true })

    // Cleanup: close read fd
    try { fs.closeSync((sess as unknown as { _readFd: number })._readFd) } catch {}
  })
})

// ════════════════════════════════════════════════════════════════════════
//  handleSendRawCommand — permission response acknowledgement
// ════════════════════════════════════════════════════════════════════════

describe('handleSendRawCommand', () => {
  function setupLiveSession(sid: string, pendingReqId: string): TestSession {
    const pipePath = path.join(h.streamsDir, `${sid}.pipe`)
    try { fs.unlinkSync(pipePath) } catch {}
    require('node:child_process').execSync(`mkfifo ${JSON.stringify(pipePath)}`)
    const readFd = fs.openSync(pipePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    const sess = makeSession(sid, {
      pid: 4001,
      pipePath,
      pendingCtrl: {
        reqId: pendingReqId,
        toolName: 'Bash',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} },
        receivedAt: h.now,
      },
    })
    ;(sess as unknown as { _readFd: number })._readFd = readFd
    h.sessions.set(sid, sess)
    h.pidAlive.add(4001)
    return sess
  }

  it('clears and persists matching pendingCtrl after a successful FIFO write', () => {
    const core = createDaemonCore(h.deps)
    const sess = setupLiveSession('raw-clears-pending', 'req-1')
    core.persistRegistry()

    const raw = JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'req-1', response: { behavior: 'allow' } },
    })
    expect(core.handleSendRawCommand('raw-clears-pending', raw)).toEqual({ ok: true })
    expect(sess.pendingCtrl).toBeNull()
    expect(core.readRegistry()['raw-clears-pending']?.pendingCtrl).toBeUndefined()

    try { fs.closeSync((sess as unknown as { _readFd: number })._readFd) } catch {}
  })

  it('does not clear pendingCtrl when the FIFO write fails', () => {
    const core = createDaemonCore(h.deps)
    const sid = 'raw-failed-write'
    const pipePath = path.join(h.streamsDir, `${sid}.pipe`)
    require('node:child_process').execSync(`mkfifo ${JSON.stringify(pipePath)}`)
    const sess = makeSession(sid, {
      pid: 4002,
      pipePath,
      pendingCtrl: {
        reqId: 'req-2',
        toolName: 'Edit',
        request: { subtype: 'can_use_tool', tool_name: 'Edit', input: {} },
        receivedAt: h.now,
      },
    })
    h.sessions.set(sid, sess)
    h.pidAlive.add(4002)

    const raw = JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'req-2', response: { behavior: 'allow' } },
    })
    expect(core.handleSendRawCommand(sid, raw)).toMatchObject({ ok: false, reason: 'ENXIO' })
    expect(sess.pendingCtrl?.reqId).toBe('req-2')
  })
})
