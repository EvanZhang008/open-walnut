/**
 * The daemon's supervision of plugin jobs (plugin-jobs-core.ts) with a fake clock,
 * fake processes and a real temp dir. The real processes are
 * tests/integration/plugin-jobs-twins.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPluginJobSupervisor, type PluginJobDeps, type PluginJobSpec, type PluginJobsSpec } from '../../src/providers/plugin-jobs-core.js'

class FakeChild extends EventEmitter {
  constructor(public pid: number | undefined) { super() }
  unref(): void { /* nothing */ }
}

let dir = ''
let now = 0
let timers: Array<{ at: number; fn: () => void; id: number }> = []
let nextTimer = 1
let nextPid = 1000
let children: FakeChild[] = []
let spawned: Array<{ command: string; args: string[]; env: Record<string, string>; cwd: string }> = []
let procs = new Map<number, string>()
let signals: Array<{ pid: number; signal: string }> = []
/** `ps` failing: start times cannot be read, though the processes are there. */
let psBroken = false
let bootedAt: number | null = null

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

function deps(over: Partial<PluginJobDeps> = {}): PluginJobDeps {
  return {
    fs, path,
    spawn: (command, args, opts) => {
      const child = new FakeChild(nextPid++)
      procs.set(child.pid!, `st-${child.pid}`)
      children.push(child)
      spawned.push({ command, args, env: opts.env, cwd: opts.cwd })
      return child
    },
    dir,
    keyOf: (home) => Buffer.from(home).toString('hex').slice(0, 16),
    now: () => now,
    setTimer: (fn, ms) => { const id = nextTimer++; timers.push({ at: now + ms, fn, id }); return id },
    clearTimer: (t) => { timers = timers.filter((x) => x.id !== t) },
    log: () => {},
    startTimeOf: (pid) => (psBroken ? null : procs.get(pid) ?? null),
    alive: (pid) => procs.has(pid),
    bootTime: () => bootedAt,
    randomToken: () => crypto.randomBytes(32).toString('hex'),
    killGroup: (pid, signal) => { signals.push({ pid, signal }) },
    program: () => ({ command: '/opt/walnut-core', args: ['walnut', 'plugin-job'] }),
    baseEnv: () => ({ HOME: '/home/u', LANG: 'C' }),
    gatewaySocket: () => '/tmp/d/agent-gateway.sock',
    sha256File: (file) => { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') } catch { return null } },
    ...over,
  }
}

/** A bundle file in the supervisor's bundle dir; returns its sha and path. */
function putBundle(text = 'export const jobs = {}\n'): { sha256: string; file: string } {
  const sha256 = crypto.createHash('sha256').update(text).digest('hex')
  const file = path.join(dir, 'bundles', `${sha256}.mjs`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return { sha256, file }
}

function job(over: Partial<PluginJobSpec> = {}): PluginJobSpec {
  return {
    plugin: 'acme-jobs', version: '1.0.0', job: 'worker', kind: 'long-running',
    bundle: putBundle(), config: { queue: 'q1' }, host: '__local__', ...over,
  }
}

function spec(jobs: PluginJobSpec[]): PluginJobsSpec {
  return { v: 1, home: '/h', walnutId: 'w1', jobs }
}

function exit(child: FakeChild, code: number | null, signal: string | null = null): void {
  if (child.pid) procs.delete(child.pid)
  child.emit('exit', code, signal)
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-'))
  now = 1_000_000
  timers = []
  nextTimer = 1
  nextPid = 1000
  children = []
  spawned = []
  procs = new Map()
  signals = []
  psBroken = false
  bootedAt = null
})

afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('long-running jobs', () => {
  it('runs this daemon\'s program on the bundle with the job described in its env', () => {
    const sup = createPluginJobSupervisor(deps())
    const j = job()
    const st = sup.configure('/h', spec([j]))
    expect(st.jobs[0]).toMatchObject({ plugin: 'acme-jobs', job: 'worker', state: 'running', pid: 1000 })
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.command).toBe('/opt/walnut-core')
    expect(spawned[0]!.args).toEqual(['walnut', 'plugin-job', j.bundle.file, 'worker'])
    expect(spawned[0]!.env.WALNUT_AGENT_SOCKET).toBe('/tmp/d/agent-gateway.sock')
    const info = JSON.parse(spawned[0]!.env.WALNUT_PLUGIN_JOB!)
    expect(info).toMatchObject({ plugin: 'acme-jobs', job: 'worker', kind: 'long-running', host: '__local__', config: { queue: 'q1' } })
    expect(info.sid).toMatch(/^plugin-job:[0-9a-f]{64}$/)
    expect(info.stateDir).toBe(spawned[0]!.cwd)
    expect(fs.existsSync(path.join(spawned[0]!.cwd, 'job.log'))).toBe(true)
    // The spec and the pid with its start time are on disk for a new daemon.
    const files = fs.readdirSync(dir)
    expect(files.some((f) => /^jobs-[0-9a-f]+\.json$/.test(f))).toBe(true)
    expect(files.some((f) => /^jobs-[0-9a-f]+\.state\.json$/.test(f))).toBe(true)
  })

  it('starts a crashed job again after 5 s, doubling to 5 min, and a steady run resets the count', () => {
    const sup = createPluginJobSupervisor(deps())
    sup.configure('/h', spec([job()]))
    exit(children[0]!, 1)
    let st = sup.status('/h').jobs[0]!
    expect(st).toMatchObject({ state: 'retrying', failures: 1, restarts: 1, lastError: 'exited with code 1' })
    advance(4_999)
    expect(spawned).toHaveLength(1)
    advance(1)
    expect(spawned).toHaveLength(2)
    exit(children[1]!, 1)
    advance(9_999)
    expect(spawned).toHaveLength(2)
    advance(1)
    expect(spawned).toHaveLength(3)
    // Many crashes: capped at 5 min.
    for (let i = 0; i < 8; i++) { exit(children.at(-1)!, 1); advance(5 * 60_000) }
    const before = spawned.length
    exit(children.at(-1)!, 1)
    advance(5 * 60_000 - 1)
    expect(spawned).toHaveLength(before)
    advance(1)
    expect(spawned).toHaveLength(before + 1)
    // Ten minutes of running: the next exit waits 5 s again.
    advance(10 * 60_000)
    exit(children.at(-1)!, 0)
    st = sup.status('/h').jobs[0]!
    expect(st.lastError).toBeUndefined()
    advance(5_000)
    expect(spawned).toHaveLength(before + 2)
  })

  it('a job that returns (exit 0) is started again too, without counting a failure', () => {
    const sup = createPluginJobSupervisor(deps())
    sup.configure('/h', spec([job()]))
    exit(children[0]!, 0)
    expect(sup.status('/h').jobs[0]).toMatchObject({ state: 'retrying', failures: 0, restarts: 1 })
    advance(5_000)
    expect(spawned).toHaveLength(2)
  })
})

describe('every-N jobs', () => {
  const every = (over: Partial<PluginJobSpec> = {}) => job({ job: 'poll', kind: 'every', everyMs: 5 * 60_000, ...over })

  it('runs soon after it is added, then once per period, never two at once', () => {
    const sup = createPluginJobSupervisor(deps())
    const st = sup.configure('/h', spec([every()]))
    expect(st.jobs[0]).toMatchObject({ state: 'idle', nextRunAt: now + 2_000 })
    advance(2_000)
    expect(spawned).toHaveLength(1)
    const startedAt = now
    advance(30_000)
    exit(children[0]!, 0)
    expect(sup.status('/h').jobs[0]).toMatchObject({ state: 'idle', runs: 1, failures: 0, lastRunAt: startedAt, lastRunMs: 30_000, nextRunAt: startedAt + 5 * 60_000 })
    advance(5 * 60_000 - 30_001)
    expect(spawned).toHaveLength(1)
    advance(1)
    expect(spawned).toHaveLength(2)
    // A run longer than the period: the next one starts a second after it ends, not during it.
    advance(7 * 60_000)
    expect(spawned).toHaveLength(2)
    exit(children[1]!, 0)
    advance(999)
    expect(spawned).toHaveLength(2)
    advance(1)
    expect(spawned).toHaveLength(3)
  })

  it('a failed run is counted and the schedule goes on', () => {
    const sup = createPluginJobSupervisor(deps())
    sup.configure('/h', spec([every()]))
    advance(2_000)
    exit(children[0]!, 2)
    expect(sup.status('/h').jobs[0]).toMatchObject({ runs: 1, failures: 1, lastError: 'exited with code 2', state: 'idle' })
    advance(5 * 60_000)
    expect(spawned).toHaveLength(2)
  })

  it('a run past its timeout (twice the period, at least 10 min) is stopped and the next one comes', () => {
    const sup = createPluginJobSupervisor(deps())
    sup.configure('/h', spec([every()]))
    advance(2_000)
    const pid = children[0]!.pid!
    advance(10 * 60_000 - 1)
    expect(signals).toEqual([])
    advance(1)
    expect(signals).toEqual([{ pid, signal: 'SIGTERM' }])
    exit(children[0]!, null, 'SIGTERM')
    expect(sup.status('/h').jobs[0]!.lastError).toBe('ran past its 10 min limit and was stopped')
    // The SIGKILL timer finds the process gone and signals nothing more.
    advance(10_000)
    expect(signals).toHaveLength(1)
    advance(60_000)
    expect(spawned).toHaveLength(2)
  })

  it('keeps its schedule across a new daemon: no run at once, and an overdue one runs once', () => {
    let sup = createPluginJobSupervisor(deps())
    sup.configure('/h', spec([every()]))
    advance(2_000)
    const startedAt = now
    exit(children[0]!, 0)
    // A new daemon one minute later: the next run stays 5 min after the last.
    advance(60_000)
    sup = createPluginJobSupervisor(deps())
    timers = []
    sup.boot()
    expect(sup.status('/h').jobs[0]).toMatchObject({ state: 'idle', runs: 1, nextRunAt: startedAt + 5 * 60_000 })
    // A daemon that comes back an hour later (a reboot): one run soon, not twelve.
    sup = createPluginJobSupervisor(deps())
    timers = []
    advance(60 * 60_000)
    sup.boot()
    expect(sup.status('/h').jobs[0]!.nextRunAt).toBe(now + 2_000)
    advance(2_000)
    expect(spawned).toHaveLength(2)
  })
})

describe('the set the leader sends', () => {
  it('stops a job it leaves out, restarts a changed one, leaves an unchanged one alone', () => {
    const sup = createPluginJobSupervisor(deps())
    const a = job({ job: 'worker' })
    const b = job({ job: 'other' })
    sup.configure('/h', spec([a, b]))
    expect(spawned).toHaveLength(2)
    // The same set again: nothing starts or stops.
    sup.configure('/h', spec([a, b]))
    expect(spawned).toHaveLength(2)
    expect(signals).toEqual([])
    // b left out: stopped. a with new settings: restarted once its old run has exited.
    sup.configure('/h', spec([{ ...a, config: { queue: 'q2' } }]))
    expect(signals.map((s) => s.pid).sort()).toEqual([1000, 1001])
    expect(spawned).toHaveLength(2)
    expect(sup.status('/h').jobs[0]).toMatchObject({ state: 'starting' })
    exit(children[0]!, null, 'SIGTERM')
    expect(spawned).toHaveLength(3)
    expect(JSON.parse(spawned[2]!.env.WALNUT_PLUGIN_JOB!).config).toEqual({ queue: 'q2' })
    // The exits of the stopped runs are not restarts of the new one.
    exit(children[1]!, null, 'SIGTERM')
    expect(sup.status('/h').jobs).toHaveLength(1)
    expect(sup.status('/h').jobs[0]).toMatchObject({ state: 'running', pid: 1002 })
    advance(60_000)
    expect(spawned).toHaveLength(3)
    // The empty set: everything stops; the spec goes, and the state once the run has exited.
    sup.configure('/h', spec([]))
    expect(signals.at(-1)).toEqual({ pid: 1002, signal: 'SIGTERM' })
    expect(sup.status('/h').jobs).toEqual([])
    expect(fs.readdirSync(dir).filter((f) => /^jobs-[0-9a-f]+\.json$/.test(f))).toEqual([])
    exit(children[2]!, null, 'SIGTERM')
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('jobs-'))).toEqual([])
  })

  it('a set sent again keeps a crash loop\'s backoff', () => {
    const sup = createPluginJobSupervisor(deps())
    const a = job()
    sup.configure('/h', spec([a]))
    exit(children[0]!, 1) // 5 s
    advance(5_000)
    exit(children[1]!, 1) // 10 s
    advance(10_000)
    exit(children[2]!, 1) // 20 s
    sup.configure('/h', spec([a]))
    expect(spawned).toHaveLength(3)
    advance(19_999)
    expect(spawned).toHaveLength(3)
    advance(1)
    expect(spawned).toHaveLength(4)
  })

  it('a changed every job counts its schedule from the run in flight', () => {
    const sup = createPluginJobSupervisor(deps())
    const poll = job({ job: 'poll', kind: 'every', everyMs: 5 * 60_000 })
    sup.configure('/h', spec([poll]))
    advance(2_000)
    const startedAt = now
    advance(30_000)
    sup.configure('/h', spec([{ ...poll, config: { queue: 'q9' } }]))
    exit(children[0]!, null, 'SIGTERM')
    expect(sup.status('/h').jobs[0]).toMatchObject({ state: 'idle', nextRunAt: startedAt + 5 * 60_000 })
    advance(5 * 60_000 - 30_001)
    expect(spawned).toHaveLength(1)
    advance(1)
    expect(spawned).toHaveLength(2)
  })

  it('a stopped run that ignores SIGTERM gets SIGKILL after 10 s', () => {
    const sup = createPluginJobSupervisor(deps())
    sup.configure('/h', spec([job()]))
    sup.configure('/h', spec([]))
    expect(signals).toEqual([{ pid: 1000, signal: 'SIGTERM' }])
    advance(10_000)
    expect(signals).toEqual([{ pid: 1000, signal: 'SIGTERM' }, { pid: 1000, signal: 'SIGKILL' }])
  })

  it('never runs a bundle that is missing or not the one named, and tries again when told', () => {
    const sup = createPluginJobSupervisor(deps())
    const b = putBundle('export const jobs = { worker: async () => {} }\n')
    const wrong = { sha256: 'a'.repeat(64), file: path.join(dir, 'bundles', `${'a'.repeat(64)}.mjs`) }
    let st = sup.configure('/h', spec([job({ bundle: wrong })]))
    expect(st.jobs[0]).toMatchObject({ state: 'refused', lastError: 'its code is not on this machine yet' })
    fs.writeFileSync(wrong.file, 'tampered')
    st = sup.configure('/h', spec([job({ bundle: wrong })]))
    expect(st.jobs[0]).toMatchObject({ state: 'refused', lastError: 'its code on this machine is not the version Walnut sent' })
    expect(spawned).toEqual([])
    st = sup.configure('/h', spec([job({ bundle: b })]))
    expect(st.jobs[0]!.state).toBe('running')
  })

  it('refuses a bad spec without touching what runs', () => {
    const sup = createPluginJobSupervisor(deps())
    sup.configure('/h', spec([job()]))
    const bad = (j: Record<string, unknown>) => () => sup.configure('/h', spec([j as unknown as PluginJobSpec]))
    expect(bad({ ...job(), plugin: '../x' })).toThrow(/plugin id/)
    expect(bad({ ...job(), job: 'Bad Name' })).toThrow(/job name/)
    expect(bad({ ...job(), kind: 'cron' })).toThrow(/kind/)
    expect(bad({ ...job(), kind: 'every', everyMs: 1000 })).toThrow(/everyMs/)
    expect(bad({ ...job(), bundle: { sha256: 'a'.repeat(64), file: '/etc/passwd' } })).toThrow(/bundle.file/)
    expect(bad({ ...job(), secretsFile: 'relative.json' })).toThrow(/absolute/)
    expect(() => sup.configure('/h', spec([job(), job()]))).toThrow(/named twice/)
    expect(() => sup.configure('/h', { ...spec([]), home: '/other' })).toThrow(/another Walnut/)
    expect(() => sup.configure('/h', { ...spec([]), walnutId: 'bad id!' })).toThrow(/walnutId/)
    expect(sup.status('/h').jobs[0]).toMatchObject({ state: 'running', pid: 1000 })
    expect(signals).toEqual([])
  })

  it('keeps two Walnuts apart', () => {
    const sup = createPluginJobSupervisor(deps())
    sup.configure('/h', spec([job()]))
    sup.configure('/test', { v: 1, home: '/test', walnutId: 'w2', jobs: [job()] })
    sup.configure('/test', { v: 1, home: '/test', walnutId: 'w2', jobs: [] })
    expect(sup.status('/h').jobs).toHaveLength(1)
    expect(signals).toEqual([{ pid: 1001, signal: 'SIGTERM' }])
  })
})

describe('which process is a run', () => {
  it('each run has its own caller id, known while it runs and while it is being stopped', () => {
    let sup = createPluginJobSupervisor(deps())
    sup.configure('/h', spec([job()]))
    const sid = JSON.parse(spawned[0]!.env.WALNUT_PLUGIN_JOB!).sid as string
    expect(sup.isRunSid(sid)).toBe(true)
    expect(sup.isRunSid('external')).toBe(false)
    expect(sup.homeOfRun(sid)).toBe('/h')
    expect(sup.homeOfRun('plugin-job:' + 'f'.repeat(64))).toBeNull()
    // A new daemon adopts the run with its id.
    sup = createPluginJobSupervisor(deps())
    timers = []
    sup.boot()
    expect(sup.homeOfRun(sid)).toBe('/h')
    // Being stopped: still its id until it is gone.
    sup.configure('/h', spec([]))
    expect(sup.homeOfRun(sid)).toBe('/h')
    procs.delete(1000)
    advance(1_000)
    expect(sup.homeOfRun(sid)).toBeNull()
  })

  it('a run it cannot tell (ps failing) is neither replaced nor signalled until it can', () => {
    let sup = createPluginJobSupervisor(deps())
    sup.configure('/h', spec([job()]))
    psBroken = true
    sup = createPluginJobSupervisor(deps())
    timers = []
    sup.boot()
    expect(spawned).toHaveLength(1)
    expect(sup.status('/h').jobs[0]).toMatchObject({ state: 'running', pid: 1000 })
    advance(60_000)
    expect(spawned).toHaveLength(1)
    sup.configure('/h', spec([{ ...job(), config: { queue: 'q2' } }]))
    advance(30_000)
    expect(signals).toEqual([])
    expect(spawned).toHaveLength(1)
    // ps works again: the old run is ours, so it is stopped, and the new one starts after it.
    psBroken = false
    advance(5_000)
    expect(signals).toEqual([{ pid: 1000, signal: 'SIGTERM' }])
    expect(spawned).toHaveLength(1)
    procs.delete(1000)
    advance(1_000)
    expect(spawned).toHaveLength(2)
  })

  it('a start time ps could not tell at the spawn is read later, so a new daemon adopts by it', () => {
    psBroken = true
    let sup = createPluginJobSupervisor(deps())
    sup.configure('/h', spec([job()]))
    psBroken = false
    advance(5_000)
    sup = createPluginJobSupervisor(deps())
    timers = []
    procs.set(1000, 'someone-else') // the pid now holds another process
    sup.boot()
    expect(spawned).toHaveLength(2)
  })

  it('an unconfirmed run from before the machine booted is not adopted', () => {
    let sup = createPluginJobSupervisor(deps())
    sup.configure('/h', spec([job()]))
    advance(60 * 60_000)
    psBroken = true
    bootedAt = now - 60_000
    sup = createPluginJobSupervisor(deps())
    timers = []
    sup.boot()
    expect(spawned).toHaveLength(2)
  })

  it('a daemon that comes back while a stop is under way finishes it, and a new run waits for it', () => {
    let sup = createPluginJobSupervisor(deps())
    const a = job()
    sup.configure('/h', spec([a]))
    sup.configure('/h', spec([]))
    expect(signals).toEqual([{ pid: 1000, signal: 'SIGTERM' }])
    sup = createPluginJobSupervisor(deps())
    timers = []
    signals = []
    sup.boot()
    expect(signals).toEqual([{ pid: 1000, signal: 'SIGTERM' }])
    sup.configure('/h', spec([a]))
    expect(spawned).toHaveLength(1)
    advance(10_000)
    expect(signals.at(-1)).toEqual({ pid: 1000, signal: 'SIGKILL' })
    procs.delete(1000)
    advance(1_000)
    expect(spawned).toHaveLength(2)
  })

  it('writes the supervised file when a run starts and every minute while it goes', () => {
    const sup = createPluginJobSupervisor(deps())
    sup.configure('/h', spec([job()]))
    const file = path.join(spawned[0]!.cwd, 'supervised')
    expect(Number(fs.readFileSync(file, 'utf8'))).toBe(now)
    const first = now
    advance(30_000)
    expect(Number(fs.readFileSync(file, 'utf8'))).toBe(first)
    advance(35_000)
    expect(Number(fs.readFileSync(file, 'utf8'))).toBeGreaterThanOrEqual(first + 60_000)
  })
})

describe('cleanup', () => {
  const ago = (file: string, ms: number) => { const t = (now - ms) / 1000; fs.utimesSync(file, t, t) }

  it('removes a bundle no job names a day after its write, and a gone job\'s run dir after 7 days', () => {
    now = Date.now() // file times are real ones
    const sup = createPluginJobSupervisor(deps())
    const used = job()
    const other = job({ job: 'other' })
    sup.configure('/h', spec([used, other]))
    sup.configure('/h', spec([used]))
    exit(children[1]!, null, 'SIGTERM')
    const old = putBundle('export const jobs = { old: 1 }\n')
    const fresh = putBundle('export const jobs = { fresh: 1 }\n')
    const tmp = `${old.file}.123.tmp`
    fs.writeFileSync(tmp, 'partial')
    ago(old.file, 25 * 60 * 60_000)
    ago(tmp, 25 * 60 * 60_000)
    ago(fresh.file, 60 * 60_000)
    ago(used.bundle.file, 30 * 24 * 60 * 60_000)
    const goneDir = spawned[1]!.cwd
    for (const f of fs.readdirSync(goneDir)) ago(path.join(goneDir, f), 6 * 24 * 60 * 60_000)
    ago(goneDir, 6 * 24 * 60 * 60_000)
    sup.prune()
    expect(fs.existsSync(old.file)).toBe(false)
    expect(fs.existsSync(tmp)).toBe(false)
    expect(fs.existsSync(fresh.file)).toBe(true)
    expect(fs.existsSync(used.bundle.file)).toBe(true)
    expect(fs.existsSync(goneDir)).toBe(true)
    for (const f of fs.readdirSync(goneDir)) ago(path.join(goneDir, f), 8 * 24 * 60 * 60_000)
    ago(goneDir, 8 * 24 * 60 * 60_000)
    sup.prune()
    expect(fs.existsSync(goneDir)).toBe(false)
    expect(fs.existsSync(spawned[0]!.cwd)).toBe(true)
  })
})

describe('a new daemon', () => {
  it('adopts a job that still runs, never starting a second one, and signals no stranger', () => {
    let sup = createPluginJobSupervisor(deps())
    sup.configure('/h', spec([job()]))
    // The daemon goes; its job lives on.
    sup = createPluginJobSupervisor(deps())
    timers = []
    sup.boot()
    expect(spawned).toHaveLength(1)
    expect(sup.status('/h').jobs[0]).toMatchObject({ state: 'running', pid: 1000 })
    // The adopted run ends (no exit event: it is not our child): the poll sees it, and it is started again.
    procs.delete(1000)
    advance(5_000)
    expect(sup.status('/h').jobs[0]).toMatchObject({ state: 'retrying', lastError: 'is no longer running' })
    advance(5_000)
    expect(spawned).toHaveLength(2)
    // The pid is reused by another process before the next daemon: it is not adopted or signalled.
    sup = createPluginJobSupervisor(deps())
    timers = []
    procs.set(1001, 'someone-else')
    sup.boot()
    expect(spawned).toHaveLength(3)
    sup.configure('/h', spec([]))
    expect(signals.find((s) => s.pid === 1001)).toBeUndefined()
  })
})

describe('status and logs', () => {
  it('reads the metrics the job wrote, and the newest log lines', () => {
    const sup = createPluginJobSupervisor(deps())
    sup.configure('/h', spec([job()]))
    const run = spawned[0]!.cwd
    fs.writeFileSync(path.join(run, 'metrics.json'), JSON.stringify({ v: 1, at: 123, values: { processed: 7, bad: 'x' } }))
    fs.writeFileSync(path.join(run, 'job.log'), Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n') + '\n')
    expect(sup.status('/h').jobs[0]).toMatchObject({ metrics: { processed: 7 }, metricsAt: 123 })
    const r = sup.logs('/h', 'acme-jobs', 'worker', 3)
    expect(r.lines).toEqual(['line 297', 'line 298', 'line 299'])
    expect(sup.logs('/h', 'acme-jobs', 'worker', 'junk').lines).toHaveLength(200)
    expect(() => sup.logs('/h', 'acme-jobs', 'nope', 3)).toThrow(/no such job/)
  })

  it('caps a running job\'s log by copying it aside and emptying it in place', () => {
    const sup = createPluginJobSupervisor(deps({ maxLogBytes: 1_000 }))
    sup.configure('/h', spec([job()]))
    const log = path.join(spawned[0]!.cwd, 'job.log')
    fs.writeFileSync(log, 'x'.repeat(1_500))
    advance(5_000)
    expect(fs.statSync(log).size).toBe(0)
    expect(fs.statSync(`${log}.1`).size).toBe(1_500)
  })
})
