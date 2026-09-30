/**
 * `session.control` by host, over REAL daemon processes (control-host-policy.ts).
 *
 * The one legitimate sender of `session.control` is the cloud replica, which
 * always asks the bridge alias '__local__' (the Mac's own daemon). A remote exec
 * host's daemon forwards whatever a process on that host sends it, so every
 * action from it is refused. Two real daemon-source processes stand in for the
 * two hosts:
 *
 *   remote host   a process there -> its daemon (cmdControlRelay) -> control-request
 *                 -> the REAL DaemonConnection handler under host key 'remote-dev'
 *                 -> forbidden, and the action never runs
 *   the Mac       callPrimaryControl on the replica side -> the REAL bridge registry
 *                 -> the Mac's daemon -> the REAL handler under '__local__' -> runs
 *
 * A session on the remote host still reaches Walnut through the gateway: an
 * NDJSON line on that daemon's agent socket (what `walnut tools call` sends) is
 * relayed to the same handler and answered by the real op executor, against a
 * stub API on a test port that serves the real task store.
 *
 * As in asks-relay-e2e.test.ts, the trusted socket is a plain WebSocket feeding
 * the real handler (a real DaemonConnection would dial and deploy a daemon).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-control-host-e2e'))

import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { attachBridge, closeAllBridges, bridgeForHost } from '../../src/web/ws/bridge-registry.js'
import { callPrimaryControl } from '../../src/web/routes/v1-control-relay.js'
import { resolveApiBase } from '../../src/ops/executor.js'
import { WALNUT_HOME } from '../../src/constants.js'
import { getTask, _resetForTesting } from '../../src/core/task-manager.js'
import { closeDb } from '../../src/core/task-db.js'

interface Daemon { proc: ChildProcess; port: number; dir: string }

let tmpRoot = ''
const daemons: Daemon[] = []
const sockets: WebSocket[] = []
let cloud: WebSocketServer | null = null
let api: http.Server | null = null
let apiUrl = ''
const apiOrigins: Array<string | undefined> = []
const saved: Record<string, string | undefined> = {}

async function spawnDaemon(name: string): Promise<Daemon> {
  const dir = path.join(tmpRoot, name)
  fs.mkdirSync(dir, { recursive: true })
  const script = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
  const proc = spawn('node', [script, '--start'], {
    // Every directory the daemon owns is ours: it never sees a real registry or stream.
    env: { ...process.env, WALNUT_DAEMON_DIR: path.join(dir, 'd'), WALNUT_STREAMS_DIR: path.join(dir, 's'), WALNUT_LEGACY_STREAMS_DIR: path.join(dir, 'ls') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 20_000)
    proc.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`daemon exited early: ${code}`)) })
  })
  const d = { proc, port, dir: path.join(dir, 'd') }
  daemons.push(d)
  return d
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.on('open', () => { sockets.push(ws); resolve(ws) })
    ws.on('error', reject)
  })
}

function rpc(ws: WebSocket, id: number, cmd: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`rpc timeout: ${cmd}`)), 20_000)
    const onMessage = (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>
      if (msg.id === id) { clearTimeout(timer); ws.off('message', onMessage); resolve(msg) }
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, cmd, ...params }))
  })
}

/** This server's side of a daemon's trusted socket, under `hostKey`: the real relay handlers. */
function serve(ws: WebSocket, hostKey: string): { controls: string[] } {
  const conn = new DaemonConnection(hostKey, null)
  let nextId = 60_000
  ;(conn as unknown as { send: (cmd: string, params: Record<string, unknown>) => Promise<unknown> }).send =
    async (cmd, params) => { ws.send(JSON.stringify({ id: ++nextId, cmd, ...params })); return { ok: true } }
  const controls: string[] = []
  const handlers = conn as unknown as Record<string, (e: Record<string, unknown>) => Promise<void>>
  ws.on('message', (data) => {
    let msg: Record<string, unknown>
    try { msg = JSON.parse(data.toString()) } catch { return }
    if (msg.ev === 'control-request') { controls.push(String(msg.action)); void handlers.handleControlRequest(msg) }
    if (msg.ev === 'gateway-request') void handlers.handleGatewayRequest(msg)
  })
  return { controls }
}

function waitFor(pred: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'))
      setTimeout(tick, 100)
    }
    tick()
  })
}

const createOp = (id: string) => ({
  op: {
    opId: `op-${id}`, type: 'create', at: new Date().toISOString(),
    task: { id, title: `Control probe ${id}`, status: 'todo', phase: 'TODO', priority: 'none', project: '', source: 'local', session_ids: [], description: '', summary: '', note: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  },
})

let remote: { controls: string[] }
let hostProcess: WebSocket
let remoteDaemon: Daemon

beforeAll(async () => {
  for (const k of ['WALNUT_BRIDGE_BLIP_GRACE_MS', 'OPEN_WALNUT_API_URL']) saved[k] = process.env[k]
  process.env.WALNUT_BRIDGE_BLIP_GRACE_MS = '0'
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-control-host-'))
  closeDb()
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true })
  fs.mkdirSync(WALNUT_HOME, { recursive: true })
  _resetForTesting()

  // The API a gateway op reaches: a test port serving the real task store, never :3456.
  api = http.createServer((req, res) => {
    apiOrigins.push(req.headers['x-walnut-origin'] as string | undefined)
    const m = /^\/api\/tasks\/([^/?]+)/.exec(req.url ?? '')
    void (async () => {
      const task = m ? await getTask(decodeURIComponent(m[1]!)).catch(() => undefined) : undefined
      res.writeHead(task ? 200 : 404, { 'content-type': 'application/json' })
      res.end(JSON.stringify(task ? { task } : { error: 'not found' }))
    })()
  })
  await new Promise<void>((resolve) => api!.listen(0, '127.0.0.1', resolve))
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
  process.env.OPEN_WALNUT_API_URL = apiUrl

  // The remote host: its daemon, this server's trusted socket to it, and a process there.
  remoteDaemon = await spawnDaemon('remote')
  remote = serve(await connectWs(remoteDaemon.port), 'remote-dev')
  hostProcess = await connectWs(remoteDaemon.port)

  // The Mac: its daemon, this server's trusted socket, and its bridge to the replica.
  cloud = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((resolve) => cloud!.on('listening', resolve))
  cloud.on('connection', (ws) => attachBridge(ws as unknown as WebSocket, 'bridge-local'))
  const mac = await spawnDaemon('mac')
  const macSocket = await connectWs(mac.port)
  serve(macSocket, '__local__')
  const conf = await rpc(macSocket, 1, 'bridge.configure', {
    enabled: true, url: `ws://127.0.0.1:${(cloud.address() as AddressInfo).port}/bridge`, token: 'test-machine-token', hostAlias: '__local__',
  })
  expect(conf.ok).toBe(true)
  await waitFor(() => bridgeForHost('__local__').connected)
}, 90_000)

afterAll(async () => {
  closeAllBridges()
  for (const ws of sockets) { try { ws.close() } catch { /* closed */ } }
  for (const d of daemons) {
    if (d.proc.exitCode !== null) continue
    d.proc.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { try { d.proc.kill('SIGKILL') } catch { /* gone */ } resolve() }, 3000)
      d.proc.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
  await new Promise<void>((resolve) => cloud ? cloud.close(() => resolve()) : resolve())
  await new Promise<void>((resolve) => api ? api.close(() => resolve()) : resolve())
  closeDb()
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true })
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
})

describe('session.control over real daemons, by host', () => {
  it('a process on a remote host cannot run a box-level or session action through its daemon', async () => {
    const attempts: Array<[string, string, Record<string, unknown>]> = [
      ['server.tasks.apply', '__server__', createOp('ctl-remote-1')],
      ['server.routines.run', '__server__', { id: 'routine-x' }],
      ['server.routines.check-test', '__server__', { check: { run: 'true', timeoutSeconds: 5 } }],
      ['server.chat.turn', '__server__', { text: 'hello' }],
      ['server.human-inbox.send', '__server__', { subject: 'probe', body: 'probe' }],
      ['server.files.list', '__server__', { path: '/' }],
      ['model', 'sess-probe', { model: 'sonnet' }],
      ['terminate', 'sess-probe', {}],
    ]
    let id = 100
    for (const [action, sessionId, params] of attempts) {
      const reply = await rpc(hostProcess, ++id, 'session.control', { action, sessionId, params })
      expect(reply, action).toMatchObject({ ok: false, errorKind: 'forbidden' })
      expect(String(reply.error), action).toBe(
        `${action} was refused: session controls are accepted only through this Mac's own daemon, not the daemon on host remote-dev`)
    }
    // Each one reached this server's handler, and none of them ran.
    expect(remote.controls).toEqual(attempts.map(([a]) => a))
    _resetForTesting()
    await expect(getTask('ctl-remote-1')).rejects.toThrow(/No task found/)
  })

  it('the replica\'s relay over the Mac\'s own daemon still runs the same action', async () => {
    const outcome = await callPrimaryControl('server.tasks.apply', '__server__', createOp('ctl-local-1'), 20_000)
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, result: { applied: true, opId: 'op-ctl-local-1' } })
    _resetForTesting()
    expect(await getTask('ctl-local-1')).toMatchObject({ title: 'Control probe ctl-local-1' })
  })

  it('a session on the remote host still reaches Walnut through the gateway (`walnut tools call`)', async () => {
    expect(resolveApiBase()).toBe(`${apiUrl}/api/v1`)
    const sock = path.join(remoteDaemon.dir, 'agent-gateway.sock')
    await waitFor(() => fs.existsSync(sock))
    const line = JSON.stringify({ v: 1, op: 'tools.call', sid: 'external', args: { name: 'task_get', args: { id: 'ctl-local-1' } } })
    const answer = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const s = net.createConnection(sock)
      let text = ''
      s.on('data', (c) => { text += c.toString() })
      s.on('end', () => { try { resolve(JSON.parse(text.trim())) } catch (e) { reject(e) } })
      s.on('error', reject)
      s.write(line + '\n')
    })
    expect(answer, JSON.stringify(answer)).toMatchObject({ ok: true, result: { task: { id: 'ctl-local-1' } } })
    // The op ran for the remote host, never as this Mac.
    expect(apiOrigins).toEqual(['host:remote-dev'])
  })
})
