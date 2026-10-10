/**
 * A host server end to end (docs/plan/walnut-servers-everywhere.md, "A server on
 * a host" and "One kind of link"), without SSH: a real daemon (the source twin,
 * a process), the real host server program (in this process), and stand-ins for
 * the Mac and the companion that link to the daemon the way the real ones do.
 *
 *   browser ──► host server public port ─┐ follower link (loopback)
 *                                         ▼
 *   fake Mac ── trusted link ──► real daemon ◄── bridge (the daemon dials) ── fake companion
 *      │ its stream end                                                         │ its stream end
 *      ▼                                                                        ▼
 *   the Mac's door (an echo server)                                  the companion's door
 *
 * Nothing connects to anything but the daemon: every byte between the host
 * server and the Mac or the companion rides a stream the daemon passes from one
 * link to the other. What's checked:
 *   - with the Mac linked, requests (large ones too) and WebSockets go to it unchanged;
 *   - the Mac gone, the first request finds out and goes on to the companion,
 *     under the companion's own Host and Origin;
 *   - neither, the alone page (HTML) or a 503 `leader_away` (API, WebSocket);
 *   - the Mac back, browsers reach it again;
 *   - the Mac's stream to the host server reaches its status and its copy door;
 *   - the Mac sets the tunnel through the daemon, and a tunnel in front of the
 *     public port reaches the Mac; the server's report comes back to the Mac.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { createStreamEndpoint, spliceStream, type StreamEndpoint } from '../../src/lib/link-stream.js'
import { startHostServer, type HostServer } from '../../src/host-server/main.js'
import { StreamLane, type LaneForward } from '../../src/providers/stream-lane.js'

const HOME = '/fixture/mac-home'
const WALNUT = 'wmachostsrv1'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(fn: () => T | Promise<T>, ms: number, label: string): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting for ' + label)
    await sleep(100)
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) })
  })
}

function listen(server: http.Server | net.Server, port = 0): Promise<number> {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
}

/** A door that says what reached it, echoes bodies, can send a big answer, and echoes WebSockets. */
function door(name: string) {
  const seen: Array<{ method: string; url: string; host?: string; origin?: string; via?: string; xff?: string; bytes: number }> = []
  const server = http.createServer((req, res) => {
    let bytes = 0
    const parts: Buffer[] = []
    req.on('data', (c: Buffer) => { bytes += c.length; if (parts.length < 4) parts.push(c) })
    req.on('end', () => {
      seen.push({
        method: req.method!, url: req.url!, host: req.headers.host, origin: req.headers.origin,
        via: req.headers['x-walnut-via'] as string | undefined, xff: req.headers['x-forwarded-for'] as string | undefined, bytes,
      })
      if (req.url?.startsWith('/big')) {
        const n = Number(new URL(req.url, 'http://x').searchParams.get('n'))
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': n })
        const chunk = Buffer.alloc(64 * 1024, 7)
        let left = n
        const pump = () => {
          while (left > 0) {
            const piece = chunk.subarray(0, Math.min(chunk.length, left))
            left -= piece.length
            if (!res.write(piece)) { res.once('drain', pump); return }
          }
          res.end()
        }
        pump()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-from': name })
      res.end(JSON.stringify({ from: name, url: req.url, bytes, head: Buffer.concat(parts).subarray(0, 32).toString() }))
    })
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/ws-refused')) { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return }
    wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (m) => ws.send(`${name}:${String(m)}`)))
  })
  return { server, seen }
}

let base = ''
let daemonPid = 0
let daemon: ChildProcess | null = null
let daemonPort = 0
let placeholderPid = 0
let macDoor: ReturnType<typeof door>
let companionDoor: ReturnType<typeof door>
let macDoorPort = 0
let companionDoorPort = 0
let companionBridge: http.Server
let companionBridgePort = 0
let companionSockets = new Set<WebSocket>()
let hostServer: HostServer | null = null
let publicPort = 0
let tunnelPid = 0

/** The fake Mac: a trusted link to the daemon, its stream end plugged into its door. */
interface Mac { ws: WebSocket; streams: StreamEndpoint; beat: ReturnType<typeof setInterval>; cmd: (body: Record<string, unknown>) => Promise<Record<string, any>>; streamFrames: () => number }
let mac: Mac | null = null

let cmdId = 1
async function linkMac(): Promise<Mac> {
  const ws = new WebSocket(`ws://127.0.0.1:${daemonPort}`)
  await new Promise((r) => ws.once('open', r))
  const pending = new Map<number, (m: Record<string, any>) => void>()
  const streams = createStreamEndpoint({
    send: (frame) => ws.send(JSON.stringify(frame)),
    accept: (info) => (info.from === 'follower' ? (s) => spliceStream(s, net.connect(macDoorPort, '127.0.0.1')) : null),
  })
  let streamFrames = 0
  ws.on('message', (data) => {
    let m: Record<string, any>
    try { m = JSON.parse(String(data)) } catch { return }
    if (streams.handle(m)) { streamFrames++; return }
    const p = typeof m.id === 'number' ? pending.get(m.id) : undefined
    if (p) { pending.delete(m.id); p(m) }
  })
  ws.on('close', () => streams.closeAll('closed'))
  const cmd = (body: Record<string, unknown>) => new Promise<Record<string, any>>((resolve, reject) => {
    const id = cmdId++
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`cmd ${body.cmd} timed out`)) }, 15_000)
    pending.set(id, (m) => { clearTimeout(t); resolve(m) })
    ws.send(JSON.stringify({ id, ...body }))
  })
  // A live Mac is heard all the time.
  const beat = setInterval(() => { try { ws.send(JSON.stringify({ id: 0, cmd: 'ping' })) } catch { /* closed */ } }, 1_000)
  expect((await cmd({ cmd: 'leader.configure', home: HOME, walnutId: WALNUT, backup: true })).ok).toBe(true)
  return { ws, streams, beat, cmd, streamFrames: () => streamFrames }
}

function unlinkMac(): void {
  if (!mac) return
  clearInterval(mac.beat)
  mac.ws.close()
  mac = null
}

/** The fake companion's /bridge: the daemon dials it; its stream end is plugged into its door. */
function startCompanionBridge(): http.Server {
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end() })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      companionSockets.add(ws)
      const streams = createStreamEndpoint({
        send: (frame) => ws.send(JSON.stringify(frame)),
        accept: (info) => (info.from === 'follower' ? (s) => spliceStream(s, net.connect(companionDoorPort, '127.0.0.1')) : null),
      })
      let id = 1_000_000
      ws.on('message', (data) => {
        let m: Record<string, any>
        try { m = JSON.parse(String(data)) } catch { return }
        if (streams.handle(m)) return
        // Keep the daemon's paced uplink open, the way the real companion does.
        if (m.ev === 'bridge-ping') ws.send(JSON.stringify({ id: id++, cmd: 'ping', ...(typeof m.seq === 'number' ? { ackSeq: m.seq } : {}) }))
      })
      ws.on('close', () => { companionSockets.delete(ws); streams.closeAll('closed') })
    })
  })
  return server
}

/** A GET with exactly these headers (fetch would not send our Host: a tunnel in front of it does). */
function get(pathname: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: Headers }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: publicPort, path: pathname, headers, agent: false }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        const h = new Headers()
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') h.set(k, v)
        resolve({ status: res.statusCode ?? 0, body, headers: h })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function wsEcho(url: string, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const t = setTimeout(() => { ws.terminate(); reject(new Error('ws timeout')) }, 10_000)
    ws.on('open', () => ws.send(text))
    ws.on('message', (m) => { clearTimeout(t); ws.close(); resolve(String(m)) })
    ws.on('unexpected-response', (_req, res) => { clearTimeout(t); resolve(`status ${res.statusCode}`) })
    ws.on('error', (e) => { clearTimeout(t); reject(e) })
  })
}

/** One request from the Mac to the host server, on a stream through the daemon. */
async function macAsks(method: string, route: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const stream = await mac!.streams.open('follower', { purpose: 'test' })
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = http.request({
      method, path: route, headers: { host: 'host-server', ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) },
      createConnection: () => stream,
    } as http.RequestOptions, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text || '{}') }))
    })
    req.on('error', reject)
    req.end(data ?? undefined)
  })
}

const baseSpec = () => ({
  v: 1, home: HOME, walnutId: WALNUT, command: process.execPath,
  // The daemon's server is a stand-in that hands this test the token it was started with;
  // the host server itself runs in this process.
  args: ['-e', `require('fs').writeFileSync(${JSON.stringify(path.join(base, 'token'))}, process.env.WALNUT_FOLLOWER_TOKEN + ' ' + process.pid); setInterval(() => {}, 1 << 30)`],
  cwd: base, env: {}, log: path.join(base, 'placeholder.log'), port: publicPort,
  settings: { expose: { enabled: false, definition: null, options: {} }, exposeRetry: 0 },
})

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'hse-'))
  const daemonDir = path.join(base, 'd')
  fs.mkdirSync(daemonDir)
  macDoor = door('mac')
  companionDoor = door('companion')
  macDoorPort = await listen(macDoor.server)
  companionDoorPort = await listen(companionDoor.server)
  companionBridge = startCompanionBridge()
  companionBridgePort = await listen(companionBridge)

  const env: NodeJS.ProcessEnv = {
    ...process.env, WALNUT_DAEMON_DIR: daemonDir, WALNUT_STREAMS_DIR: path.join(daemonDir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(daemonDir, 'spawn-journal.jsonl'),
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  const script = path.join(daemonDir, 'daemon.cjs')
  fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
  daemon = spawn(process.execPath, [script, '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  if (process.env.DEBUG_DAEMON) daemon.stderr?.on('data', (b) => process.stderr.write(b))
  await waitFor(() => fs.existsSync(path.join(daemonDir, 'daemon.port')) && fs.existsSync(path.join(daemonDir, 'daemon.pid')), 60_000, 'daemon')
  daemonPid = Number(fs.readFileSync(path.join(daemonDir, 'daemon.pid'), 'utf8'))
  daemonPort = Number(fs.readFileSync(path.join(daemonDir, 'daemon.port'), 'utf8'))

  mac = await linkMac()
  expect((await mac.cmd({ cmd: 'bridge.configure', enabled: true, url: `ws://127.0.0.1:${companionBridgePort}/bridge`, token: 't', hostAlias: 'devbox' })).ok).toBe(true)
  await waitFor(() => companionSockets.size > 0, 20_000, 'the daemon to dial the companion')
  publicPort = await freePort()
  expect((await mac.cmd({ cmd: 'server.configure', home: HOME, spec: baseSpec() })).ok).toBe(true)
  const [token, pid] = (await waitFor(() => { try { return fs.readFileSync(path.join(base, 'token'), 'utf8') } catch { return '' } }, 20_000, 'the token')).split(' ')
  placeholderPid = Number(pid)

  hostServer = await startHostServer({
    env: { publicPort, daemonDir, leaderHome: HOME, walnutId: WALNUT, followerToken: token!, label: 'devbox' },
  })
}, 120_000)

afterAll(async () => {
  try { if (mac) await mac.cmd({ cmd: 'server.configure', home: HOME, spec: null }) } catch { /* gone */ }
  await hostServer?.stop().catch(() => undefined)
  unlinkMac()
  for (const pid of [tunnelPid, placeholderPid, daemonPid]) {
    if (pid > 1) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
  }
  macDoor?.server.close()
  companionDoor?.server.close()
  companionBridge?.close()
  for (const s of companionSockets) s.terminate()
  await sleep(500)
  fs.rmSync(base, { recursive: true, force: true })
})

describe('a host server, linked to its daemon only', () => {
  it('with the Mac linked, sends every request and WebSocket to it as they came', async () => {
    await waitFor(() => hostServer!.route().kind === 'leader', 20_000, 'the leader route')
    const r = await get('/api/tasks?x=1', { host: 'devbox-tunnel.example', origin: 'https://devbox-tunnel.example', authorization: 'Bearer tok' })
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body)).toMatchObject({ from: 'mac', url: '/api/tasks?x=1' })
    expect(r.headers.get('x-walnut-answered-via')).toBe('leader')
    expect(macDoor.seen.at(-1)).toMatchObject({ host: 'devbox-tunnel.example', origin: 'https://devbox-tunnel.example', via: 'host-server', xff: '127.0.0.1' })
    const post = await fetch(`http://127.0.0.1:${publicPort}/api/v1/browser-pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'ABCD-EFGH' }) })
    expect(await post.json()).toMatchObject({ from: 'mac', head: JSON.stringify({ code: 'ABCD-EFGH' }) })
    expect(await wsEcho(`ws://127.0.0.1:${publicPort}/ws`, 'hello')).toBe('mac:hello')
    // A refused upgrade comes back as the target said.
    expect(await wsEcho(`ws://127.0.0.1:${publicPort}/ws-refused`, 'x')).toBe('status 401')
  })

  it('carries large bodies both ways through the daemon, several at once', async () => {
    const up = Buffer.alloc(3 * 1024 * 1024, 1)
    const [posted, big, big2] = await Promise.all([
      fetch(`http://127.0.0.1:${publicPort}/upload`, { method: 'POST', body: up }).then((r) => r.json()),
      fetch(`http://127.0.0.1:${publicPort}/big?n=${6 * 1024 * 1024}`).then(async (r) => (await r.arrayBuffer()).byteLength),
      fetch(`http://127.0.0.1:${publicPort}/big?n=${2 * 1024 * 1024 + 3}`).then(async (r) => (await r.arrayBuffer()).byteLength),
    ])
    expect(posted).toMatchObject({ from: 'mac', bytes: up.length })
    expect(big).toBe(6 * 1024 * 1024)
    expect(big2).toBe(2 * 1024 * 1024 + 3)
  }, 60_000)

  it('the Mac reaches the host server on a stream: its status and its copy door, no credential', async () => {
    const status = await macAsks('GET', '/host-api/status')
    expect(status.status).toBe(200)
    expect(status.json).toMatchObject({ ok: true, port: publicPort, route: { kind: 'leader' }, daemon: { state: 'following' } })
    // The copy door answers (an unknown step is refused by the store, not by a credential check).
    const copy = await macAsks('POST', '/bridge/replica', { op: 'nope' })
    expect(copy).toEqual({ status: 400, json: { ok: false, error: 'unknown_op' } })
    // And its report reaches the Mac through the daemon.
    const reported = await waitFor(async () => {
      const r = await mac!.cmd({ cmd: 'server.status', home: HOME })
      return r.status?.report ? r.status : null
    }, 15_000, 'the report')
    expect(reported.report).toMatchObject({ route: { kind: 'leader' }, port: publicPort })
  })

  it('the Mac gone, the first request finds out and goes on to the companion under its own name', async () => {
    unlinkMac()
    const r = await get('/api/tasks', { origin: 'https://devbox-tunnel.example' })
    expect(JSON.parse(r.body)).toMatchObject({ from: 'companion' })
    expect(companionDoor.seen.at(-1)).toMatchObject({
      host: `127.0.0.1:${companionBridgePort}`, origin: `http://127.0.0.1:${companionBridgePort}`, via: 'host-server', xff: '127.0.0.1',
    })
    expect(hostServer!.route().kind).toBe('companion')
    expect(await wsEcho(`ws://127.0.0.1:${publicPort}/ws`, 'hi')).toBe('companion:hi')
  })

  it('neither answering, says so: a page, a 503 for the API and for a WebSocket', async () => {
    for (const s of companionSockets) s.terminate()
    companionBridge.close()
    await waitFor(() => hostServer!.route().kind === 'alone', 15_000, 'alone')
    // A page of its own (host-server/alone-page.ts): it names nothing until a device token holds.
    const page = await get('/', { accept: 'text/html' })
    expect(page.status).toBe(200)
    expect(page.body).toContain('Walnut on devbox')
    expect(page.body).toContain('data-why="nobody-answers"')
    expect(page.body).toContain('Neither your Mac nor your cloud companion is answering')
    expect(page.headers.get('content-security-policy')).toMatch(/script-src 'nonce-/)
    const api = await get('/api/tasks')
    expect(api.status).toBe(503)
    expect(JSON.parse(api.body).error.code).toBe('leader_away')
    expect(await wsEcho(`ws://127.0.0.1:${publicPort}/ws`, 'x')).toBe('status 503')
  })

  it('the Mac back, browsers reach it again', async () => {
    mac = await linkMac()
    await waitFor(() => hostServer!.route().kind === 'leader', 15_000, 'the leader route again')
    expect(JSON.parse((await get('/api/tasks')).body)).toMatchObject({ from: 'mac' })
  })

  it('with a lane, the big bytes ride it, not the session link; a lane that drops costs the session link nothing, and requests wait for it', async () => {
    // The lane's forward: a TCP hop to the daemon that can die, as an SSH connection does on a bad packet.
    let kill: () => void = () => {}
    let opened = 0
    const forward = async (): Promise<LaneForward> => {
      opened++
      const conns = new Set<net.Socket>()
      const hop = net.createServer((c) => {
        const u = net.connect(daemonPort, '127.0.0.1')
        conns.add(c); conns.add(u)
        c.pipe(u).pipe(c)
        c.on('error', () => u.destroy()); u.on('error', () => c.destroy())
        c.on('close', () => u.destroy()); u.on('close', () => c.destroy())
      })
      const port = await listen(hop)
      let exit: ((why: string) => void) | null = null
      const end = () => { for (const s of conns) s.destroy(); hop.close() }
      kill = () => { end(); exit?.('Corrupted MAC on input') }
      return { port, onExit: (cb) => { exit = cb }, stop: end }
    }
    const lane = new StreamLane({
      hostKey: 'devbox', home: HOME, walnutId: async () => WALNUT, daemonInstanceId: () => null, forward,
      accept: (info) => (info.from === 'follower' ? (st) => spliceStream(st, net.connect(macDoorPort, '127.0.0.1')) : null),
      beatMs: 1_000,
    })
    try {
      lane.start()
      await waitFor(() => lane.ready, 10_000, 'the lane')
      const before = mac!.streamFrames()
      const up = Buffer.alloc(3 * 1024 * 1024, 2)
      const [posted, big] = await Promise.all([
        fetch(`http://127.0.0.1:${publicPort}/upload`, { method: 'POST', body: up }).then((r) => r.json()),
        fetch(`http://127.0.0.1:${publicPort}/big?n=${6 * 1024 * 1024}`).then(async (r) => (await r.arrayBuffer()).byteLength),
      ])
      expect(posted).toMatchObject({ from: 'mac', bytes: up.length })
      expect(big).toBe(6 * 1024 * 1024)
      // The Mac's own stream to the host server, on the lane.
      const stream = await lane.open('follower', 'test')
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({ path: '/host-api/status', headers: { host: 'host-server' }, createConnection: () => stream } as http.RequestOptions, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) })
        req.on('error', reject)
        req.end()
      })
      expect(status).toBe(200)
      expect(mac!.streamFrames()).toBe(before)

      // The lane's connection dies: the session link stays, the lane dials again at once, and a
      // browser's request asked for meanwhile waits for it instead of taking the session link.
      kill()
      await waitFor(() => !lane.ready, 5_000, 'the lane down')
      expect(mac!.ws.readyState).toBe(WebSocket.OPEN)
      const r = await get('/api/tasks?after=lane')
      expect(JSON.parse(r.body)).toMatchObject({ from: 'mac', url: '/api/tasks?after=lane' })
      expect(opened).toBe(2)
      expect(mac!.streamFrames()).toBe(before)
      expect(hostServer!.route().kind).toBe('leader')

      // A lane that does not come back: after a short wait, browsers go on over the session link.
      lane.stop()
      const r2 = await get('/api/tasks?no=lane')
      expect(JSON.parse(r2.body)).toMatchObject({ from: 'mac', url: '/api/tasks?no=lane' })
      expect(mac!.streamFrames()).toBeGreaterThan(before)
    } finally {
      lane.stop()
    }
  }, 60_000)

  it('runs the tunnel the Mac sets through the daemon, in front of the public port, and stops it', async () => {
    const fake = path.join(base, 'fake-tunnel.cjs')
    const pidFile = path.join(base, 'tunnel.pid')
    fs.writeFileSync(fake, `
const net = require('node:net'); const fs = require('node:fs')
const target = Number(process.argv[2])
const s = net.createServer((c) => { const u = net.connect(target, '127.0.0.1'); c.pipe(u).pipe(c); c.on('error', () => u.destroy()); u.on('error', () => c.destroy()) })
s.listen(0, '127.0.0.1', () => { fs.writeFileSync(process.argv[3], String(process.pid)); console.log('Public: http://127.0.0.1:' + s.address().port); setTimeout(() => console.log('Connected!'), 200) })
process.on('SIGTERM', () => process.exit(0))
`)
    const definition = {
      id: 'faketunnel', title: 'Fake tunnel', command: process.execPath, args: [fake, '{port}', pidFile, '{name}'],
      options: [{ key: 'name', label: 'Name', default: 'walnut', pattern: '[a-z]+' }],
      urlPattern: 'http://127\\.0\\.0\\.1:\\d+', readyPattern: 'connected!', probe: false,
    }
    const on = { ...baseSpec(), settings: { expose: { enabled: true, definition, options: { name: 'devbox' } }, exposeRetry: 0 } }
    const reply = await mac!.cmd({ cmd: 'server.configure', home: HOME, spec: on })
    // Settings change, nothing restarts.
    expect(reply.status).toMatchObject({ state: 'running', pid: placeholderPid })
    const connected = await waitFor(async () => {
      const s = (await macAsks('GET', '/host-api/status')).json.expose
      return s.state === 'connected' ? s : null
    }, 30_000, 'the tunnel')
    expect(connected).toMatchObject({ enabled: true, provider: 'faketunnel', port: publicPort })
    tunnelPid = Number(fs.readFileSync(pidFile, 'utf8'))
    const through = await fetch(`${connected.url}/api/tasks`)
    expect(await through.json()).toMatchObject({ from: 'mac' })
    const off = { ...on, settings: { expose: { enabled: false, definition, options: { name: 'devbox' } }, exposeRetry: 0 } }
    await mac!.cmd({ cmd: 'server.configure', home: HOME, spec: off })
    await waitFor(() => { try { process.kill(tunnelPid, 0); return false } catch { return true } }, 15_000, 'the tunnel to stop')
  }, 60_000)
})
