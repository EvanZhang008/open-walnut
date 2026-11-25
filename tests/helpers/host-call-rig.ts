/**
 * A REAL standalone daemon process with the host's Walnut server beside it, for the host call
 * entry's and the host's own sessions' twins (tests/integration/host-call-entry-twins.test.ts,
 * tests/integration/host-session-walnut-cli.test.ts):
 *
 *   test as the Mac ==trusted WS==> daemon     leader.configure, server.configure, jobs.configure;
 *                                               answers every relayed call as `mac`
 *   test as the host's Walnut server ==follower WS==> follower.hello {answersLocal, callSocket}
 *     and the entry itself (replica/host-call-entry.ts) on its real unix socket in the daemon dir,
 *     handing lines to the daemon with follower.gateway
 *
 * Hygiene: every dir is a temp dir (short: socket paths) under rigBase(); each daemon is stopped by
 * the pid it wrote into its own dir, the fake host server, job runs and session CLIs by the pids
 * they logged into a .jsonl file there (endRigs).
 */
import { expect } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createHostCallEntry, listenHostCallEntry, type HostCallListener } from '../../src/replica/host-call-entry.js'
import { hostCallSocketPath } from '../../src/providers/host-call-token-core.js'
import { testBun } from './bun-runtime.js'

const ROOT = path.resolve(__dirname, '../..')
/** The bun the daemons run on (none: the rig's tests skip). */
export const BUN: string | undefined = testBun()
export const HOME = '/fixture/marina-home'
export const WALNUT = 'wmarinahost02'
/** The host server's own port: the root a session this host assembles is named (127.0.0.1). */
export const HOST_SERVER_PORT = 41_238

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

export interface Daemon { proc: ChildProcess; dir: string; port: number; pid: number; sock: string }

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
import { waitFor } from './poll-wait.js'
export { waitFor }
/** Asks again until the answer is the one awaited or `ms` ran out; the last answer either way. */
export async function askUntil<T>(ask: () => Promise<T>, done: (answer: T) => boolean, ms: number): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const answer = await ask()
    if (done(answer) || Date.now() > end) return answer
    await sleep(100)
  }
}
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
export function lines(file: string): Array<Record<string, any>> {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
}

let base = ''
/** The temp dir every rig of this file lives in (startRigs). */
export const rigBase = (): string => base
const started: number[] = []
const listeners: HostCallListener[] = []

async function spawnDaemon(name: string, jobOut: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<Daemon> {
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
    ...extraEnv,
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  delete env.WALNUT_DAEMON_STATE_DIR
  delete env.OPEN_WALNUT_API_URL; delete env.WALNUT_AGENT_SOCKET; delete env.WALNUT_SESSION_ID
  delete env.WALNUT_CALL_SOCKET; delete env.WALNUT_CALL_TOKEN
  const stderr = process.env.DEBUG_DAEMON ? 'pipe' : 'ignore'
  const proc = spawn(BUN!, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start'], { env, stdio: ['ignore', 'ignore', stderr], cwd: ROOT })
  if (process.env.DEBUG_DAEMON) proc.stderr?.on('data', (b) => process.stderr.write('[daemon] ' + b.toString()))
  const sock = path.join(dir, 'agent-gateway.sock')
  await waitFor(() => fs.existsSync(path.join(dir, 'daemon.port')) && fs.existsSync(sock) && fs.existsSync(path.join(dir, 'daemon.pid')), 60_000, 'the daemon')
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
export function cmd(ws: WebSocket, body: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, any>> {
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
 * A follower's report, taken: it is never answered, and the daemon handles one socket's frames in
 * order and at once, so an answered command sent after it comes back once the report was taken.
 */
export async function report(ws: WebSocket, body: Record<string, unknown>): Promise<void> {
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

export function socketCall(sock: string, sid: string, name: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock)
    let buf = ''
    c.on('connect', () => c.write(JSON.stringify({ v: 1, op: 'tools.call', sid, args: { name, args: {} } }) + '\n'))
    c.on('data', (d) => { buf += d.toString(); if (buf.includes('\n')) { c.destroy(); resolve(JSON.parse(buf.slice(0, buf.indexOf('\n')))) } })
    c.on('error', reject)
  })
}

export interface Rig { name: string; extraEnv: NodeJS.ProcessEnv; d: Daemon; mac: WebSocket; follower: WebSocket; macAsked: Array<Record<string, any>>; entryLines: Array<Record<string, any>>; callSocket: string; jobOut: string; startJob: (job: string) => Promise<Record<string, any>>; stopJobs: () => Promise<void> }

export async function rig(name: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<Rig> {
  const jobOut = path.join(base, `${name}-job.jsonl`)
  const d = await spawnDaemon(name, jobOut, extraEnv)
  const mac = await connectWs(d.port)
  const macAsked = answersAs(mac, 'mac')
  expect((await cmd(mac, { cmd: 'leader.configure', home: HOME, walnutId: WALNUT, backup: false })).ok).toBe(true)
  const fakeOut = path.join(base, `${name}-fake.jsonl`)
  const entryFile = path.join(base, `${name}-server.cjs`)
  fs.writeFileSync(entryFile, FAKE_SERVER)
  const spec = { v: 1, home: HOME, walnutId: WALNUT, command: process.execPath, args: [entryFile], cwd: base, env: { FAKE_OUT: fakeOut }, log: path.join(base, `${name}-server.log`), port: HOST_SERVER_PORT, settings: { expose: { enabled: false } } }
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
  return { name, extraEnv, d, mac, follower, macAsked, entryLines, callSocket, jobOut, startJob, stopJobs }
}

/**
 * The rig's daemon taken over by a new one on the same dir (a handover, an update): the old one is
 * stopped, the new one boots (reading back the host server spec it keeps, server-*.json, and
 * adopting that server) and takes the Mac's socket again. No follower says hello to it.
 */
export async function restartDaemon(r: Rig): Promise<{ d: Daemon; mac: WebSocket; macAsked: Array<Record<string, any>> }> {
  r.mac.close(); r.follower.close()
  try { process.kill(r.d.pid, 'SIGTERM') } catch { /* gone */ }
  await waitFor(() => !alive(r.d.pid), 30_000, 'the old daemon to stop')
  for (const f of ['daemon.port', 'daemon.pid']) fs.rmSync(path.join(r.d.dir, f), { force: true })
  const d = await spawnDaemon(r.name, r.jobOut, r.extraEnv)
  const mac = await connectWs(d.port)
  const macAsked = answersAs(mac, 'mac')
  expect((await cmd(mac, { cmd: 'leader.configure', home: HOME, walnutId: WALNUT, backup: false })).ok).toBe(true)
  return { d, mac, macAsked }
}

/** One temp dir for a test file's rigs (its beforeAll). */
export function startRigs(prefix: string): void { base = fs.mkdtempSync(path.join(os.tmpdir(), prefix)) }

/** Stop everything the file's rigs started, and remove their dir (its afterAll). */
export async function endRigs(): Promise<void> {
  await Promise.all(listeners.splice(0).map((l) => l.close()))
  for (const f of fs.existsSync(base) ? fs.readdirSync(base).filter((n) => n.endsWith('.jsonl')) : []) {
    for (const l of lines(path.join(base, f))) if (typeof l.pid === 'number' && l.pid > 1 && alive(l.pid)) { try { process.kill(l.pid, 'SIGKILL') } catch { /* gone */ } }
  }
  for (const pid of started.splice(0)) if (pid > 1) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
  try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* best effort */ }
}
