/**
 * A plugin job that serves its plugin's routes, on a REAL daemon process (the standalone)
 * (plugin-jobs-core.ts http, plugin-job-door.ts, plugin-job-harness.ts): the leader
 * sends a serving job, the daemon runs it as its own `walnut plugin-job` process on a
 * socket of its run (0600, in a 0700 dir), and `jobs.http` carries a request to the job's
 * walnut.http.route handler and its answer back. Only the leader of the Walnut that
 * placed the job reaches it; a crashed run answers `not_running` until it is back, and
 * a page polling it meanwhile writes no error line in the daemon's log.
 *
 *   test (leader WS) ══jobs.configure / jobs.http══► daemon ══serve socket══► job process
 *   test (other Walnut's leader) ══jobs.http══► daemon: not_serving
 *
 * Hygiene: every dir is a temp dir (short: unix socket paths have a length limit);
 * at the end only processes proven ours are stopped: a daemon whose start time is the one
 * read when it came up, a job whose command line names this run's temp dir.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket } from 'ws'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { testBun } from '../helpers/bun-runtime.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const HOME = '/fixture/walnut-home'
const OTHER_HOME = '/fixture/other-walnut-home'
const WALNUT = 'wprimaryserve01'
const OTHER = 'wothersserve01'
const BUN: string | undefined = testBun()

/** The plugin's job code, as the Mac bundles it: a serving worker and a job that does not serve. */
const BUNDLE = `
import fs from 'node:fs'
const log = (o) => fs.appendFileSync(process.env.JOB_OUT, JSON.stringify(Object.assign({ t: Date.now(), pid: process.pid }, o)) + '\\n')
const queue = []
export const jobs = {
  worker: async (walnut, signal) => {
    const info = JSON.parse(process.env.WALNUT_PLUGIN_JOB)
    walnut.http.route('GET', '/queue', (r) => ({ json: { length: queue.length, pid: process.pid, path: r.path, query: r.query, origin: r.headers['x-walnut-origin'] ?? null, auth: r.headers.authorization ?? null } }))
    walnut.http.route('POST', '/queue', async (r) => { queue.push((await r.json()).item); return { status: 201, json: { length: queue.length } } })
    walnut.http.route('POST', '/crash', () => { setTimeout(() => process.exit(3), 50); return { status: 202 } })
    log({ ev: 'worker-start', sock: info.serveSocket })
    await new Promise((resolve) => signal.addEventListener('abort', resolve))
  },
  quiet: async (walnut, signal) => {
    try { walnut.http.route('GET', '/x', () => ({})) } catch (e) { log({ ev: 'quiet-refused', message: e.message }) }
    await new Promise((resolve) => signal.addEventListener('abort', resolve))
  },
}
`

interface Daemon { proc: ChildProcess; dir: string; port: number; pid: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting for ' + label)
    await sleep(100)
  }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
/** A process's start time and command line as `ps` reads them, or null when it is gone. */
function psOf(pid: number, field: 'lstart' | 'command'): string | null {
  try { return execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8' }).trim() || null } catch { return null }
}

let base = ''
/** Each daemon's pid with the start time read when it came up: a reused pid has another. */
const started: Array<{ pid: number; lstart: string | null }> = []

async function spawnDaemon(dir: string, out: string): Promise<Daemon> {
  fs.mkdirSync(dir, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALNUT_DAEMON_DIR: dir,
    WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    JOB_OUT: out,
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  const proc: ChildProcess = spawn(BUN!, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'], cwd: ROOT })
  if (process.env.DEBUG_DAEMON) proc.stderr?.on('data', (b) => process.stderr.write('[daemon] ' + b.toString()))
  const portFile = path.join(dir, 'daemon.port')
  await waitFor(() => fs.existsSync(portFile) && fs.existsSync(path.join(dir, 'daemon.pid')), 60_000, 'the daemon')
  const pid = parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10)
  started.push({ pid, lstart: psOf(pid, 'lstart') })
  return { proc, dir, port: parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10), pid }
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const t = setTimeout(() => reject(new Error('ws connect timeout')), 5000)
    ws.once('open', () => { clearTimeout(t); resolve(ws) })
    ws.once('error', (e) => { clearTimeout(t); reject(e) })
  })
}

let cmdId = 1
function cmd(ws: WebSocket, body: Record<string, unknown>): Promise<Record<string, any>> {
  const id = cmdId++
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', on); reject(new Error(`cmd ${body.cmd} timed out`)) }, 20_000)
    const on = (data: WebSocket.Data) => {
      try { const m = JSON.parse(data.toString()); if (m.id === id) { clearTimeout(t); ws.off('message', on); resolve(m) } } catch { /* not json */ }
    }
    ws.on('message', on)
    ws.send(JSON.stringify({ id, ...body }))
  })
}

function events(file: string): Array<Record<string, any>> {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
}

function http(ws: WebSocket, home: string, method: string, p: string, body = '', headers: Record<string, string> = {}) {
  const b = Buffer.from(body)
  return cmd(ws, { cmd: 'jobs.http', home, plugin: 'acme-door', method, path: p, headers, size: b.byteLength, data: b.toString('base64') })
}
const json = (r: Record<string, any>) => JSON.parse(Buffer.from(String(r.data), 'base64').toString('utf8'))
/** The daemon's log lines (daemon-<instance>.log), oldest first. */
function daemonLog(dir: string): Array<Record<string, any>> {
  const files = fs.readdirSync(dir).filter((n) => /^daemon-.+\.log$/.test(n)).sort()
  return files.flatMap((n) => fs.readFileSync(path.join(dir, n), 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)] } catch { return [] }
  }))
}

beforeAll(() => { base = fs.mkdtempSync('/tmp/pjs-') })

afterAll(() => {
  // A job run is ours while its command line names its bundle in this run's temp dir.
  for (const file of base && fs.existsSync(base) ? fs.readdirSync(base).filter((n) => n.endsWith('.jsonl')) : []) {
    for (const pid of new Set(events(path.join(base, file)).map((e) => e.pid))) {
      if (typeof pid === 'number' && pid > 1 && psOf(pid, 'command')?.includes(base)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
    }
  }
  for (const d of started) {
    if (d.pid > 1 && d.lstart && psOf(d.pid, 'lstart') === d.lstart) { try { process.kill(d.pid, 'SIGTERM') } catch { /* gone */ } }
  }
  if (base) { try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* best effort */ } }
})

describe.skipIf(!BUN)('standalone daemon: a plugin job serves routes', () => {
  it('jobs.http reaches the serving job of the leader\'s Walnut only, and says why while it is not running', async () => {
    const dir = path.join(base, 'd')
    const out = path.join(base, 'jobs.jsonl')
    const d = await spawnDaemon(dir, out)
    const leader = await connectWs(d.port)
    const other = await connectWs(d.port)
    const beat = setInterval(() => {
      for (const ws of [leader, other]) { try { ws.send(JSON.stringify({ id: 0, cmd: 'ping' })) } catch { /* closed */ } }
    }, 500)
    try {
      const sha256 = crypto.createHash('sha256').update(BUNDLE).digest('hex')
      const file = path.join(dir, 'plugin-jobs', 'bundles', `${sha256}.mjs`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, BUNDLE)
      const jobs = [
        { plugin: 'acme-door', version: '1.0.0', job: 'worker', kind: 'long-running', serves: true, bundle: { sha256, file }, config: {}, host: 'devbox' },
        { plugin: 'acme-door', version: '1.0.0', job: 'quiet', kind: 'long-running', bundle: { sha256, file }, config: {}, host: 'devbox' },
      ]
      // Nobody who has not said which Walnut it leads asks a job anything.
      expect((await http(leader, HOME, 'GET', '/queue')).error).toMatch(/send leader\.configure for this Walnut first/)
      expect((await cmd(leader, { cmd: 'leader.configure', home: HOME, walnutId: WALNUT, backup: false })).ok).toBe(true)
      expect((await cmd(other, { cmd: 'leader.configure', home: OTHER_HOME, walnutId: OTHER, backup: false })).ok).toBe(true)
      const configured = await cmd(leader, { cmd: 'jobs.configure', home: HOME, spec: { v: 1, home: HOME, walnutId: WALNUT, jobs } })
      expect(configured.ok).toBe(true)
      expect(configured.jobs.find((j: any) => j.job === 'worker')).toMatchObject({ serves: true, state: 'running' })

      await waitFor(async () => (await http(leader, HOME, 'GET', '/queue')).ok === true, 30_000, 'the job to serve')
      const sock = events(out).find((e) => e.ev === 'worker-start')!.sock as string
      expect(fs.statSync(sock).mode & 0o777).toBe(0o600)
      expect(fs.statSync(path.dirname(sock)).mode & 0o777).toBe(0o700)
      // The job that does not serve was told so when it tried.
      await waitFor(() => events(out).some((e) => e.ev === 'quiet-refused'), 15_000, 'the quiet job to try')
      expect(events(out).find((e) => e.ev === 'quiet-refused')!.message).toMatch(/does not serve routes/)

      const posted = await http(leader, HOME, 'POST', '/queue', JSON.stringify({ item: 'a' }), { 'content-type': 'application/json' })
      expect(posted).toMatchObject({ ok: true, status: 201 })
      expect(json(posted)).toEqual({ length: 1 })
      const got = await http(leader, HOME, 'GET', '/queue?limit=5', '', { 'x-walnut-origin': 'remote-http' })
      expect(got).toMatchObject({ ok: true, status: 200 })
      expect(got.headers['content-type']).toBe('application/json; charset=utf-8')
      const first = json(got)
      expect(first).toMatchObject({ length: 1, path: '/api/plugins/acme-door/queue?limit=5', query: { limit: '5' }, origin: 'remote-http', auth: null })
      expect((await http(leader, HOME, 'GET', '/nope')).status).toBe(404)

      // Another Walnut's leader on the same daemon reaches no job of this one.
      const foreign = await http(other, OTHER_HOME, 'GET', '/queue')
      expect(foreign).toMatchObject({ ok: false, errorKind: 'not_serving' })
      // Nor by naming this Walnut's home on its own socket.
      expect((await http(other, HOME, 'GET', '/queue')).error).toMatch(/send leader\.configure for this Walnut first/)

      // A request body past 256 KB (an upload to this machine) never reaches the job.
      const big = Buffer.alloc(256 * 1024 + 1)
      expect(await cmd(leader, { cmd: 'jobs.http', home: HOME, plugin: 'acme-door', method: 'POST', path: '/queue', headers: {}, size: big.byteLength, data: big.toString('base64') })).toMatchObject({ ok: false, errorKind: 'request_too_large' })

      // The job crashes: until its restart (5 s on) the leader hears why, then it serves again.
      const logBefore = daemonLog(dir).length
      expect((await http(leader, HOME, 'POST', '/crash')).status).toBe(202)
      await waitFor(() => !alive(first.pid), 10_000, 'the job to exit')
      const down = await http(leader, HOME, 'GET', '/queue')
      expect(down).toMatchObject({ ok: false })
      expect(['not_running', 'not_ready', 'no_answer']).toContain(down.errorKind)
      // A page polling it every 100 ms until it is back.
      await waitFor(async () => (await http(leader, HOME, 'GET', '/queue')).ok === true, 30_000, 'the restarted job to serve')
      const during = daemonLog(dir).slice(logBefore)
      expect(during.filter((l) => l.level === 'error')).toEqual([])
      expect(during.filter((l) => l.msg === 'command refused').map((l) => l.level)).toContain('info')
      const again = json(await http(leader, HOME, 'GET', '/queue'))
      expect(again.pid).not.toBe(first.pid)
      expect(again.length).toBe(0)

      // Left out of the set: stopped, and its socket is gone.
      const none = await cmd(leader, { cmd: 'jobs.configure', home: HOME, spec: { v: 1, home: HOME, walnutId: WALNUT, jobs: [] } })
      expect(none.jobs).toEqual([])
      await waitFor(() => !alive(again.pid), 20_000, 'the job to stop')
      await waitFor(() => !fs.existsSync(sock), 10_000, 'its socket to go')
      expect(await http(leader, HOME, 'GET', '/queue')).toMatchObject({ ok: false, errorKind: 'not_serving' })
    } finally {
      clearInterval(beat)
      leader.close(); other.close()
      try { process.kill(d.pid, 'SIGTERM') } catch { /* gone */ }
      await waitFor(() => !alive(d.pid), 20_000, 'daemon exit')
    }
  }, 150_000)
})
