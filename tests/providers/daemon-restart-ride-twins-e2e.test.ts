/**
 * A `walnut` call made while its host's daemon is being replaced waits for the
 * next daemon and gets its answer, on the real daemon twins and their own CLIs
 * (the JS source twin under node, the standalone twin under bun when bun is
 * installed).
 *
 * 2026-11-03 on a dev box: a deploy replaced the daemon, and for 6 s there was no
 * gateway socket; every call in that window failed at once. A daemon that stops
 * for a successor now leaves `<dir>/restarting` (daemon-restart-mark.ts), the
 * successor removes it once its socket listens, and a call in between waits.
 * A daemon with no successor (an isolated one) leaves no mark, so a call there
 * still fails at once. A call the server still has when the daemon stops is
 * answered before it goes: a read goes again through the next daemon, anything
 * else is told it may have run (seen live the same day: a `host_list` in flight
 * at a daemon restart ended "agent socket closed without a response").
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths and every
 * daemon is SIGKILLed after each test.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { testBun } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'
import { guardedPath } from '../setup/exec-guard.js'

let scriptPath = ''
let root = ''
const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
type Twin = { name: string; command: (...args: string[]) => [string, string[]] }
const TWINS: Twin[] = [
  { name: `source twin (${SOURCE_TWIN.runtime})`, command: (...args) => [SOURCE_TWIN.file, [scriptPath, ...args]] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (...args: string[]): [string, string[]] => [BUN, [STANDALONE, ...args]] }] : []),
]
const procs: ChildProcess[] = []
const sockets: WebSocket[] = []
let rpcId = 1
const WAIT_LINE = 'walnut: the Walnut daemon on this host is restarting; waiting for the next one (up to 45s)'

function dirs() {
  return {
    home: path.join(root, 'home'),
    daemon: path.join(root, 'daemon'),
    sock: path.join(root, 'daemon', 'agent-gateway.sock'),
    mark: path.join(root, 'daemon', 'restarting'),
  }
}

function env(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const d = dirs()
  return {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: guardedPath([], '/usr/bin:/bin'),
    HOME: d.home,
    WALNUT_DAEMON_DIR: d.daemon,
    WALNUT_STREAMS_DIR: path.join(root, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'),
    ...extra,
  }
}

// 'probe': false for a successor booted while a call waits for it. The probe socket names no
// Walnut, which a daemon takes for an older server, so a call arriving while it is open is relayed
// to it and lost when it closes (a task_send is never sent twice): 3 runs in 12 under load
// (2026-11-04, CI's Node side job). The server's own hello is that daemon's round trip.
async function boot(twin: Twin, extra: Record<string, string>, probe = true): Promise<{ proc: ChildProcess; port: number }> {
  const [cmd, args] = twin.command('--start')
  const proc = spawn(cmd, args, { env: env(extra), stdio: ['ignore', 'pipe', 'pipe'] })
  procs.push(proc)
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    onDaemonEarlyExit(proc, { daemonDir: dirs().daemon }, (err) => { clearTimeout(timer); reject(err) })
  })
  expect(await waitFor(() => fs.existsSync(dirs().sock), 30_000)).toBe(true)
  if (!probe) return { proc, port }
  // One round trip: the daemon's start block, signal handlers last, has run to its end.
  await new Promise<void>((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}`)
    w.on('open', () => { w.close(); resolve() })
    w.on('error', reject)
  })
  return { proc, port }
}

async function stop(proc: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()))
  proc.kill('SIGTERM')
  await exited
}

/** The twin's own CLI: `walnut tools call <op> '{}'` as a session on this host runs it. */
function cli(twin: Twin, op = 'task_send', json = '{}'): Promise<{ out: string; err: string; code: number | null; ms: number }> {
  const t0 = Date.now()
  const [cmd, args] = twin.command('walnut', 'tools', 'call', op, json)
  const child = spawn(cmd, args, {
    env: env({ WALNUT_AGENT_SOCKET: dirs().sock, WALNUT_SESSION_ID: 'external', WALNUT_CLI_WAIT_MS: '30000' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  procs.push(child)
  let out = ''
  let err = ''
  child.stdout?.on('data', (c) => { out += c })
  child.stderr?.on('data', (c) => { err += c })
  return new Promise((resolve) => child.on('close', (code) => resolve({ out, err, code, ms: Date.now() - t0 })))
}

async function connect(port: number, run: string, readOps?: string[]): Promise<{ ws: WebSocket; requests: Array<Record<string, unknown>> }> {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}`)
    w.on('open', () => resolve(w))
    w.on('error', reject)
  })
  sockets.push(ws)
  const requests: Array<Record<string, unknown>> = []
  ws.on('message', (data: Buffer) => {
    try { const m = JSON.parse(data.toString()) as Record<string, unknown>; if (m.ev === 'gateway-request') requests.push(m) } catch { /* not a frame */ }
  })
  expect((await rpc(ws, { cmd: 'hello', run, ...(readOps ? { readOps } : {}) })).ok).toBe(true)
  return { ws, requests }
}

function rpc(ws: WebSocket, cmd: Record<string, unknown>, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const id = rpcId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); ws.off('message', onMessage); resolve(msg) }
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, ...cmd }))
  })
}

async function waitFor(check: () => boolean, ms = 8_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return check()
}

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-restart-ride-src-'))
  scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
})

afterEach(async () => {
  for (const s of sockets.splice(0)) { try { s.close() } catch { /* closed */ } }
  for (const p of procs.splice(0)) {
    if (p.exitCode !== null || p.signalCode !== null) continue
    p.kill('SIGKILL')
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 3000)
      p.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

function newRoot(): void {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.platform() === 'win32' ? os.tmpdir() : '/tmp', 'wrr-')))
  fs.mkdirSync(dirs().home, { recursive: true })
}

for (const twin of TWINS) {
  describe(`a walnut call while the daemon is replaced, ${twin.name}`, () => {
    // WALNUT_DAEMON_KEEP_SESSIONS=1: this daemon has a successor, as a production one does.
    const SUCCESSOR = { WALNUT_DAEMON_KEEP_SESSIONS: '1' }

    it('the call made between the two daemons waits and gets the next one\'s answer', async () => {
      newRoot()
      const first = await boot(twin, SUCCESSOR)
      await stop(first.proc)
      // The stopping daemon left the mark and took its socket with it.
      expect(fs.existsSync(dirs().sock)).toBe(false)
      const sec = Number(fs.readFileSync(dirs().mark, 'utf-8'))
      expect(Math.abs(Math.floor(Date.now() / 1000) - sec)).toBeLessThan(10)

      const call = cli(twin)
      await new Promise((r) => setTimeout(r, 1_500))
      const next = await boot(twin, SUCCESSOR, false)
      // Listening again: the mark is gone, so nothing else waits on it.
      expect(await waitFor(() => !fs.existsSync(dirs().mark))).toBe(true)
      const server = await connect(next.port, 'run-b')
      expect(await waitFor(() => server.requests.length > 0, 20_000)).toBe(true)
      expect((await rpc(server.ws, { cmd: 'gateway-result', relayId: server.requests[0].relayId, result: { sent: true } })).ok).toBe(true)

      const r = await call
      expect(r.code).toBe(0)
      expect(JSON.parse(r.out)).toEqual({ sent: true })
      // stderr is a pipe here, as for an agent: no notice in what it reads back.
      expect(r.err).not.toContain(WAIT_LINE)
      expect(r.ms).toBeGreaterThanOrEqual(1_500)
      expect(server.requests).toHaveLength(1)
    }, 120_000)

    // 2026-11-03 live: a `host_list` whose CLI connected while the daemon finished its
    // stop got "read ECONNRESET" and failed. Only Linux promises that reset means unread.
    it.runIf(process.platform === 'linux')('a call the exiting daemon never read waits and gets the next one\'s answer', async () => {
      newRoot()
      fs.mkdirSync(dirs().daemon, { recursive: true, mode: 0o700 })
      fs.writeFileSync(dirs().mark, String(Math.floor(Date.now() / 1000)), { mode: 0o600 })
      // The exiting daemon: it takes the connection, never reads it, and goes with it.
      let took = 0
      let gone = false
      const exiting = net.createServer({ pauseOnConnect: true }, (s) => {
        took += 1
        setTimeout(() => {
          s.destroy()
          exiting.close(() => { gone = true })
        }, 400)
      })
      await new Promise<void>((resolve) => exiting.listen(dirs().sock, () => resolve()))
      const call = cli(twin, 'host_list')
      expect(await waitFor(() => took === 1 && gone, 20_000)).toBe(true)
      try { fs.unlinkSync(dirs().sock) } catch { /* removed with the server */ }
      const next = await boot(twin, SUCCESSOR, false)
      const server = await connect(next.port, 'run-b')
      expect(await waitFor(() => server.requests.length > 0, 20_000)).toBe(true)
      expect((await rpc(server.ws, { cmd: 'gateway-result', relayId: server.requests[0].relayId, result: { hosts: [] } })).ok).toBe(true)

      const r = await call
      expect(r.err).not.toContain('ECONNRESET')
      expect(r.code).toBe(0)
      expect(JSON.parse(r.out)).toEqual({ hosts: [] })
      expect(server.requests).toHaveLength(1)
      expect(took).toBe(1)
    }, 120_000)

    it('a read still at the server when the daemon stops is sent again through the next daemon', async () => {
      newRoot()
      const first = await boot(twin, SUCCESSOR)
      const before = await connect(first.port, 'run-a', ['host_list'])
      const call = cli(twin, 'host_list')
      expect(await waitFor(() => before.requests.length === 1, 20_000)).toBe(true)
      // The server has it and has not answered when the daemon is replaced.
      await stop(first.proc)
      const next = await boot(twin, SUCCESSOR, false)
      const server = await connect(next.port, 'run-a', ['host_list'])
      expect(await waitFor(() => server.requests.length === 1, 20_000)).toBe(true)
      expect((await rpc(server.ws, { cmd: 'gateway-result', relayId: server.requests[0].relayId, result: { hosts: [] } })).ok).toBe(true)
      const r = await call
      expect(r.code).toBe(0)
      expect(JSON.parse(r.out)).toEqual({ hosts: [] })
    }, 120_000)

    it('a call that may change something, still at the server when the daemon stops, is told it may have run and is not sent again', async () => {
      newRoot()
      const first = await boot(twin, SUCCESSOR)
      const before = await connect(first.port, 'run-a', ['host_list'])
      const call = cli(twin, 'task_send')
      expect(await waitFor(() => before.requests.length === 1, 20_000)).toBe(true)
      await stop(first.proc)
      const r = await call
      // hub_timeout: the answer did not come back. Never hub_unreachable, which every client
      // reads as "nothing ran, send it again" (the Mac's CLI even sends it again over HTTP).
      expect(r.code).toBe(5)
      expect(r.err).toContain('hub_timeout')
      expect(r.err).toContain('it may have run, so check before running it again')
      expect(r.err).not.toContain('socket closed without a response')
      // The next daemon never gets it.
      const next = await boot(twin, SUCCESSOR, false)
      const server = await connect(next.port, 'run-a', ['host_list'])
      await new Promise((res) => setTimeout(res, 1_500))
      expect(server.requests).toEqual([])
    }, 120_000)

    it('a host_exec still at the server when the daemon stops names its job to read, never "call it again"', async () => {
      newRoot()
      const first = await boot(twin, SUCCESSOR)
      const before = await connect(first.port, 'run-a', ['host_list'])
      const call = cli(twin, 'host_exec', JSON.stringify({ host: 'gpu-box', command: 'make' }))
      expect(await waitFor(() => before.requests.length === 1, 20_000)).toBe(true)
      const jobId = ((before.requests[0].payload as { args?: { job_id?: unknown } }).args?.job_id)
      expect(typeof jobId).toBe('string')
      await stop(first.proc)
      const r = await call
      expect(r.code).toBe(5)
      expect(r.err).toContain(`host_exec may have started on gpu-box as job ${String(jobId)}: do not run it again`)
      expect(r.err).not.toMatch(/nothing ran|call it again/)
    }, 120_000)

    it('a daemon with no successor leaves no mark: the call fails at once, as before', async () => {
      newRoot()
      const only = await boot(twin, {})
      await stop(only.proc)
      expect(fs.existsSync(dirs().mark)).toBe(false)
      const r = await cli(twin)
      expect(r.code).toBe(6)
      expect(r.err).toContain('Walnut daemon socket unreachable')
      expect(r.err).not.toContain('restarting')
      expect(r.ms).toBeLessThan(10_000)
    }, 120_000)
  })
}
