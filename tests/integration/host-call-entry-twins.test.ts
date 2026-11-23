/**
 * The host call entry ('host-call-entry-v1') on REAL daemon processes, both twins:
 *
 *   test as the Mac ==trusted WS==> daemon     leader.configure, server.configure, jobs.configure;
 *                                               answers every relayed call as `mac`
 *   test as the host's Walnut server ==follower WS==> follower.hello {answersLocal, callSocket}
 *     and the entry itself (replica/host-call-entry.ts) on its real unix socket in the daemon dir,
 *     handing lines to the daemon with follower.gateway
 *   a real job run (the daemon's own `walnut plugin-job`): its first walnut.ops.call
 *
 * Proven: a run started after the follower said its socket gets WALNUT_CALL_SOCKET and its own
 * WALNUT_CALL_TOKEN beside the gateway socket; its call goes over HTTP on the entry socket, through
 * the daemon's gateway rules (a plugin job's call: to the server of its Walnut) and back, the same
 * answer a socket line gets; a token for another sid, or none, or of a run that ended, is refused
 * and runs nothing; a socket outside the daemon dir's entry dir (an old http address too) is never
 * given; once the follower's report says no socket (its experiment off), the next run gets none.
 * The daemon's own away answers are counted in follower.status and server.status.
 *
 * Hygiene: every dir is a temp dir (short: socket paths); each daemon is stopped by the pid it
 * wrote into its own dir, the fake host server and the job runs by the pids they logged.
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
import { createHostCallEntry, listenHostCallEntry, type HostCallListener } from '../../src/replica/host-call-entry.js'
import { hostCallSocketPath } from '../../src/providers/host-call-token-core.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { testBun } from '../helpers/bun-runtime.js'

const ROOT = path.resolve(__dirname, '../..')
const HOME = '/fixture/marina-home'
const WALNUT = 'wmarinahost02'
const BUN: string | undefined = testBun()

const FAKE_SERVER = `
const fs = require('fs')
fs.appendFileSync(process.env.FAKE_OUT, JSON.stringify({ pid: process.pid, token: process.env.WALNUT_FOLLOWER_TOKEN }) + '\\n')
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1 << 30)
`

/** The plugin's job: says its run id and what env it got, makes one call, says its answer, waits. */
const BUNDLE = `
import fs from 'node:fs'
const run = async (walnut, signal) => {
    const info = JSON.parse(process.env.WALNUT_PLUGIN_JOB)
    const out = (o) => fs.appendFileSync(process.env.JOB_OUT, JSON.stringify({ pid: process.pid, job: info.job, ...o }) + '\\n')
    out({ sid: info.sid, callSocket: process.env.WALNUT_CALL_SOCKET ?? null, callToken: process.env.WALNUT_CALL_TOKEN ?? null, socket: process.env.WALNUT_AGENT_SOCKET ?? null })
    try { out({ answer: await walnut.ops.call('task_list', { limit: 1 }) }) } catch (e) { out({ error: String(e && e.message), code: e && e.code }) }
    await new Promise((resolve) => signal.addEventListener('abort', resolve))
}
export const jobs = { worker: run, second: run, third: run }
`

type Twin = 'source' | 'standalone'
interface Daemon { proc: ChildProcess; dir: string; port: number; pid: number; sock: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms: number, label: string): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for ' + label)
    await sleep(50)
  }
}
/** Asks again until the answer is the one awaited or `ms` ran out; the last answer either way. */
async function askUntil<T>(ask: () => Promise<T>, done: (answer: T) => boolean, ms: number): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const answer = await ask()
    if (done(answer) || Date.now() > end) return answer
    await sleep(100)
  }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
function lines(file: string): Array<Record<string, any>> {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
}

let base = ''
const started: number[] = []
const listeners: HostCallListener[] = []

async function spawnDaemon(name: string, twin: Twin, jobOut: string): Promise<Daemon> {
  const dir = path.join(base, name)
  fs.mkdirSync(dir, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALNUT_DAEMON_DIR: dir,
    WALNUT_JOURNAL_DIR: path.join(base, name + '-j'),
    WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_GATEWAY_TIMEOUT_MS: '20000',
    JOB_OUT: jobOut,
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  delete env.WALNUT_DAEMON_STATE_DIR
  delete env.OPEN_WALNUT_API_URL; delete env.WALNUT_AGENT_SOCKET; delete env.WALNUT_SESSION_ID
  delete env.WALNUT_CALL_SOCKET; delete env.WALNUT_CALL_TOKEN
  const stderr = process.env.DEBUG_DAEMON ? 'pipe' : 'ignore'
  let proc: ChildProcess
  if (twin === 'standalone') {
    proc = spawn(BUN!, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start'], { env, stdio: ['ignore', 'ignore', stderr], cwd: ROOT })
  } else {
    const script = path.join(dir, 'daemon.cjs')
    fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
    proc = spawn(SOURCE_TWIN.file, [script, '--start'], { env, stdio: ['ignore', 'ignore', stderr] })
  }
  if (process.env.DEBUG_DAEMON) proc.stderr?.on('data', (b) => process.stderr.write(`[${twin}] ` + b.toString()))
  const sock = path.join(dir, 'agent-gateway.sock')
  await waitFor(() => fs.existsSync(path.join(dir, 'daemon.port')) && fs.existsSync(sock) && fs.existsSync(path.join(dir, 'daemon.pid')), 60_000, `${twin} daemon`)
  const pid = parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10)
  started.push(pid)
  return { proc, dir, sock, pid, port: parseInt(fs.readFileSync(path.join(dir, 'daemon.port'), 'utf8').trim(), 10) }
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
function cmd(ws: WebSocket, body: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, any>> {
  const id = cmdId++
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', on); reject(new Error(`cmd ${body.cmd} timed out`)) }, timeoutMs)
    const on = (data: WebSocket.Data) => {
      try { const m = JSON.parse(data.toString()); if (m.id === id) { clearTimeout(t); ws.off('message', on); resolve(m) } } catch { /* not json */ }
    }
    ws.on('message', on)
    ws.send(JSON.stringify({ id, ...body }))
  })
}

/**
 * A follower's report, taken: it is never answered, and both twins handle one socket's frames in
 * order and at once, so an answered command sent after it comes back once the report was taken.
 */
async function report(ws: WebSocket, body: Record<string, unknown>): Promise<void> {
  ws.send(JSON.stringify({ cmd: 'follower.report', report: body }))
  await cmd(ws, { cmd: 'follower.status' })
}

function answersAs(ws: WebSocket, who: string): Array<Record<string, any>> {
  const asked: Array<Record<string, any>> = []
  ws.on('message', (data) => {
    let m: Record<string, any>
    try { m = JSON.parse(String(data)) } catch { return }
    if (m.ev !== 'gateway-request') return
    asked.push(m)
    ws.send(JSON.stringify({ id: cmdId++, cmd: 'gateway-result', relayId: m.relayId, result: { who, op: m.payload?.name } }))
  })
  return asked
}

function socketCall(sock: string, sid: string, name: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock)
    let buf = ''
    c.on('connect', () => c.write(JSON.stringify({ v: 1, op: 'tools.call', sid, args: { name, args: {} } }) + '\n'))
    c.on('data', (d) => { buf += d.toString(); if (buf.includes('\n')) { c.destroy(); resolve(JSON.parse(buf.slice(0, buf.indexOf('\n')))) } })
    c.on('error', reject)
  })
}

interface Rig { d: Daemon; mac: WebSocket; follower: WebSocket; macAsked: Array<Record<string, any>>; entryLines: Array<Record<string, any>>; callSocket: string; jobOut: string; startJob: (job: string) => Promise<Record<string, any>>; stopJobs: () => Promise<void> }

async function rig(twin: Twin, name: string): Promise<Rig> {
  const jobOut = path.join(base, `${name}-job.jsonl`)
  const d = await spawnDaemon(name, twin, jobOut)
  const mac = await connectWs(d.port)
  const macAsked = answersAs(mac, 'mac')
  expect((await cmd(mac, { cmd: 'leader.configure', home: HOME, walnutId: WALNUT, backup: false })).ok).toBe(true)
  const fakeOut = path.join(base, `${name}-fake.jsonl`)
  const entryFile = path.join(base, `${name}-server.cjs`)
  fs.writeFileSync(entryFile, FAKE_SERVER)
  const spec = { v: 1, home: HOME, walnutId: WALNUT, command: process.execPath, args: [entryFile], cwd: base, env: { FAKE_OUT: fakeOut }, log: path.join(base, `${name}-server.log`), port: 41_238, settings: { expose: { enabled: false } } }
  expect((await cmd(mac, { cmd: 'server.configure', home: HOME, spec })).ok).toBe(true)
  await waitFor(() => lines(fakeOut).length > 0, 30_000, 'the host server token')
  const follower = await connectWs(d.port)
  // The entry, as the follower serves it, handing each line to this daemon.
  const caps = ((await cmd(follower, { cmd: 'hello' })).capabilities ?? []) as string[]
  const entryLines: Array<Record<string, any>> = []
  const entry = createHostCallEntry({
    request: (c, params, timeoutMs) => { entryLines.push(params.request as Record<string, any>); return cmd(follower, { cmd: c, ...params }, timeoutMs) },
    capabilities: () => caps,
    linked: () => true,
    enabled: () => true,
    log: () => {},
  })
  const listener = await listenHostCallEntry(entry, { socketPath: hostCallSocketPath(path, crypto, d.dir, WALNUT), uid: process.getuid?.() ?? null, log: () => {} })
  expect(listener).not.toBeNull()
  listeners.push(listener!)
  const callSocket = listener!.socketPath
  let hello: Record<string, any> = {}
  for (let attempt = 0; attempt < 40 && hello.ok !== true; attempt++) {
    hello = await cmd(follower, { cmd: 'follower.hello', walnutId: WALNUT, home: HOME, token: lines(fakeOut).at(-1)!.token, answersLocal: true, callSocket })
    if (hello.ok !== true) await sleep(250)
  }
  expect(hello.ok, JSON.stringify(hello)).toBe(true)
  const sha256 = crypto.createHash('sha256').update(BUNDLE).digest('hex')
  const file = path.join(d.dir, 'plugin-jobs', 'bundles', `${sha256}.mjs`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, BUNDLE)
  const jobs: Array<Record<string, unknown>> = []
  const startJob = async (job: string) => {
    jobs.push({ plugin: 'acme-sync', version: '1.0.0', job, kind: 'long-running', bundle: { sha256, file }, config: {}, host: 'devbox' })
    expect((await cmd(mac, { cmd: 'jobs.configure', home: HOME, spec: { v: 1, home: HOME, walnutId: WALNUT, jobs } })).ok).toBe(true)
    await waitFor(() => lines(jobOut).some((l) => l.job === job && ('answer' in l || 'error' in l)), 60_000, `the ${job} run's call`)
    const said = lines(jobOut).filter((l) => l.job === job)
    return { ...said.find((l) => typeof l.sid === 'string')!, ...said.find((l) => 'answer' in l || 'error' in l)! }
  }
  const stopJobs = async () => {
    jobs.length = 0
    expect((await cmd(mac, { cmd: 'jobs.configure', home: HOME, spec: { v: 1, home: HOME, walnutId: WALNUT, jobs } })).ok).toBe(true)
  }
  return { d, mac, follower, macAsked, entryLines, callSocket, jobOut, startJob, stopJobs }
}

beforeAll(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'hce-')) })

afterAll(async () => {
  await Promise.all(listeners.splice(0).map((l) => l.close()))
  for (const f of fs.existsSync(base) ? fs.readdirSync(base).filter((n) => n.endsWith('.jsonl')) : []) {
    for (const l of lines(path.join(base, f))) if (typeof l.pid === 'number' && l.pid > 1 && alive(l.pid)) { try { process.kill(l.pid, 'SIGKILL') } catch { /* gone */ } }
  }
  for (const pid of started) if (pid > 1) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
  try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* best effort */ }
})

for (const twin of ['source', 'standalone'] as const) {
  describe.skipIf(twin === 'standalone' && !BUN)(`${twin === 'source' ? `source twin (${SOURCE_TWIN.runtime})` : 'standalone twin'}: the host call entry`, () => {
    it('a job run gets the entry socket and its own token, its call is handed back by the entry and answered on the socket, and a wrong or ended run\'s token runs nothing', async () => {
      const r = await rig(twin, `${twin.slice(0, 2)}a`)
      try {
        const run = await r.startJob('worker')
        expect(run.callSocket).toBe(r.callSocket)
        expect(fs.statSync(r.callSocket).mode & 0o777).toBe(0o600)
        expect(run.callToken).toMatch(/^[0-9a-f]{64}$/)
        expect(run.socket).toBe(r.d.sock)
        // Its call went to the entry first, which handed it back unrun (a plugin job's run is vouched for
        // only on the gateway socket, by the process there), and the socket answered it, once.
        expect(r.entryLines.map((l) => [l.sid, l.args?.name])).toEqual([[run.sid, 'task_list']])
        expect(run.answer).toEqual({ who: 'mac', op: 'task_list' })
        expect(r.macAsked).toHaveLength(1)
        expect(r.macAsked[0]).toMatchObject({ callerSid: 'external', payload: { name: 'task_list' } })
        // The very same line on the socket: the same answer.
        expect(await socketCall(r.d.sock, run.sid, 'task_list')).toEqual({ ok: true, result: { who: 'mac', op: 'task_list' } })

        // follower.gateway itself: the token of this run only, and even its own token runs nothing for
        // a job (job_on_socket): the door has no socket peer to vouch for the run.
        const line = { v: 1, op: 'tools.call', sid: run.sid, args: { name: 'task_get', args: {} } }
        const asked = r.macAsked.length
        const good = await cmd(r.follower, { cmd: 'follower.gateway', request: line, token: run.callToken, openedAt: Date.now() })
        expect(good).toMatchObject({ ok: false, errorKind: 'job_on_socket' })
        expect(r.macAsked.length).toBe(asked)
        const other = await cmd(r.follower, { cmd: 'follower.gateway', request: { ...line, sid: 'plugin-job:' + '0'.repeat(64) }, token: run.callToken })
        expect(other).toMatchObject({ ok: false, errorKind: 'bad_token' })
        const none = await cmd(r.follower, { cmd: 'follower.gateway', request: line })
        expect(none).toMatchObject({ ok: false, errorKind: 'bad_token' })
        expect(r.macAsked.length).toBe(asked)
        // Not over the Mac's socket: only a follower's link may hand a line in.
        expect(await cmd(r.mac, { cmd: 'follower.gateway', request: line, token: run.callToken })).toMatchObject({ ok: false })
        expect(r.macAsked.length).toBe(asked)

        // The key and the runs are the daemon dir's own private files.
        expect(fs.statSync(path.join(r.d.dir, 'host-call.key')).mode & 0o777).toBe(0o600)
        expect(fs.statSync(path.join(r.d.dir, 'host-call-runs.json')).mode & 0o777).toBe(0o600)

        // The count of own away answers is there to read, zero here (the Mac answered every call).
        expect((await cmd(r.follower, { cmd: 'follower.status' })).offlineAnswers).toMatchObject({ total: 0 })
        expect((await cmd(r.follower, { cmd: 'server.status' })).offlineAnswers).toMatchObject({ total: 0 })

        // The run ends: its token ends with it, though the sid is the same.
        await r.stopJobs()
        await waitFor(() => !alive(run.pid), 30_000, 'the job run to end')
        const after = await askUntil(
          () => cmd(r.follower, { cmd: 'follower.gateway', request: line, token: run.callToken, openedAt: Date.now() }),
          (a) => a.errorKind === 'bad_token', 4_000,
        )
        expect(after).toMatchObject({ ok: false, errorKind: 'bad_token' })
      } finally {
        r.mac.close(); r.follower.close()
      }
    }, 180_000)

    it('the follower\'s report says no socket (its experiment off) or one outside the entry dir: the next run gets none, and calls over the gateway socket', async () => {
      const r = await rig(twin, `${twin.slice(0, 2)}b`)
      try {
        await report(r.follower, { callSocket: null })
        const run = await r.startJob('worker')
        expect(run.callSocket).toBeNull()
        expect(run.callToken).toBeNull()
        expect(run.answer).toEqual({ who: 'mac', op: 'task_list' })
        // A socket outside this daemon dir's entry dir, or an old http address: never given.
        const stray = path.join(base, 'stray.sock')
        const straySrv = net.createServer()
        await new Promise<void>((resolve) => straySrv.listen(stray, () => resolve()))
        fs.chmodSync(stray, 0o600)
        for (const bad of [stray, 'http://127.0.0.1:4100/api/host/call', `${r.d.dir}/host-call/../host-call/${path.basename(r.callSocket)}`]) {
          await report(r.follower, { callSocket: bad })
        }
        const strayRun = await r.startJob('third')
        expect(strayRun.callSocket).toBeNull()
        expect(strayRun.answer).toEqual({ who: 'mac', op: 'task_list' })
        straySrv.close()
        // And its socket again: the run after that gets it.
        await report(r.follower, { callSocket: r.callSocket })
        const next = await r.startJob('second')
        expect(next.callSocket).toBe(r.callSocket)
        expect(r.entryLines.map((l) => l.sid)).toEqual([next.sid])
        expect(next.answer).toEqual({ who: 'mac', op: 'task_list' })
      } finally {
        r.mac.close(); r.follower.close()
      }
    }, 180_000)
  })
}
