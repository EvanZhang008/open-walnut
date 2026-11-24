/**
 * REAL daemon processes (daemon-standalone.ts under bun) with a session and this host's own Walnut
 * server linked as the follower, for the follower gateway suites (tests/integration/follower-*.test.ts):
 *
 *   test as the Mac ==trusted WS==> daemon: start (a mock session), host.slice, leader.configure,
 *     server.configure (a fake host server that hands its follower token back)
 *   test as the host's Walnut server ==follower WS==> follower.hello {answersLocal: true}
 *   a session's calls on the agent-gateway socket
 *
 * Hygiene: every dir is under the suite's temp `base` (short: socket paths); each daemon is
 * stopped by the pid it wrote into its own dir, the fake host server and the mock session by the
 * pids they logged into `base/*.jsonl` (cleanupFollowerTwins).
 */
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { testBun } from './bun-runtime.js'
import type { GatewayResponse } from '../../src/providers/gateway-core.js'

const ROOT = path.resolve(__dirname, '../..')
export const BUN: string | undefined = testBun()

/** A session's CLI: logs its pid, says it is ready and idles. */
const MOCK_CLI = `
const fs = require('fs')
const sid = process.argv[2]
fs.appendFileSync(process.argv[3], JSON.stringify({ pid: process.pid }) + '\\n')
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: sid })
out({ type: 'result', subtype: 'success', is_error: false, result: 'ready', session_id: sid })
out({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
process.stdin.on('data', () => {})
setInterval(() => {}, 1 << 30)
`

/** The host server the daemon starts: hands its follower token to the test (FAKE_OUT) and idles. */
const FAKE_SERVER = `
const fs = require('fs')
fs.appendFileSync(process.env.FAKE_OUT, JSON.stringify({ pid: process.pid, token: process.env.WALNUT_FOLLOWER_TOKEN }) + '\\n')
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1 << 30)
`

/** The one daemon there is; kept as a parameter so a suite can still name it in its labels. */
export type Twin = 'standalone'
export interface Daemon { proc: ChildProcess; dir: string; port: number; pid: number; sock: string }

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function waitFor(cond: () => boolean, ms: number, label: string): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for ' + label)
    await sleep(50)
  }
}

export function lines(file: string): Array<Record<string, any>> {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * One daemon in `base/name`, its journal in `base/name-j`. `takeoverMs` is the
 * companion's takeover window and the quiet window this daemon calls the Mac away by; `beatMs`
 * its keepalive beat. Its pid is pushed onto `started`.
 */
export async function spawnFollowerTwin(o: { base: string; name: string; twin?: Twin; takeoverMs: number; beatMs: number; started: number[] }): Promise<Daemon> {
  const dir = path.join(o.base, o.name)
  fs.mkdirSync(dir, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALNUT_DAEMON_DIR: dir,
    WALNUT_JOURNAL_DIR: path.join(o.base, o.name + '-j'),
    WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_TRUSTED_CLIENT_BEAT_MS: String(o.beatMs),
    WALNUT_LEADER_TAKEOVER_MS: String(o.takeoverMs),
    WALNUT_LEADER_QUIET_MS: String(o.takeoverMs),
    WALNUT_GATEWAY_TIMEOUT_MS: '20000',
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  delete env.WALNUT_DAEMON_STATE_DIR
  delete env.OPEN_WALNUT_API_URL; delete env.WALNUT_AGENT_SOCKET; delete env.WALNUT_SESSION_ID
  const stderr = process.env.DEBUG_DAEMON ? 'pipe' : 'ignore'
  if (!BUN) throw new Error('the session daemon runs on bun, and there is none (BUN_INSTALL, ~/.bun/bin/bun)')
  const proc: ChildProcess = spawn(BUN, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start'], { env, stdio: ['ignore', 'ignore', stderr], cwd: ROOT })
  if (process.env.DEBUG_DAEMON) proc.stderr?.on('data', (b) => process.stderr.write(`[${o.name}] ` + b.toString()))
  const sock = path.join(dir, 'agent-gateway.sock')
  await waitFor(() => fs.existsSync(path.join(dir, 'daemon.port')) && fs.existsSync(sock) && fs.existsSync(path.join(dir, 'daemon.pid')), 60_000, `${o.name} daemon`)
  const pid = parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10)
  o.started.push(pid)
  return { proc, dir, sock, pid, port: parseInt(fs.readFileSync(path.join(dir, 'daemon.port'), 'utf8').trim(), 10) }
}

export function connectWs(port: number, autoPong = true): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { autoPong })
    const t = setTimeout(() => reject(new Error('ws connect timeout')), 5000)
    ws.once('open', () => { clearTimeout(t); resolve(ws) })
    ws.once('error', (e) => { clearTimeout(t); reject(e) })
  })
}

let cmdId = 1
/** A fresh frame id for a frame sent without waiting for its answer (a gateway-result). */
export const nextFrameId = () => cmdId++

export function cmd(ws: WebSocket, body: Record<string, unknown>): Promise<Record<string, any>> {
  const id = cmdId++
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', on); reject(new Error(`cmd ${body.cmd} timed out`)) }, 30_000)
    const on = (data: WebSocket.Data) => {
      try { const m = JSON.parse(data.toString()); if (m.id === id) { clearTimeout(t); ws.off('message', on); resolve(m) } } catch { /* not json */ }
    }
    ws.on('message', on)
    ws.send(JSON.stringify({ id, ...body }))
  })
}

/** Starts the mock session `sid` of `home`'s task `task` on the daemon, through the Mac's socket. */
export async function startMockSession(o: { base: string; name: string; d: Daemon; mac: WebSocket; sid: string; home: string; task: string }): Promise<Record<string, any>> {
  const mock = path.join(o.base, 'mock-cli.cjs')
  fs.writeFileSync(mock, MOCK_CLI)
  return cmd(o.mac, { cmd: 'start', sid: o.sid, cwd: o.d.dir, message: 'init', args: [process.execPath, mock, o.sid, path.join(o.base, `${o.name}-cli.jsonl`)], origin: { home: o.home, task: o.task } })
}

/**
 * Has the daemon start `home`'s host server (server.configure on the Mac's socket) and links a
 * second socket as it: follower.hello with the token the daemon gave it, answersLocal.
 */
export async function linkFollower(o: { base: string; name: string; d: Daemon; mac: WebSocket; home: string; walnutId: string; serverPort: number }): Promise<{ follower: WebSocket; hello: Record<string, any> }> {
  const fakeOut = path.join(o.base, `${o.name}-fake.jsonl`)
  const entry = path.join(o.base, `${o.name}-server.cjs`)
  fs.writeFileSync(entry, FAKE_SERVER)
  const spec = { v: 1, home: o.home, walnutId: o.walnutId, command: process.execPath, args: [entry], cwd: o.base, env: { FAKE_OUT: fakeOut }, log: path.join(o.base, `${o.name}-server.log`), port: o.serverPort, settings: { expose: { enabled: false } } }
  const configured = await cmd(o.mac, { cmd: 'server.configure', home: o.home, spec })
  if (configured.ok !== true) throw new Error('server.configure: ' + JSON.stringify(configured))
  await waitFor(() => lines(fakeOut).length > 0, 30_000, 'the host server token')
  const follower = await connectWs(o.d.port)
  let hello: Record<string, any> = {}
  for (let attempt = 0; attempt < 40 && hello.ok !== true; attempt++) {
    hello = await cmd(follower, { cmd: 'follower.hello', walnutId: o.walnutId, home: o.home, token: lines(fakeOut).at(-1)!.token, answersLocal: true })
    if (hello.ok !== true) await sleep(250)
  }
  return { follower, hello }
}

/** One session call on the agent-gateway socket, and the daemon's answer with how long it took. */
export function gatewayCall(d: Daemon, sid: string, name: string, args: Record<string, unknown> = {}): Promise<{ ms: number; reply: GatewayResponse }> {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const s = net.connect(d.sock)
    let buf = ''
    const t = setTimeout(() => { s.destroy(); reject(new Error(`gateway ${name} timeout`)) }, 60_000)
    s.on('connect', () => s.write(JSON.stringify({ v: 1, op: 'tools.call', sid, waitMs: 20_000, args: { name, args } }) + '\n'))
    s.on('data', (c) => {
      buf += c.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl !== -1) { clearTimeout(t); s.destroy(); resolve({ ms: Date.now() - t0, reply: JSON.parse(buf.slice(0, nl)) }) }
    })
    s.on('error', (e) => { clearTimeout(t); reject(e) })
  })
}

/** Ends what the suite started: the logged pids (host servers, mock sessions), then the daemons, then `base`. */
export async function cleanupFollowerTwins(base: string, started: number[]): Promise<void> {
  for (const f of fs.existsSync(base) ? fs.readdirSync(base).filter((n) => n.endsWith('.jsonl')) : []) {
    for (const l of lines(path.join(base, f))) if (typeof l.pid === 'number' && l.pid > 1 && alive(l.pid)) { try { process.kill(l.pid, 'SIGKILL') } catch { /* gone */ } }
  }
  const daemons = started.filter((pid) => pid > 1)
  for (const pid of daemons) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
  // Each daemon gets up to 3 s to stop on its own, then SIGKILL; its dir goes only once it is gone.
  const until = Date.now() + 3_000
  while (daemons.some(alive) && Date.now() < until) await sleep(50)
  for (const pid of daemons) if (alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* best effort */ }
}
