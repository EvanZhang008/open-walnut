/**
 * The companion's forward on a stream through a real daemon, both twins
 * ('bridge-stream-v1', docs/plan/walnut-replica-servers-impl.md WP13).
 *
 *   companion (this process: a /bridge server) <-- the daemon dials it
 *   the Mac   (this process: a trusted client) --> the daemon
 *
 * Pinned: the bridge hello says `bridge-stream-v1` (and says nothing with the cap
 * hidden, as an older daemon); a stream the bridge opens goes to the primary only,
 * arrives there as `from: 'companion'`, and carries bytes both ways; a stream to
 * the follower is refused with the daemon's why; it goes to the server socket that
 * named its Walnut, never to its bulk channel; with no primary linked the open is
 * refused at once (never sent).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { testBun } from '../helpers/bun-runtime.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const BUN: string | undefined = testBun()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms: number, label: string): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for ' + label)
    await sleep(50)
  }
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

let base = ''
const started: number[] = []
const procs: ChildProcess[] = []
let wss: WebSocketServer | null = null
let cport = 0
/** The bridge sockets the daemons dialled, by host alias, and every frame each sent. */
const bridges = new Map<string, { ws: WebSocket; frames: Array<Record<string, any>> }>()

async function spawnDaemon(dir: string, twin: 'source' | 'standalone', extra: NodeJS.ProcessEnv = {}): Promise<{ port: number; pid: number }> {
  fs.mkdirSync(dir, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...process.env, ...extra,
    WALNUT_DAEMON_DIR: dir,
    WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  let proc: ChildProcess
  if (twin === 'source') {
    const script = path.join(dir, 'daemon.cjs')
    fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
    proc = spawn(SOURCE_TWIN.file, [script, '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  } else {
    proc = spawn(BUN!, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'], cwd: ROOT })
  }
  procs.push(proc)
  if (process.env.DEBUG_DAEMON) proc.stderr?.on('data', (b) => process.stderr.write(`[${twin}] ` + b.toString()))
  const portFile = path.join(dir, 'daemon.port')
  await waitFor(() => fs.existsSync(portFile) && fs.existsSync(path.join(dir, 'daemon.pid')), 60_000, `${twin} daemon`)
  const pid = parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10)
  started.push(pid)
  return { port: parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10), pid }
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const t = setTimeout(() => reject(new Error('ws connect timeout')), 5000)
    ws.once('open', () => { clearTimeout(t); resolve(ws) })
    ws.once('error', (e) => { clearTimeout(t); reject(e) })
  })
}

let cmdId = 1
function cmd(ws: WebSocket, body: Record<string, unknown>): Promise<Record<string, any>> {
  const id = cmdId++
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', on); reject(new Error(`cmd ${body.cmd} timed out`)) }, 15_000)
    const on = (data: WebSocket.Data) => {
      try { const m = JSON.parse(data.toString()); if (m.id === id) { clearTimeout(t); ws.off('message', on); resolve(m) } } catch { /* not json */ }
    }
    ws.on('message', on)
    ws.send(JSON.stringify({ id, ...body }))
  })
}

/** Every frame a socket receives, kept. */
function record(ws: WebSocket): Array<Record<string, any>> {
  const seen: Array<Record<string, any>> = []
  ws.on('message', (d) => { try { seen.push(JSON.parse(String(d))) } catch { /* not json */ } })
  return seen
}

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wbs-'))
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((r) => wss!.on('listening', () => r()))
  wss.on('connection', (ws) => {
    const frames: Array<Record<string, any>> = []
    ws.on('message', (d) => {
      let f: Record<string, any>
      try { f = JSON.parse(String(d)) } catch { return }
      frames.push(f)
      if (f.ev === 'hello') bridges.set(String(f.hostAlias), { ws, frames })
      if (f.ev === 'bridge-ping') { try { ws.send(JSON.stringify({ id: 900_000 + frames.length, cmd: 'ping', ackSeq: f.seq })) } catch { /* closed */ } }
    })
  })
  cport = (wss.address() as net.AddressInfo).port
})

afterAll(async () => {
  for (const pid of started) { if (pid > 1 && alive(pid)) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } } }
  await sleep(300)
  for (const p of procs) { if (p.exitCode === null && p.signalCode === null) { try { p.kill('SIGKILL') } catch { /* gone */ } } }
  for (const pid of started) { if (pid > 1 && alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } } }
  wss?.close()
  try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* best effort */ }
})

const closeOf = (frames: Array<Record<string, any>>, sid: string) => frames.find((f) => f.ev === 'stream-close' && f.sid === sid)
// What both twins tell the companion in the bridge hello (BRIDGE_CAPABILITIES; the send
// and permission relays joined bridge-stream-v1 in 5408d5875).
const BRIDGE_CAPS = ['bridge-stream-v1', 'send-dedupe-v1', 'send-lost-line-v1', 'session-permission-v1']

for (const twin of ['source', 'standalone'] as const) {
  describe.skipIf(twin === 'standalone' && !BUN)(`${twin} twin: the companion's forward stream through the bridge`, () => {
    it('the hello says bridge-stream-v1; a stream to the primary arrives from the companion and carries bytes both ways; never to the follower', async () => {
      const alias = `${twin.slice(0, 3)}box`
      const d = await spawnDaemon(path.join(base, twin.slice(0, 2)), twin)
      const mac = await connectWs(d.port)
      const macSaw = record(mac)
      expect((await cmd(mac, { cmd: 'ping' })).ok).toBe(true)
      const configured = await cmd(mac, { cmd: 'bridge.configure', enabled: true, url: `ws://127.0.0.1:${cport}/bridge`, token: 't', hostAlias: alias })
      expect(configured.ok, JSON.stringify(configured)).toBe(true)
      await waitFor(() => bridges.has(alias), 20_000, 'the bridge hello')
      const b = bridges.get(alias)!
      expect(b.frames.find((f) => f.ev === 'hello')).toMatchObject({ hostAlias: alias, capabilities: BRIDGE_CAPS })
      // The Mac names its Walnut on its session link (as host.slice and leader.configure do);
      // its second socket (the bulk channel) names none and drops stream frames: never a target.
      expect((await cmd(mac, { cmd: 'leader.configure', home: '/fixture/acme-home', walnutId: 'wacmetest01' })).ok).toBe(true)
      const bulk = await connectWs(d.port)
      const bulkSaw = record(bulk)
      expect((await cmd(bulk, { cmd: 'ping' })).ok).toBe(true)

      b.ws.send(JSON.stringify({ cmd: 'stream.open', sid: 'o1', to: 'primary', purpose: 'web' }))
      await waitFor(() => macSaw.some((m) => m.ev === 'stream-open'), 10_000, 'the stream at the Mac')
      const open = macSaw.find((m) => m.ev === 'stream-open')!
      expect(open).toMatchObject({ from: 'companion', purpose: 'web' })
      mac.send(JSON.stringify({ cmd: 'stream.accept', sid: open.sid }))
      await waitFor(() => b.frames.some((f) => f.ev === 'stream-accept' && f.sid === 'o1'), 10_000, 'the accept at the companion')
      b.ws.send(JSON.stringify({ cmd: 'stream.data', sid: 'o1', d: Buffer.from('GET /api/v1/usage/overview HTTP/1.1\r\n\r\n').toString('base64') }))
      await waitFor(() => macSaw.some((m) => m.ev === 'stream-data' && m.sid === open.sid), 10_000, 'the bytes at the Mac')
      expect(Buffer.from(macSaw.find((m) => m.ev === 'stream-data')!.d, 'base64').toString()).toMatch(/^GET \/api\/v1\/usage\/overview/)
      mac.send(JSON.stringify({ cmd: 'stream.data', sid: open.sid, d: Buffer.from('HTTP/1.1 200 OK\r\n\r\n').toString('base64') }))
      await waitFor(() => b.frames.some((f) => f.ev === 'stream-data' && f.sid === 'o1'), 10_000, 'the bytes at the companion')
      expect(Buffer.from(b.frames.find((f) => f.ev === 'stream-data' && f.sid === 'o1')!.d, 'base64').toString()).toBe('HTTP/1.1 200 OK\r\n\r\n')
      b.ws.send(JSON.stringify({ cmd: 'stream.close', sid: 'o1' }))
      await waitFor(() => macSaw.some((m) => m.ev === 'stream-close' && m.sid === open.sid), 10_000, 'the close at the Mac')

      // Never to a follower or to the companion itself: refused with the daemon's why.
      for (const [sid, to] of [['o2', 'follower'], ['o3', 'companion']] as const) {
        b.ws.send(JSON.stringify({ cmd: 'stream.open', sid, to }))
        await waitFor(() => !!closeOf(b.frames, sid), 10_000, `the ${to} refusal`)
        expect(closeOf(b.frames, sid)!.error).toBe('the companion opens streams to the primary only')
      }
      expect(macSaw.filter((m) => m.ev === 'stream-open')).toHaveLength(1)
      expect(bulkSaw.filter((m) => m.ev === 'stream-open')).toHaveLength(0)

      // No primary linked (only the bulk channel left): refused at once, so the companion
      // knows it was never sent, and takes server.http instead.
      mac.close()
      await sleep(500)
      const at = Date.now()
      b.ws.send(JSON.stringify({ cmd: 'stream.open', sid: 'o4', to: 'primary' }))
      await waitFor(() => !!closeOf(b.frames, 'o4'), 10_000, 'the refusal with no Mac')
      expect(closeOf(b.frames, 'o4')!.error).toMatch(/no primary server connected/)
      expect(Date.now() - at).toBeLessThan(5_000)
      expect(bulkSaw.filter((m) => m.ev === 'stream-open')).toHaveLength(0)
      bulk.close()
    }, 120_000)

    it('with the cap hidden (WALNUT_BRIDGE_HIDE_CAPS, an older daemon to the companion), the hello says nothing of it', async () => {
      const alias = `${twin.slice(0, 3)}old`
      const d = await spawnDaemon(path.join(base, `${twin.slice(0, 2)}o`), twin, { WALNUT_BRIDGE_HIDE_CAPS: 'bridge-stream-v1' })
      const mac = await connectWs(d.port)
      try {
        expect((await cmd(mac, { cmd: 'bridge.configure', enabled: true, url: `ws://127.0.0.1:${cport}/bridge`, token: 't', hostAlias: alias })).ok).toBe(true)
        await waitFor(() => bridges.has(alias), 20_000, 'the bridge hello')
        expect(bridges.get(alias)!.frames.find((f) => f.ev === 'hello')!.capabilities).toEqual(BRIDGE_CAPS.filter((c) => c !== 'bridge-stream-v1'))
        // The trusted hello still advertises it to the Mac (it is the daemon's own feature).
        const hello = await cmd(mac, { cmd: 'hello' })
        expect(hello.capabilities ?? hello.result?.capabilities).toContain('bridge-stream-v1')
      } finally {
        mac.close()
      }
    }, 90_000)
  })
}
