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
import { createHostServerSupervisor, heldServerAt, type HostServerDeps, type HostServerSpec } from '../../src/providers/host-server-core.js'

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
    heldAt: heldServerAt,
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
  it('makes its cwd before the spawn: a second Walnut on the host has its own data dir, which nothing made yet', () => {
    const cwd = path.join(dir, 'walnuts', 'w1', 'data')
    const sup = createHostServerSupervisor(deps())
    sup.configure('/h', spec({ cwd }))
    expect(spawned).toHaveLength(1)
    expect(fs.statSync(cwd).isDirectory()).toBe(true)
    expect(fs.statSync(cwd).mode & 0o777).toBe(0o700)
  })

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

  it('a server\'s data dir names its leader\'s Walnut (walnutOf), and still does for a new daemon after a restart', () => {
    const data = path.join(dir, 'walnuts', 'w1', 'data')
    const first = createHostServerSupervisor(deps())
    first.configure('/h', spec({ env: { WALNUT_HOST_SERVER: '1', OPEN_WALNUT_HOME: data }, fallback: { args: ['/app/cli.js', 'host-server'], env: { OPEN_WALNUT_HOME: data + '-fallback' } } }))
    expect(first.walnutOf(data)).toBe('/h')
    expect(first.walnutOf(data + '/')).toBe('/h')
    expect(first.walnutOf(data + '-fallback')).toBe('/h')
    // A leader's own home, another dir, a relative path: no server's data dir.
    for (const other of ['/h', path.join(dir, 'walnuts', 'w2', 'data'), 'walnuts/w1/data', '']) expect(first.walnutOf(other)).toBeUndefined()
    timers = []
    const second = createHostServerSupervisor(deps())
    expect(second.walnutOf(data), 'nothing before boot').toBeUndefined()
    second.boot()
    expect(second.walnutOf(data)).toBe('/h')
    // Removed: the dir names nobody any more.
    second.configure('/h', null)
    expect(second.walnutOf(data)).toBeUndefined()
  })

  it('a data dir that is a Walnut\'s own home, another server\'s, or the service\'s is refused at configure; walnutOf takes only the leader\'s layout, by real path', () => {
    const data = path.join(dir, 'walnuts', 'w1', 'data')
    fs.mkdirSync(data, { recursive: true })
    const prod = path.join(dir, 'home', '.open-walnut')
    const sup = createHostServerSupervisor({ ...deps(), realpath: (p) => { try { return fs.realpathSync(p) } catch { return null } }, walnutHomes: () => ['/leader-b', prod] })
    const at = (home: string, env: Record<string, string>, walnutId = 'w1') => () => sup.configure(home, spec({ home, walnutId, env }))
    // A Walnut's own home: a leader this daemon knows, the production data dir, a leader of a spec here.
    expect(at('/h', { OPEN_WALNUT_HOME: '/leader-b' })).toThrow(/is a Walnut's own home/)
    expect(at('/h', { OPEN_WALNUT_HOME: prod })).toThrow(/is a Walnut's own home/)
    sup.configure('/h2', spec({ home: '/h2', walnutId: 'w2', env: { OPEN_WALNUT_HOME: path.join(dir, 'walnuts', 'w2', 'data') } }))
    expect(at('/h', { OPEN_WALNUT_HOME: '/h2' })).toThrow(/is a Walnut's own home/)
    // Another server's data dir, by real path (a link to it is the same dir).
    fs.mkdirSync(path.join(dir, 'walnuts', 'w2', 'data'), { recursive: true })
    fs.symlinkSync(path.join(dir, 'walnuts'), path.join(dir, 'linked'))
    expect(at('/h', { OPEN_WALNUT_HOME: path.join(dir, 'linked', 'w2', 'data') })).toThrow(/data dir of another Walnut's server/)
    expect(sup.status('/h').state).toBe('off')
    // The leader's layout, named through the link: its Walnut.
    sup.configure('/h', spec({ home: '/h', walnutId: 'w1', env: { OPEN_WALNUT_HOME: data } }))
    expect(sup.walnutOf(path.join(dir, 'linked', 'w1', 'data'))).toBe('/h')
    // Not the layout (no walnuts/<id>/ above it, or another id's): no Walnut.
    const flat = path.join(dir, 'flat-data')
    sup.configure('/h3', spec({ home: '/h3', walnutId: 'w3', env: { OPEN_WALNUT_HOME: flat } }))
    expect(sup.walnutOf(flat)).toBeUndefined()
    const wrong = path.join(dir, 'walnuts', 'w1x', 'data')
    sup.configure('/h4', spec({ home: '/h4', walnutId: 'w4', env: { OPEN_WALNUT_HOME: wrong } }))
    expect(sup.walnutOf(wrong)).toBeUndefined()
  })

  it('a spec kept from before the check runs on, but its conflicting data dir names no Walnut', () => {
    const prod = path.join(dir, 'home', '.open-walnut')
    const first = createHostServerSupervisor(deps())
    // An older daemon kept it (no homes to check against then).
    first.configure('/h', spec({ env: { OPEN_WALNUT_HOME: prod } }))
    timers = []
    const warned: string[] = []
    const second = createHostServerSupervisor({ ...deps(), walnutHomes: () => [prod], log: (_l, msg) => { warned.push(msg) } })
    second.boot()
    expect(second.status('/h').state).toBe('running')
    expect(second.walnutOf(prod)).toBeUndefined()
    expect(warned).toContain('host server: its data dir is not taken as its Walnut\'s')
  })

  it('the shared data dir from before the split names the Walnut its .walnut-id mark names in full, and no other', () => {
    const W = 'w1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const legacy = path.join(dir, 'host-root', 'data')
    fs.mkdirSync(legacy, { recursive: true })
    const sup = createHostServerSupervisor({ ...deps(), realpath: (p) => { try { return fs.realpathSync(p) } catch { return null } } })
    sup.configure('/h', spec({ home: '/h', walnutId: W, env: { OPEN_WALNUT_HOME: legacy } }))
    expect(sup.walnutOf(legacy), 'no mark yet').toBeUndefined()
    // As legacyDataOwnerScript writes it (printf, no newline) and as a hand edit may leave it (one newline).
    for (const mark of [W, W + '\n']) {
      fs.writeFileSync(path.join(legacy, '.walnut-id'), mark)
      expect(sup.walnutOf(legacy), JSON.stringify(mark)).toBe('/h')
    }
    // Another Walnut's mark, the 16-char dir key only, or padding: not this Walnut's.
    for (const mark of ['w2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', W.slice(0, 16), ` ${W}`, `${W} `]) {
      fs.writeFileSync(path.join(legacy, '.walnut-id'), mark)
      expect(sup.walnutOf(legacy), JSON.stringify(mark)).toBeUndefined()
    }
    // The mark in a dir that is not the shared one's leaf (`data`): not that layout.
    const other = path.join(dir, 'host-root', 'store')
    fs.mkdirSync(other, { recursive: true })
    fs.writeFileSync(path.join(other, '.walnut-id'), W)
    sup.configure('/h5', spec({ home: '/h5', walnutId: W, env: { OPEN_WALNUT_HOME: other } }))
    expect(sup.walnutOf(other)).toBeUndefined()
    // The conflict checks still hold for it: a dir that is a Walnut's own home is refused, marked or not.
    fs.writeFileSync(path.join(legacy, '.walnut-id'), W)
    const guarded = createHostServerSupervisor({ ...deps(), walnutHomes: () => [legacy] })
    expect(() => guarded.configure('/h', spec({ home: '/h', walnutId: W, env: { OPEN_WALNUT_HOME: legacy } }))).toThrow(/is a Walnut's own home/)
  })

  it('a data dir looked up before it exists still matches through a link once it is made', () => {
    const real = path.join(dir, 'real')
    fs.mkdirSync(real)
    fs.symlinkSync(real, path.join(dir, 'link'))
    const data = path.join(real, 'walnuts', 'w1', 'data')
    const viaLink = path.join(dir, 'link', 'walnuts', 'w1', 'data')
    const sup = createHostServerSupervisor({ ...deps(), realpath: (p) => { try { return fs.realpathSync(p) } catch { return null } } })
    sup.configure('/h', spec({ home: '/h', walnutId: 'w1', env: { OPEN_WALNUT_HOME: data } }))
    expect(sup.walnutOf(viaLink), 'not made yet: the link names another path').toBeUndefined()
    fs.mkdirSync(data, { recursive: true })
    expect(sup.walnutOf(viaLink)).toBe('/h')
  })

  it('the service\'s own data dir names the Walnut it follows', () => {
    const own = path.join(dir, 'walnuts', 'self', 'data')
    const sup = createHostServerSupervisor({ ...deps(), self: { home: '/leader', pid: process.pid, dataHome: own, changed: () => {} } })
    expect(sup.walnutOf(own)).toBe('/leader')
    expect(sup.walnutOf(path.join(dir, 'elsewhere'))).toBeUndefined()
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

describe('host server supervision: the fallback after a crash loop (WP2)', () => {
  const withFallback = () => spec({
    args: ['/app/cli.js', 'web', '--replica'], env: { WALNUT_ROLE: 'replica', LABEL: 'x' },
    fallback: { args: ['/app/cli.js', 'host-server'], env: { WALNUT_HOST_SERVER: '1', LABEL: 'x' } },
  })
  const last = () => children[children.length - 1]!

  it('three exits within ten minutes switch to the fallback args with no configure, and server.status says so', () => {
    const sup = createHostServerSupervisor(deps())
    sup.configure('/h', withFallback())
    expect(sup.status('/h')).toMatchObject({ state: 'running', program: 'primary' })
    expect(sup.status('/h').fallback).toBeUndefined()
    // Exits 1 and 2: the primary again, with the usual backoff.
    exit(last(), 1); advance(5_000)
    exit(last(), 1); advance(10_000)
    expect(spawned.map((s) => s.args.at(-1))).toEqual(['--replica', '--replica', '--replica'])
    // Exit 3 inside the window: the fallback, after the first delay only.
    exit(last(), 1)
    const status = sup.status('/h')
    expect(status).toMatchObject({ state: 'retrying', program: 'fallback', fallback: { since: now, until: now + 60 * 60_000, lastError: 'exited with code 1' } })
    advance(5_000)
    expect(spawned.at(-1)!.args).toEqual(['/app/cli.js', 'host-server'])
    // The fallback env replaces the primary's; the token is the same one.
    expect(spawned.at(-1)!.env).toMatchObject({ WALNUT_HOST_SERVER: '1', LABEL: 'x', HOME: '/home/u' })
    expect(spawned.at(-1)!.env.WALNUT_ROLE).toBeUndefined()
    expect(spawned.at(-1)!.env.WALNUT_FOLLOWER_TOKEN).toBe(spawned[0]!.env.WALNUT_FOLLOWER_TOKEN)
    expect(sup.status('/h')).toMatchObject({ state: 'running', program: 'fallback' })
  })

  it('answersCalls: only the replica with host-local-calls, on its primary program, kept across a restart and gone with its spec', () => {
    const sup = createHostServerSupervisor(deps())
    expect(sup.answersCalls('/h')).toBe(false)
    const calls = () => spec({ ...withFallback(), env: { WALNUT_ROLE: 'replica', WALNUT_CAPABILITIES: 'host-local-calls', LABEL: 'x' } })
    sup.configure('/h', withFallback())
    expect(sup.answersCalls('/h'), 'a replica without the capability').toBe(false)
    sup.configure('/h', spec({ env: { WALNUT_CAPABILITIES: 'host-local-calls' } }))
    expect(sup.answersCalls('/h'), 'not the replica program').toBe(false)
    sup.configure('/h', calls())
    expect(sup.answersCalls('/h')).toBe(true)
    // Exited and restarting: still this host's follower (not "linked right now").
    exit(last(), 1)
    expect(sup.status('/h').state).toBe('retrying')
    expect(sup.answersCalls('/h')).toBe(true)
    // The fallback (the plain host server) answers none.
    advance(5_000); exit(last(), 1)
    advance(10_000); exit(last(), 1)
    expect(sup.status('/h').program).toBe('fallback')
    expect(sup.answersCalls('/h')).toBe(false)
    // Removed by the leader (below the floors, turned off): none.
    sup.configure('/h', null)
    expect(sup.answersCalls('/h')).toBe(false)
  })

  it('answersCalls: a new daemon keeps it from the spec file it boots from', () => {
    const sup = createHostServerSupervisor(deps())
    sup.configure('/h', spec({ ...withFallback(), env: { WALNUT_ROLE: 'replica', WALNUT_CAPABILITIES: 'host-local-calls' } }))
    expect(createHostServerSupervisor(deps()).answersCalls('/h'), 'before its boot').toBe(false)
    const next = createHostServerSupervisor(deps())
    next.boot()
    expect(next.answersCalls('/h')).toBe(true)
  })

  it('three exits spread over more than ten minutes never switch', () => {
    const sup = createHostServerSupervisor(deps())
    sup.configure('/h', withFallback())
    exit(last(), 1); advance(6 * 60_000)
    exit(last(), 1); advance(6 * 60_000)
    exit(last(), 1)
    expect(sup.status('/h')).toMatchObject({ program: 'primary' })
  })

  it('a spec without a fallback crash-loops on its own args, as before', () => {
    const sup = createHostServerSupervisor(deps())
    sup.configure('/h', spec())
    for (let i = 0; i < 4; i++) { exit(last(), 1); advance(5 * 60_000) }
    expect(new Set(spawned.map((s) => s.args.join(' ')))).toEqual(new Set(['/app/cli.js web']))
    expect(sup.status('/h').program).toBeUndefined()
  })

  it('goes back to the primary after one hour', () => {
    const sup = createHostServerSupervisor(deps())
    sup.configure('/h', withFallback())
    exit(last(), 1); advance(5_000); exit(last(), 1); advance(10_000); exit(last(), 1); advance(5_000)
    const fallbackPid = last().pid!
    expect(sup.status('/h')).toMatchObject({ state: 'running', program: 'fallback', pid: fallbackPid })
    advance(60 * 60_000)
    // The fallback is stopped, and the primary starts once it let go of the port.
    expect(signals).toContainEqual({ pid: fallbackPid, signal: 'SIGTERM' })
    advance(5_000)
    expect(spawned.at(-1)!.args.at(-1)).toBe('--replica')
    expect(sup.status('/h')).toMatchObject({ state: 'running', program: 'primary' })
    expect(sup.status('/h').fallback).toBeUndefined()
  })

  it('a resend of the same spec on the same link (a settings save, retryExpose) keeps the fallback', () => {
    const sup = createHostServerSupervisor(deps())
    sup.configure('/h', withFallback(), { freshLink: true })
    exit(last(), 1); advance(5_000); exit(last(), 1); advance(10_000); exit(last(), 1); advance(5_000)
    expect(sup.status('/h').program).toBe('fallback')
    const spawnsBefore = spawned.length
    const saved = withFallback() as Record<string, unknown>
    saved.settings = { expose: { enabled: true }, exposeRetry: 3 }
    expect(sup.configure('/h', saved, { freshLink: false })).toMatchObject({ program: 'fallback' })
    // The new settings are taken all the same (the fallback reads them too).
    expect(sup.settingsOf('/h')).toEqual(saved.settings)
    expect(sup.configure('/h', withFallback())).toMatchObject({ program: 'fallback' })
    advance(10_000)
    // Nothing restarted: the fallback keeps the port, no crash loop again.
    expect(spawned.length).toBe(spawnsBefore)
    expect(spawned.at(-1)!.args.at(-1)).toBe('host-server')
  })

  it('goes back to the primary at the next configure from a fresh link (the same spec, the Mac is back)', () => {
    const sup = createHostServerSupervisor(deps())
    sup.configure('/h', withFallback())
    exit(last(), 1); advance(5_000); exit(last(), 1); advance(10_000); exit(last(), 1); advance(5_000)
    expect(sup.status('/h').program).toBe('fallback')
    expect(sup.configure('/h', withFallback(), { freshLink: true })).toMatchObject({ program: 'primary' })
    advance(5_000)
    expect(spawned.at(-1)!.args.at(-1)).toBe('--replica')
    // And the crash count starts again.
    exit(last(), 1); advance(5_000)
    expect(sup.status('/h').program).toBe('primary')
  })

  it('a new daemon adopting the fallback keeps it until its hour ends', () => {
    const first = createHostServerSupervisor(deps())
    first.configure('/h', withFallback())
    exit(last(), 1); advance(5_000); exit(last(), 1); advance(10_000); exit(last(), 1); advance(5_000)
    const pid = last().pid!
    timers = []
    const second = createHostServerSupervisor(deps())
    second.boot()
    expect(second.status('/h')).toMatchObject({ state: 'running', pid, program: 'fallback' })
    advance(60 * 60_000)
    expect(signals).toContainEqual({ pid, signal: 'SIGTERM' })
  })

  it('refuses a fallback it cannot run safely', () => {
    const sup = createHostServerSupervisor(deps())
    expect(() => sup.configure('/h', spec({ fallback: { args: Array(65).fill('a'), env: {} } }))).toThrow(/fallback\.args/)
    expect(() => sup.configure('/h', spec({ fallback: { args: [], env: { WALNUT_FOLLOWER_TOKEN: 'x' } } }))).toThrow(/WALNUT_FOLLOWER_TOKEN/)
    expect(() => sup.configure('/h', spec({ fallback: { args: [], env: { 'BAD-KEY': 'v' } } }))).toThrow(/fallback\.env/)
  })
})

describe('host server supervision: the host\'s one Walnut service is its own follower (self)', () => {
  const selfDeps = (changes: string[]) => ({ ...deps(), self: { home: '/h', pid: 4242, changed: (why: string) => { changes.push(why) } } })

  it('a new runtime keeps the service\'s spec and token, starts no child for it, and runs the others as before', () => {
    const first = createHostServerSupervisor(deps())
    first.configure('/h', spec())
    first.configure('/other', spec({ home: '/other', port: 4100 }))
    const token = spawned[0]!.env.WALNUT_FOLLOWER_TOKEN
    timers = []
    spawned = []
    procs.delete(1000) // the old follower child was ended by the service's entry
    const changes: string[] = []
    const second = createHostServerSupervisor(selfDeps(changes))
    second.boot()
    expect(second.status('/h')).toMatchObject({ state: 'running', pid: 4242 })
    expect(second.tokenMatches('/h', token)).toBe(true)
    // The other Walnut's follower is adopted as before; nothing is started for the service's own home.
    expect(spawned).toEqual([])
    expect(second.status('/other')).toMatchObject({ state: 'running', pid: 1001 })
    advance(60_000)
    expect(spawned).toEqual([])
    expect(signals).toEqual([])
    expect(changes).toEqual([])
  })

  it('new settings change live; a spec that changes what runs, or none, restarts the service and never signals it', () => {
    const first = createHostServerSupervisor(deps())
    first.configure('/h', spec())
    timers = []
    spawned = []
    const changes: string[] = []
    const sup = createHostServerSupervisor(selfDeps(changes))
    sup.boot()
    sup.configure('/h', spec({ settings: { expose: { enabled: true } } }))
    expect(sup.settingsOf('/h')).toEqual({ expose: { enabled: true } })
    expect(changes).toEqual([])
    const saved = JSON.parse(fs.readFileSync(path.join(dir, `server-${Buffer.from('/h').toString('hex').slice(0, 16)}.json`), 'utf8'))
    expect(saved.spec.settings).toEqual({ expose: { enabled: true } })

    sup.configure('/h', spec({ port: 4001 }))
    expect(changes).toEqual(['the leader changed what runs'])
    const resaved = JSON.parse(fs.readFileSync(path.join(dir, `server-${Buffer.from('/h').toString('hex').slice(0, 16)}.json`), 'utf8'))
    expect(resaved.spec.port).toBe(4001)
    sup.configure('/h', null)
    expect(changes).toEqual(['the leader changed what runs', 'the leader removed the follower'])
    expect(fs.existsSync(path.join(dir, `server-${Buffer.from('/h').toString('hex').slice(0, 16)}.json`))).toBe(false)
    expect(spawned).toEqual([])
    expect(signals).toEqual([])
  })
  // Review A3b S34-L3: after a declared move /h -> /h2 the leader names /h2; the host keys the Walnut by /h.
  it('a home a declared move made the service\'s own is the service: no second follower, and its spec keeps the service\'s home', () => {
    const canonical = (home: string): string => (home === '/h2' ? '/h' : home)
    const keyOf = (home: string): string => Buffer.from(canonical(home)).toString('hex').slice(0, 16)
    const first = createHostServerSupervisor({ ...deps(), keyOf })
    first.configure('/h', spec())
    timers = []
    spawned = []
    procs.delete(1000)
    const changes: string[] = []
    const sup = createHostServerSupervisor({ ...selfDeps(changes), keyOf, canonical })
    sup.boot()
    const token = JSON.parse(fs.readFileSync(path.join(dir, `server-${keyOf('/h')}.json`), 'utf8')).token
    // Its new home reads the service's own entry: status, token, settings.
    expect(sup.status('/h2')).toMatchObject({ state: 'running', pid: 4242 })
    expect(sup.tokenMatches('/h2', token)).toBe(true)
    sup.configure('/h2', spec({ home: '/h2', settings: { expose: { enabled: true } } }))
    expect(sup.settingsOf('/h2')).toEqual({ expose: { enabled: true } })
    expect(changes).toEqual([])
    const saved = JSON.parse(fs.readFileSync(path.join(dir, `server-${keyOf('/h')}.json`), 'utf8'))
    // The home service-mode.json names, so the next --service start finds this spec (service-entry.ts decideServiceEntry).
    expect(saved.spec.home).toBe('/h')
    expect(saved.spec.settings).toEqual({ expose: { enabled: true } })
    // A change of what runs restarts the one service; nothing is ever started beside it.
    sup.configure('/h2', spec({ home: '/h2', port: 4001 }))
    expect(changes).toEqual(['the leader changed what runs'])
    expect(JSON.parse(fs.readFileSync(path.join(dir, `server-${keyOf('/h')}.json`), 'utf8')).spec).toMatchObject({ home: '/h', port: 4001 })
    expect(sup.homes()).toEqual(['/h'])
    advance(60_000)
    expect(spawned).toEqual([])
    expect(signals).toEqual([])
    // Without the alias the other home is another Walnut, as before.
    const plain = createHostServerSupervisor({ ...selfDeps([]), dir: fs.mkdtempSync(path.join(dir, 'plain-')) })
    plain.configure('/h2', spec({ home: '/h2', port: 4200 }))
    expect(spawned).toHaveLength(1)
  })
})

// A machine that leads a Walnut as its one service (src/binary/service-entry.ts runLeaderService) runs
// no follower of that Walnut: the spec it kept from when it followed is neither started at boot nor by a
// configure. Another Walnut's follower runs as before.
describe('a leading service runs no follower of the Walnut it leads', () => {
  it('skips that Walnut\'s spec at boot and refuses a configure for it; another Walnut\'s runs', () => {
    createHostServerSupervisor(deps()).configure('/h', spec())
    createHostServerSupervisor(deps()).configure('/other', spec({ home: '/other', walnutId: 'w2', port: 4100 }))
    spawned = []
    procs.clear()
    const sup = createHostServerSupervisor({ ...deps(), leads: 'w1' })
    sup.boot()
    expect(spawned).toHaveLength(1)
    expect(sup.homes()).toEqual(['/other'])
    expect(sup.status('/other')).toMatchObject({ state: 'running' })
    expect(() => sup.configure('/h', spec({ port: 4001 }))).toThrow(/this machine leads Walnut w1/)
    expect(spawned).toHaveLength(1)
  })
})

describe('the pid file has one reader (heldServerAt)', () => {
  it('reads { pid, startTime }, and nothing from a missing, broken or odd file', () => {
    const file = path.join(dir, 'server-x.pid')
    expect(heldServerAt(fs, file)).toEqual({ pid: 0, startTime: null })
    fs.writeFileSync(file, '{ half')
    expect(heldServerAt(fs, file)).toEqual({ pid: 0, startTime: null })
    fs.writeFileSync(file, JSON.stringify({ pid: 1.5, startTime: 7 }))
    expect(heldServerAt(fs, file)).toEqual({ pid: 0, startTime: null })
    fs.writeFileSync(file, JSON.stringify({ pid: 4321, startTime: 'st' }))
    expect(heldServerAt(fs, file)).toEqual({ pid: 4321, startTime: 'st' })
  })

  it('the supervisor and stopRecordedServer both read through it (no second parser)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/providers/host-server-core.ts'), 'utf8')
    expect(src.match(/typeof held\?\.startTime === 'string'/g)).toHaveLength(1)
    expect(src).toContain('deps.heldAt(fs, pidFile(spec.home))')
    expect(src).toContain('heldServerAt(o.fs, o.pidFile)')
  })
})
