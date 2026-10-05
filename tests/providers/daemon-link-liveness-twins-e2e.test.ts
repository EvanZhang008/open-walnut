/**
 * Dead links, on both daemon twins booted for real (connection matrix
 * 2026-10-02, gate 2026-10-03).
 *
 * 1. The cloud bridge goes silent and the old flow never draws a reset (a
 *    middlebox dropped it: matrix B7/H7). The watchdog used to only call
 *    close() and wait for onclose to redial; Node's WebSocket close handshake
 *    has no timeout, so the source twin never redialed. It also took 77 to
 *    105 s to notice. Now: after a ping interval with nothing heard the daemon
 *    pings, and when the third ping is due with still nothing it tears the
 *    link down and redials by itself.
 * 2. A trusted client goes silent: an SSH forward that died on the far side
 *    while sshd keeps this end open ACKs every byte and never resets (gate P5).
 *    Both twins ping every trusted client each beat and close one nothing was
 *    heard from for 8 beats in a row, and relays then reach the live client.
 *    The bridge adapter is never one of those clients.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths; the
 * "cloud" is a local ws server; proxies are local; daemons are SIGKILLed
 * after each test.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { BRIDGE_WATCHDOG, bridgeSilenceTeardownMs } from '../../src/providers/daemon-core.js'

const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
let scriptPath = ''
type Twin = { name: string; command: () => [string, string[]] }
const SOURCE_TWIN: Twin = { name: 'source twin (node)', command: () => [process.execPath, [scriptPath, '--start']] }
const BUN_TWIN: Twin | null = BUN ? { name: 'standalone twin (bun)', command: () => [BUN, [STANDALONE, '--start']] } : null
const TWINS: Twin[] = [SOURCE_TWIN, ...(BUN_TWIN ? [BUN_TWIN] : [])]

/** The trusted-client beat and the bridge ping interval the tests run at. */
const BEAT = 200
const PING = 300

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-liveness-src-'))
  scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
})
afterAll(() => { fs.rmSync(path.dirname(scriptPath), { recursive: true, force: true }) })

async function boot(twin: Twin, extraEnv: Record<string, string>): Promise<void> {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-liveness-')))
  const home = path.join(root, 'home')
  const streams = path.join(root, 'streams')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(streams, { recursive: true })
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: '/usr/bin:/bin',
    HOME: home,
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

/** The daemon's own log lines matching `re`. */
function daemonLog(re: RegExp): string[] {
  const dir = path.join(root, 'daemon')
  const out: string[] = []
  for (const f of fs.readdirSync(dir).filter((n) => /^daemon-.*\.log$/.test(n))) {
    for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (l && re.test(l)) out.push(l)
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

let rpcId = 1
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

/**
 * A WebSocket client that completes the handshake, then reads frames and never
 * sends a byte: no pong, no frame. It counts the pings it is sent and notes
 * when the daemon closes it.
 */
async function muteClient(toPort: number) {
  const sock = net.connect(toPort, '127.0.0.1')
  const state = { pings: 0, closedAt: null as number | null, openedAt: 0 }
  let buf = Buffer.alloc(0)
  let open = false
  await new Promise<void>((resolve, reject) => {
    sock.on('error', reject)
    sock.on('connect', () => {
      sock.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${toPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`)
    })
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (!open) {
        const end = buf.indexOf('\r\n\r\n')
        if (end < 0) return
        if (!/^HTTP\/1\.1 101/.test(buf.subarray(0, end).toString())) { reject(new Error('no upgrade')); return }
        buf = buf.subarray(end + 4)
        open = true
        state.openedAt = Date.now()
        resolve()
      }
      // Server frames are unmasked: opcode, length, payload.
      while (buf.length >= 2) {
        let len = buf[1] & 0x7f
        let off = 2
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4 } else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10 }
        if (buf.length < off + len) break
        if ((buf[0] & 0x0f) === 0x09) state.pings++
        buf = buf.subarray(off + len)
      }
    })
  })
  sock.on('close', () => { if (state.closedAt == null) state.closedAt = Date.now() })
  sock.on('error', () => {})
  closers.push(() => { sock.destroy() })
  // A FIN and nothing more: the socket stays half-open until the daemon ends its side.
  return Object.assign(state, { end: () => { sock.end() } })
}

/**
 * A TCP proxy that can blackhole: every pair open at blackhole() stops carrying
 * bytes in both directions and is never closed, by either end's bytes or by
 * anything else. Like sshd's end of a dead forward, a dead pair takes every
 * byte and never closes its side, not even when the daemon closes its own (a
 * daemon that only ends its half keeps the socket for good). New connections
 * pass again after pass(), the old ones stay dead.
 */
async function startProxy(targetPort: number) {
  const pairs: Array<{ client: net.Socket; up: net.Socket; dead: boolean; upEndedAt: number | null }> = []
  let accepting = true
  const server = net.createServer((client) => {
    const up = net.connect({ port: targetPort, host: '127.0.0.1', allowHalfOpen: true })
    const pair = { client, up, dead: !accepting, upEndedAt: null as number | null }
    pairs.push(pair)
    client.on('data', (b) => { if (!pair.dead) up.write(b) })
    up.on('data', (b) => { if (!pair.dead) client.write(b) })
    // A dead pair never forwards a close either: the far end must find out by itself.
    client.on('close', () => { if (!pair.dead) up.destroy() })
    up.on('end', () => { pair.upEndedAt = Date.now(); if (!pair.dead) up.end() })
    up.on('close', () => { if (!pair.dead) client.destroy() })
    client.on('error', () => {})
    up.on('error', () => {})
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const proxyPort = (server.address() as net.AddressInfo).port
  const proxy = {
    port: proxyPort,
    pairs,
    blackhole() { accepting = false; for (const p of pairs) p.dead = true },
    pass() { accepting = true },
    close: () => new Promise<void>((r) => { for (const p of pairs) { p.client.destroy(); p.up.destroy() } server.close(() => r()) }),
  }
  closers.push(proxy.close)
  return proxy
}

/**
 * A fake cloud companion: answers the daemon's bridge-ping markers (as the
 * replica does) unless muted, counts hellos and pings, notes when a connection
 * closes, and can send an stt request down the newest connection.
 */
async function startCloud() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((resolve) => wss.on('listening', () => resolve()))
  const cloud = {
    port: 0,
    hellos: [] as number[],
    pings: [] as number[],
    answers: [] as number[],
    closes: [] as number[],
    mute: false,
    conns: [] as import('ws').WebSocket[],
    sendStt() { const c = cloud.conns[cloud.conns.length - 1]; c.send(JSON.stringify({ id: nextId++, cmd: 'stt', audio: 'AAAA', format: 'webm' })) },
  }
  let nextId = 1
  wss.on('connection', (ws) => {
    cloud.conns.push(ws)
    ws.on('close', () => cloud.closes.push(Date.now()))
    ws.on('message', (data) => {
      let f: Record<string, unknown>
      try { f = JSON.parse(data.toString()) } catch { return }
      if (f.ev === 'hello') cloud.hellos.push(Date.now())
      if (f.ev === 'bridge-ping') {
        cloud.pings.push(Date.now())
        if (cloud.mute) return
        try { ws.send(JSON.stringify({ id: nextId++, cmd: 'ping', ackSeq: f.seq })); cloud.answers.push(Date.now()) } catch { /* closed */ }
      }
    })
  })
  cloud.port = (wss.address() as net.AddressInfo).port
  closers.push(() => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()) }))
  return cloud
}

async function configureBridge(ctl: WebSocket, cloudPort: number): Promise<void> {
  const conf = await rpc(ctl, { cmd: 'bridge.configure', enabled: true, url: `ws://127.0.0.1:${cloudPort}/bridge`, token: 't', hostAlias: 'devbox' })
  expect(conf.ok).toBe(true)
}

describe.each(TWINS)('bridge silence watchdog: $name', (twin) => {
  it('a blackholed bridge link is torn down and redialed without waiting for its close', async () => {
    const cloud = await startCloud()
    const proxy = await startProxy(cloud.port)
    await boot(twin, { WALNUT_BRIDGE_PING_MS: String(PING) })
    const ctl = await connect(port)
    await configureBridge(ctl, proxy.port)
    await waitFor(() => cloud.hellos.length >= 1, 15_000, 'the first hello')
    // A healthy link is not torn down: the cloud answers every marker.
    await sleep(6 * PING)
    expect(cloud.hellos.length).toBe(1)

    const t0 = Date.now()
    proxy.blackhole()
    await sleep(200)
    proxy.pass()
    // Silence (3 pings, 0.9 to 1 s) + the first redial (about 1 s) + slack.
    await waitFor(() => cloud.hellos.length >= 2, 10_000, 'a redial after the silence teardown')
    expect(cloud.hellos[1] - t0).toBeLessThan(8_000)
    // The old flow is still dead and was never closed by the proxy: the daemon
    // redialed on its own instead of waiting for that close.
    expect(proxy.pairs[0].dead).toBe(true)
    const status = await rpc(ctl, { cmd: 'bridge.status' })
    expect(status.connected).toBe(true)
  }, 60_000)

  it('pings a quiet bridge, and gives up when the third ping is due with nothing heard', async () => {
    const cloud = await startCloud()
    await boot(twin, { WALNUT_BRIDGE_PING_MS: String(PING) })
    const ctl = await connect(port)
    await configureBridge(ctl, cloud.port)
    await waitFor(() => cloud.hellos.length >= 1, 15_000, 'the first hello')
    // Quiet but answering: pinged about once an interval, never torn down.
    await sleep(8 * PING)
    expect(cloud.answers.length).toBeGreaterThanOrEqual(4)
    expect(cloud.closes).toHaveLength(0)

    cloud.mute = true
    const lastAnswer = cloud.answers[cloud.answers.length - 1]
    await waitFor(() => cloud.closes.length >= 1, 10_000, 'the watchdog to give up on the muted link')
    // Exactly two unanswered pings, then the close where the third was due.
    expect(cloud.pings.filter((t) => t > lastAnswer)).toHaveLength(2)
    const silentFor = cloud.closes[0] - lastAnswer
    expect(silentFor).toBeGreaterThanOrEqual(3 * PING - 50)
    expect(silentFor).toBeLessThan(3 * PING + PING / 3 + 1_000)
    // The daemon logs the least silence it tears down at, which the bridge
    // monitor reads (bridgeSilenceTeardownMs, what the monitor is checked against).
    const bound = bridgeSilenceTeardownMs({ ...BRIDGE_WATCHDOG, pingIntervalMs: PING })
    const lines = daemonLog(/"msg":"bridge: inbound silence/).map((l) => JSON.parse(l) as { limitMs?: number; silentMs?: number })
    expect(lines).toHaveLength(1)
    expect(lines[0].limitMs).toBe(bound.minMs)
    expect(lines[0].silentMs).toBeGreaterThanOrEqual(bound.minMs - 50)
    cloud.mute = false
    await waitFor(() => cloud.hellos.length >= 2, 10_000, 'the redial')
  }, 60_000)
})

describe.each(TWINS)('trusted client keepalive: $name', (twin) => {
  it('closes a client that never answers on the 8th silent beat, and keeps one that answers', async () => {
    await boot(twin, { WALNUT_TRUSTED_CLIENT_BEAT_MS: String(BEAT) })
    const live = await connect(port)
    let livePings = 0
    live.on('ping', () => { livePings++ })
    const mute = await muteClient(port)
    await waitFor(() => mute.closedAt != null, 15_000, 'the daemon to close the mute client')
    // Pinged on beats 1 to 8, closed on the 9th: not a beat sooner or later.
    expect(mute.pings).toBe(8)
    expect(mute.closedAt! - mute.openedAt).toBeGreaterThanOrEqual(8 * BEAT - 50)
    expect(daemonLog(/client silent, closing it/)).toHaveLength(1)

    // The live client only answered pings (said nothing of its own) and is still served.
    expect(livePings).toBeGreaterThanOrEqual(8)
    const r = await rpc(live, { cmd: 'ping' })
    expect(r.ok).toBe(true)
    expect(live.readyState).toBe(WebSocket.OPEN)
  }, 60_000)

  it('never closes the bridge as a silent client', async () => {
    const cloud = await startCloud()
    await boot(twin, { WALNUT_TRUSTED_CLIENT_BEAT_MS: String(BEAT) })
    const ctl = await connect(port)
    await configureBridge(ctl, cloud.port)
    await waitFor(() => cloud.hellos.length >= 1, 15_000, 'the first hello')
    // Well past 8 beats. The bridge itself pings every 15 s here, so the cloud says nothing.
    await sleep(16 * BEAT)
    expect(cloud.closes).toHaveLength(0)
    expect(cloud.hellos).toHaveLength(1)
    expect(daemonLog(/client silent, closing it/)).toHaveLength(0)
  }, 60_000)

  // Gate P5 (2026-10-03): the dead client came first and the JS twin never
  // closed it, so every relay went into it (165 s and on).
  it('closes a dead first client that still takes bytes, and relays then reach the live one', async () => {
    const cloud = await startCloud()
    await boot(twin, { WALNUT_TRUSTED_CLIENT_BEAT_MS: String(BEAT) })
    const proxy = await startProxy(port)
    await connect(proxy.port)
    const live = await connect(port)
    const liveGot: number[] = []
    live.on('message', (m) => { if (String(m).includes('stt-request')) liveGot.push(Date.now()) })
    await configureBridge(live, cloud.port)
    await waitFor(() => cloud.hellos.length >= 1, 15_000, 'the first hello')
    await sleep(3 * BEAT)

    const t0 = Date.now()
    proxy.blackhole()
    await waitFor(() => proxy.pairs[0].upEndedAt != null, 30 * BEAT, 'the daemon to close the dead client')
    // Its last pong came just before the blackhole: 8 silent beats from there.
    expect(proxy.pairs[0].upEndedAt! - t0).toBeGreaterThanOrEqual(7 * BEAT)
    cloud.sendStt()
    await waitFor(() => liveGot.length > 0, 5_000, 'the stt relay to reach the live client')
  }, 60_000)

  // Gate 2026-10-04: the JS twin's socket wrapper listened only for close and
  // error, so a client that half-closed (sent its FIN and nothing else) stayed
  // in wsClients until the keepalive's 8 beats ran out.
  it('drops a client that half-closes at once, without waiting for the keepalive', async () => {
    await boot(twin, {})
    const live = await connect(port)
    const fin = await muteClient(port)
    await waitFor(() => daemonLog(/"msg":"client connected"/).length >= 2, 5_000, 'both clients to be connected')
    fin.end()
    await waitFor(() => fin.closedAt != null, 5_000, 'the daemon to close the half-closed socket')
    await waitFor(() => daemonLog(/"msg":"client disconnected"/).length >= 1, 5_000, 'the daemon to drop the client')
    const left = daemonLog(/"msg":"client disconnected"/).map((l) => JSON.parse(l) as { clients?: number })
    expect(left).toHaveLength(1)
    expect(left[0].clients).toBe(1)
    expect(live.readyState).toBe(WebSocket.OPEN)
  }, 60_000)
})
