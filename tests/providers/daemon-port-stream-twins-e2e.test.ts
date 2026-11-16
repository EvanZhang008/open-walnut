/**
 * 'port-stream-v1' on the real daemon twins, booted for real (the JS source twin
 * under node, and the standalone twin under bun when bun is installed): the
 * server's own link endpoint (src/lib/link-stream.ts) over a real WebSocket to the
 * daemon, which connects to a TCP port on its own loopback (servers this test
 * owns). What a host network machine's service preview and embedded VS Code ride
 * where an SSH host has `ssh -L`.
 *
 * The last case per twin is the whole Mac side too: a host network machine's
 * DaemonConnection, with every `ssh` refused (an expired certificate), forwards a
 * real HTTP service through ensurePortForward, its 127.0.0.1 listener, the real
 * daemon and back, and the same local port answers again after the link drops.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths, and the
 * only process ended is the daemon this test spawned, through its own handle: SIGTERM
 * first so it cleans up, SIGKILL only if it is still there after a deadline.
 * Every service is a server this test listens on; refused hosts are never dialled.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { Duplex } from 'node:stream'

const sshSpawns = vi.hoisted(() => [] as string[][])
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return {
    ...original,
    spawn: vi.fn((cmd: string, args: string[], opts?: unknown) => {
      if (cmd === 'ssh') { sshSpawns.push(args); throw new Error('ssh refused by the test: SSH certificate expired') }
      return original.spawn(cmd, args, opts as never)
    }),
  }
})

import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { createStreamEndpoint, type StreamEndpoint } from '../../src/lib/link-stream.js'
import { testBun } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'
import { guardedPath } from '../setup/exec-guard.js'

let scriptPath = ''
let scriptDir = ''
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
const servers: net.Server[] = []
let rpcId = 1

async function boot(twin: Twin): Promise<number> {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.platform() === 'win32' ? os.tmpdir() : '/tmp', 'wps-')))
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  const daemonDir = path.join(root, 'daemon')
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: guardedPath([], '/usr/bin:/bin'),
    HOME: home,
    WALNUT_DAEMON_DIR: daemonDir,
    WALNUT_STREAMS_DIR: path.join(root, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'),
  }
  const [cmd, args] = twin.command()
  proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc!.on('error', (err) => { clearTimeout(timer); reject(err) })
    onDaemonEarlyExit(proc!, { daemonDir }, (err) => { clearTimeout(timer); reject(err) })
  })
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

/** A server socket to the daemon, said hello, with the server's own stream endpoint on it. */
async function link(port: number): Promise<{ ws: WebSocket; ep: StreamEndpoint; hello: Record<string, unknown> }> {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}`)
    w.on('open', () => resolve(w))
    w.on('error', reject)
  })
  sockets.push(ws)
  const hello = await rpc(ws, { cmd: 'hello' })
  expect(hello.ok).toBe(true)
  const ep = createStreamEndpoint({
    send: (frame) => {
      if (ws.readyState !== WebSocket.OPEN) throw new Error('link down')
      ws.send(JSON.stringify(frame))
    },
  })
  ws.on('message', (data: Buffer) => {
    try { ep.handle(JSON.parse(data.toString()) as Record<string, unknown>) } catch { /* not a frame */ }
  })
  ws.on('close', () => ep.closeAll('the link closed'))
  return { ws, ep, hello }
}

async function listen(onConn: (c: net.Socket) => void): Promise<number> {
  // A cut stream reaches the service as a reset: an error the service expects.
  const s = net.createServer({ allowHalfOpen: true }, (c) => { c.on('error', () => {}); onConn(c) })
  servers.push(s)
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  return (s.address() as net.AddressInfo).port
}

function readAll(s: Duplex): Promise<Buffer> {
  const parts: Buffer[] = []
  s.on('data', (b: Buffer) => parts.push(b))
  return new Promise((resolve, reject) => {
    s.on('end', () => resolve(Buffer.concat(parts)))
    s.on('error', reject)
  })
}

async function waitFor(check: () => boolean, ms = 8_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return check()
}

beforeAll(() => {
  scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-port-stream-twins-src-'))
  scriptPath = path.join(scriptDir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
})

afterAll(() => {
  if (scriptDir) fs.rmSync(scriptDir, { recursive: true, force: true })
  scriptDir = ''
})

/** End the daemon this test spawned (its own handle only): TERM, then KILL after a deadline. */
async function stopOwnDaemon(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<boolean>((resolve) => child.once('exit', () => resolve(true)))
  const within = (ms: number) => Promise.race([exited, new Promise<boolean>((r) => setTimeout(() => r(false), ms))])
  child.kill('SIGTERM')
  if (await within(5_000)) return
  child.kill('SIGKILL')
  await within(3_000)
}

const conns: DaemonConnection[] = []

afterEach(async () => {
  for (const c of conns.splice(0)) c.disconnect()
  sshSpawns.length = 0
  for (const s of sockets.splice(0)) { try { s.close() } catch { /* closed */ } }
  for (const s of servers.splice(0)) s.close()
  if (proc) await stopOwnDaemon(proc)
  proc = null
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

for (const twin of TWINS) {
  describe(`port streams, ${twin.name}`, () => {
    it('advertises port-stream-v1 and carries binary both ways with a half close', async () => {
      const port = await boot(twin)
      const { ep, hello } = await link(port)
      expect((hello.capabilities ?? (hello.result as { capabilities?: string[] } | undefined)?.capabilities) as string[]).toContain('port-stream-v1')
      // The service answers once the request is in (its FIN), on a half-open socket.
      const svc = await listen((c) => {
        const parts: Buffer[] = []
        c.on('data', (b) => parts.push(b))
        c.on('end', () => c.end(Buffer.concat(parts).reverse()))
      })
      const big = Buffer.alloc(1024 * 1024 + 11)
      for (let i = 0; i < big.length; i++) big[i] = (i * 13) & 0xff
      const s = await ep.openPort(svc, 'localhost')
      const got = readAll(s)
      s.end(big)
      expect((await got).equals(Buffer.from(big).reverse())).toBe(true)
      expect(await waitFor(() => ep.size() === 0)).toBe(true)
    }, 90_000)

    it('carries several streams at once', async () => {
      const port = await boot(twin)
      const { ep } = await link(port)
      const svc = await listen((c) => c.pipe(c))
      const answers = await Promise.all(Array.from({ length: 10 }, async (_, i) => {
        const s = await ep.openPort(svc, '127.0.0.1')
        const got = readAll(s)
        s.end(`n${i}`)
        return (await got).toString()
      }))
      expect(answers).toEqual(Array.from({ length: 10 }, (_, i) => `n${i}`))
    }, 90_000)

    it('refuses an invalid port, a host that is not its loopback, and a port nothing listens on', async () => {
      const port = await boot(twin)
      const { ep } = await link(port)
      let dialled = 0
      const svc = await listen(() => { dialled++ })
      await expect(ep.openPort(0, '127.0.0.1')).rejects.toThrow(/not a TCP port/)
      await expect(ep.openPort(70_000, '127.0.0.1')).rejects.toThrow(/not a TCP port/)
      await expect(ep.openPort(svc, '0.0.0.0')).rejects.toThrow(/only this host's own loopback/)
      await expect(ep.openPort(svc, 'example.test')).rejects.toThrow(/only this host's own loopback/)
      await expect(ep.openPort(svc, '169.254.169.254')).rejects.toThrow(/only this host's own loopback/)
      const gone = await listen(() => {})
      // Wait for the listener itself to close, not a clock.
      await new Promise<void>((r) => servers.pop()!.close(() => r()))
      await expect(ep.openPort(gone, '127.0.0.1')).rejects.toThrow(/nothing is listening on port/)
      expect(dialled).toBe(0)
    }, 90_000)

    it('a socket that said it is a probe opens no port stream', async () => {
      const port = await boot(twin)
      const { ws, ep } = await link(port)
      expect((await rpc(ws, { cmd: 'client.role', role: 'probe' })).ok).toBe(true)
      let dialled = 0
      const svc = await listen(() => { dialled++ })
      await expect(ep.openPort(svc, '127.0.0.1')).rejects.toThrow(/only the Walnut server linked here opens a port stream/)
      expect(dialled).toBe(0)
    }, 90_000)

    it('the link closing resets its TCP connections on the host, even a half-open one', async () => {
      const port = await boot(twin)
      const { ws, ep } = await link(port)
      let closed = false
      let opened = false
      const svc = await listen((c) => { opened = true; c.resume(); c.on('close', () => { closed = true }) })
      const s = await ep.openPort(svc, '127.0.0.1')
      s.on('error', () => {})
      s.write('hello')
      expect(await waitFor(() => opened)).toBe(true)
      ws.close()
      expect(await waitFor(() => closed)).toBe(true)
    }, 90_000)
  })
}

/** A raw socket to the daemon, said hello. */
async function rawLink(port: number): Promise<{ ws: WebSocket; caps: string[] }> {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}`)
    w.on('open', () => resolve(w))
    w.on('error', reject)
  })
  sockets.push(ws)
  const hello = await rpc(ws, { cmd: 'hello' })
  return { ws, caps: (hello.capabilities ?? (hello.result as { capabilities?: string[] } | undefined)?.capabilities ?? []) as string[] }
}

function httpGet(port: number, p = '/'): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, agent: false }, (res) => {
      const parts: Buffer[] = []
      res.on('data', (b: Buffer) => parts.push(b))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts) }))
      res.on('error', reject)
      res.on('close', () => { if (!res.complete) reject(new Error('the answer was cut')) })
    })
    req.on('error', reject)
  })
}

type ConnInternals = {
  ws: unknown
  streams: { closeAll(reason: string): void } | null
  streamEndpoint(): { handle(msg: Record<string, unknown>): boolean }
  sshExec: (...args: unknown[]) => Promise<string>
}

for (const twin of TWINS) {
  describe(`a host network machine's port forward end to end, ${twin.name}`, () => {
    it('forwards a real HTTP service with SSH refused, and answers again on the same port after a link drop', async () => {
      const port = await boot(twin)
      const conn = new DaemonConnection('joined-box', { hostname: 'joined-box.walnut-net.invalid', via: 'net', endpoint: '60d53783dcf0c6e95fe6c2ff390fd3131d42a167eecee7eac15e57e69ed36f5b' })
      conns.push(conn)
      const inner = conn as unknown as ConnInternals
      const sshExec = vi.spyOn(inner, 'sshExec').mockRejectedValue(new Error('SSH certificate expired'))
      /** Make a real socket to the daemon this connection's session link (what connect() leaves behind). */
      const attach = async () => {
        const { ws, caps } = await rawLink(port)
        vi.spyOn(conn, 'hasCapability').mockImplementation((cap) => caps.includes(cap))
        ws.on('message', (data: Buffer) => {
          try { inner.streamEndpoint().handle(JSON.parse(data.toString()) as Record<string, unknown>) } catch { /* not a frame */ }
        })
        ws.on('close', () => inner.streams?.closeAll('the link to joined-box closed'))
        inner.ws = ws
        return ws
      }
      const first = await attach()

      const body = Buffer.alloc(1024 * 1024 + 9)
      for (let i = 0; i < body.length; i++) body[i] = (i * 29) & 0xff
      let held: http.ServerResponse | null = null
      const svc = http.createServer((req, res) => {
        if (req.url === '/bin') res.end(body)
        else if (req.url === '/hold') { held = res; res.write('part') }
        else res.end(`ok ${req.url}`)
      })
      servers.push(svc as unknown as net.Server)
      await new Promise<void>((r) => svc.listen(0, '127.0.0.1', () => r()))
      const svcPort = (svc.address() as net.AddressInfo).port

      const local = await conn.ensurePortForward(svcPort, 'localhost', { evictable: true })
      expect((await httpGet(local, '/a?b=1')).body.toString()).toBe('ok /a?b=1')
      expect((await httpGet(local, '/bin')).body.equals(body)).toBe(true)
      const parallel = await Promise.all(Array.from({ length: 6 }, (_, i) => httpGet(local, `/p${i}`)))
      expect(parallel.map((r) => r.body.toString())).toEqual(Array.from({ length: 6 }, (_, i) => `ok /p${i}`))
      await expect(conn.ensurePortForward(svcPort, 'joined-box.example.test', { evictable: true })).rejects.toThrow(/only its own loopback/)

      // The link drops mid-answer: the browser's connection is cut, the listener stays.
      const cut = httpGet(local, '/hold')
      expect(await waitFor(() => held !== null)).toBe(true)
      first.close()
      await expect(cut).rejects.toThrow()
      await attach()
      expect(await conn.ensurePortForward(svcPort, 'localhost', { evictable: true })).toBe(local)
      expect((await httpGet(local, '/again')).body.toString()).toBe('ok /again')

      expect(sshSpawns).toEqual([])
      expect(sshExec).not.toHaveBeenCalled()
    }, 90_000)
  })
}

describe('port-stream-v1 wiring in both twins', () => {
  const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '../..', p), 'utf8')
  const twins = { standalone: read('src/providers/daemon-standalone.ts'), source: read('src/providers/daemon-source.ts') }

  it('each twin opens a port stream only for its own server socket, and gives the relay a loopback connect', () => {
    for (const src of Object.values(twins)) {
      const at = src.indexOf("if (cmd.to === 'port')")
      expect(at).toBeGreaterThan(-1)
      const branch = src.slice(at, at + 400)
      // The role check comes first, then the relay's own port and host checks.
      expect(branch.indexOf('isServerClient(ws)')).toBeGreaterThan(-1)
      expect(branch.indexOf('isServerClient(ws)')).toBeLessThan(branch.indexOf('streamRelay.openPort('))
      expect(src.match(/streamRelay\.openPort\(/g)).toHaveLength(1)
      expect(src).toMatch(/connect: [^\n]*net\.connect\(\{ port[^\n]*allowHalfOpen: true/)
    }
  })
})
