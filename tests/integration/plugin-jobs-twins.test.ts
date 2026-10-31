/**
 * Plugin jobs on REAL daemon processes, both twins (plugin-jobs-core.ts,
 * plugin-job-harness.ts): the leader sends the set, the daemon runs each job as
 * its own `walnut plugin-job` process, restarts a crash, runs an every job on its
 * period, carries a job's `walnut.ops.call` through its agent gateway to the
 * server of the Walnut that runs the job (never another client), keeps a job
 * running across its own restart (adoption), starts a changed job only after its
 * old run has exited, and stops what the leader leaves out.
 *
 *   test (leader WS) ══jobs.configure══► daemon (source twin, standalone on bun)
 *                    ◄═gateway-request══   │ spawns <its program> walnut plugin-job <bundle> <job>
 *   test (stranger)  never asked           ▼
 *                                    job process ══agent gateway socket══► daemon
 *
 * Hygiene: every dir is a temp dir; daemons and job processes are ours and are
 * stopped by pid at the end.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { testBun } from '../helpers/bun-runtime.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const HOME = '/fixture/walnut-home'
const WALNUT = 'wprimaryjobs01'
const BUN: string | undefined = testBun()

/** The plugin's job code, as the Mac bundles it: one ES module with a `jobs` export. */
const BUNDLE = `
import fs from 'node:fs'
const log = (o) => fs.appendFileSync(process.env.JOB_OUT, JSON.stringify(Object.assign({ t: Date.now(), pid: process.pid }, o)) + '\\n')
export const jobs = {
  worker: async (walnut, signal) => {
    log({ ev: 'worker-start', config: walnut.config, host: walnut.host, plugin: walnut.plugin, job: walnut.job, sock: process.env.WALNUT_AGENT_SOCKET, sid: JSON.parse(process.env.WALNUT_PLUGIN_JOB).sid, cwd: process.cwd(), leaked: Object.keys(process.env).filter((k) => k.startsWith('WALNUT_') && k !== 'WALNUT_AGENT_SOCKET' && k !== 'WALNUT_PLUGIN_JOB') })
    walnut.metrics.inc('starts')
    walnut.log.info('worker up', { n: 1 })
    try { log({ ev: 'op', r: await walnut.ops.call('task_list', { limit: 1 }) }) } catch (e) { log({ ev: 'op-error', code: e.code, message: e.message }) }
    if (!fs.existsSync(process.env.JOB_OUT + '.crashed')) {
      fs.writeFileSync(process.env.JOB_OUT + '.crashed', '1')
      throw new Error('the first run crashes')
    }
    if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve))
    log({ ev: 'worker-aborted' })
  },
  poll: async (walnut) => { log({ ev: 'poll', every: walnut.job.everyMs }) },
}
`

interface Daemon { proc: ChildProcess; dir: string; port: number; pid: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms: number, label: string): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for ' + label)
    await sleep(50)
  }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

let base = ''
const started: number[] = []

async function spawnDaemon(dir: string, twin: 'source' | 'standalone', out: string): Promise<Daemon> {
  fs.mkdirSync(dir, { recursive: true })
  for (const f of ['daemon.port', 'daemon.pid']) { try { fs.unlinkSync(path.join(dir, f)) } catch { /* none */ } }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALNUT_DAEMON_DIR: dir,
    WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_PLUGIN_JOB_MIN_EVERY_MS: '3000',
    JOB_OUT: out,
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  let proc: ChildProcess
  if (twin === 'source') {
    const script = path.join(dir, 'daemon.cjs')
    fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
    proc = spawn(SOURCE_TWIN.file, [script, '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  } else {
    proc = spawn(BUN!, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'], cwd: ROOT })
  }
  if (process.env.DEBUG_DAEMON) proc.stderr?.on('data', (b) => process.stderr.write(`[${twin}] ` + b.toString()))
  const portFile = path.join(dir, 'daemon.port')
  await waitFor(() => fs.existsSync(portFile) && fs.existsSync(path.join(dir, 'daemon.pid')), 60_000, `${twin} daemon`)
  const pid = parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10)
  started.push(pid)
  return { proc, dir, port: parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10), pid }
}

async function stopDaemon(d: Daemon): Promise<void> {
  try { process.kill(d.pid, 'SIGTERM') } catch { /* gone */ }
  await waitFor(() => !alive(d.pid), 20_000, 'daemon exit')
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
    const t = setTimeout(() => { ws.off('message', on); reject(new Error(`cmd ${body.cmd} timed out`)) }, 15_000)
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

/** A server end: answers every gateway request with what it was asked, and who it is. */
function hubAnswers(ws: WebSocket, who: string, asked: string[] = []): string[] {
  ws.on('message', (data) => {
    let m: Record<string, any>
    try { m = JSON.parse(String(data)) } catch { return }
    if (m.ev !== 'gateway-request') return
    asked.push(String(m.payload?.name))
    ws.send(JSON.stringify({ id: cmdId++, cmd: 'gateway-result', relayId: m.relayId, result: { echo: m.payload?.name, args: m.payload?.args, callerSid: m.callerSid, who } }))
  })
  return asked
}

/** One request on the daemon's agent gateway socket, as a job (or anyone on this machine) sends it. */
function gatewayCall(sock: string, sid: string, name: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock)
    let buf = ''
    c.on('connect', () => c.write(JSON.stringify({ v: 1, op: 'tools.call', sid, args: { name, args: {} } }) + '\n'))
    c.on('data', (d) => { buf += d.toString(); if (buf.includes('\n')) { c.destroy(); resolve(JSON.parse(buf.slice(0, buf.indexOf('\n')))) } })
    c.on('error', reject)
  })
}

beforeAll(() => {
  // Short: a unix socket path has a length limit.
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-'))
})

afterAll(() => {
  for (const file of fs.existsSync(base) ? fs.readdirSync(base).filter((n) => n.endsWith('.jsonl')) : []) {
    for (const e of events(path.join(base, file))) {
      if (typeof e.pid === 'number' && e.pid > 1 && alive(e.pid)) { try { process.kill(e.pid, 'SIGKILL') } catch { /* gone */ } }
    }
  }
  for (const pid of started) { if (pid > 1) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } } }
  try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* best effort */ }
})

for (const twin of ['source', 'standalone'] as const) {
  describe.skipIf(twin === 'standalone' && !BUN)(`${twin} twin: plugin jobs`, () => {
    it('runs, restarts a crash, runs every N, relays ops, adopts across a daemon restart, stops on removal', async () => {
      const dir = path.join(base, twin.slice(0, 2))
      const out = path.join(base, `${twin}.jsonl`)
      let d = await spawnDaemon(dir, twin, out)
      let leader = await connectWs(d.port)
      hubAnswers(leader, 'leader')
      // A server client that never names a Walnut (an older server, a test one): never a job's hub.
      const stranger = await connectWs(d.port)
      const strangerAsked = hubAnswers(stranger, 'stranger')
      const beat = setInterval(() => {
        for (const ws of [leader, stranger]) { try { ws.send(JSON.stringify({ id: 0, cmd: 'ping' })) } catch { /* closed */ } }
      }, 500)

      // The bundle where the leader puts it: <daemon's jobs dir>/bundles/<sha>.mjs.
      const sha256 = crypto.createHash('sha256').update(BUNDLE).digest('hex')
      const file = path.join(dir, 'plugin-jobs', 'bundles', `${sha256}.mjs`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, BUNDLE)
      const jobs = [
        { plugin: 'acme-jobs', version: '1.2.0', job: 'worker', kind: 'long-running', bundle: { sha256, file }, config: { queue: 'q1' }, host: 'devbox' },
        { plugin: 'acme-jobs', version: '1.2.0', job: 'poll', kind: 'every', everyMs: 3000, bundle: { sha256, file }, config: {}, host: 'devbox' },
      ]
      const spec = { v: 1, home: HOME, walnutId: WALNUT, jobs }

      // Only the leader of this Walnut may say what runs.
      expect((await cmd(stranger, { cmd: 'jobs.configure', home: HOME, spec })).error).toMatch(/send leader\.configure for this Walnut first/)
      expect((await cmd(leader, { cmd: 'leader.configure', home: HOME, walnutId: WALNUT, backup: false })).ok).toBe(true)
      expect((await cmd(leader, { cmd: 'jobs.configure', home: HOME, spec: { ...spec, walnutId: 'wsomeoneelse' } })).error).toMatch(/another Walnut/)
      const status0 = await cmd(leader, { cmd: 'jobs.status', home: HOME })
      expect(status0.bundles).toBe(path.join(dir, 'plugin-jobs', 'bundles'))
      const first = await cmd(leader, { cmd: 'jobs.configure', home: HOME, spec })
      expect(first.ok).toBe(true)
      expect(first.jobs.map((j: any) => `${j.job}:${j.state}`).sort()).toEqual(['poll:idle', 'worker:running'])

      // The first run crashes; the daemon starts it again after 5 s.
      await waitFor(() => events(out).filter((e) => e.ev === 'worker-start').length >= 2, 30_000, 'the worker to start again')
      const ev = events(out)
      const starts = ev.filter((e) => e.ev === 'worker-start')
      expect(starts[1]!.t - starts[0]!.t).toBeGreaterThanOrEqual(4_500)
      expect(starts[0]).toMatchObject({ config: { queue: 'q1' }, host: 'devbox', plugin: { id: 'acme-jobs', version: '1.2.0' }, job: { name: 'worker', kind: 'long-running' }, leaked: [] })
      expect(starts[0]!.sid).toMatch(/^plugin-job:[0-9a-f]{64}$/)
      expect(starts[1]!.sid).not.toBe(starts[0]!.sid)
      // walnut.ops.call went through the gateway to this Walnut's server, as an external caller,
      // and never to the client that names no Walnut.
      const op = ev.find((e) => e.ev === 'op')
      expect(op?.r).toEqual({ echo: 'task_list', args: { limit: 1 }, callerSid: 'external', who: 'leader' })
      expect(strangerAsked).toEqual([])
      // An id no run holds is refused on this machine, and so is a run's id once that run is over.
      const sock = starts[0]!.sock as string
      expect((await gatewayCall(sock, 'plugin-job:' + 'f'.repeat(64), 'task_list')).error?.code).toBe('unknown_caller')
      expect((await gatewayCall(sock, starts[0]!.sid, 'task_list')).error?.code).toBe('unknown_caller')
      expect((await gatewayCall(sock, starts[1]!.sid, 'task_list')).result).toMatchObject({ who: 'leader' })
      // The daemon says it looks after the run.
      const supervised = Number(fs.readFileSync(path.join(starts[0]!.cwd, 'supervised'), 'utf8'))
      expect(Date.now() - supervised).toBeLessThan(90_000)

      // The every job: soon after it is added, then every 3 s, never two at once (each run logs
      // after its process has started, which takes a varying few hundred ms).
      // Four logged: the third run has exited (a run is counted at its exit), since runs never overlap.
      await waitFor(() => events(out).filter((e) => e.ev === 'poll').length >= 4, 30_000, 'four polls')
      const polls = events(out).filter((e) => e.ev === 'poll')
      expect(polls[0]!.every).toBe(3000)
      for (let i = 1; i < polls.length; i++) expect(polls[i]!.t - polls[i - 1]!.t).toBeGreaterThanOrEqual(2_500)

      const st = await cmd(leader, { cmd: 'jobs.status', home: HOME })
      const worker = st.jobs.find((j: any) => j.job === 'worker')
      const poll = st.jobs.find((j: any) => j.job === 'poll')
      expect(worker).toMatchObject({ state: 'running', restarts: 1, failures: 1 })
      expect(worker.metrics.starts).toBeGreaterThanOrEqual(1)
      expect(poll.runs).toBeGreaterThanOrEqual(3)
      expect(poll.failures).toBe(0)
      const logs = await cmd(leader, { cmd: 'jobs.logs', home: HOME, plugin: 'acme-jobs', job: 'worker', lines: 50 })
      expect(logs.ok).toBe(true)
      const text = (logs.lines as string[]).join('\n')
      expect(text).toContain('run started')
      expect(text).toContain('worker up')
      expect(text).toContain('the first run crashes')
      const workerPid = worker.pid as number
      expect(alive(workerPid)).toBe(true)

      // A new daemon (an upgrade): the running worker is adopted, not started twice, and keeps its id.
      clearInterval(beat)
      leader.close(); stranger.close()
      await stopDaemon(d)
      expect(alive(workerPid)).toBe(true)
      const startsBefore = events(out).filter((e) => e.ev === 'worker-start').length
      d = await spawnDaemon(dir, twin, out)
      leader = await connectWs(d.port)
      hubAnswers(leader, 'leader')
      const beat2 = setInterval(() => { try { leader.send(JSON.stringify({ id: 0, cmd: 'ping' })) } catch { /* closed */ } }, 500)
      expect((await cmd(leader, { cmd: 'leader.configure', home: HOME, walnutId: WALNUT, backup: false })).ok).toBe(true)
      const after = await cmd(leader, { cmd: 'jobs.status', home: HOME })
      const adopted = after.jobs.find((j: any) => j.job === 'worker')
      expect(adopted).toMatchObject({ state: 'running', pid: workerPid })
      await sleep(1_500)
      expect(events(out).filter((e) => e.ev === 'worker-start').length).toBe(startsBefore)
      expect((await gatewayCall(sock, starts[1]!.sid, 'task_list')).result).toMatchObject({ who: 'leader' })

      // New settings for the adopted worker: the old run stops first, then the new one starts.
      const changed = jobs.map((j) => (j.job === 'worker' ? { ...j, config: { queue: 'q2' } } : j))
      expect((await cmd(leader, { cmd: 'jobs.configure', home: HOME, spec: { ...spec, jobs: changed } })).ok).toBe(true)
      await waitFor(() => events(out).some((e) => e.ev === 'worker-start' && e.config?.queue === 'q2'), 30_000, 'the changed worker')
      const ordered = events(out)
      const abortedAt = ordered.findIndex((e) => e.ev === 'worker-aborted' && e.pid === workerPid)
      const q2At = ordered.findIndex((e) => e.ev === 'worker-start' && e.config?.queue === 'q2')
      expect(abortedAt).toBeGreaterThan(-1)
      expect(q2At).toBeGreaterThan(abortedAt)
      expect(alive(workerPid)).toBe(false)
      const q2Pid = ordered[q2At]!.pid as number

      // The leader leaves the worker out: it is told to stop and does.
      const removed = await cmd(leader, { cmd: 'jobs.configure', home: HOME, spec: { ...spec, jobs: jobs.filter((j) => j.job !== 'worker') } })
      expect(removed.jobs.map((j: any) => j.job)).toEqual(['poll'])
      await waitFor(() => events(out).some((e) => e.ev === 'worker-aborted' && e.pid === q2Pid), 15_000, 'the worker to stop')
      await waitFor(() => !alive(q2Pid), 15_000, 'the worker process to exit')

      // A bundle that is not the one named never runs.
      const bad = await cmd(leader, { cmd: 'jobs.configure', home: HOME, spec: { ...spec, jobs: [{ ...jobs[0], bundle: { sha256: 'b'.repeat(64), file: path.join(dir, 'plugin-jobs', 'bundles', `${'b'.repeat(64)}.mjs`) } }] } })
      expect(bad.jobs[0]).toMatchObject({ state: 'refused' })

      // The empty set: nothing runs for this Walnut any more.
      const none = await cmd(leader, { cmd: 'jobs.configure', home: HOME, spec: { ...spec, jobs: [] } })
      expect(none.jobs).toEqual([])
      const pollsNow = events(out).filter((e) => e.ev === 'poll').length
      await sleep(4_000)
      expect(events(out).filter((e) => e.ev === 'poll').length).toBe(pollsNow)
      clearInterval(beat2)
      leader.close()
      await stopDaemon(d)
    }, 150_000)
  })
}
