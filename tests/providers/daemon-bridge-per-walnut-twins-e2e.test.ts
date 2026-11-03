/**
 * One daemon, two Walnuts, two cloud companions (2026-11-03): each Walnut keeps
 * its own bridge link (walnut-scope-v1). Before, one global link served both, so
 * every 5-minute re-push of one tore the other's down and one's enabled:false
 * turned the other's off; and a phone relay on either link went to whichever
 * server socket came first.
 *
 * Real daemon processes (both twins), isolated temp dirs, two fake companions on
 * loopback. A "server" is a plain socket that names its Walnut with
 * leader.configure, as a Walnut server does.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from '#ws'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { testBun } from '../helpers/bun-runtime.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const HOME_A = '/fixture/walnut-a'
const HOME_B = '/fixture/walnut-b'

const bunPath = (() => {
  const candidates = [process.env.WALNUT_TEST_BUN, testBun()]
  for (const p of candidates) if (p && fs.existsSync(p)) return p
  try { return execFileSync('which', ['bun'], { encoding: 'utf8' }).trim() || null } catch { return null }
})()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}

type Frame = Record<string, unknown>
interface Daemon { proc: ChildProcess; dir: string; port: number; pid: number }

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) { try { await fn() } catch { /* best effort */ } }
})

async function spawnDaemon(twin: 'source' | 'standalone', dir: string): Promise<Daemon> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALNUT_DAEMON_DIR: dir,
    WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  for (const f of ['daemon.port', 'daemon.pid']) fs.rmSync(path.join(dir, f), { force: true })
  let proc: ChildProcess
  if (twin === 'source') {
    const script = path.join(dir, 'daemon.cjs')
    fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
    proc = spawn(SOURCE_TWIN.file, [script, '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  } else {
    proc = spawn(bunPath!, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'], cwd: ROOT })
  }
  if (process.env.DEBUG_DAEMON) proc.stderr?.on('data', (b) => process.stderr.write(`[${twin}] ${b.toString()}`))
  const portFile = path.join(dir, 'daemon.port')
  await waitFor(() => fs.existsSync(portFile) && fs.existsSync(path.join(dir, 'daemon.pid')), 30_000, `${twin} daemon`)
  const d = {
    proc, dir,
    port: parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10),
    pid: parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10),
  }
  cleanups.push(() => stopDaemon(d))
  return d
}

async function stopDaemon(d: Daemon): Promise<void> {
  if (d.proc.exitCode !== null || d.proc.signalCode !== null) return
  const exited = new Promise((r) => d.proc.once('exit', r))
  // Only the pid the isolated daemon wrote into its own temp dir.
  if (d.pid > 1) { try { process.kill(d.pid, 'SIGTERM') } catch { /* gone */ } }
  try { d.proc.kill('SIGTERM') } catch { /* gone */ }
  await Promise.race([exited, sleep(3_000)])
}

let nextId = 1
class Peer {
  readonly frames: Frame[] = []
  constructor(readonly ws: WebSocket) {
    ws.on('error', () => { /* deadlines report failures */ })
    ws.on('message', (d) => { try { this.frames.push(JSON.parse(String(d)) as Frame) } catch { /* not json */ } })
  }
  send(frame: Frame): number {
    const id = nextId++
    this.ws.send(JSON.stringify({ ...frame, id }))
    return id
  }
  async rpc(frame: Frame): Promise<Frame> {
    const id = this.send(frame)
    await waitFor(() => this.frames.some((f) => f.id === id), 15_000, `rpc ${String(frame.cmd)}`)
    return this.frames.find((f) => f.id === id)!
  }
  events(ev: string): Frame[] { return this.frames.filter((f) => f.ev === ev) }
  get open(): boolean { return this.ws.readyState === WebSocket.OPEN }
}

async function connect(port: number): Promise<Peer> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
  const peer = new Peer(ws)
  cleanups.push(() => { try { ws.terminate() } catch { /* gone */ } })
  return peer
}

/** A Walnut server's socket: it names its Walnut, and answers relays like the real one. */
function walnutIdOf(home: string): string {
  return `w${crypto.createHash('sha1').update(home).digest('hex').slice(0, 12)}`
}

async function server(port: number, home: string | null, backup = false): Promise<Peer> {
  const peer = await connect(port)
  const pinger = setInterval(() => { try { peer.ws.ping() } catch { /* closed */ } }, 150)
  peer.ws.once('close', () => clearInterval(pinger))
  cleanups.push(() => clearInterval(pinger))
  if (home) {
    const r = await peer.rpc({ cmd: 'leader.configure', home, walnutId: walnutIdOf(home), backup })
    expect(r.ok, JSON.stringify(r)).toBe(true)
  }
  return peer
}

/** A fake companion: records every bridge connection, answers its ping markers. */
async function companion() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((r) => wss.on('listening', () => r()))
  const links: Peer[] = []
  wss.on('connection', (ws) => {
    const peer = new Peer(ws as unknown as WebSocket)
    links.push(peer)
    ws.on('message', (d) => {
      try {
        const f = JSON.parse(String(d)) as Frame
        if (f.ev === 'bridge-ping') ws.send(JSON.stringify({ cmd: 'ping', ackSeq: f.seq, id: nextId++ }))
      } catch { /* not json */ }
    })
  })
  cleanups.push(() => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()) }))
  const port = (wss.address() as { port: number }).port
  return {
    url: `ws://127.0.0.1:${port}/bridge`,
    links,
    /** Connections that said hello. */
    hellos: () => links.filter((l) => l.events('hello').length > 0),
    async link(index = 0): Promise<Peer> {
      await waitFor(() => links.length > index && links[index].events('hello').length > 0, 15_000, `bridge hello ${index}`)
      return links[index]
    },
  }
}

function configure(peer: Peer, url: string, home: string | null, extra: Frame = {}): Promise<Frame> {
  return peer.rpc({ cmd: 'bridge.configure', enabled: true, url, token: 'fixture-only', hostAlias: 'fixture-host', ...(home ? { home } : {}), ...extra })
}

function scopeKey(home: string): string {
  return crypto.createHash('sha1').update(home).digest('hex').slice(0, 16)
}

const TWINS = bunPath ? (['source', 'standalone'] as const) : (['source'] as const)

describe.each(TWINS)('one bridge link per Walnut (%s twin)', (twin) => {
  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `walnut-bridge-scope-${twin}-`))
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
    return dir
  }

  it('two Walnuts keep two links: a re-push, a new token or enabled:false of one leaves the other alone', async () => {
    const cloudA = await companion(), cloudB = await companion()
    const d = await spawnDaemon(twin, tempDir())
    const a = await server(d.port, HOME_A), b = await server(d.port, HOME_B)
    expect(await configure(a, cloudA.url, HOME_A)).toMatchObject({ ok: true, applied: true })
    expect(await configure(b, cloudB.url, HOME_B)).toMatchObject({ ok: true, applied: true })
    const linkA = await cloudA.link(), linkB = await cloudB.link()

    // The 5-minute re-push, from both: nothing reconnects (it used to be a teardown each).
    expect(await configure(a, cloudA.url, HOME_A)).toMatchObject({ ok: true, connected: true })
    expect(await configure(b, cloudB.url, HOME_B)).toMatchObject({ ok: true, connected: true })
    await sleep(500)
    expect(cloudA.links).toHaveLength(1)
    expect(cloudB.links).toHaveLength(1)
    expect(linkA.open && linkB.open).toBe(true)

    // B's new token redials B only.
    expect(await configure(b, cloudB.url, HOME_B, { token: 'fixture-rotated' })).toMatchObject({ ok: true })
    await cloudB.link(1)
    expect(cloudA.links).toHaveLength(1)
    expect(linkA.open).toBe(true)

    // B turns its bridge off: A's link stays up and answers.
    expect(await b.rpc({ cmd: 'bridge.configure', enabled: false, home: HOME_B })).toMatchObject({ ok: true, connected: false })
    await waitFor(() => !cloudB.links[1].open, 10_000, 'B link closed')
    expect(linkA.open).toBe(true)
    expect(await linkA.rpc({ cmd: 'ping' })).toMatchObject({ ok: true })
    expect(await a.rpc({ cmd: 'bridge.status', home: HOME_A })).toMatchObject({ ok: true, connected: true })
    expect(await b.rpc({ cmd: 'bridge.status', home: HOME_B })).toMatchObject({ ok: true, connected: false })

    // Each Walnut's file is its own, under its scope dir, with its home inside.
    const fileA = JSON.parse(fs.readFileSync(path.join(d.dir, 'walnuts', scopeKey(HOME_A), 'bridge.json'), 'utf8'))
    expect(fileA).toMatchObject({ enabled: true, url: cloudA.url, home: HOME_A, scoped: 1 })
    expect(fs.existsSync(path.join(d.dir, 'bridge.json'))).toBe(false)
  }, 90_000)

  it('a relay on A\'s link reaches only A\'s server, and B cannot answer it', async () => {
    const cloudA = await companion(), cloudB = await companion()
    const d = await spawnDaemon(twin, tempDir())
    // B connects first: the old pick took the first trusted client.
    const b = await server(d.port, HOME_B), a = await server(d.port, HOME_A)
    await configure(a, cloudA.url, HOME_A)
    await configure(b, cloudB.url, HOME_B)
    const linkA = await cloudA.link(), linkB = await cloudB.link()
    await sleep(400)

    const sendId = linkA.send({ cmd: 'session.message', sessionId: 'sid-a', message: 'hello', messageId: 'qm-mobile-scope-1' })
    await waitFor(() => a.events('message-request').length === 1, 10_000, 'A got the relay')
    expect(b.events('message-request')).toHaveLength(0)
    const req = a.events('message-request')[0]
    // B answering A's relay is refused, and the relay stays for A.
    const forged = await b.rpc({ cmd: 'message-result', relayId: req.relayId, result: { messageId: 'forged' } })
    expect(forged.ok).toBe(false)
    expect(String(forged.error)).toMatch(/not this Walnut's relay/)
    expect(await a.rpc({ cmd: 'message-result', relayId: req.relayId, result: { messageId: 'qm-mobile-scope-1' } })).toMatchObject({ ok: true })
    await waitFor(() => linkA.frames.some((f) => f.id === sendId), 10_000, 'A link answered')
    expect(linkA.frames.find((f) => f.id === sendId)).toMatchObject({ ok: true, result: { messageId: 'qm-mobile-scope-1' } })

    // The other way round: B's companion reaches B.
    linkB.send({ cmd: 'session.launch', action: 'create', params: {} })
    await waitFor(() => b.events('launch-request').length === 1, 10_000, 'B got the launch relay')
    expect(a.events('launch-request')).toHaveLength(0)

    // A named link with no server of its Walnut: nothing goes to the other Walnut.
    a.ws.terminate()
    await sleep(400)
    const none = await linkA.rpc({ cmd: 'session.message', sessionId: 'sid-a', message: 'hi', messageId: 'qm-mobile-scope-2' })
    expect(none.ok).toBe(false)
    expect(String(none.error)).toMatch(/^session\.message: no primary server connected/)
    expect(b.events('message-request')).toHaveLength(0)

    // A feed event goes up the pushing Walnut's own link only.
    const before = linkA.events('mobile-event').length
    expect(await b.rpc({ cmd: 'mobile-event', kind: 'fixture', data: { n: 1 }, home: HOME_B })).toMatchObject({ ok: true, relayed: true })
    await waitFor(() => linkB.events('mobile-event').length === 1, 10_000, 'B feed event')
    expect(linkA.events('mobile-event')).toHaveLength(before)
  }, 90_000)

  it('a push with no home keeps the old single link, and its relays reach any server as before', async () => {
    const cloud = await companion()
    const dir = tempDir()
    const d = await spawnDaemon(twin, dir)
    const old = await server(d.port, null)
    expect(await configure(old, cloud.url, null)).toMatchObject({ ok: true, applied: true })
    const link = await cloud.link()
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'bridge.json'), 'utf8'))).toMatchObject({ enabled: true, url: cloud.url, scoped: 1 })
    expect(fs.existsSync(path.join(dir, 'walnuts'))).toBe(false)
    await sleep(400)
    link.send({ cmd: 'session.message', sessionId: 'sid-old', message: 'hello', messageId: 'qm-mobile-old-1' })
    await waitFor(() => old.events('message-request').length === 1, 10_000, 'the unbound server got the relay')
    // A re-push changes nothing; enabled:false turns it off.
    await configure(old, cloud.url, null)
    await sleep(300)
    expect(cloud.links).toHaveLength(1)
    expect(await old.rpc({ cmd: 'bridge.configure', enabled: false })).toMatchObject({ ok: true, connected: false })
    await waitFor(() => !link.open, 10_000, 'the link closed')
  }, 60_000)

  it('the copy an older daemon left is taken over by its Walnut without a second link, and every link redials at boot', async () => {
    const cloudA = await companion(), cloudB = await companion()
    const dir = tempDir()
    // What a daemon before the split kept: one global file, no `scoped` marker.
    fs.writeFileSync(path.join(dir, 'bridge.json'), JSON.stringify({ enabled: true, url: cloudA.url, token: 'fixture-only', hostAlias: 'fixture-host' }), { mode: 0o600 })
    const d = await spawnDaemon(twin, dir)
    const inherited = await cloudA.link()
    const a = await server(d.port, HOME_A), b = await server(d.port, HOME_B)
    // B's companion and host alias are other ones: B does not take A's link over.
    await configure(b, cloudB.url, HOME_B, { hostAlias: 'fixture-host-b' })
    await cloudB.link()
    expect(fs.existsSync(path.join(dir, 'bridge.json'))).toBe(true)
    // A names the same companion: the link moves to A as it is.
    expect(await configure(a, cloudA.url, HOME_A)).toMatchObject({ ok: true, connected: true })
    await sleep(500)
    expect(cloudA.links).toHaveLength(1)
    expect(inherited.open).toBe(true)
    expect(fs.existsSync(path.join(dir, 'bridge.json'))).toBe(false)
    // It is A's link now: its relays go to A.
    inherited.send({ cmd: 'session.message', sessionId: 'sid-a', message: 'hello', messageId: 'qm-mobile-inherit-1' })
    await waitFor(() => a.events('message-request').length === 1, 10_000, 'A got the relay')
    expect(b.events('message-request')).toHaveLength(0)

    // A restart dials both saved links again.
    await stopDaemon(d)
    await waitFor(() => !inherited.open, 10_000, 'old A link closed')
    await spawnDaemon(twin, dir)
    await cloudA.link(1)
    await cloudB.link(1)
  }, 90_000)

  function legacyFile(dir: string, url: string, hostAlias = 'fixture-host'): void {
    // What a daemon before the split kept: one global file, no `scoped` marker.
    fs.writeFileSync(path.join(dir, 'bridge.json'), JSON.stringify({ enabled: true, url, token: 'fixture-only', hostAlias }), { mode: 0o600 })
  }

  it('on a host with one Walnut, a disabled push closes the copy an older daemon left, for good', async () => {
    const cloud = await companion()
    const dir = tempDir()
    legacyFile(dir, cloud.url)
    const d = await spawnDaemon(twin, dir)
    const inherited = await cloud.link()
    const a = await server(d.port, HOME_A)
    // Bridge off (or credentials missing): no url, no alias.
    expect(await a.rpc({ cmd: 'bridge.configure', enabled: false, home: HOME_A })).toMatchObject({ ok: true, connected: false })
    await waitFor(() => !inherited.open, 10_000, 'the old link closed')
    expect(fs.existsSync(path.join(dir, 'bridge.json'))).toBe(false)
    await sleep(1_500)
    expect(cloud.links).toHaveLength(1)
    // Not after a restart either.
    await stopDaemon(d)
    await spawnDaemon(twin, dir)
    await sleep(1_500)
    expect(cloud.links).toHaveLength(1)
  }, 60_000)

  it('on a shared host the copy stays while it is not this Walnut\'s, and a later push of its own companion takes it over', async () => {
    const cloudA = await companion(), cloudB = await companion()
    const dir = tempDir()
    legacyFile(dir, cloudA.url)
    const d = await spawnDaemon(twin, dir)
    const inherited = await cloudA.link()
    const a = await server(d.port, HOME_A), b = await server(d.port, HOME_B)
    await configure(b, cloudB.url, HOME_B, { hostAlias: 'fixture-host-b' })
    await cloudB.link()
    // A's disabled push names nothing, and A is not the only Walnut: the copy stays.
    expect(await a.rpc({ cmd: 'bridge.configure', enabled: false, home: HOME_A })).toMatchObject({ ok: true })
    await sleep(500)
    expect(inherited.open).toBe(true)
    expect(fs.existsSync(path.join(dir, 'bridge.json'))).toBe(true)
    // A's link of its own already exists; the enabled push with the old url still takes the copy over.
    expect(await configure(a, cloudA.url, HOME_A)).toMatchObject({ ok: true })
    await waitFor(() => !inherited.open, 10_000, 'the old link closed')
    const own = await cloudA.link(1)
    expect(fs.existsSync(path.join(dir, 'bridge.json'))).toBe(false)
    await sleep(500)
    expect(cloudA.links).toHaveLength(2)
    expect(own.open).toBe(true)
    // A second push changes nothing.
    await configure(a, cloudA.url, HOME_A)
    await sleep(500)
    expect(cloudA.links).toHaveLength(2)
  }, 60_000)

  it('two Walnuts naming the host alike: A\'s push to its own companion leaves B\'s copy running', async () => {
    const cloudA = await companion(), cloudB = await companion()
    const dir = tempDir()
    legacyFile(dir, cloudB.url, 'fixture-host')
    const d = await spawnDaemon(twin, dir)
    const inherited = await cloudB.link()
    const a = await server(d.port, HOME_A)
    await server(d.port, HOME_B)
    // Same alias, another companion host: not A's copy.
    expect(await configure(a, cloudA.url, HOME_A, { hostAlias: 'fixture-host' })).toMatchObject({ ok: true })
    await cloudA.link()
    await sleep(800)
    expect(inherited.open).toBe(true)
    expect(fs.existsSync(path.join(dir, 'bridge.json'))).toBe(true)
    expect(cloudB.links).toHaveLength(1)
  }, 60_000)

  it('a scope dir another Walnut left keeps the copy from a lone Walnut\'s disabled push', async () => {
    const cloud = await companion()
    const dir = tempDir()
    legacyFile(dir, cloud.url)
    // B armed a trigger here once (its scope dir sits under the trigger state base), and is not connected now.
    fs.mkdirSync(path.join(dir, 'trigger-state', 'walnuts', scopeKey(HOME_B)), { recursive: true })
    // A's own scope dir does not count.
    fs.mkdirSync(path.join(dir, 'walnuts', scopeKey(HOME_A)), { recursive: true })
    const d = await spawnDaemon(twin, dir)
    const inherited = await cloud.link()
    const a = await server(d.port, HOME_A)
    expect(await a.rpc({ cmd: 'bridge.configure', enabled: false, home: HOME_A })).toMatchObject({ ok: true })
    await sleep(800)
    expect(inherited.open).toBe(true)
    expect(fs.existsSync(path.join(dir, 'bridge.json'))).toBe(true)
  }, 60_000)

  for (const order of ['named first', 'unnamed first'] as const) {
    it(`an older server's repeated disabled pushes never touch a new Walnut's link (${order})`, async () => {
      const cloud = await companion()
      const d = await spawnDaemon(twin, tempDir())
      const older = await server(d.port, null)
      const fresh = await server(d.port, HOME_A)
      const off = () => older.rpc({ cmd: 'bridge.configure', enabled: false })
      if (order === 'unnamed first') expect(await off()).toMatchObject({ ok: true, connected: false })
      await configure(fresh, cloud.url, HOME_A)
      const link = await cloud.link()
      for (let i = 0; i < 4; i++) {
        expect(await off()).toMatchObject({ ok: true, connected: false })
        // The new server's own re-push in between, as both run their clocks.
        await configure(fresh, cloud.url, HOME_A)
      }
      await sleep(800)
      expect(cloud.links).toHaveLength(1)
      expect(link.open).toBe(true)
      expect(await fresh.rpc({ cmd: 'bridge.status', home: HOME_A })).toMatchObject({ ok: true, connected: true })
    }, 60_000)
  }

  it('an older server\'s disabled push owns and closes the copy when it comes first; the new Walnut\'s own link after it is never touched', async () => {
    const cloud = await companion()
    const dir = tempDir()
    legacyFile(dir, cloud.url, 'some-other-alias')
    const d = await spawnDaemon(twin, dir)
    const inherited = await cloud.link()
    const older = await server(d.port, null)
    const fresh = await server(d.port, HOME_A)
    // The older server pushed since boot, so "only Walnut here" is off: the url match takes it over.
    expect(await older.rpc({ cmd: 'bridge.configure', enabled: false, url: undefined })).toMatchObject({ ok: true })
    // The unnamed push made the copy the older server's own and turned it off.
    await waitFor(() => !inherited.open, 10_000, 'the copy closed by its older server')
    await configure(fresh, cloud.url, HOME_A)
    const link = await cloud.link(1)
    for (let i = 0; i < 3; i++) await older.rpc({ cmd: 'bridge.configure', enabled: false })
    await sleep(800)
    expect(cloud.links).toHaveLength(2)
    expect(link.open).toBe(true)
  }, 60_000)

  it('the copy with the new Walnut\'s url, taken over before any older push, survives those pushes', async () => {
    const cloud = await companion()
    const dir = tempDir()
    legacyFile(dir, cloud.url, 'some-other-alias')
    const d = await spawnDaemon(twin, dir)
    const inherited = await cloud.link()
    const older = await server(d.port, null)
    const fresh = await server(d.port, HOME_A)
    await older.rpc({ cmd: 'ping' })
    // Another Walnut shows itself (bound socket) so only the url can match.
    await server(d.port, HOME_B)
    expect(await configure(fresh, cloud.url, HOME_A)).toMatchObject({ ok: true })
    // Taken over by the url (its host alias differs, so it redials once with the new one).
    expect(fs.existsSync(path.join(dir, 'bridge.json'))).toBe(false)
    const link = await cloud.link(1)
    await waitFor(() => !inherited.open, 10_000, 'the first connection replaced')
    for (let i = 0; i < 3; i++) await older.rpc({ cmd: 'bridge.configure', enabled: false })
    await sleep(800)
    expect(cloud.links).toHaveLength(2)
    expect(link.open).toBe(true)
  }, 60_000)

  it('companion A cannot claim B\'s lead, gets only its own witness, and never reaches or hears B\'s session', async () => {
    const cloudA = await companion(), cloudB = await companion()
    const dir = tempDir()
    const d = await spawnDaemon(twin, dir)
    const a = await server(d.port, HOME_A, true), b = await server(d.port, HOME_B, true)
    await configure(a, cloudA.url, HOME_A)
    await configure(b, cloudB.url, HOME_B, { hostAlias: 'fixture-host-b' })
    const linkA = await cloudA.link(), linkB = await cloudB.link()

    const witnessA = await linkA.rpc({ cmd: 'leader.witness' })
    expect(witnessA.ok).toBe(true)
    expect((witnessA.walnuts as Frame[]).map((w) => w.walnutId)).toEqual([walnutIdOf(HOME_A)])
    const claim = await linkA.rpc({ cmd: 'leader.claim', walnutId: walnutIdOf(HOME_B), epoch: 99 })
    expect(claim).toMatchObject({ ok: false, errorKind: 'not_owner' })
    // Its own claim passes the gate (refused by the leader book: B's primary is alive).
    const own = await linkA.rpc({ cmd: 'leader.claim', walnutId: walnutIdOf(HOME_A), epoch: 99 })
    expect(own.errorKind).not.toBe('not_owner')

    // A session of B's on this host.
    const mock = path.join(dir, 'mock-cli.cjs')
    fs.writeFileSync(mock, "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: process.argv[2] }) + '\\n')\n"
      + "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ready', session_id: process.argv[2] }) + '\\n')\n"
      + "process.stdin.on('data', (c) => require('fs').appendFileSync(process.argv[3], c))\nsetInterval(() => {}, 1 << 30)\n")
    const sid = crypto.randomUUID()
    const inbox = path.join(dir, 'inbox.txt')
    const started = await b.rpc({ cmd: 'start', sid, cwd: dir, message: 'init', args: [process.execPath, mock, sid, inbox], origin: { home: HOME_B, task: 'fixture-task' } })
    expect(started.ok, JSON.stringify(started)).toBe(true)
    cleanups.push(async () => { await b.rpc({ cmd: 'stop', sid, reason: 'user', home: HOME_B }).catch(() => null) })
    await waitFor(() => linkB.events('session_state').some((e) => e.sid === sid), 15_000, 'B hears its session')
    expect(linkA.events('session_state').filter((e) => e.sid === sid)).toHaveLength(0)
    for (const frame of [
      { cmd: 'send', sid, message: 'from the wrong companion', messageId: 'qm-wrong-1' },
      { cmd: 'attach', sid },
      { cmd: 'read-history', sid },
      { cmd: 'status', sid },
    ]) {
      expect(await linkA.rpc(frame), String(frame.cmd)).toMatchObject({ ok: false, errorKind: 'not_owner' })
    }
    expect(await linkB.rpc({ cmd: 'status', sid })).toMatchObject({ ok: true, exists: true })
    // A session whose Walnut is not recorded stays reachable, as before.
    expect(await linkA.rpc({ cmd: 'status', sid: crypto.randomUUID() })).toMatchObject({ ok: true, exists: false })
    await sleep(300)
    expect(fs.existsSync(inbox) ? fs.readFileSync(inbox, 'utf8') : '').not.toContain('from the wrong companion')
  }, 90_000)

  it('a relay reaches the server that pushed the link before that socket binds its home', async () => {
    const cloud = await companion()
    const d = await spawnDaemon(twin, tempDir())
    const bystander = await server(d.port, null)
    const pusher = await server(d.port, null)
    await configure(pusher, cloud.url, HOME_A)
    const link = await cloud.link()
    await sleep(400)
    link.send({ cmd: 'session.message', sessionId: 'sid-a', message: 'hello', messageId: 'qm-mobile-unbound-1' })
    await waitFor(() => pusher.events('message-request').length === 1, 10_000, 'the pusher got the relay')
    expect(bystander.events('message-request')).toHaveLength(0)
    // Gone with its socket: nothing else takes it.
    pusher.ws.terminate()
    await sleep(400)
    const none = await link.rpc({ cmd: 'session.message', sessionId: 'sid-a', message: 'hi', messageId: 'qm-mobile-unbound-2' })
    expect(String(none.error)).toMatch(/^session\.message: no primary server connected/)
    expect(bystander.events('message-request')).toHaveLength(0)
  }, 60_000)
})
