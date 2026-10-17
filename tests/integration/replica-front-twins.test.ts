/**
 * A host replica's front against both daemon twins, every piece a real process
 * (docs/plan/walnut-replica-servers-impl.md, WP2): the daemon (the source twin
 * under node, the standalone twin under bun) supervises a real `web --replica`
 * child that it started from `server.configure` (a tsx boot spec, with the plain
 * host server as its fallback); a stand-in Mac links to the daemon over WS the
 * way the real one does (leader.configure, streams to its door).
 *
 *   browser --> replica public port --+ follower link (loopback)
 *                                     v
 *   stand-in Mac -- trusted link --> real daemon --spawns--> web --replica (tsx)
 *      | its stream end
 *      v
 *   the Mac's door (an echo server)
 *
 * Checked, with LEADER_QUIET_MS=6000 on the daemon (the replica reads the window
 * from the daemon's follower view): the first report reaches the daemon within
 * 5 s of the front starting; GET, POST, a 4 MB body and a WebSocket are
 * forwarded to the Mac; the Mac paused with `ws._socket.pause()` (a sleeping
 * Mac keeps its socket open and silent): inside the window the daemon still
 * refuses a follower write (`leader_answers`), past it a GET is answered on the
 * replica's copies (`x-walnut-offline`), a write the journal does not take is 503 needs_leader, the daemon
 * lets a follower write past its leader check, and the WebSocket spliced to the
 * Mac is closed with 4001; the Mac awake again, the replica's own sockets close
 * with 4002 and requests reach the Mac. Then a replica build that crashes only
 * when away: with the Mac paused the daemon itself switches to the host server
 * after 3 exits, and the front door answers; `server.status` says `fallback`.
 *
 * The boot script is the test's: it runs the CLI's own `runWeb({replica:true})`
 * and opens a loopback probe (presence, a follower write over the replica's own
 * link) the test reads. Isolation: one temp base for HOME, data, run and daemon
 * dirs; PATH leads with a `claude` that refuses to run; every process is reaped
 * in afterAll (the daemon's server group by the daemon, then any pid left).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { createStreamEndpoint, spliceStream, type StreamEndpoint } from '../../src/lib/link-stream.js'
import { BUN, freePort, waitFor } from '../helpers/host-alone-harness.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const TSX_CLI = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const HOME = '/fixture/marina-mac-home'
const WALNUT = 'b7c6d5e4f3a2918071625344a5b6c7d8'
const QUIET_MS = 6_000
const PHONE_TOKEN = 'acme-phone-' + 'q'.repeat(40)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const sha256 = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')

/** Runs the CLI's own entry as a host replica, then a probe the test reads. */
const BOOT = `
const fs = await import('node:fs')
const http = await import('node:http')
const { runWeb } = await import(${JSON.stringify(path.join(ROOT, 'src/commands/web.ts'))})
await runWeb({ replica: true, dev: true })
const { getHostReplicaFront } = await import(${JSON.stringify(path.join(ROOT, 'src/web/server.ts'))})
const front = getHostReplicaFront()
if (!front) { process.stderr.write('NO FRONT\\n'); process.exit(4) }
// A build that crashes only when away (the fallback case): exits once the view says the Mac is away.
if (process.env.REPLICA_CRASH_WHEN_AWAY === '1') {
  setInterval(() => { const p = front.presence(); if (!p.answers && p.why !== 'no-daemon') { process.stderr.write('CRASH: away\\n'); process.exit(1) } }, 200)
}
const probe = http.createServer(async (req, res) => {
  const out = (b) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)) }
  if (req.url === '/presence') return out(front.presence())
  if (req.url === '/follower-send') {
    try { out(await front.link.request('follower.send', { sid: 'cccccccc-0000-4000-8000-000000000001', text: 'hi' }, 5000)) } catch (e) { out({ ok: false, error: String(e) }) }
    return
  }
  res.writeHead(404); res.end()
})
probe.listen(0, '127.0.0.1', () => fs.writeFileSync(process.env.REPLICA_PROBE_FILE, String(probe.address().port)))
`

/** The Mac's door: says what reached it, echoes bodies (their size), echoes WebSockets. */
function macDoor() {
  const seen: Array<{ method: string; url: string; bytes: number; opId?: string; forwardedAt?: string }> = []
  const server = http.createServer((req, res) => {
    let bytes = 0
    req.on('data', (c: Buffer) => { bytes += c.length })
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, bytes, opId: req.headers['x-walnut-op-id'] as string | undefined, forwardedAt: req.headers['x-walnut-forwarded-at'] as string | undefined })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ from: 'mac', url: req.url, bytes }))
    })
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (m) => ws.send(`mac:${String(m)}`))))
  return { server, seen }
}

interface Mac { ws: WebSocket; streams: StreamEndpoint; beat: ReturnType<typeof setInterval> | null; cmd: (body: Record<string, unknown>) => Promise<Record<string, any>> }

let cmdId = 1
async function linkMac(daemonPort: number, doorPort: number): Promise<Mac> {
  const ws = new WebSocket(`ws://127.0.0.1:${daemonPort}`)
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
  const pending = new Map<number, (m: Record<string, any>) => void>()
  const streams = createStreamEndpoint({
    send: (frame) => ws.send(JSON.stringify(frame)),
    accept: (info) => (info.from === 'follower' ? (s) => spliceStream(s, net.connect(doorPort, '127.0.0.1')) : null),
  })
  ws.on('message', (data) => {
    let m: Record<string, any>
    try { m = JSON.parse(String(data)) } catch { return }
    if (streams.handle(m)) return
    const p = typeof m.id === 'number' ? pending.get(m.id) : undefined
    if (p) { pending.delete(m.id); p(m) }
  })
  ws.on('close', () => streams.closeAll('closed'))
  ws.on('error', () => { /* closed below */ })
  const cmd = (body: Record<string, unknown>) => new Promise<Record<string, any>>((resolve, reject) => {
    const id = cmdId++
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`cmd ${String(body.cmd)} timed out`)) }, 15_000)
    pending.set(id, (m) => { clearTimeout(t); resolve(m) })
    ws.send(JSON.stringify({ id, ...body }))
  })
  const mac: Mac = { ws, streams, beat: null, cmd }
  mac.beat = setInterval(() => { try { ws.send(JSON.stringify({ id: 0, cmd: 'ping' })) } catch { /* closed */ } }, 1_000)
  const configured = await cmd({ cmd: 'leader.configure', home: HOME, walnutId: WALNUT, backup: true })
  if (!configured.ok) throw new Error('leader.configure: ' + JSON.stringify(configured))
  return mac
}

/** A sleeping Mac: its socket stays open, nothing comes from it and nothing it is sent is read. */
function pauseMac(mac: Mac): void {
  if (mac.beat) clearInterval(mac.beat)
  mac.beat = null
  ;(mac.ws as unknown as { _socket: { pause(): void } })._socket.pause()
}
function wakeMac(mac: Mac): void {
  ;(mac.ws as unknown as { _socket: { resume(): void } })._socket.resume()
  mac.beat = setInterval(() => { try { mac.ws.send(JSON.stringify({ id: 0, cmd: 'ping' })) } catch { /* closed */ } }, 1_000)
}

/** One HTTP request to a port, these headers exactly. */
function call(port: number, method: string, p: string, opts: { body?: Buffer | string; headers?: Record<string, string> } = {}): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? null : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body)
    const req = http.request({ host: '127.0.0.1', port, method, path: p, agent: false, headers: { ...(data ? { 'content-length': String(data.length) } : {}), ...opts.headers } }, (res) => {
      const parts: Buffer[] = []
      res.on('data', (c: Buffer) => parts.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(parts).toString('utf8'), headers: res.headers }))
    })
    req.on('error', reject)
    req.end(data ?? undefined)
  })
}

/** A request from the Mac to the replica's leader door, on a stream through the daemon. */
async function macAsks(mac: Mac, method: string, route: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const stream = await mac.streams.open('follower', { purpose: 'test' })
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = http.request({
      method, path: route, headers: { host: 'host-server', ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) },
      createConnection: () => stream,
    } as http.RequestOptions, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => { try { resolve({ status: res.statusCode ?? 0, json: JSON.parse(text || '{}') }) } catch { resolve({ status: res.statusCode ?? 0, json: { text } }) } })
    })
    req.on('error', reject)
    req.end(data ?? undefined)
  })
}

/** Descendants of `pid` (tsx runs the server in a node child). */
function childPids(pid: number): number[] {
  let direct: number[] = []
  try { direct = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number) } catch { return [] }
  return direct.flatMap((c) => [c, ...childPids(c)])
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

interface Rig {
  base: string; daemonDir: string; daemon: ChildProcess; daemonPid: number; daemonPort: number
  door: ReturnType<typeof macDoor>; doorPort: number; mac: Mac; publicPort: number
  /** Every server pid the daemon started for this test (the replica's tree, the fallback's). */
  serverPids: Set<number>
}

function replicaDirs(base: string) {
  const home = path.join(base, 'home')
  const d = { home, data: path.join(home, '.open-walnut-host', 'data'), run: path.join(home, '.open-walnut-host', 'run'), hsRun: path.join(base, 'hs-run'), bin: path.join(home, 'bin') }
  for (const x of [d.data, d.run, d.hsRun, d.bin]) fs.mkdirSync(x, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(d.bin, 'claude'), '#!/bin/sh\necho "claude is disabled in this test" >&2\nexit 1\n', { mode: 0o755 })
  return d
}

/** The spec the Mac's manager sends for a host that opted in (core/host-server/manager.ts), run from this tree by tsx. */
function replicaSpec(rig: Rig, extraEnv: Record<string, string> = {}): Record<string, unknown> {
  const d = replicaDirs(rig.base)
  const boot = path.join(rig.base, 'boot.mts')
  fs.writeFileSync(boot, BOOT)
  const common = {
    PATH: `${d.bin}${path.delimiter}${process.env.PATH ?? ''}`, HOME: d.home, TMPDIR: os.tmpdir(), NODE_ENV: 'production',
    OPEN_WALNUT_HOME: d.data, WALNUT_HOST_SERVER: '1', WALNUT_HOST_SERVER_PORT: String(rig.publicPort),
    WALNUT_LEADER_HOME: HOME, WALNUT_WALNUT_ID: WALNUT, WALNUT_HOST_LABEL: 'devbox', WALNUT_NO_AUTO_UPDATE: '1',
  }
  return {
    v: 1, home: HOME, walnutId: WALNUT, command: process.execPath, args: [TSX_CLI, boot], cwd: ROOT,
    env: {
      ...common, WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_DAEMON_DIR: d.run,
      WALNUT_LEADER_QUIET_MS: String(QUIET_MS), REPLICA_PROBE_FILE: path.join(rig.base, 'probe.port'), ...extraEnv,
    },
    log: path.join(rig.base, 'server.log'), port: rig.publicPort,
    settings: { expose: { enabled: false, definition: null, options: {} }, exposeRetry: 0 },
    // The plain host server, as the manager sends it (its log dir its own here, never /tmp/open-walnut).
    fallback: { args: [TSX_CLI, path.join(ROOT, 'src/cli.ts'), 'host-server'], env: { ...common, WALNUT_DAEMON_DIR: d.hsRun } },
  }
}

async function startRig(twin: 'source' | 'standalone'): Promise<Rig> {
  // Short: the daemon's unix socket path must fit in 104 bytes on macOS.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rft-'))
  const daemonDir = path.join(base, 'd')
  fs.mkdirSync(daemonDir)
  const door = macDoor()
  const doorPort = await new Promise<number>((r) => door.server.listen(0, '127.0.0.1', () => r((door.server.address() as net.AddressInfo).port)))
  const env: NodeJS.ProcessEnv = {
    ...process.env, WALNUT_DAEMON_DIR: daemonDir, WALNUT_STREAMS_DIR: path.join(daemonDir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(daemonDir, 'spawn-journal.jsonl'), WALNUT_LEADER_QUIET_MS: String(QUIET_MS),
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  let daemon: ChildProcess
  if (twin === 'source') {
    const script = path.join(daemonDir, 'daemon.cjs')
    fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
    daemon = spawn(process.execPath, [script, '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  } else {
    if (!BUN) throw new Error('the standalone twin needs bun (BUN_INSTALL, ~/.bun/bin/bun)')
    daemon = spawn(BUN, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'], cwd: ROOT })
  }
  if (process.env.DEBUG_DAEMON) daemon.stderr?.on('data', (b) => process.stderr.write(b))
  await waitFor(() => fs.existsSync(path.join(daemonDir, 'daemon.port')) && fs.existsSync(path.join(daemonDir, 'daemon.pid')), 60_000, 'daemon')
  const daemonPid = Number(fs.readFileSync(path.join(daemonDir, 'daemon.pid'), 'utf8'))
  const daemonPort = Number(fs.readFileSync(path.join(daemonDir, 'daemon.port'), 'utf8'))
  const mac = await linkMac(daemonPort, doorPort)
  const publicPort = await freePort()
  return { base, daemonDir, daemon, daemonPid, daemonPort, door, doorPort, mac, publicPort, serverPids: new Set() }
}

/** Notes every server pid (and its children) the daemon starts, from its pid files. */
function watchServerPids(rig: Rig): () => void {
  const dir = path.join(rig.daemonDir, 'host-server')
  const t = setInterval(() => {
    let names: string[] = []
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.pid')) } catch { return }
    for (const n of names) {
      const pid = Number(String(fs.readFileSync(path.join(dir, n), 'utf8')).trim().split(/\s+/)[0])
      if (pid > 1) { rig.serverPids.add(pid); for (const c of childPids(pid)) rig.serverPids.add(c) }
    }
  }, 300)
  return () => clearInterval(t)
}

/** The command line of `pid`, or '' when it is gone. */
function commandOf(pid: number): string {
  try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim() } catch { return '' }
}

async function stopRig(rig: Rig | null): Promise<void> {
  if (!rig) return
  try { await rig.mac.cmd({ cmd: 'server.configure', home: HOME, spec: null }) } catch { /* the Mac is asleep or gone */ }
  if (rig.mac.beat) clearInterval(rig.mac.beat)
  try { rig.mac.ws.terminate() } catch { /* gone */ }
  await waitFor(() => [...rig.serverPids].every((p) => !alive(p)), 12_000, 'the servers to stop').catch(() => undefined)
  if (rig.daemonPid > 1) { try { process.kill(rig.daemonPid, 'SIGTERM') } catch { /* gone */ } }
  try { rig.daemon.kill('SIGTERM') } catch { /* gone */ }
  // Whatever is left of the servers this test's daemon started (checked by command line: never another process).
  for (const pid of rig.serverPids) {
    if (alive(pid) && commandOf(pid).includes(ROOT)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  }
  await new Promise<void>((r) => rig.door.server.close(() => r()))
  await sleep(300)
  if (!process.env.KEEP_REPLICA_RIG) fs.rmSync(rig.base, { recursive: true, force: true })
}

/** The daemon's word on its server (`server.status`). */
async function serverStatus(rig: Rig): Promise<Record<string, any>> {
  const r = await rig.mac.cmd({ cmd: 'server.status', home: HOME })
  return (r.status ?? {}) as Record<string, any>
}

async function probe(rig: Rig, p: string): Promise<Record<string, any>> {
  const port = Number(fs.readFileSync(path.join(rig.base, 'probe.port'), 'utf8'))
  return JSON.parse((await call(port, 'GET', p)).text) as Record<string, any>
}

/** A WebSocket through the public port that stays open; resolves when open, records how it closed. */
interface OpenWs {
  ws: WebSocket; closed: Promise<{ code: number; reason: string }>; first: Promise<string>
  /** The first message (now or later) that `pred` takes. */
  next(pred: (m: string) => boolean): Promise<string>
}
function openWs(port: number, p = '/ws'): Promise<OpenWs> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${p}`)
    const closed = new Promise<{ code: number; reason: string }>((r) => ws.once('close', (code, reason) => r({ code, reason: String(reason) })))
    const first = new Promise<string>((r) => ws.once('message', (m) => r(String(m))))
    const got: string[] = []
    const waiters: Array<{ pred: (m: string) => boolean; done: (m: string) => void }> = []
    ws.on('message', (m) => {
      const text = String(m)
      got.push(text)
      for (const w of [...waiters]) if (w.pred(text)) { waiters.splice(waiters.indexOf(w), 1); w.done(text) }
    })
    const next = (pred: (m: string) => boolean) => new Promise<string>((r) => {
      const hit = got.find(pred)
      if (hit) r(hit); else waiters.push({ pred, done: r })
    })
    ws.once('open', () => resolve({ ws, closed, first, next }))
    ws.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)))
    ws.once('error', reject)
  })
}

/** The Mac's link, linked again when the daemon closed a sleeping one. */
async function macOf(rig: Rig): Promise<Mac> {
  if (rig.mac.ws.readyState !== WebSocket.OPEN) rig.mac = await linkMac(rig.daemonPort, rig.doorPort)
  return rig.mac
}

describe.each(['source', 'standalone'] as const)('a host replica supervised by the %s twin', (twin) => {
  let rig: Rig | null = null
  let unwatch: () => void = () => {}
  const port = () => rig!.publicPort
  const asPhone = { authorization: `Bearer ${PHONE_TOKEN}` }

  beforeAll(async () => {
    rig = await startRig(twin)
    unwatch = watchServerPids(rig)
    const configured = await rig.mac.cmd({ cmd: 'server.configure', home: HOME, spec: replicaSpec(rig) })
    expect(configured.ok, JSON.stringify(configured)).toBe(true)
  }, 120_000)

  afterAll(async () => {
    unwatch()
    await stopRig(rig)
    for (const pid of rig?.serverPids ?? []) expect(alive(pid) && commandOf(pid).includes(ROOT), `server pid ${pid} reaped`).toBe(false)
  }, 60_000)

  it('runs web --replica under the daemon; its first report reaches the daemon within 5 s of the spawn', async () => {
    const st = await waitFor(async () => { const s = await serverStatus(rig!); return s.report ? s : null }, 150_000, 'the first report')
    expect(st).toMatchObject({ state: 'running', program: 'primary' })
    expect(st.report).toMatchObject({ program: 'replica', role: 'replica', placement: 'host', port: port() })
    // The daemon's own clock on both ends: `since` is when it spawned the server (state running), and
    // nothing restarted it (restarts 0), so this is spawn to first report, module load included.
    expect(st.restarts).toBe(0)
    expect(typeof st.since).toBe('number')
    expect(st.reportedAt - st.since).toBeLessThan(5_000)
    expect(st.reportedAt - st.report.startedAt).toBeLessThan(5_000)
    console.info('[replica-front-twins]', twin, JSON.stringify({ frontToReportMs: st.reportedAt - st.report.startedAt, spawnToReportMs: typeof st.since === 'number' ? st.reportedAt - st.since : null }))
    await waitFor(async () => (await serverStatus(rig!)).report?.presence?.answers === true, 20_000, 'the Mac answering')
    // The report goes out before the heavy init; the public port listens once that is done.
    await waitFor(async () => { try { return (await call(port(), 'GET', '/api/config')).status > 0 } catch { return false } }, 120_000, 'the public port')
  }, 240_000)

  it('forwards GET, POST (op id kept, forwarded-at stamped), a 4 MB body and a WebSocket to the Mac', async () => {
    const g = await call(port(), 'GET', '/api/tasks?x=1', { headers: { authorization: 'Bearer tok' } })
    expect(JSON.parse(g.text)).toMatchObject({ from: 'mac', url: '/api/tasks?x=1' })
    expect(g.headers['x-walnut-answered-via']).toBe('leader')
    const p = await call(port(), 'POST', '/api/tasks', { body: '{"title":"acme"}', headers: { 'content-type': 'application/json', 'x-walnut-op-id': 'op-twins-0001' } })
    expect(JSON.parse(p.text)).toMatchObject({ from: 'mac', bytes: 16 })
    expect(rig!.door.seen.at(-1)).toMatchObject({ method: 'POST', opId: 'op-twins-0001' })
    expect(Math.abs(Date.now() - Number(rig!.door.seen.at(-1)!.forwardedAt))).toBeLessThan(10_000)
    const big = Buffer.alloc(4 * 1024 * 1024, 3)
    const b = await call(port(), 'POST', '/upload', { body: big, headers: { 'content-type': 'application/octet-stream' } })
    expect(JSON.parse(b.text)).toMatchObject({ from: 'mac', bytes: big.length })
    const s = await openWs(port())
    s.ws.send('hello')
    expect(await s.first).toBe('mac:hello')
    s.ws.close()
    // The phone's device token reaches the replica in the device copy, on the leader door.
    const { deviceListHash } = await import('../../src/core/replication/device-replica.js')
    const devices = [{ id: 'd1a2b3c4d5e6f7', name: 'acme-phone', tokenHash: sha256(PHONE_TOKEN) }]
    const put = await macAsks(rig!.mac, 'POST', '/bridge/replica', { op: 'put', kind: 'devices', devices, hash: deviceListHash(devices) })
    expect(put.status, JSON.stringify(put.json)).toBe(200)
    // One whole tasks round (an empty manifest needs nothing): the copies now have an age,
    // which an away answer's x-walnut-offline carries (the copies' last round, not presence).
    const round = await macAsks(rig!.mac, 'POST', '/bridge/replica', { op: 'sync', kind: 'tasks', entries: [], asOf: Date.now() })
    expect(round.status, JSON.stringify(round.json)).toBe(200)
  }, 60_000)

  it('the Mac asleep: inside the window the daemon still refuses a follower write; past it the replica answers away and the spliced socket closes 4001', async () => {
    const spliced = await openWs(port())
    spliced.ws.send('x')
    expect(await spliced.first).toBe('mac:x')
    pauseMac(rig!.mac)
    const pausedAt = Date.now()
    // Inside LEADER_QUIET_MS the daemon calls the Mac present: a follower write must go through it.
    const inside = await probe(rig!, '/follower-send')
    expect(Date.now() - pausedAt).toBeLessThan(QUIET_MS - 1_000)
    expect(inside).toMatchObject({ ok: false, errorKind: 'leader_answers' })
    await waitFor(async () => (await probe(rig!, '/presence')).answers === false, 20_000, 'the replica calling the Mac away')
    // The one window: not before the daemon's (the Mac's last beat was at most 1 s before the pause).
    expect(Date.now() - pausedAt).toBeGreaterThanOrEqual(QUIET_MS - 1_500)
    expect(await spliced.closed).toEqual({ code: 4001, reason: 'leader_away' })
    // A read runs on the replica's copies and says how fresh they are.
    const g = await call(port(), 'GET', '/api/tasks', { headers: asPhone })
    expect(g.status, g.text.slice(0, 300)).toBe(200)
    expect(Number(g.headers['x-walnut-offline'])).toBeGreaterThan(0)
    expect(g.headers['x-walnut-answered-via']).toBe('replica')
    // A write that needs the Mac says so; nothing reached the Mac. (WP10 journals a
    // create, an edit or a complete on this host; deleting a task still needs the Mac.)
    const seen = rig!.door.seen.length
    const w = await call(port(), 'DELETE', '/api/tasks/t-twins-none', { headers: asPhone })
    expect(w.status).toBe(503)
    expect(JSON.parse(w.text).error).toMatchObject({ code: 'needs_leader', why: 'task_writes_need_mac', retryAfter: 5 })
    expect(rig!.door.seen.length).toBe(seen)
    // And the daemon agrees: a follower write now passes its leader check (the session is unknown here).
    expect(await probe(rig!, '/follower-send')).toMatchObject({ ok: false, errorKind: 'not_found' })
  }, 60_000)

  it('the Mac awake again: the replica\'s own sockets close with 4002, and requests reach the Mac', async () => {
    const own = await openWs(port(), `/ws?token=${PHONE_TOKEN}`)
    // The replica's own socket runs reads; a write RPC needs the Mac (src/replica/ws-rpc-table.ts),
    // and a send to a session that does not run on this host needs it too (WP10, ws-writes.ts).
    const isRes = (id: string) => (m: string) => { try { const f = JSON.parse(m); return f.type === 'res' && f.id === id } catch { return false } }
    own.ws.send(JSON.stringify({ type: 'req', id: 'w1', method: 'session:start', payload: { taskId: 'x', message: 'hi' }, opId: 'op-twins-ws-1' }))
    const refused = JSON.parse(await own.next(isRes('w1')))
    expect(refused).toMatchObject({ ok: false })
    expect(String(refused.error)).toMatch(/^needs_leader: session_writes_need_mac/)
    own.ws.send(JSON.stringify({ type: 'req', id: 'w2', method: 'session:send', payload: { sessionId: 'x', message: 'hi' }, opId: 'op-twins-ws-2' }))
    const elsewhere = JSON.parse(await own.next(isRes('w2')))
    expect(elsewhere).toMatchObject({ ok: false })
    expect(String(elsewhere.error)).toMatch(/^needs_leader: session_on_mac/)
    own.ws.send(JSON.stringify({ type: 'req', id: 'r1', method: 'set-interest', payload: { mode: 'global' } }))
    expect(String(JSON.parse(await own.next(isRes('r1'))).error ?? '')).not.toMatch(/needs_leader/)
    wakeMac(await macOf(rig!))
    expect(await own.closed).toEqual({ code: 4002, reason: 'leader_back' })
    await waitFor(async () => (await probe(rig!, '/presence')).answers === true, 20_000, 'the Mac answering again')
    const g = await call(port(), 'GET', '/api/tasks?back=1')
    expect(JSON.parse(g.text)).toMatchObject({ from: 'mac', url: '/api/tasks?back=1' })
  }, 60_000)

  it('a replica build that crashes only when away: the daemon falls back to the host server by itself while the Mac sleeps, and the front door answers', async () => {
    const r = await rig!.mac.cmd({ cmd: 'server.configure', home: HOME, spec: replicaSpec(rig!, { REPLICA_CRASH_WHEN_AWAY: '1' }) })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    await waitFor(async () => (await serverStatus(rig!)).report?.presence?.answers === true, 150_000, 'the new build answering')
    pauseMac(rig!.mac)
    const dir = path.join(rig!.daemonDir, 'host-server')
    const saved = () => {
      for (const n of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
        try { const j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); if (j.fallback) return j } catch { /* being written */ }
      }
      return null
    }
    // No word from the Mac in all this time: the daemon decides alone.
    const fell = await waitFor(saved, 300_000, 'the daemon to switch to the fallback')
    expect(fell.fallback.until - fell.fallback.since).toBe(60 * 60_000)
    const page = await waitFor(async () => {
      try { const p = await call(port(), 'GET', '/', { headers: { accept: 'text/html' } }); return p.status === 200 && p.text.includes('Walnut on devbox') ? p : null } catch { return null }
    }, 90_000, 'the host server page on the front door')
    expect(page.headers['content-security-policy']).toMatch(/script-src 'nonce-/)
    // The Mac back: the daemon's status names the program it runs and why.
    wakeMac(await macOf(rig!))
    const st = await waitFor(async () => {
      try { await macOf(rig!); const s = await serverStatus(rig!); return s.program === 'fallback' && s.state === 'running' ? s : null } catch { return null }
    }, 30_000, 'server.status to say fallback')
    expect(st.fallback).toMatchObject({ since: fell.fallback.since, until: fell.fallback.until })
    expect(String(st.fallback.lastError)).toMatch(/code 1/)
  }, 480_000)
})
