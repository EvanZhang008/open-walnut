/**
 * host-slice-probe-v1 on a REAL daemon (both twins): a reconnect to a daemon that
 * still holds the server's copy names it (`host.slice {home, hash}`) instead of
 * sending it. 2026-10-29: the whole copy (about 1.5 MB) went out on every
 * reconnect, and an upload burst is what the SSH path's relay drops the link on,
 * so a new link dropped again within a second, five times in a row.
 *
 * What's real: the daemon process (source twin under node, standalone under bun
 * when bun is installed), its WS, its agent-gateway socket. The Walnut server is a
 * bare WS client. Every daemon is killed by the pid it wrote into its own temp dir.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import type { GatewayResponse } from '../../src/providers/gateway-core.js'
import type { HostSlice } from '../../src/providers/offline-host-core.js'
import { ADVERTISED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'
import { testBun } from '../helpers/bun-runtime.js'

const ROOT = path.resolve(__dirname, '../..')
const HOME = '/fixture/walnut-home'
const A = 'aaaaaaaa-1111-4111-8111-111111111111'
const TASK_A = 'mtaskaaa-0001'

const bunPath = (() => {
  const own = testBun()
  if (own) return own
  try { return execFileSync('which', ['bun'], { encoding: 'utf8' }).trim() || null } catch { return null }
})()

interface Daemon { proc: ChildProcess; dir: string; port: number; sock: string; pid: number }

function waitFor(cond: () => boolean, ms: number, label: string): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve()
      if (Date.now() - start > ms) return reject(new Error('timed out waiting for ' + label))
      setTimeout(tick, 50)
    }
    tick()
  })
}

async function spawnDaemon(twin: 'source' | 'standalone'): Promise<Daemon> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `walnut-slice-probe-${twin}-`))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALNUT_DAEMON_DIR: dir,
    WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_GATEWAY_TIMEOUT_MS: '2000',
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  let proc: ChildProcess
  if (twin === 'source') {
    const script = path.join(dir, 'daemon.cjs')
    fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
    proc = spawn(SOURCE_TWIN.file, [script, '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  } else {
    proc = spawn(bunPath!, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'], cwd: ROOT })
  }
  const portFile = path.join(dir, 'daemon.port')
  const sock = path.join(dir, 'agent-gateway.sock')
  await waitFor(() => fs.existsSync(portFile) && fs.existsSync(sock) && fs.existsSync(path.join(dir, 'daemon.pid')), 30_000, `${twin} daemon`)
  return {
    proc, dir, sock,
    port: parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10),
    pid: parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10),
  }
}

function stopDaemon(d: Daemon): void {
  if (d.pid > 1) { try { process.kill(d.pid, 'SIGTERM') } catch { /* gone */ } }
  try { d.proc.kill('SIGTERM') } catch { /* gone */ }
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const t = setTimeout(() => reject(new Error('ws connect timeout')), 5000)
    ws.once('open', () => { clearTimeout(t); resolve(ws) })
    ws.once('error', (e) => { clearTimeout(t); reject(e) })
  })
}

let nextId = 1
function cmd(ws: WebSocket, body: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', on); reject(new Error(`cmd ${body.cmd} timed out`)) }, timeoutMs)
    const on = (raw: WebSocket.Data) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>
        if (msg.id === id) { clearTimeout(t); ws.off('message', on); resolve(msg) }
      } catch { /* not json */ }
    }
    ws.on('message', on)
    ws.send(JSON.stringify({ id, ...body }))
  })
}

function data(reply: Record<string, unknown>): Record<string, unknown> {
  return (reply.data && typeof reply.data === 'object' ? reply.data : reply) as Record<string, unknown>
}

function gateway(sock: string, sid: string, name: string, args: Record<string, unknown> = {}): Promise<GatewayResponse> {
  return new Promise((resolve, reject) => {
    const s = net.connect(sock)
    let buf = ''
    const t = setTimeout(() => { s.destroy(); reject(new Error('gateway timeout')) }, 15_000)
    s.on('connect', () => s.write(JSON.stringify({ v: 1, op: 'tools.call', sid, args: { name, args } }) + '\n'))
    s.on('data', (c) => {
      buf += c.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl !== -1) { clearTimeout(t); s.destroy(); resolve(JSON.parse(buf.slice(0, nl))) }
    })
    s.on('error', (e) => { clearTimeout(t); reject(e) })
  })
}

/** A CLI that boots, goes idle and keeps reading: the gateway only answers a session it tracks. */
const MOCK_CLI = `
const sid = process.argv[2]
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: sid })
out({ type: 'result', subtype: 'success', is_error: false, result: 'ready', session_id: sid })
out({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
process.stdin.on('data', () => {})
setInterval(() => {}, 1 << 30)
`

const T0 = Date.parse('2026-10-29T08:00:00.000Z')

function slice(overrides: Partial<HostSlice> = {}): HostSlice {
  return {
    v: 1, home: HOME, hash: 'h-probe-1', asOf: T0, host: 'devbox',
    sessions: [{ sid: A, taskId: TASK_A, title: 'Parent work' }],
    tasks: [{ id: TASK_A, title: 'Parent work', phase: 'IN_PROGRESS', project: 'Acme' }],
    requests: [],
    ...overrides,
  }
}

const twins: Array<'source' | 'standalone'> = bunPath ? ['source', 'standalone'] : ['source']

it('advertises host-slice-probe-v1 and host-slice-gz-v1', () => {
  expect(ADVERTISED_DAEMON_CAPABILITIES).toContain('host-slice-probe-v1')
  expect(ADVERTISED_DAEMON_CAPABILITIES).toContain('host-slice-gz-v1')
})

describe.each(twins)('host.slice probe on the real %s daemon', (twin) => {
  let d: Daemon

  beforeAll(async () => {
    d = await spawnDaemon(twin)
    const mock = path.join(d.dir, 'mock-cli.cjs')
    fs.writeFileSync(mock, MOCK_CLI)
    const ws = await connectWs(d.port)
    const started = await cmd(ws, {
      cmd: 'start', sid: A, cwd: d.dir, message: 'init',
      args: [process.execPath, mock, A], origin: { home: HOME, task: TASK_A },
    })
    expect(started.ok, JSON.stringify(started)).toBe(true)
    await waitFor(() => {
      try { return fs.readFileSync(path.join(d.dir, 'streams', `${A}.jsonl`), 'utf8').includes('"state":"idle"') } catch { return false }
    }, 20_000, 'the session idle')
    const pushed = await cmd(ws, { cmd: 'host.slice', slice: slice() })
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true)
    ws.close()
    await new Promise((r) => setTimeout(r, 300))
  }, 60_000)

  afterAll(() => { if (d) stopDaemon(d) })

  it('takes a gzipped copy (host-slice-gz-v1) as it takes the JSON one', async () => {
    const ws = await connectWs(d.port)
    try {
      const gz = zlib.gzipSync(Buffer.from(JSON.stringify(slice({ hash: 'h-gz-1', tasks: [{ id: TASK_A, title: 'Gzipped work', phase: 'IN_PROGRESS', project: 'Acme' }] })))).toString('base64')
      const r = await cmd(ws, { cmd: 'host.slice', sliceGz: gz })
      expect(r.ok, JSON.stringify(r)).toBe(true)
      expect(data(r).changed).toBe(true)
      const held = await cmd(ws, { cmd: 'host.slice', home: HOME, hash: 'h-gz-1', asOf: T0 })
      expect(data(held).have).toBe(true)
    } finally { ws.close() }
    await new Promise((r) => setTimeout(r, 300))
    const g = await gateway(d.sock, A, 'task_get', { id: TASK_A })
    expect(g.ok, JSON.stringify(g)).toBe(true)
    if (g.ok) expect(JSON.stringify(g.result)).toContain('Gzipped work')
    // Back to the copy the other cases read.
    const ws2 = await connectWs(d.port)
    try { expect((await cmd(ws2, { cmd: 'host.slice', slice: slice() })).ok).toBe(true) } finally { ws2.close() }
    await new Promise((r) => setTimeout(r, 300))
  }, 30_000)

  it('a probe naming another copy is told to send it, and binds nothing', async () => {
    const ws = await connectWs(d.port)
    try {
      const r = await cmd(ws, { cmd: 'host.slice', home: HOME, hash: 'h-other', asOf: T0 + 60_000 })
      expect(r.ok, JSON.stringify(r)).toBe(true)
      expect(data(r).have).toBe(false)
      // Unbound: the gateway still answers from the copy, as of the push.
      const g = await gateway(d.sock, A, 'task_get', { id: TASK_A })
      expect(g.ok, JSON.stringify(g)).toBe(true)
      if (g.ok) expect(g.result).toMatchObject({ offline: true, task: { id: TASK_A } })
      const unknown = await cmd(ws, { cmd: 'host.slice', home: '/fixture/no-such-home', hash: 'h-probe-1' })
      expect(data(unknown).have).toBe(false)
    } finally { ws.close() }
  })

  it('a probe naming the held copy binds the socket as a push would, and moves its time', async () => {
    const ws = await connectWs(d.port)
    const seen: string[] = []
    ws.on('message', (raw) => seen.push(raw.toString()))
    try {
      const r = await cmd(ws, { cmd: 'host.slice', home: HOME, hash: 'h-probe-1', asOf: T0 + 3_600_000 })
      expect(r.ok, JSON.stringify(r)).toBe(true)
      expect(data(r)).toMatchObject({ have: true, changed: false, pendingHandover: false })
      // Bound: a gateway call goes to this socket (the connected server), not to the copy.
      void gateway(d.sock, A, 'task_get', { id: TASK_A }).catch(() => {})
      await waitFor(() => seen.some((m) => m.includes('task_get')), 10_000, 'the call relayed to the bound socket')
    } finally { ws.close() }
    await new Promise((r) => setTimeout(r, 300))
    // Away again: the copy answers, as of the probe's time.
    const g = await gateway(d.sock, A, 'task_get', { id: TASK_A })
    expect(g.ok, JSON.stringify(g)).toBe(true)
    if (g.ok) expect(JSON.stringify(g.result)).toContain(new Date(T0 + 3_600_000).toISOString().slice(0, 16))
  }, 30_000)
})
