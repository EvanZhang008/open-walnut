/**
 * client-role-v1 on the real daemon twins, booted for real (the JS source twin
 * under node, and the standalone twin under bun when bun is installed).
 *
 * 2026-11-02: a test server attached read only to a host's shared daemon sat ahead
 * of the real Walnut in the daemon's socket order, so an env-less `walnut` call
 * (sid 'external', no known owner) was handed to it and answered from its paused
 * copy of the data: every trigger read as off. A server that announces itself as a
 * probe is never a relay target, whatever its place in the order.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths and the
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

let scriptPath = ''
let root = ''
const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
type Twin = { name: string; command: () => [string, string[]] }
const TWINS: Twin[] = [
  { name: `source twin (${SOURCE_TWIN.runtime})`, command: () => [SOURCE_TWIN.file, [scriptPath, '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]
let proc: ChildProcess | null = null
const sockets: WebSocket[] = []
let rpcId = 1
let daemonDir = ''

async function boot(twin: Twin): Promise<number> {
  // Short on purpose: a unix socket path is limited to 104 bytes on macOS, and the gateway
  // socket sits three levels down (the Node twin cannot bind it under a long temp dir).
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.platform() === 'win32' ? os.tmpdir() : '/tmp', 'wrt-')))
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  daemonDir = path.join(root, 'daemon')
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: '/usr/bin:/bin',
    HOME: home,
    WALNUT_DAEMON_DIR: daemonDir,
    WALNUT_STREAMS_DIR: path.join(root, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'),
  }
  const [cmd, args] = twin.command()
  proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc!.on('error', (err) => { clearTimeout(timer); reject(err) })
    onDaemonEarlyExit(proc!, { daemonDir }, (err) => { clearTimeout(timer); reject(err) })
  })
  // The gateway socket is bound a moment after the port is printed.
  expect(await waitFor(() => fs.existsSync(path.join(daemonDir, 'agent-gateway.sock')), 30_000)).toBe(true)
  return port
}

/** Open a socket and say hello, so the daemon counts it a fresh client. */
async function connect(port: number): Promise<WebSocket> {
  const s = await new Promise<WebSocket>((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}`)
    w.on('open', () => resolve(w))
    w.on('error', reject)
  })
  sockets.push(s)
  const reply = await rpc(s, { cmd: 'hello' })
  expect(reply.ok).toBe(true)
  return s
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

/** Frames of one kind a socket received from now on. */
function collect(ws: WebSocket, ev: string): Array<Record<string, unknown>> {
  const got: Array<Record<string, unknown>> = []
  ws.on('message', (data: Buffer) => {
    try { const m = JSON.parse(data.toString()) as Record<string, unknown>; if (m.ev === ev) got.push(m) } catch { /* not a frame */ }
  })
  return got
}

/** An env-less `walnut` call, as the CLI writes it: one NDJSON line on the gateway socket. */
function externalCall(): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(path.join(daemonDir, 'agent-gateway.sock'))
    let buf = ''
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('gateway timeout')) }, 15_000)
    sock.on('connect', () => sock.write(JSON.stringify({ v: 1, op: 'tools.call', sid: 'external', args: { name: 'trigger_list', args: {} } }) + '\n'))
    sock.on('data', (c) => {
      buf += c.toString('utf-8')
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      clearTimeout(timer); sock.destroy()
      resolve(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>)
    })
    sock.on('error', (e) => { clearTimeout(timer); reject(e) })
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-role-twins-src-'))
  scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
})

afterEach(async () => {
  for (const s of sockets.splice(0)) { try { s.close() } catch { /* closed */ } }
  if (proc && proc.exitCode === null) {
    proc.kill('SIGKILL')
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 3000)
      proc!.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
  proc = null
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

for (const twin of TWINS) {
  describe(`client.role probe, ${twin.name}`, () => {
    it('advertises client-role-v1', async () => {
      const port = await boot(twin)
      const ws = await connect(port)
      const hello = await rpc(ws, { cmd: 'hello' })
      expect((hello.capabilities ?? (hello.result as { capabilities?: string[] } | undefined)?.capabilities) as string[]).toContain('client-role-v1')
    }, 90_000)

    it('control: without the role, the first socket in order gets an env-less call', async () => {
      const port = await boot(twin)
      const first = await connect(port)
      const second = await connect(port)
      const gotFirst = collect(first, 'gateway-request')
      const gotSecond = collect(second, 'gateway-request')
      void externalCall().catch(() => undefined)
      expect(await waitFor(() => gotFirst.length + gotSecond.length > 0)).toBe(true)
      expect(gotFirst.length).toBe(1)
      expect(gotSecond.length).toBe(0)
    }, 90_000)

    it('a probe ahead of the real server never gets the call; the server does', async () => {
      const port = await boot(twin)
      const probe = await connect(port)
      const server = await connect(port)
      expect((await rpc(probe, { cmd: 'client.role', role: 'probe' })).ok).toBe(true)
      const gotProbe = collect(probe, 'gateway-request')
      const gotServer = collect(server, 'gateway-request')
      void externalCall().catch(() => undefined)
      expect(await waitFor(() => gotServer.length > 0)).toBe(true)
      expect(gotProbe.length).toBe(0)
    }, 90_000)

    it('with only a probe attached, the call is not handed to it', async () => {
      const port = await boot(twin)
      const probe = await connect(port)
      expect((await rpc(probe, { cmd: 'client.role', role: 'probe' })).ok).toBe(true)
      const gotProbe = collect(probe, 'gateway-request')
      const reply = await externalCall()
      expect(gotProbe.length).toBe(0)
      expect(reply.ok).not.toBe(true)
    }, 90_000)

    it('refuses an unknown role', async () => {
      const port = await boot(twin)
      const ws = await connect(port)
      const reply = await rpc(ws, { cmd: 'client.role', role: 'admin' })
      expect(reply.ok).toBe(false)
    }, 90_000)
  })
}
