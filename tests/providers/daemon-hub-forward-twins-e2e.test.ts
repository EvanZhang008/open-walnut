/**
 * 'hub-forward-v1' end to end on the real session daemon (daemon-standalone.ts under bun, when
 * bun is installed), with the primary's real DaemonConnection:
 *
 *   a client on "home-pc" ── 127.0.0.1:<local> ── home-pc's daemon (booted for real, its own
 *   hub-forwards.json) ══ the daemon link ══ the primary's DaemonConnection('home-pc')
 *   ── net.hub_ports in the primary's config.yaml ── 127.0.0.1:<svc> on "the Mac" (a service here)
 *
 * The link is a real WebSocket to the daemon (what walnut-net carries for a `transport: net`
 * host; the iroh hop under it is a byte pipe and is not part of this test). Both "machines" are
 * this machine, so every address is a loopback port this test picked.
 *
 * What it proves: bytes flow both ways to a listed port (HTTP, 1 MB bodies, parallel
 * requests); an unlisted port, an unlisted host, a primary with nothing listed and a stream naming
 * another address are refused and never reach a service; with no file the machine listens
 * nowhere; the listener is on 127.0.0.1 only; an older primary (no acceptor) refuses cleanly and
 * the listener stays; with no primary link the forward's port is not bound, so a connection is
 * refused by TCP (ECONNREFUSED: a client falling back to another hub knows nothing was sent);
 * a link drop cuts the forwarded connections and the port refuses until the next link, which
 * carries again (a flapping link too); a file written later is taken up; the status a plugin
 * reads says up, and the machine's own says why it waits.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths; the only process ended
 * is the daemon this test spawned, through its own handle (SIGTERM, then SIGKILL after a deadline).
 * Every service is a server this test listens on. Real ssh is refused.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-hub-forward-twins'))
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return {
    ...original,
    spawn: vi.fn((cmd: string, args: string[], opts?: unknown) => {
      if (cmd === 'ssh') throw new Error('ssh refused by the test')
      return original.spawn(cmd, args, opts as never)
    }),
  }
})

import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { createStreamEndpoint } from '../../src/lib/link-stream.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { hubPortStatus, resetHubPortsForTest } from '../../src/core/hosts/hub-ports.js'
import { testBun } from '../helpers/bun-runtime.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'
import { guardedPath } from '../setup/exec-guard.js'

let root = ''
let daemonDir = ''
const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
let proc: ChildProcess | null = null
const sockets: WebSocket[] = []
const servers: net.Server[] = []
const clients: net.Socket[] = []
const conns: DaemonConnection[] = []
let rpcId = 1
const HOME = '/walnut/primary-home'
const ENDPOINT = '60d53783dcf0c6e95fe6c2ff390fd3131d42a167eecee7eac15e57e69ed36f5b'

function forwardsFile(): string { return path.join(daemonDir, 'net', 'hub-forwards.json') }
function writeForwards(forwards: Array<Record<string, unknown>>): void {
  fs.mkdirSync(path.dirname(forwardsFile()), { recursive: true })
  fs.writeFileSync(forwardsFile(), JSON.stringify({ forwards }))
}

async function boot(forwards?: Array<Record<string, unknown>>): Promise<number> {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.platform() === 'win32' ? os.tmpdir() : '/tmp', 'whf-')))
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  daemonDir = path.join(root, 'daemon')
  if (forwards) writeForwards(forwards)
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: guardedPath([], '/usr/bin:/bin'),
    HOME: home,
    WALNUT_DAEMON_DIR: daemonDir,
    WALNUT_STREAMS_DIR: path.join(root, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'),
    WALNUT_NET_NO_DOWNLOAD: '1',
  }
  proc = spawn(BUN!, [STANDALONE, '--start'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
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

/** A socket to the daemon that said hello and leader.configure: the primary's session link. */
async function leaderSocket(port: number): Promise<{ ws: WebSocket; caps: string[] }> {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}`)
    w.on('open', () => resolve(w))
    w.on('error', reject)
  })
  sockets.push(ws)
  const hello = await rpc(ws, { cmd: 'hello' })
  const caps = (hello.capabilities ?? (hello.result as { capabilities?: string[] } | undefined)?.capabilities ?? []) as string[]
  expect(await rpc(ws, { cmd: 'leader.configure', home: HOME, walnutId: 'w-primary', backup: false })).toMatchObject({ ok: true })
  return { ws, caps }
}

type ConnInternals = {
  ws: unknown
  streams: { closeAll(reason: string): void } | null
  streamEndpoint(): { handle(msg: Record<string, unknown>): boolean }
}

/** The primary's DaemonConnection for home-pc, on a real leader socket to the daemon (what connect() leaves behind). */
async function primary(port: number, conn = new DaemonConnection('home-pc', { hostname: 'home-pc.walnut-net.invalid', via: 'net', endpoint: ENDPOINT })) {
  if (!conns.includes(conn)) conns.push(conn)
  const inner = conn as unknown as ConnInternals
  const { ws, caps } = await leaderSocket(port)
  vi.spyOn(conn, 'hasCapability').mockImplementation((cap) => caps.includes(cap))
  ws.on('message', (data: Buffer) => {
    try { inner.streamEndpoint().handle(JSON.parse(data.toString()) as Record<string, unknown>) } catch { /* not a frame */ }
  })
  ws.on('close', () => inner.streams?.closeAll('the link to home-pc closed'))
  inner.ws = ws
  return { conn, inner, ws, caps }
}

/** An older primary's link: its endpoint takes only the streams it knew (none from a hub). */
async function olderPrimary(port: number) {
  const { ws } = await leaderSocket(port)
  const ep = createStreamEndpoint({ send: (frame) => ws.send(JSON.stringify(frame)), accept: (info) => (info.from === 'follower' ? () => {} : null) })
  ws.on('message', (data: Buffer) => { try { ep.handle(JSON.parse(data.toString()) as Record<string, unknown>) } catch { /* not a frame */ } })
  return { ws }
}

async function freePort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  const port = (s.address() as net.AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

/** "The Mac's coderelay": an HTTP service on this machine's loopback. */
async function macService(): Promise<{ port: number; conns: () => number; held: () => http.ServerResponse | null }> {
  let n = 0
  let held: http.ServerResponse | null = null
  const body = big(1024 * 1024 + 9)
  const svc = http.createServer((req, res) => {
    if (req.url === '/bin') { res.end(body); return }
    if (req.url === '/hold') { held = res; res.write('part'); return }
    if (req.method === 'POST') {
      const parts: Buffer[] = []
      req.on('data', (b: Buffer) => parts.push(b))
      req.on('end', () => res.end(Buffer.concat(parts).reverse()))
      return
    }
    res.end(`mac ${req.url}`)
  })
  svc.on('connection', () => { n++ })
  servers.push(svc as unknown as net.Server)
  await new Promise<void>((r) => svc.listen(0, '127.0.0.1', () => r()))
  return { port: (svc.address() as net.AddressInfo).port, conns: () => n, held: () => held }
}

function big(n: number): Buffer { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 29 + 3) & 0xff; return b }

function request(port: number, p = '/', body?: Buffer): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: body ? 'POST' : 'GET', agent: false }, (res) => {
      const parts: Buffer[] = []
      res.on('data', (b: Buffer) => parts.push(b))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts) }))
      res.on('error', reject)
      res.on('close', () => { if (!res.complete) reject(new Error('the answer was cut')) })
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** An HTTP request (what coderelay sends) that must be refused by TCP: the error's code. */
function refusedCode(port: number): Promise<string> {
  return request(port, '/v1/messages').then(() => 'answered', (err: Error & { code?: string }) => err.code ?? err.message)
}

/** A raw connection to `port`: what it reads until the far side closes it, and whether it was refused. */
function rawTry(port: number, host = '127.0.0.1'): Promise<{ refused: boolean; got: string }> {
  return new Promise((resolve) => {
    const c = net.connect({ port, host })
    clients.push(c)
    let got = ''
    c.on('data', (b) => { got += b.toString() })
    c.on('error', (err: Error & { code?: string }) => { if (err.code === 'ECONNREFUSED') resolve({ refused: true, got }) })
    c.on('connect', () => c.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'))
    c.on('close', () => resolve({ refused: false, got }))
  })
}

async function hubStatus(ws: WebSocket): Promise<{ file: string; forwards: Array<Record<string, unknown>> }> {
  const s = await rpc(ws, { cmd: 'hub.status' })
  expect(s.ok).toBe(true)
  return s as unknown as { file: string; forwards: Array<Record<string, unknown>> }
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await check()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return check()
}

const listening = async (ws: WebSocket, local: number) => (await hubStatus(ws)).forwards.some((f) => f.local_port === local && f.listening === true)

async function stopOwnDaemon(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<boolean>((resolve) => child.once('exit', () => resolve(true)))
  const within = (ms: number) => Promise.race([exited, new Promise<boolean>((r) => setTimeout(() => r(false), ms))])
  child.kill('SIGTERM')
  if (await within(5_000)) return
  child.kill('SIGKILL')
  await within(3_000)
}

afterEach(async () => {
  for (const c of conns.splice(0)) c.disconnect()
  for (const c of clients.splice(0)) c.destroy()
  for (const s of sockets.splice(0)) { try { s.close() } catch { /* closed */ } }
  for (const s of servers.splice(0)) s.close()
  if (proc) await stopOwnDaemon(proc)
  proc = null
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
  resetHubPortsForTest()
  vi.restoreAllMocks()
})

describe.skipIf(!BUN)('hub forwards end to end, standalone daemon (bun)', () => {
  it('carries HTTP both ways to a listed port on the primary\'s loopback, only on 127.0.0.1, and the status says up', async () => {
    const mac = await macService()
    await updateConfig({ net: { hub_ports: [{ port: mac.port, hosts: ['home-pc'] }] } } as never)
    const local = await freePort()
    const port = await boot([{ local_port: local, to: 'primary', port: mac.port }])
    const { ws, caps } = await primary(port)
    expect(caps).toContain('hub-forward-v1')
    expect(await waitFor(() => listening(ws, local))).toBe(true)
    expect((await hubStatus(ws)).file).toBe(forwardsFile())

    expect((await request(local, '/v1/messages?x=1')).body.toString()).toBe('mac /v1/messages?x=1')
    const body = big(1024 * 1024 + 9)
    expect((await request(local, '/bin')).body.equals(body)).toBe(true)
    const up = big(1024 * 1024 + 3)
    expect((await request(local, '/echo', up)).body.equals(Buffer.from(up).reverse())).toBe(true)
    const parallel = await Promise.all(Array.from({ length: 6 }, (_, i) => request(local, `/p${i}`)))
    expect(parallel.map((r) => r.body.toString())).toEqual(Array.from({ length: 6 }, (_, i) => `mac /p${i}`))

    // Nothing listens on the machine's other addresses: the listener is 127.0.0.1 only.
    const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)
    if (lan) expect((await rawTry(local, lan.address)).refused).toBe(true)

    const s = (await hubStatus(ws)).forwards.find((f) => f.local_port === local)!
    expect(s).toMatchObject({ port: mac.port, listening: true, refused: 0 })
    expect(Number(s.opened)).toBeGreaterThanOrEqual(9)
    // The status a plugin reads (walnut.hosts.list): up, with the machine's local port and the last connection.
    const status = await hubPortStatus('home-pc', { link: { connected: true, hasCapability: (c) => caps.includes(c), send: (cmd) => rpc(ws, { cmd }) } })
    expect(status).toEqual([expect.objectContaining({ port: mac.port, linked: true, up: true, needsUpdate: false, forward: { localPort: local, listening: true, error: null, waiting: null } })])
    expect(status[0].lastConnectedAt).toBeGreaterThan(Date.now() - 60_000)
    expect(status[0].opened).toBeGreaterThanOrEqual(9)
  }, 120_000)

  it('refuses an unlisted host, an unlisted port, a primary with nothing listed, and a stream naming another address', async () => {
    const mac = await macService()
    const other = await macService()
    const local = await freePort()
    const local2 = await freePort()
    const port = await boot([{ local_port: local, port: mac.port }, { local_port: local2, port: other.port }])
    const { ws, inner } = await primary(port)
    expect(await waitFor(async () => (await listening(ws, local)) && (await listening(ws, local2)))).toBe(true)

    // The primary lists the port for another machine only.
    await updateConfig({ net: { hub_ports: [{ port: mac.port, hosts: ['other-pc'] }] } } as never)
    expect((await rawTry(local)).got).toBe('')
    // A port it does not list at all.
    expect((await rawTry(local2)).got).toBe('')
    // Nothing listed (the default).
    await updateConfig({ net: { hub_ports: [] } } as never)
    expect((await rawTry(local)).got).toBe('')
    expect(mac.conns()).toBe(0)
    expect(other.conns()).toBe(0)
    const st = (await hubStatus(ws)).forwards
    expect(st.find((f) => f.local_port === local)).toMatchObject({ opened: 0, refused: 2, lastRefusal: `port ${mac.port} on this Walnut is not open to hub forwards (net.hub_ports, or a plugin grant)` })
    expect(st.find((f) => f.local_port === local2)).toMatchObject({ opened: 0, refused: 1, lastRefusal: `port ${other.port} on this Walnut is not open to hub forwards (net.hub_ports, or a plugin grant)` })

    // A hub stream that names an address (no daemon of ours sends one) is refused by the
    // primary's own DaemonConnection, even for a listed port, and nothing is dialled.
    await updateConfig({ net: { hub_ports: [{ port: mac.port, hosts: ['home-pc'] }] } } as never)
    const sent: Array<Record<string, unknown>> = []
    const realSend = (ws as WebSocket).send.bind(ws)
    vi.spyOn(ws, 'send').mockImplementation(((data: string, ...rest: unknown[]) => { try { sent.push(JSON.parse(String(data))) } catch { /* binary */ } return (realSend as (...a: unknown[]) => void)(data, ...rest) }) as never)
    inner.streamEndpoint().handle({ ev: 'stream-open', sid: 'r9001', from: 'hub', port: mac.port, host: '10.1.2.3' })
    expect(await waitFor(() => sent.some((f) => f.sid === 'r9001'))).toBe(true)
    expect(sent.find((f) => f.sid === 'r9001')).toMatchObject({ cmd: 'stream.close', error: "a hub stream reaches only this Walnut's own 127.0.0.1, never 10.1.2.3" })
    expect(mac.conns()).toBe(0)
    // And the same machine's listed port still works.
    expect((await request(local, '/ok')).body.toString()).toBe('mac /ok')
  }, 120_000)

  it('with no forwards file the machine listens nowhere; a file written later is taken up, and removing it stops the listener', async () => {
    const mac = await macService()
    await updateConfig({ net: { hub_ports: [{ port: mac.port, hosts: ['home-pc'] }] } } as never)
    const local = await freePort()
    const port = await boot()
    const { ws } = await primary(port)
    expect((await hubStatus(ws)).forwards).toEqual([])
    expect((await rawTry(local)).refused).toBe(true)
    writeForwards([{ local_port: local, to: 'primary', port: mac.port }])
    expect(await waitFor(() => listening(ws, local), 12_000)).toBe(true)
    expect((await request(local, '/later')).body.toString()).toBe('mac /later')
    fs.rmSync(forwardsFile())
    expect(await waitFor(async () => (await hubStatus(ws)).forwards.length === 0, 12_000)).toBe(true)
    expect(await waitFor(async () => (await rawTry(local)).refused, 5_000)).toBe(true)
  }, 120_000)

  it('an older primary refuses cleanly and the listener stays; the new primary then carries', async () => {
    const mac = await macService()
    await updateConfig({ net: { hub_ports: [{ port: mac.port, hosts: ['home-pc'] }] } } as never)
    const local = await freePort()
    const port = await boot([{ local_port: local, port: mac.port }])
    const old = await olderPrimary(port)
    expect(await waitFor(() => listening(old.ws, local))).toBe(true)
    expect((await rawTry(local)).got).toBe('')
    const st = (await hubStatus(old.ws)).forwards[0]
    expect(st).toMatchObject({ listening: true, refused: 1, opened: 0, lastRefusal: 'this server does not take that stream' })
    expect(mac.conns()).toBe(0)
    old.ws.close()
    const { ws } = await primary(port)
    expect(await waitFor(async () => {
      try { return (await request(local, '/new')).body.toString() === 'mac /new' } catch { return false }
    })).toBe(true)
    expect(await listening(ws, local)).toBe(true)
  }, 120_000)

  it('a probe never reads hub.status; with two Walnuts leading here a forward that names none is refused, one that names its Walnut goes to it', async () => {
    const mac = await macService()
    await updateConfig({ net: { hub_ports: [{ port: mac.port, hosts: ['home-pc'] }] } } as never)
    const local = await freePort()
    const port = await boot([{ local_port: local, port: mac.port }])
    const probe = await leaderlessProbe(port)
    expect(await rpc(probe, { cmd: 'client.role', role: 'probe' })).toMatchObject({ ok: true })
    expect(await rpc(probe, { cmd: 'hub.status' })).toMatchObject({ ok: false })
    const { ws } = await primary(port)
    expect(await waitFor(() => listening(ws, local))).toBe(true)
    // A second Walnut leads this machine too (another primary's server socket).
    const second = await new Promise<WebSocket>((resolve, reject) => {
      const w = new WebSocket(`ws://127.0.0.1:${port}`)
      w.on('open', () => resolve(w))
      w.on('error', reject)
    })
    sockets.push(second)
    await rpc(second, { cmd: 'hello' })
    expect(await rpc(second, { cmd: 'leader.configure', home: '/walnut/other-home', walnutId: 'w-other', backup: false })).toMatchObject({ ok: true })
    let secondOpens = 0
    second.on('message', (d: Buffer) => { try { if ((JSON.parse(d.toString()) as { ev?: string }).ev === 'stream-open') secondOpens++ } catch { /* not a frame */ } })
    // Neither Walnut can take it: the port stops listening (refused by TCP) and says why.
    const AMBIGUOUS = 'more than one Walnut leads this host: name one with "walnut" in the forward'
    expect(await waitFor(async () => (await hubStatus(ws)).forwards[0].waiting === AMBIGUOUS)).toBe(true)
    expect((await rawTry(local)).refused).toBe(true)
    expect((await hubStatus(ws)).forwards[0]).toMatchObject({ listening: false, error: null })
    writeForwards([{ local_port: local, port: mac.port, walnut: 'w-primary' }])
    expect(await waitFor(async () => (await hubStatus(ws)).forwards[0]?.walnut === 'w-primary' && listening(ws, local), 12_000)).toBe(true)
    expect((await request(local, '/named')).body.toString()).toBe('mac /named')
    expect(secondOpens).toBe(0)
  }, 120_000)

  it('with no primary link up the forward port refuses (ECONNREFUSED) and says it waits; once the link is up it carries end to end', async () => {
    const mac = await macService()
    await updateConfig({ net: { hub_ports: [{ port: mac.port, hosts: ['home-pc'] }] } } as never)
    const local = await freePort()
    const port = await boot([{ local_port: local, port: mac.port }])
    const probe = await leaderlessProbe(port)
    // The daemon read its file: the forward is there, waiting, and not an error.
    expect(await waitFor(async () => (await hubStatus(probe)).forwards[0]?.waiting === 'the primary is not linked to this host')).toBe(true)
    expect((await hubStatus(probe)).forwards[0]).toMatchObject({ local_port: local, listening: false, error: null, refused: 0 })
    // Refused by TCP: never accepted, so the client knows nothing was sent.
    expect(await refusedCode(local)).toBe('ECONNREFUSED')
    expect((await rawTry(local)).refused).toBe(true)
    expect(mac.conns()).toBe(0)
    // The link comes up: the forward listens at once (well before the 5 s file read) and carries as before.
    const { ws } = await primary(port)
    expect(await waitFor(() => listening(ws, local), 1_500)).toBe(true)
    expect((await hubStatus(ws)).forwards[0]).toMatchObject({ waiting: null, error: null })
    expect((await request(local, '/v1/messages')).body.toString()).toBe('mac /v1/messages')
    const up = big(256 * 1024 + 5)
    expect((await request(local, '/echo', up)).body.equals(Buffer.from(up).reverse())).toBe(true)
  }, 120_000)

  it('a dropped link cuts the forwarded connections and the port refuses until the next link, which carries again; a flapping link ends listening', async () => {
    const mac = await macService()
    await updateConfig({ net: { hub_ports: [{ port: mac.port, hosts: ['home-pc'] }] } } as never)
    const local = await freePort()
    const port = await boot([{ local_port: local, port: mac.port }])
    const first = await primary(port)
    expect(await waitFor(() => listening(first.ws, local))).toBe(true)
    const cut = request(local, '/hold')
    expect(await waitFor(() => mac.held() !== null)).toBe(true)
    const refusedBefore = Number((await hubStatus(first.ws)).forwards[0].refused)
    first.ws.close()
    await expect(cut).rejects.toThrow()
    // No primary now: the port stops listening on its own (no connection needed to find out),
    // so a connection is refused (never accepted and closed), and the status says why.
    const probe = await leaderlessProbe(port)
    expect(await waitFor(async () => (await hubStatus(probe)).forwards[0].waiting === 'the primary is not linked to this host', 1_500)).toBe(true)
    expect((await rawTry(local)).refused).toBe(true)
    expect(await refusedCode(local)).toBe('ECONNREFUSED')
    expect((await hubStatus(probe)).forwards[0]).toMatchObject({ listening: false, error: null, refused: refusedBefore })
    const again = await primary(port, first.conn)
    expect(await waitFor(() => listening(again.ws, local), 1_500)).toBe(true)
    expect((await request(local, '/again')).body.toString()).toBe('mac /again')
    // Flapping: links close and come back at once, several times; it ends listening and carries.
    let last = again
    for (let i = 0; i < 4; i++) {
      last.ws.close()
      last = await primary(port, first.conn)
    }
    expect(await waitFor(async () => {
      try { return (await request(local, '/flapped')).body.toString() === 'mac /flapped' } catch { return false }
    })).toBe(true)
    expect((await hubStatus(last.ws)).forwards[0]).toMatchObject({ listening: true, error: null, waiting: null })
    // And down once more: refused again, with no connection accepted and closed on the way.
    const refusedLast = Number((await hubStatus(last.ws)).forwards[0].refused)
    last.ws.close()
    expect(await waitFor(async () => (await hubStatus(probe)).forwards[0].waiting !== null, 1_500)).toBe(true)
    expect((await rawTry(local)).refused).toBe(true)
    expect((await hubStatus(probe)).forwards[0].refused).toBe(refusedLast)
  }, 120_000)
})

/** A socket that reads hub.status but never says leader.configure: no primary for the forwards. */
async function leaderlessProbe(port: number): Promise<WebSocket> {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}`)
    w.on('open', () => resolve(w))
    w.on('error', reject)
  })
  sockets.push(ws)
  await rpc(ws, { cmd: 'hello' })
  return ws
}

describe('hub-forward-v1 wiring in the session daemon', () => {
  it('listens on 127.0.0.1 through the core, reads its own file beside the net key, and answers hub.status to its primary only', () => {
    const src = fs.readFileSync(STANDALONE, 'utf8')
    expect(src).toMatch(/HUB_FORWARDS_FILE = path\.join\(NET_STATE_DIR, 'hub-forwards\.json'\)/)
    expect(src).toMatch(/case 'hub\.status': return cmdHubStatus\(ws, id/)
    const at = src.indexOf('function cmdHubStatus')
    expect(src.slice(at, at + 300)).toMatch(/if \(!isServerClient\(ws\)\) return sendError/)
    // The host a listener binds comes from the core (always 127.0.0.1), never the daemon.
    expect(src).toMatch(/srv\.listen\(port, host,/)
    expect(src.match(/hubForwards\.start\(\)/g)).toHaveLength(1)
  })
})
