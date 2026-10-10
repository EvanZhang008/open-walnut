/**
 * The daemon's supervision of a host server (host-server-core.ts) with a fake
 * clock, fake processes and a real temp dir. The real processes are
 * tests/integration/host-server-twins.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHostServerSupervisor, type HostServerDeps, type HostServerSpec } from '../../src/providers/host-server-core.js'

class FakeChild extends EventEmitter {
  constructor(public pid: number | undefined) { super() }
  unref(): void { /* nothing */ }
}

let dir = ''
let now = 0
let timers: Array<{ at: number; fn: () => void; id: number }> = []
let nextTimer = 1
let nextPid = 1000
let nextToken = 0
let children: FakeChild[] = []
let spawned: Array<{ command: string; args: string[]; env: Record<string, string> }> = []
/** pid → start time of the processes that exist. */
let procs = new Map<number, string>()
let signals: Array<{ pid: number; signal: string }> = []
let spawnBehaviour: 'ok' | 'throw' | 'enoent' = 'ok'

function advance(ms: number): void {
  const end = now + ms
  for (;;) {
    timers.sort((a, b) => a.at - b.at)
    const next = timers[0]
    if (!next || next.at > end) break
    timers.shift()
    now = next.at
    next.fn()
  }
  now = end
}

function deps(): HostServerDeps {
  return {
    fs, path,
    spawn: (command, args, opts) => {
      if (spawnBehaviour === 'throw') throw new Error('spawn EACCES')
      const child = new FakeChild(spawnBehaviour === 'enoent' ? undefined : nextPid++)
      if (spawnBehaviour === 'enoent') queueMicrotask(() => child.emit('error', new Error('spawn /nope ENOENT')))
      else procs.set(child.pid!, `st-${child.pid}`)
      children.push(child)
      spawned.push({ command, args, env: opts.env })
      return child
    },
    dir,
    keyOf: (home) => Buffer.from(home).toString('hex').slice(0, 16),
    now: () => now,
    setTimer: (fn, ms) => { const id = nextTimer++; timers.push({ at: now + ms, fn, id }); return id },
    clearTimer: (t) => { timers = timers.filter((x) => x.id !== t) },
    log: () => {},
    startTimeOf: (pid) => procs.get(pid) ?? null,
    killGroup: (pid, signal) => { signals.push({ pid, signal }) },
    baseEnv: () => ({ HOME: '/home/u', WALNUT_HOST_DAEMON_DIR: '/tmp/d' }),
    randomToken: () => `tok${String(++nextToken).padStart(61, '0')}`,
  }
}

function spec(over: Partial<HostServerSpec> = {}): HostServerSpec {
  return {
    v: 1, home: '/h', walnutId: 'w1', command: '/usr/bin/node', args: ['/app/cli.js', 'web'], cwd: '/',
    env: { WALNUT_HOST_SERVER: '1', LABEL: 'x' }, log: path.join(dir, 'logs', 'server.log'), port: 4000, settings: { expose: { enabled: false } },
    ...over,
  }
}

function exit(child: FakeChild, code: number | null, signal: string | null = null): void {
  if (child.pid) procs.delete(child.pid)
  child.emit('exit', code, signal)
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsc-'))
  now = 1_000_000
  timers = []
  nextTimer = 1
  nextPid = 1000
  nextToken = 0
  children = []
  spawned = []
  procs = new Map()
  signals = []
  spawnBehaviour = 'ok'
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('host server supervision', () => {
  it('refuses a spec it cannot run safely', () => {
    const sup = createHostServerSupervisor(deps())
    expect(() => sup.configure('/h', spec({ command: 'node' }))).toThrow(/command must be an absolute path/)
    expect(() => sup.configure('/h', spec({ cwd: 'relative' }))).toThrow(/cwd must be an absolute path/)
    expect(() => sup.configure('/h', spec({ port: 0 }))).toThrow(/port/)
    expect(() => sup.configure('/h', spec({ walnutId: 'bad id' }))).toThrow(/walnutId/)
    expect(() => sup.configure('/h', spec({ env: { 'BAD-KEY': 'v' } }))).toThrow(/env/)
    expect(() => sup.configure('/h', spec({ home: '/other' }))).toThrow(/another Walnut/)
    expect(() => sup.configure('/h', { ...spec(), args: Array(65).fill('a') })).toThrow(/args/)
    expect(() => sup.configure('/h', spec({ env: { WALNUT_FOLLOWER_TOKEN: 'mine' } }))).toThrow(/sets WALNUT_FOLLOWER_TOKEN itself/)
    expect(() => sup.configure('/h', spec({ settings: { big: 'x'.repeat(70_000) } }))).toThrow(/settings are too large/)
    expect(spawned).toHaveLength(0)
    expect(sup.status('/h').state).toBe('off')
  })

  it('starts it with the base env under the spec env and its own token, writes the spec 0600 and the pid with its start time', () => {
    const sup = createHostServerSupervisor(deps())
    const st = sup.configure('/h', spec())
    expect(st).toMatchObject({ state: 'running', pid: 1000, port: 4000, restarts: 0 })
    const token = `tok${'1'.padStart(61, '0')}`
    expect(spawned[0]).toEqual({ command: '/usr/bin/node', args: ['/app/cli.js', 'web'], env: { HOME: '/home/u', WALNUT_HOST_DAEMON_DIR: '/tmp/d', WALNUT_HOST_SERVER: '1', LABEL: 'x', WALNUT_FOLLOWER_TOKEN: token } })
    expect(sup.tokenMatches('/h', token)).toBe(true)
    expect(sup.tokenMatches('/h', token.slice(0, -1) + '9')).toBe(false)
    expect(sup.tokenMatches('/h', undefined)).toBe(false)
    expect(sup.tokenMatches('/other', token)).toBe(false)
    const files = fs.readdirSync(dir).filter((n) => n.startsWith('server-'))
    expect(files.sort()).toEqual([expect.stringMatching(/\.json$/), expect.stringMatching(/\.pid$/)].sort())
    const specFile = files.find((n) => n.endsWith('.json'))!
    expect(fs.statSync(path.join(dir, specFile)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(fs.readFileSync(path.join(dir, files.find((n) => n.endsWith('.pid'))!), 'utf8'))).toEqual({ pid: 1000, startTime: 'st-1000' })
    expect(fs.existsSync(path.join(dir, 'logs', 'server.log'))).toBe(true)
  })

  it('restarts after an exit, waiting 5 s, then 10 s, and starts the count again after a steady run', () => {
    const sup = createHostServerSupervisor(deps())
    sup.configure('/h', spec())
    exit(children[0]!, 1)
    expect(sup.status('/h')).toMatchObject({ state: 'retrying', restarts: 1, lastError: 'exited with code 1', nextRetryAt: now + 5_000 })
    advance(4_999)
    expect(spawned).toHaveLength(1)
    advance(1)
    expect(spawned).toHaveLength(2)
    exit(children[1]!, null, 'SIGSEGV')
    expect(sup.status('/h')).toMatchObject({ state: 'retrying', restarts: 2, lastError: 'ended by SIGSEGV', nextRetryAt: now + 10_000 })
    advance(10_000)
    expect(spawned).toHaveLength(3)
    // A run of ten minutes is steady: the next wait is 5 s again.
    advance(10 * 60_000)
    exit(children[2]!, 0)
    expect(sup.status('/h').nextRetryAt).toBe(now + 5_000)
  })

  it('caps the wait at 5 minutes', () => {
    const sup = createHostServerSupervisor(deps())
    sup.configure('/h', spec())
    for (let i = 0; i < 10; i++) {
      exit(children[children.length - 1]!, 1)
      advance(5 * 60_000)
    }
    exit(children[children.length - 1]!, 1)
    expect(sup.status('/h').nextRetryAt).toBe(now + 5 * 60_000)
  })

  it('a command that cannot start is retried with the same backoff, and says why', async () => {
    const sup = createHostServerSupervisor(deps())
    spawnBehaviour = 'enoent'
    sup.configure('/h', spec())
    await Promise.resolve()
    expect(sup.status('/h')).toMatchObject({ state: 'retrying', lastError: 'could not start: spawn /nope ENOENT' })
    spawnBehaviour = 'throw'
    advance(5_000)
    expect(sup.status('/h')).toMatchObject({ state: 'retrying', lastError: 'could not start: spawn EACCES', restarts: 2 })
    spawnBehaviour = 'ok'
    advance(10_000)
    expect(sup.status('/h')).toMatchObject({ state: 'running' })
  })

  it('new settings are taken without a restart; any other change restarts it with a new token', () => {
    const sup = createHostServerSupervisor(deps())
    sup.configure('/h', spec())
    const tunnel = { expose: { enabled: true, options: { name: 'devbox' } } }
    expect(sup.configure('/h', spec({ settings: tunnel }))).toMatchObject({ state: 'running', pid: 1000 })
    expect(sup.settingsOf('/h')).toEqual(tunnel)
    expect(spawned).toHaveLength(1)
    expect(signals).toEqual([])
    sup.configure('/h', spec({ settings: tunnel, env: { WALNUT_HOST_SERVER: '1', LABEL: 'y' } }))
    expect(signals).toEqual([{ pid: 1000, signal: 'SIGTERM' }])
    expect(spawned).toHaveLength(2)
    expect(spawned[1]!.env.WALNUT_FOLLOWER_TOKEN).not.toBe(spawned[0]!.env.WALNUT_FOLLOWER_TOKEN)
    expect(sup.tokenMatches('/h', spawned[0]!.env.WALNUT_FOLLOWER_TOKEN)).toBe(false)
    // The old run's exit is not this run's.
    exit(children[0]!, 0)
    expect(sup.status('/h')).toMatchObject({ state: 'running', pid: 1001, restarts: 0 })
  })

  it('keeps what the running server reports, until it exits', () => {
    const sup = createHostServerSupervisor(deps())
    expect(sup.report('/h', { route: 'leader' })).toBe(false)
    sup.configure('/h', spec())
    expect(sup.report('/h', { route: 'leader' })).toBe(true)
    expect(sup.report('/h', { big: 'x'.repeat(20_000) })).toBe(false)
    expect(sup.report('/h', ['not', 'an', 'object'])).toBe(false)
    expect(sup.status('/h')).toMatchObject({ report: { route: 'leader' }, reportedAt: now, reportAgeMs: 0 })
    // Its age is by this host's clock: the leader's may differ.
    now += 7_000
    expect(sup.status('/h')).toMatchObject({ reportAgeMs: 7_000 })
    exit(children[0]!, 1)
    expect(sup.status('/h').report).toBeUndefined()
  })

  it('the same spec again ends a wait at once', () => {
    const sup = createHostServerSupervisor(deps())
    sup.configure('/h', spec())
    exit(children[0]!, 1)
    expect(sup.status('/h').state).toBe('retrying')
    sup.configure('/h', spec())
    expect(sup.status('/h')).toMatchObject({ state: 'running', pid: 1001 })
  })

  it('removal stops the group with SIGTERM, then SIGKILL after 10 s only if the same process is still there', () => {
    const sup = createHostServerSupervisor(deps())
    sup.configure('/h', spec())
    expect(sup.configure('/h', null).state).toBe('off')
    expect(signals).toEqual([{ pid: 1000, signal: 'SIGTERM' }])
    advance(10_000)
    expect(signals).toEqual([{ pid: 1000, signal: 'SIGTERM' }, { pid: 1000, signal: 'SIGKILL' }])
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('server-'))).toEqual([])
    // A process that ended (or whose pid now belongs to another) is never signalled again.
    sup.configure('/h', spec())
    sup.configure('/h', null)
    procs.set(1001, 'someone-else')
    advance(10_000)
    expect(signals.filter((s) => s.pid === 1001)).toEqual([{ pid: 1001, signal: 'SIGTERM' }])
  })

  it('a new daemon adopts a server that is still running, and watches it', () => {
    const first = createHostServerSupervisor(deps())
    first.configure('/h', spec())
    timers = [] // the old daemon is gone, its timers with it
    const second = createHostServerSupervisor(deps())
    second.boot()
    expect(second.status('/h')).toMatchObject({ state: 'running', pid: 1000 })
    expect(spawned).toHaveLength(1)
    // It keeps the token the server was started with.
    expect(second.tokenMatches('/h', spawned[0]!.env.WALNUT_FOLLOWER_TOKEN)).toBe(true)
    // It ends on its own: noticed within a poll, started again after the wait.
    procs.delete(1000)
    advance(5_000)
    expect(second.status('/h')).toMatchObject({ state: 'retrying', lastError: 'is no longer running' })
    advance(5_000)
    expect(second.status('/h')).toMatchObject({ state: 'running', pid: 1001 })
  })

  it('a new daemon starts a server whose pid now belongs to another process', () => {
    const first = createHostServerSupervisor(deps())
    first.configure('/h', spec())
    procs.set(1000, 'a-different-process')
    timers = []
    const second = createHostServerSupervisor(deps())
    second.boot()
    expect(second.status('/h')).toMatchObject({ state: 'running', pid: 1001 })
    expect(signals).toEqual([])
  })

  it('keeps one server per Walnut', () => {
    const sup = createHostServerSupervisor(deps())
    sup.configure('/h', spec())
    sup.configure('/test-home', spec({ home: '/test-home', port: 4100 }))
    expect(sup.homes().sort()).toEqual(['/h', '/test-home'])
    sup.configure('/test-home', null)
    expect(sup.status('/h')).toMatchObject({ state: 'running', pid: 1000 })
    expect(signals).toEqual([{ pid: 1001, signal: 'SIGTERM' }])
  })
})
