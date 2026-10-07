/**
 * The bridge over wss:// on every daemon runtime booted for real (gate
 * 2026-10-06: no test dialed a twin over TLS, so a change that put TLS on a
 * socket still looking up its host name passed every test while each JS
 * daemon crashed with SIGSEGV on its first wss dial).
 *
 * Each twin dials wss://localhost against a local TLS cloud whose certificate
 * is made at runtime (openssl) and trusted through NODE_EXTRA_CA_CERTS, then:
 * the link works (SNI, a reply cut into chunks no bigger than the size the
 * daemon agreed to), a certificate it was not told to trust is refused with
 * the daemon still up, and a dead wss link is given up and redialed. The JS
 * clients reset the dead link's TCP socket; Bun 1.3.9 ends neither a closed
 * nor a terminated wss socket (see abandonBridgeSocket in
 * daemon-standalone.ts), so that check is the JS twins' only. Without a bun
 * binary the Bun row is reported as skipped, with the reason in its name.
 *
 * MACHINE SAFETY: HOME, the daemon dir, the streams dir and the certificate
 * are temp paths; the cloud and the link are local servers; daemons are
 * SIGKILLed after each test.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { guardedPath } from '../setup/exec-guard.js'

const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
const WS_PACKAGE_DIR = path.dirname(createRequire(import.meta.url).resolve('ws/package.json'))

let srcDir = ''
let certDir = ''
let certFile = ''
let keyFile = ''
type Twin = { name: string; wsClient: string; resets: boolean; skip: boolean; command: () => [string, string[]] }
const TWINS: Twin[] = [
  { name: 'source twin, no ws package', wsClient: 'builtin', resets: true, skip: false, command: () => [process.execPath, [path.join(srcDir, 'plain/daemon.cjs'), '--start']] },
  { name: 'source twin, ws package installed', wsClient: 'ws', resets: true, skip: false, command: () => [process.execPath, [path.join(srcDir, 'withws/daemon.cjs'), '--start']] },
  // Without bun this row is reported as skipped, never dropped.
  {
    name: BUN ? 'standalone twin (bun)' : 'standalone twin (bun), SKIPPED: no bun in BUN_INSTALL/bin, ~/.bun/bin, /opt/homebrew/bin or /usr/local/bin',
    wsClient: 'bun', resets: false, skip: !BUN, command: () => [BUN!, [STANDALONE, '--start']],
  },
]

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
let procExit: { code: number | null; signal: NodeJS.Signals | null } | null = null
let port = 0
const closers: Array<() => Promise<void> | void> = []

beforeAll(async () => {
  srcDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-wss-src-')))
  const source = getDaemonSource()
  for (const d of ['plain', 'withws']) {
    fs.mkdirSync(path.join(srcDir, d))
    fs.writeFileSync(path.join(srcDir, d, 'daemon.cjs'), source, { mode: 0o755 })
  }
  fs.mkdirSync(path.join(srcDir, 'withws/node_modules'))
  fs.symlinkSync(WS_PACKAGE_DIR, path.join(srcDir, 'withws/node_modules/ws'))
  expect(() => createRequire(path.join(srcDir, 'plain/daemon.cjs')).resolve('ws')).toThrow()
  // A throwaway certificate for localhost, made here and never stored in the
  // repo. RSA: Bun 1.3.9 refused the EC certificate LibreSSL makes.
  certDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-wss-cert-')))
  certFile = path.join(certDir, 'cert.pem')
  keyFile = path.join(certDir, 'key.pem')
  await promisify(execFile)('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE',
  ], { timeout: 60_000 })
}, 90_000)
afterAll(() => {
  for (const d of [srcDir, certDir]) if (d) fs.rmSync(d, { recursive: true, force: true })
})

async function boot(twin: Twin, extraEnv: Record<string, string>): Promise<void> {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-wss-')))
  const home = path.join(root, 'home')
  const streams = path.join(root, 'streams')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(streams, { recursive: true })
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: guardedPath([], '/usr/bin:/bin'),
    HOME: home,
    NODE_PATH: undefined,
    NODE_EXTRA_CA_CERTS: undefined,
    WALNUT_DAEMON_DIR: path.join(root, 'daemon'),
    WALNUT_STREAMS_DIR: streams,
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'),
    ...extraEnv,
  }
  const [cmd, args] = twin.command()
  procExit = null
  proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  proc.on('exit', (code, signal) => { procExit = { code, signal } })
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

let nextCtlId = 1
async function ctlRpc(ctl: WebSocket, cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextCtlId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${String(cmd.cmd)} timeout`)), 10_000)
    const on = (d: Buffer) => {
      const m = JSON.parse(String(d)) as Record<string, unknown>
      if (m.id === id) { clearTimeout(timer); ctl.off('message', on); resolve(m) }
    }
    ctl.on('message', on)
    ctl.send(JSON.stringify({ id, ...cmd }))
  })
}

/** The daemon is still running (a crashed one has an exit record). */
function daemonAlive(): boolean {
  return procExit === null && proc !== null && proc.exitCode === null && proc.signalCode === null
}

/**
 * A TLS cloud that behaves like the replica: it asks a new link for 256 KB
 * chunks, reassembles them, answers every bridge-ping marker, records the SNI
 * of every TLS handshake, and can ask for a file.
 */
async function startCloud() {
  const server = https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) })
  const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 * 1024 })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  let nextId = 1000
  const cloud = {
    port: (server.address() as net.AddressInfo).port,
    dials: 0,
    sni: [] as Array<string | null>,
    hellos: [] as number[],
    /** The id of the bridge.peer request sent on each link, in order. */
    peerIds: [] as number[],
    replies: new Map<number, Record<string, unknown>>(),
    /** How many chunks each chunked reply arrived in, by reply id. */
    chunksOf: new Map<number, number>(),
    /** The biggest frame the daemon wrote, in bytes. */
    maxFrameBytes: 0,
    conns: [] as WebSocket[],
    request(cmd: Record<string, unknown>): number {
      const id = nextId++
      cloud.conns[cloud.conns.length - 1].send(JSON.stringify({ id, ...cmd }))
      return id
    },
  }
  server.on('connection', () => { cloud.dials++ })
  server.on('secureConnection', (s) => { cloud.sni.push(s.servername || null) })
  server.on('tlsClientError', () => { /* an untrusting client hangs up mid-handshake */ })
  wss.on('connection', (ws) => {
    cloud.conns.push(ws)
    ws.on('error', () => {})
    const parts = new Map<string, string[]>()
    ws.on('message', (data) => {
      cloud.maxFrameBytes = Math.max(cloud.maxFrameBytes, (data as Buffer).length)
      let f: Record<string, unknown>
      try { f = JSON.parse(data.toString()) } catch { return }
      let chunks = 0
      if (f.ev === 'chunk') {
        const got = parts.get(f.cid as string) ?? []
        got[f.i as number] = f.part as string
        parts.set(f.cid as string, got)
        if (got.filter((p) => p !== undefined).length !== f.n) return
        parts.delete(f.cid as string)
        chunks = f.n as number
        f = JSON.parse(got.join('')) as Record<string, unknown>
      }
      if (f.ev === 'hello') {
        cloud.hellos.push(Date.now())
        const id = nextId++
        cloud.peerIds.push(id)
        ws.send(JSON.stringify({ id, cmd: 'bridge.peer', chunkBytes: 256 * 1024 }))
      } else if (f.ev === 'bridge-ping') {
        try { ws.send(JSON.stringify({ id: nextId++, cmd: 'ping', ackSeq: f.seq })) } catch { /* closed */ }
      } else if (typeof f.id === 'number') {
        cloud.replies.set(f.id, f)
        if (chunks > 0) cloud.chunksOf.set(f.id, chunks)
      }
    })
  })
  closers.push(() => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(); server.closeAllConnections(); server.close(() => r()) }))
  return cloud
}

/**
 * A TCP link in front of the cloud: TLS runs end to end through it.
 * blackhole() kills every open flow (it reads and drops, never carries or
 * closes anything again), and each flow notes how the daemon ended its side:
 * with a reset (ECONNRESET) or a FIN (null).
 */
async function startLink(targetPort: number) {
  type Flow = { client: net.Socket; up: net.Socket; dead: boolean; endedAt: number | null; endedWith: string | null }
  const flows: Flow[] = []
  const server = net.createServer((client) => {
    const up = net.connect({ port: targetPort, host: '127.0.0.1' })
    const flow: Flow = { client, up, dead: false, endedAt: null, endedWith: null }
    flows.push(flow)
    client.on('data', (b) => { if (!flow.dead) up.write(b) })
    up.on('data', (b) => { if (!flow.dead) client.write(b) })
    client.on('end', () => { if (flow.endedAt == null) flow.endedAt = Date.now() })
    client.on('error', (err: NodeJS.ErrnoException) => { if (flow.endedAt == null) { flow.endedWith = err.code ?? 'error'; flow.endedAt = Date.now() } })
    client.on('close', () => { if (!flow.dead) up.destroy() })
    up.on('close', () => { if (!flow.dead) client.destroy() })
    up.on('error', () => {})
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const link = {
    port: (server.address() as net.AddressInfo).port,
    flows,
    blackhole() { for (const f of flows) f.dead = true },
    close: () => new Promise<void>((r) => { for (const f of flows) { f.client.destroy(); f.up.destroy() } server.close(() => r()) }),
  }
  closers.push(link.close)
  return link
}

// A plain title, not describe.each's $name, which cuts a long name short (the
// skip reason with it).
for (const twin of TWINS) describe(`bridge over wss: ${twin.name}`, () => {
  it.skipIf(twin.skip)('dials wss://localhost with SNI, trusts the certificate it was given, and serves a chunked reply', async () => {
    const file = path.join(root || fs.realpathSync(os.tmpdir()), `walnut-wss-${process.pid}-${Date.now()}.bin`)
    fs.writeFileSync(file, crypto.randomBytes(256 * 1024))
    closers.push(() => fs.rmSync(file, { force: true }))
    const cloud = await startCloud()
    await boot(twin, { NODE_EXTRA_CA_CERTS: certFile })
    const ctl = await connect(port)
    const reply = await ctlRpc(ctl, { cmd: 'bridge.configure', enabled: true, url: `wss://localhost:${cloud.port}/bridge`, token: 't', hostAlias: 'devbox' })
    expect(reply.ok).toBe(true)
    await waitFor(() => cloud.hellos.length >= 1 || !daemonAlive(), 20_000, 'the first hello over wss')
    expect(procExit, 'the daemon died dialing wss').toBeNull()
    expect(cloud.hellos).toHaveLength(1)
    expect(cloud.sni[0]).toBe('localhost')
    await waitFor(() => cloud.replies.has(cloud.peerIds[0]), 10_000, 'the answer to bridge.peer')
    const chunkBytes = Number(cloud.replies.get(cloud.peerIds[0])!.chunkBytes)
    expect(chunkBytes, 'the daemon turned chunking off').toBeGreaterThan(0)

    const id = cloud.request({ cmd: 'fs.readBounded', path: file })
    await waitFor(() => cloud.replies.has(id), 20_000, 'the reply over wss')
    const got = cloud.replies.get(id)!
    expect(got.ok).toBe(true)
    expect(Buffer.from(String(got.data), 'base64').equals(fs.readFileSync(file))).toBe(true)
    // The reply (over 340 KB of base64) came as chunks no bigger than the
    // size the daemon agreed to, and was put back together whole.
    expect(cloud.chunksOf.get(id), 'the reply arrived unchunked').toBeGreaterThanOrEqual(2)
    expect(cloud.maxFrameBytes).toBeLessThanOrEqual(chunkBytes)
    expect(daemonLog(/^bridge-conn-open$/).map((r) => r.wsClient)).toEqual([twin.wsClient])
    expect(daemonAlive()).toBe(true)
  }, 60_000)

  it.skipIf(twin.skip)('refuses a certificate it was not told to trust, and stays up', async () => {
    const cloud = await startCloud()
    await boot(twin, {})
    const ctl = await connect(port)
    await ctlRpc(ctl, { cmd: 'bridge.configure', enabled: true, url: `wss://localhost:${cloud.port}/bridge`, token: 't', hostAlias: 'devbox' })
    // At least one dial reached the cloud, so the refusal is the client's.
    await waitFor(() => cloud.dials >= 1 || !daemonAlive(), 15_000, 'a dial from the daemon')
    await sleep(1_500)
    expect(procExit, 'the daemon died dialing wss').toBeNull()
    expect(cloud.hellos).toHaveLength(0)
    const status = await ctlRpc(ctl, { cmd: 'bridge.status' })
    expect(status.connected).toBe(false)
    expect(daemonAlive()).toBe(true)
  }, 60_000)

  it.skipIf(twin.skip)('gives a dead wss link up and redials; the JS clients reset its TCP socket', async () => {
    const cloud = await startCloud()
    const link = await startLink(cloud.port)
    await boot(twin, { NODE_EXTRA_CA_CERTS: certFile, WALNUT_BRIDGE_PING_MS: '300' })
    const ctl = await connect(port)
    await ctlRpc(ctl, { cmd: 'bridge.configure', enabled: true, url: `wss://localhost:${link.port}/bridge`, token: 't', hostAlias: 'devbox' })
    await waitFor(() => cloud.hellos.length >= 1 || !daemonAlive(), 20_000, 'the first hello over wss')
    expect(procExit, 'the daemon died dialing wss').toBeNull()
    await sleep(600)

    link.blackhole()
    await waitFor(() => daemonLog(/inbound silence/).length >= 1, 10_000, 'the watchdog to give up')
    const gaveUpAt = Date.parse(String(daemonLog(/inbound silence/)[0].ts))
    if (twin.resets) {
      await waitFor(() => link.flows[0].endedAt != null, 5_000, 'the daemon to end the wss flow it gave up on')
      expect(link.flows[0].endedAt! - gaveUpAt).toBeLessThan(2_000)
      expect(link.flows[0].endedWith, 'the wss flow given up on ended with a FIN, not a reset').toBe('ECONNRESET')
    }
    await waitFor(() => cloud.hellos.length >= 2, 15_000, 'the redial over wss')
    expect(cloud.sni.filter((s) => s === 'localhost').length).toBeGreaterThanOrEqual(2)
    expect(daemonAlive()).toBe(true)
  }, 60_000)
})
