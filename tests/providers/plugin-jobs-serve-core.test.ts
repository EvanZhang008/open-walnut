/**
 * `jobs.http` in the daemon's supervisor (plugin-jobs-core.ts): a serving job's run gets
 * a socket of its own, and a request reaches the LIVE run of that plugin's serving job
 * for the Walnut that asked, never another's. Fake processes and clock as in
 * plugin-jobs-core.test.ts; each run's routes are served on a REAL socket by the real
 * door (plugin-job-door.ts), standing in for the job process. Real processes, both
 * twins: tests/integration/plugin-jobs-serve-twins.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createPluginJobSupervisor, type PluginJobDeps, type PluginJobSpec, type PluginJobsSpec } from '../../src/providers/plugin-jobs-core.js'
import { createPluginJobDoor } from '../../src/providers/plugin-job-door.js'

class FakeChild extends EventEmitter {
  constructor(public pid: number | undefined) { super() }
  unref(): void { /* nothing */ }
}

const door = createPluginJobDoor({
  fs, net,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
})

let base = ''
let dir = ''
let now = 0
let timers: Array<{ at: number; fn: () => void; id: number }> = []
let nextTimer = 1
let nextPid = 1000
let children: FakeChild[] = []
let spawned: Array<{ env: Record<string, string>; pid: number }> = []
let procs = new Map<number, string>()
let served: Array<{ close(): void }> = []
let forwardTimeoutMs: number | undefined

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
    spawn: (_command, _args, opts) => {
      const child = new FakeChild(nextPid++)
      procs.set(child.pid!, `st-${child.pid}`)
      children.push(child)
      spawned.push({ env: opts.env, pid: child.pid! })
      return child
    },
    dir,
    keyOf: (home) => crypto.createHash('sha1').update(home).digest('hex').slice(0, 16),
    now: () => now,
    setTimer: (fn, ms) => { const id = nextTimer++; timers.push({ at: now + ms, fn, id }); return id },
    clearTimer: (t) => { timers = timers.filter((x) => x.id !== t) },
    log: () => {},
    startTimeOf: (pid) => procs.get(pid) ?? null,
    alive: (pid) => procs.has(pid),
    randomToken: () => crypto.randomBytes(32).toString('hex'),
    killGroup: () => {},
    program: () => ({ command: '/opt/walnut-core', args: ['walnut', 'plugin-job'] }),
    baseEnv: () => ({ HOME: '/home/u' }),
    gatewaySocket: () => '/tmp/d/agent-gateway.sock',
    sha256File: (file) => { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') } catch { return null } },
    door: { ...door, forward: (sock, request) => door.forward(sock, request, forwardTimeoutMs) },
    ...over,
  }
}

function putBundle(text = 'export const jobs = {}\n'): { sha256: string; file: string } {
  const sha256 = crypto.createHash('sha256').update(text).digest('hex')
  const file = path.join(dir, 'bundles', `${sha256}.mjs`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return { sha256, file }
}

function job(over: Partial<PluginJobSpec> = {}): PluginJobSpec {
  return { plugin: 'acme', version: '1.0.0', job: 'worker', kind: 'long-running', bundle: putBundle(), config: {}, host: '__local__', serves: true, ...over }
}

function spec(home: string, jobs: PluginJobSpec[]): PluginJobsSpec {
  return { v: 1, home, walnutId: 'w1', jobs }
}

/** What the run's env tells it (WALNUT_PLUGIN_JOB). */
function infoOf(i: number): Record<string, any> { return JSON.parse(spawned[i]!.env.WALNUT_PLUGIN_JOB!) }

/** The job process of spawn `i`: its routes on the socket the daemon named, answering `who`. */
async function runRoutes(i: number, who: string, extra?: (s: ReturnType<typeof door.serve>) => void): Promise<void> {
  const sock = infoOf(i).serveSocket as string
  let up = false
  const s = door.serve(sock, { prefix: '/api/plugins/acme', log: (_l, msg) => { if (msg === 'serving routes') up = true } })
  s.route('GET', '/who', () => ({ json: { who } }))
  extra?.(s)
  served.push(s)
  for (let n = 0; n < 200 && !up; n++) await new Promise((r) => setTimeout(r, 5))
}

function get(p: string, body?: string) {
  const b = Buffer.from(body ?? '')
  return { plugin: 'acme', method: body === undefined ? 'GET' : 'POST', path: p, headers: {}, size: b.byteLength, data: b.toString('base64') }
}

/** A socket file with nobody behind it: a process that listened on it and was killed. */
async function staleSocket(file: string): Promise<void> {
  const p = spawn(process.execPath, ['-e', 'require("node:net").createServer().listen(process.argv[process.argv.length - 1])', file], { stdio: 'ignore' })
  try {
    for (let n = 0; n < 400 && !fs.existsSync(file); n++) await new Promise((r) => setTimeout(r, 10))
  } finally {
    if (p.pid && p.pid > 1) p.kill('SIGKILL')
  }
  await new Promise<void>((r) => p.once('exit', () => r()))
}

function answerOf(r: Record<string, unknown>): unknown { return JSON.parse(Buffer.from(String(r.data), 'base64').toString('utf8')) }

beforeEach(() => {
  // Short: the run dir's socket path fits, as it does on a real daemon dir.
  base = fs.mkdtempSync('/tmp/pjs-')
  dir = path.join(base, 'd')
  fs.mkdirSync(dir, { mode: 0o700 })
  now = Date.now()
  timers = []
  nextTimer = 1
  nextPid = 1000
  children = []
  spawned = []
  procs = new Map()
  forwardTimeoutMs = undefined
})

afterEach(() => {
  for (const s of served.splice(0)) s.close()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('jobs.http', () => {
  it('reaches the live run of the serving job of the Walnut that asks, and never another Walnut\'s', async () => {
    const sup = createPluginJobSupervisor(deps())
    sup.configure('/home-a', spec('/home-a', [job()]))
    sup.configure('/home-b', spec('/home-b', [job()]))
    await runRoutes(0, 'a')
    await runRoutes(1, 'b')
    expect(infoOf(0).serveSocket).not.toBe(infoOf(1).serveSocket)
    expect(answerOf(await sup.http('/home-a', get('/who')))).toEqual({ who: 'a' })
    expect(answerOf(await sup.http('/home-b', get('/who')))).toEqual({ who: 'b' })
    // A Walnut that placed no job here reaches nobody's.
    await expect(sup.http('/home-c', get('/who'))).rejects.toMatchObject({ code: 'not_serving', level: 'warn' })
    await expect(sup.http('/home-a', { ...get('/who'), plugin: 'other' })).rejects.toMatchObject({ code: 'not_serving' })
    // What our own leader should never send is an error.
    await expect(sup.http('/home-a', { ...get('/who'), plugin: '../acme' })).rejects.toMatchObject({ code: 'bad_request', level: 'error' })
  })

  it('puts the socket in the run dir (0700) and tells only the serving job; status says it serves', async () => {
    const sup = createPluginJobSupervisor(deps())
    const st = sup.configure('/h', spec('/h', [job(), job({ job: 'poller', serves: undefined })]))
    const byJob = Object.fromEntries(spawned.map((s, i) => [infoOf(i).job, infoOf(i)]))
    expect(path.dirname(byJob.worker.serveSocket)).toBe(byJob.worker.stateDir)
    expect(path.basename(byJob.worker.serveSocket)).toMatch(/^[0-9a-f]{16}\.sock$/)
    expect('serveSocket' in byJob.poller).toBe(false)
    expect(fs.statSync(path.dirname(byJob.worker.serveSocket)).mode & 0o777).toBe(0o700)
    expect(st.jobs.find((j) => j.job === 'worker')?.serves).toBe(true)
    expect('serves' in st.jobs.find((j) => j.job === 'poller')!).toBe(false)
  })

  it('a run dir too deep for a socket path gets a short path of its own, recorded for the daemon that adopts it', async () => {
    const long = 'acme-' + 'x'.repeat(90)
    const sup = createPluginJobSupervisor(deps())
    sup.configure('/h', spec('/h', [job({ plugin: long })]))
    const sock = infoOf(0).serveSocket as string
    expect(path.dirname(sock)).toBe(path.join(dir, 'sockets'))
    expect(path.basename(sock)).toMatch(/^[0-9a-f]{16}\.sock$/)
    expect(Buffer.byteLength(sock)).toBeLessThanOrEqual(100)
    expect(fs.statSync(path.dirname(sock)).mode & 0o777).toBe(0o700)
    const state = fs.readdirSync(dir).find((f) => f.endsWith('.state.json'))!
    expect(JSON.parse(fs.readFileSync(path.join(dir, state), 'utf8')).jobs[`${long}/worker`].sock).toBe(sock)
    let up = false
    const s = door.serve(sock, { prefix: '/x', log: (_l, msg) => { if (msg === 'serving routes') up = true } })
    s.route('GET', '/who', () => ({ json: { who: 'first daemon' } }))
    served.push(s)
    for (let n = 0; n < 200 && !up; n++) await new Promise((r) => setTimeout(r, 5))
    // A new daemon (an upgrade) adopts the run and finds its socket.
    const again = createPluginJobSupervisor(deps())
    again.boot()
    expect(spawned).toHaveLength(1)
    expect(answerOf(await again.http('/h', { ...get('/who'), plugin: long }))).toEqual({ who: 'first daemon' })
  })

  it('a job that is not running says why; one running with no route yet is not_ready', async () => {
    const sup = createPluginJobSupervisor(deps())
    sup.configure('/h', spec('/h', [job()]))
    // Refusals a page polling a restarting job meets are logged as info, not as errors.
    await expect(sup.http('/h', get('/who'))).rejects.toMatchObject({ code: 'not_ready', level: 'info' })
    // It crashes: it is started again after 5 s, and says so meanwhile.
    procs.delete(children[0]!.pid!)
    children[0]!.emit('exit', 1, null)
    await expect(sup.http('/h', get('/who'))).rejects.toMatchObject({ code: 'not_running', message: 'the job "worker" is not running: it stopped (exited with code 1) and starts again in 5 s', retryAfterS: 5, level: 'info' })
    advance(5_000)
    expect(spawned).toHaveLength(2)
    await runRoutes(1, 'second run')
    expect(answerOf(await sup.http('/h', get('/who')))).toEqual({ who: 'second run' })
  })

  it('a plugin whose jobs do not serve, or a daemon without the door, takes no request', async () => {
    const plain = createPluginJobSupervisor(deps())
    plain.configure('/h', spec('/h', [job({ serves: undefined })]))
    await expect(plain.http('/h', get('/who'))).rejects.toMatchObject({ code: 'not_serving' })
    const noDoor = createPluginJobSupervisor(deps({ door: undefined }))
    const st = noDoor.configure('/h', spec('/h', [job()]))
    // A serving job is not started where nothing could reach its routes.
    expect(spawned).toHaveLength(1)
    expect(st.jobs[0]).toMatchObject({ state: 'refused', lastError: expect.stringMatching(/cannot serve a job's routes/) })
    await expect(noDoor.http('/h', get('/who'))).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('bounds what it forwards: a body past 256 KB, a job past its time, more than 8 at once', async () => {
    const sup = createPluginJobSupervisor(deps())
    sup.configure('/h', spec('/h', [job()]))
    const hold: Array<() => void> = []
    await runRoutes(0, 'a', (s) => {
      s.route('GET', '/slow', () => new Promise((resolve) => { hold.push(() => resolve({ json: { slow: true } })) }))
    })
    const big = Buffer.alloc(256 * 1024 + 1)
    await expect(sup.http('/h', { plugin: 'acme', method: 'POST', path: '/who', headers: {}, size: big.byteLength, data: big.toString('base64') })).rejects.toMatchObject({ code: 'request_too_large', level: 'warn' })
    forwardTimeoutMs = 150
    await expect(sup.http('/h', get('/slow'))).rejects.toMatchObject({ code: 'timeout', level: 'warn' })
    forwardTimeoutMs = 5_000
    const eight = Array.from({ length: 8 }, () => sup.http('/h', get('/slow')))
    for (let n = 0; n < 200 && hold.length < 9; n++) await new Promise((r) => setTimeout(r, 5))
    await expect(sup.http('/h', get('/who'))).rejects.toMatchObject({ code: 'busy', level: 'warn' })
    for (const release of hold.splice(0)) release()
    for (const r of await Promise.all(eight)) expect(answerOf(r)).toEqual({ slow: true })
    // The count went back down.
    expect(answerOf(await sup.http('/h', get('/who')))).toEqual({ who: 'a' })
  })

  it('an answer that is not one is logged as an error', async () => {
    const sup = createPluginJobSupervisor(deps({ door: { ...door, forward: async () => { throw Object.assign(new Error('the job answered with something that is not JSON'), { code: 'bad_answer' }) } } }))
    sup.configure('/h', spec('/h', [job()]))
    await expect(sup.http('/h', get('/who'))).rejects.toMatchObject({ code: 'bad_answer', level: 'error' })
  })

  it('refuses serves on an every job and a second serving job of one plugin; serving changes start a new run, nothing else does', async () => {
    const sup = createPluginJobSupervisor(deps())
    expect(() => sup.configure('/h', spec('/h', [job({ kind: 'every', everyMs: 60_000 })]))).toThrow(/only a long-running job serves routes/)
    expect(() => sup.configure('/h', spec('/h', [job(), job({ job: 'other' })]))).toThrow(/acme has two jobs that serve routes/)
    expect(() => sup.configure('/h', spec('/h', [job({ serves: 'yes' as unknown as true })]))).toThrow(/serves must be true or false/)
    const plain = job({ serves: undefined })
    sup.configure('/h', spec('/h', [plain]))
    sup.configure('/h', spec('/h', [{ ...plain }]))
    expect(spawned).toHaveLength(1)
    // It serves now: the old run stops first, and the new one has a socket.
    sup.configure('/h', spec('/h', [{ ...plain, serves: true }]))
    procs.delete(children[0]!.pid!)
    children[0]!.emit('exit', 0, 'SIGTERM')
    expect(spawned).toHaveLength(2)
    expect(infoOf(1).serveSocket).toMatch(/\/[0-9a-f]{16}\.sock$/)
  })

  it('removes a socket no run holds once it is a day old, in the short dir and a live run\'s dir, and a run\'s own at its exit', async () => {
    const sup = createPluginJobSupervisor(deps())
    sup.configure('/h', spec('/h', [job({ plugin: 'acme-' + 'x'.repeat(90) }), job({ plugin: 'acme-near' })]))
    const live = infoOf(0).serveSocket as string
    const orphan = path.join(dir, 'sockets', 'abcdefabcdef0123.sock')
    // A run of acme-near before this one, killed with its daemon: its socket is in the run dir.
    const nearDir = path.dirname(infoOf(1).serveSocket as string)
    const earlier = path.join(nearDir, '0123456789abcdef.sock')
    // Socket files as runs killed while they listened leave them.
    await staleSocket(live)
    await staleSocket(orphan)
    await staleSocket(earlier)
    const old = new Date(Date.now() - 2 * 24 * 60 * 60_000)
    for (const f of [orphan, live, earlier]) fs.utimesSync(f, old, old)
    sup.prune()
    expect(fs.existsSync(orphan)).toBe(false)
    expect(fs.existsSync(earlier)).toBe(false)
    expect(fs.existsSync(live)).toBe(true)
    procs.delete(children[0]!.pid!)
    children[0]!.emit('exit', 1, null)
    expect(fs.existsSync(live)).toBe(false)
  })
})
