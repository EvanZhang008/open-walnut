/**
 * A busy bridge on a slow link, on every daemon runtime booted for real (gate
 * 2026-10-04).
 *
 * 1. On a busy link the answers to the daemon's markers are the only frames it
 *    hears, and its watchdog tears the link down three pings after the last
 *    one. A marker followed every SECOND 256 KB chunk, so a link slower than
 *    two chunks per watchdog window was torn down mid-transfer, redialed and
 *    torn down again: a 2 MB reply at 8 KB/s never arrived (9 connections in
 *    420 s). Then a marker followed every chunk, but a chunk was as large as
 *    the replica asked (256 KB), so a 60 s dip to 2 KB/s still dropped the
 *    link twice (gate 2026-10-05). Now no more than 64 KB goes out between two
 *    markers, whatever chunk size the replica asks for.
 * 2. A link the daemon gives up on must be reset. The JS twin dialed with
 *    Node's global WebSocket, which has no terminate(): close() waits for a
 *    close handshake that never finishes on a dead path, so the old flow stayed
 *    open, and on a shared slow link it kept draining. Then it destroyed the
 *    socket, and the kernel still sent what it had buffered before the FIN
 *    (gate 2026-10-05: 8 dials, 7 drops, no reply behind a slow link). Now
 *    both Node clients reset the TCP socket, and so does Bun's terminate() on
 *    ws:// (these links are ws://). On wss:// Bun 1.3.9 ends nothing; see
 *    daemon-bridge-wss-twins-e2e.test.ts and abandonBridgeSocket.
 *
 * Runtimes: the source twin with no ws package (its own client), the source
 * twin with the ws package next to it (as deploySource installs it on a remote
 * host), and the bun twin.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths; the
 * "cloud" is a local ws server; the links are local proxies; daemons are
 * SIGKILLed after each test.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { BRIDGE_WATCHDOG, bridgeSilenceTeardownMs } from '../../src/providers/daemon-core.js'

const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
const WS_PACKAGE_DIR = path.dirname(createRequire(import.meta.url).resolve('ws/package.json'))

let srcDir = ''
type Twin = { name: string; wsClient: string; command: () => [string, string[]] }
const TWINS: Twin[] = [
  { name: 'source twin, no ws package', wsClient: 'builtin', command: () => [process.execPath, [path.join(srcDir, 'plain/daemon.cjs'), '--start']] },
  { name: 'source twin, ws package installed', wsClient: 'ws', command: () => [process.execPath, [path.join(srcDir, 'withws/daemon.cjs'), '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', wsClient: 'bun', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]

/** The chunk size this cloud asks for: what replicas asked before 2026-10-05. */
const ASKED_CHUNK = 256 * 1024
/** The most the daemon sends between two markers (markerEveryBytes in bridge-uplink-core.ts). */
const MARKER_RUN = 64 * 1024
/**
 * The bridge ping interval and the link's rate. The bytes between two markers
 * cross in 2.2 pings: inside the watchdog's 3-ping window with most of a ping
 * to spare, while one chunk of the size asked for (8.8 pings) is far past its
 * latest teardown (bridgeSilenceTeardownMs). The gate's dip (2 KB/s against a
 * 45 s window) sat between the two the same way.
 */
const PING = 1_200
const RATE = Math.round(MARKER_RUN / (2.2 * PING / 1000))

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
    await sleep(20)
  }
}

let root = ''
let proc: ChildProcess | null = null
let port = 0
const closers: Array<() => Promise<void> | void> = []

beforeAll(() => {
  srcDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-slowlink-src-')))
  const source = getDaemonSource()
  for (const d of ['plain', 'withws']) {
    fs.mkdirSync(path.join(srcDir, d))
    fs.writeFileSync(path.join(srcDir, d, 'daemon.cjs'), source, { mode: 0o755 })
  }
  fs.mkdirSync(path.join(srcDir, 'withws/node_modules'))
  fs.symlinkSync(WS_PACKAGE_DIR, path.join(srcDir, 'withws/node_modules/ws'))
  // The plain case is only meaningful if nothing above it resolves ws.
  expect(() => createRequire(path.join(srcDir, 'plain/daemon.cjs')).resolve('ws')).toThrow()
})
afterAll(() => { if (srcDir) fs.rmSync(srcDir, { recursive: true, force: true }) })

async function boot(twin: Twin, extraEnv: Record<string, string>): Promise<void> {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-slowlink-')))
  const home = path.join(root, 'home')
  const streams = path.join(root, 'streams')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(streams, { recursive: true })
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: '/usr/bin:/bin',
    HOME: home,
    NODE_PATH: undefined,
    WALNUT_DAEMON_DIR: path.join(root, 'daemon'),
    WALNUT_STREAMS_DIR: streams,
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'),
    ...extraEnv,
  }
  const [cmd, args] = twin.command()
  proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc!.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc!.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })
}

/** The daemon's own log records whose msg matches `re`. */
function daemonLog(re: RegExp): Array<Record<string, unknown>> {
  const dir = path.join(root, 'daemon')
  const out: Array<Record<string, unknown>> = []
  for (const f of fs.readdirSync(dir).filter((n) => /^daemon-.*\.log$/.test(n))) {
    for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!l) continue
      try { const r = JSON.parse(l) as Record<string, unknown>; if (re.test(String(r.msg))) out.push(r) } catch { /* not a record */ }
    }
  }
  return out
}

afterEach(async () => {
  for (const c of closers.splice(0).reverse()) { try { await c() } catch { /* already gone */ } }
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 10_000)
      proc!.once('exit', () => { clearTimeout(t); resolve() })
    })
    proc.kill('SIGKILL')
    await exited
  }
  proc = null
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

async function connect(toPort: number): Promise<WebSocket> {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${toPort}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
  closers.push(() => { try { ws.terminate() } catch { /* closed */ } })
  return ws
}

async function configureBridge(daemonPort: number, cloudPort: number): Promise<void> {
  const ctl = await connect(daemonPort)
  const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bridge.configure timeout')), 10_000)
    ctl.on('message', (d) => { const m = JSON.parse(String(d)) as Record<string, unknown>; if (m.id === 1) { clearTimeout(timer); resolve(m) } })
    ctl.send(JSON.stringify({ id: 1, cmd: 'bridge.configure', enabled: true, url: `ws://127.0.0.1:${cloudPort}/bridge`, token: 't', hostAlias: 'devbox' }))
  })
  expect(reply.ok).toBe(true)
}

/**
 * A link between the daemon and the cloud. Daemon-to-cloud bytes cross one
 * bottleneck shared by every flow, in arrival order, at `rate` bytes a second
 * (unlimited when 0); the other way is free. A flow reads at most 64 KB ahead
 * of the bottleneck, so the rest waits in the daemon. blackhole() kills every
 * open flow: it takes bytes and never carries or closes anything again, like
 * a path that died. Each flow notes when the daemon ended its side and how:
 * with a reset (ECONNRESET) or with a FIN (null).
 */
async function startLink(targetPort: number, rate: number) {
  type Flow = { client: net.Socket; up: net.Socket; dead: boolean; queued: number; daemonEndedAt: number | null; daemonEndedWith: string | null; carried: number }
  const flows: Flow[] = []
  const queue: Array<{ flow: Flow; buf: Buffer }> = []
  const AHEAD = 64 * 1024
  const server = net.createServer((client) => {
    const up = net.connect({ port: targetPort, host: '127.0.0.1' })
    const flow: Flow = { client, up, dead: false, queued: 0, daemonEndedAt: null, daemonEndedWith: null, carried: 0 }
    flows.push(flow)
    client.on('data', (b) => {
      if (flow.dead) return
      if (!rate) { up.write(b); flow.carried += b.length; return }
      queue.push({ flow, buf: b })
      flow.queued += b.length
      if (flow.queued > AHEAD) client.pause()
    })
    up.on('data', (b) => { if (!flow.dead) client.write(b) })
    const ended = () => { if (flow.daemonEndedAt == null) flow.daemonEndedAt = Date.now() }
    client.on('end', ended)
    client.on('close', () => { ended(); if (!flow.dead) up.destroy() })
    up.on('close', () => { if (!flow.dead) client.destroy() })
    client.on('error', (err: NodeJS.ErrnoException) => { if (flow.daemonEndedAt == null) flow.daemonEndedWith = err.code ?? 'error'; ended() })
    up.on('error', () => {})
  })
  let last = Date.now()
  let budget = 0
  const pump = setInterval(() => {
    const now = Date.now()
    budget += (now - last) * rate / 1000
    last = now
    while (queue.length > 0 && budget > 0) {
      const head = queue[0]
      const n = Math.min(head.buf.length, Math.ceil(budget))
      if (!head.flow.dead && !head.flow.up.destroyed) head.flow.up.write(head.buf.subarray(0, n))
      head.flow.carried += n
      budget -= n
      head.flow.queued -= n
      if (n === head.buf.length) queue.shift(); else head.buf = head.buf.subarray(n)
      if (head.flow.queued <= AHEAD / 2) head.flow.client.resume()
    }
    if (queue.length === 0) budget = Math.min(budget, rate / 50)
  }, 20)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const link = {
    port: (server.address() as net.AddressInfo).port,
    flows,
    blackhole() { for (const f of flows) f.dead = true },
    close: () => new Promise<void>((r) => { clearInterval(pump); for (const f of flows) { f.client.destroy(); f.up.destroy() } server.close(() => r()) }),
  }
  closers.push(link.close)
  return link
}

/**
 * A fake cloud companion that behaves like the replica: it asks a new link to
 * cut frames into chunks (bridge.peer), reassembles them, answers every
 * bridge-ping marker with a ping RPC that echoes its seq, and can ask for a file.
 */
async function startCloud() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', maxPayload: 64 * 1024 * 1024 })
  await new Promise<void>((resolve) => wss.on('listening', () => resolve()))
  let nextId = 1000
  const cloud = {
    port: (wss.address() as net.AddressInfo).port,
    hellos: [] as number[],
    closes: [] as number[],
    answers: [] as number[],
    largestChunk: 0,
    mute: false,
    replies: new Map<number, Record<string, unknown>>(),
    conns: [] as WebSocket[],
    request(cmd: Record<string, unknown>): number {
      const id = nextId++
      cloud.conns[cloud.conns.length - 1].send(JSON.stringify({ id, ...cmd }))
      return id
    },
  }
  wss.on('connection', (ws) => {
    cloud.conns.push(ws)
    const parts = new Map<string, string[]>()
    ws.on('close', () => cloud.closes.push(Date.now()))
    ws.on('message', (data) => {
      let f: Record<string, unknown>
      try { f = JSON.parse(data.toString()) } catch { return }
      if (f.ev === 'chunk') {
        cloud.largestChunk = Math.max(cloud.largestChunk, Buffer.byteLength(data as Buffer))
        const got = parts.get(f.cid as string) ?? []
        got[f.i as number] = f.part as string
        parts.set(f.cid as string, got)
        if (got.filter((p) => p !== undefined).length !== f.n) return
        parts.delete(f.cid as string)
        f = JSON.parse(got.join('')) as Record<string, unknown>
      }
      if (f.ev === 'hello') {
        cloud.hellos.push(Date.now())
        ws.send(JSON.stringify({ id: nextId++, cmd: 'bridge.peer', chunkBytes: ASKED_CHUNK }))
      } else if (f.ev === 'bridge-ping') {
        if (cloud.mute) return
        try { ws.send(JSON.stringify({ id: nextId++, cmd: 'ping', ackSeq: f.seq })); cloud.answers.push(Date.now()) } catch { /* closed */ }
      } else if (typeof f.id === 'number') {
        cloud.replies.set(f.id, f)
      }
    })
  })
  closers.push(() => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()) }))
  return cloud
}

describe.each(TWINS)('bridge on a slow link: $name', (twin) => {
  it('a large reply crosses a busy slow link without a teardown', async () => {
    const bound = bridgeSilenceTeardownMs({ ...BRIDGE_WATCHDOG, pingIntervalMs: PING })
    // The case sits where it matters: the bytes between two markers fit the
    // window, one chunk of the size the cloud asks for does not.
    expect(MARKER_RUN / RATE * 1000).toBeLessThan(bound.minMs - PING / 2)
    expect(ASKED_CHUNK / RATE * 1000).toBeGreaterThan(bound.maxMs + PING / 2)

    const file = path.join(fs.realpathSync(os.tmpdir()), `walnut-slowlink-${process.pid}-${Date.now()}.bin`)
    fs.writeFileSync(file, crypto.randomBytes(256 * 1024))
    closers.push(() => fs.rmSync(file, { force: true }))
    const cloud = await startCloud()
    const link = await startLink(cloud.port, RATE)
    await boot(twin, { WALNUT_BRIDGE_PING_MS: String(PING) })
    await configureBridge(port, link.port)
    await waitFor(() => cloud.hellos.length >= 1, 15_000, 'the first hello')
    await sleep(500)

    const t0 = Date.now()
    const id = cloud.request({ cmd: 'fs.readBounded', path: file })
    // About 350 KB of base64 at RATE: some 15 s; the bound leaves room for a loaded machine.
    await waitFor(() => cloud.replies.has(id) || cloud.closes.length > 0, 60_000, 'the reply')
    const reply = cloud.replies.get(id)
    expect(cloud.closes, 'the link was torn down mid-transfer').toHaveLength(0)
    expect(reply?.ok).toBe(true)
    expect(Buffer.from(String(reply!.data), 'base64').equals(fs.readFileSync(file))).toBe(true)
    // It really was slow and busy: many chunks, each answered, none over 64 KB.
    expect(Date.now() - t0).toBeGreaterThan(4 * MARKER_RUN / RATE * 1000)
    expect(cloud.answers.length).toBeGreaterThanOrEqual(5)
    expect(cloud.largestChunk).toBeGreaterThan(MARKER_RUN / 2)
    expect(cloud.largestChunk).toBeLessThanOrEqual(MARKER_RUN)
    expect(cloud.hellos).toHaveLength(1)
    expect(daemonLog(/inbound silence/)).toHaveLength(0)
    expect(daemonLog(/^bridge-conn-open$/).map((r) => r.wsClient)).toEqual([twin.wsClient])
  }, 120_000)

  it('resets a link it gave up on, so the dead flow does not stay open or drain', async () => {
    const cloud = await startCloud()
    const link = await startLink(cloud.port, 0)
    await boot(twin, { WALNUT_BRIDGE_PING_MS: '300' })
    await configureBridge(port, link.port)
    await waitFor(() => cloud.hellos.length >= 1, 15_000, 'the first hello')
    await sleep(600)

    link.blackhole()
    await waitFor(() => daemonLog(/inbound silence/).length >= 1, 10_000, 'the watchdog to give up')
    const gaveUpAt = Date.parse(String(daemonLog(/inbound silence/)[0].ts))
    expect(Number.isFinite(gaveUpAt)).toBe(true)
    // close() would wait for a close handshake the dead path never carries.
    await waitFor(() => link.flows[0].daemonEndedAt != null, 5_000, 'the daemon to end the flow it gave up on')
    expect(link.flows[0].daemonEndedAt! - gaveUpAt).toBeLessThan(2_000)
    // With a reset, not a FIN: behind a FIN the kernel first sends everything
    // the socket buffered, which on a slow shared link starves the redial.
    expect(link.flows[0].daemonEndedWith, 'the flow given up on ended with a FIN, not a reset').toBe('ECONNRESET')
    // The redial gets a new flow, and the bridge is back.
    await waitFor(() => cloud.hellos.length >= 2, 10_000, 'the redial')
  }, 60_000)
})
