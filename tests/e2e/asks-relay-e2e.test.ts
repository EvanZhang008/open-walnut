/**
 * GET /api/v1/asks on a cloud REPLICA, end to end over a REAL relay: no mocked
 * bridge anywhere between the phone's request and the Mac's answer.
 *
 *   supertest GET /api/v1/asks (CLOUD_MODE replica route)
 *     -> relayControlAction -> the REAL bridge registry (bridgeRequest)
 *     -> a localhost WebSocket -> the REAL daemon-source process (cmdControlRelay)
 *     -> control-request on its trusted socket -> the REAL DaemonConnection
 *        handler (host policy, handleSessionControlRelay -> computeAgentAsks over
 *        a real task store)
 *     -> control-result back through the daemon and the bridge to the route.
 *
 * Only the two transports a test cannot own are stood in for: the daemon's
 * trusted socket is a plain WebSocket that feeds `handleControlRequest` and
 * carries its `send` (a real DaemonConnection would dial and deploy a daemon of
 * its own), and the session store answers "no sessions" (every ask here is
 * idle or has none). The replica and the primary share this process, which is
 * fine because neither the list nor the relay handler reads CLOUD_MODE.
 *
 * What it pins: the phone gets exactly the primary's answer (every row, every
 * field, `launch: true`), the primary's 404 and a limit the replica refuses keep
 * their frozen shape, and a primary that went away answers 503 bridge_offline
 * rather than a list the replica made up.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-asks-relay-e2e', { CLOUD_MODE: true }))
vi.mock('../../src/core/session-tracker.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/session-tracker.js')>()),
  listSessions: async () => [],
  listSessionsForTasks: async () => [],
}))

import express from 'express'
import request from 'supertest'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { attachBridge, closeAllBridges, bridgeForHost } from '../../src/web/ws/bridge-registry.js'
import { asksV1Router, computeAgentAsks } from '../../src/web/routes/asks-v1.js'
import { errorHandler } from '../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../src/constants.js'
import { listTasksSlim, _resetForTesting } from '../../src/core/task-manager.js'
import { closeDb, getDb, taskToRow } from '../../src/core/task-db.js'
import type { Task } from '../../src/core/types.js'

const PRIMARY_ALIAS = '__local__'

let tmpRoot: string
let daemonProc: ChildProcess | null = null
let daemonPort = 0
let cloud: WebSocketServer
let ctl: WebSocket
let savedGrace: string | undefined

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', asksV1Router)
  app.use(errorHandler)
  return app
}

async function spawnDaemon(): Promise<void> {
  const script = path.join(tmpRoot, 'daemon.cjs')
  fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
  const proc = spawn('node', [script, '--start'], {
    env: {
      ...process.env,
      // Every directory the daemon owns is ours: it must never see the real
      // daemon's registry or streams.
      WALNUT_DAEMON_DIR: path.join(tmpRoot, 'daemon'),
      WALNUT_STREAMS_DIR: path.join(tmpRoot, 'streams'),
      WALNUT_LEGACY_STREAMS_DIR: path.join(tmpRoot, 'legacy-streams'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  daemonProc = proc
  daemonPort = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 15_000)
    proc.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })
}

async function stopDaemon(): Promise<void> {
  const proc = daemonProc
  if (!proc || proc.exitCode !== null) return
  proc.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* gone */ } resolve() }, 3000)
    proc.once('exit', () => { clearTimeout(t); resolve() })
  })
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.on('open', () => resolve(ws))
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

async function waitFor(pred: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** The primary's side of the trusted socket: the real relay handler. */
function servePrimary(ws: WebSocket): { handled: string[] } {
  const conn = new DaemonConnection(PRIMARY_ALIAS, null)
  let nextId = 50_000
  ;(conn as unknown as { send: (cmd: string, params: Record<string, unknown>) => Promise<unknown> }).send =
    async (cmd, params) => { ws.send(JSON.stringify({ id: ++nextId, cmd, ...params })); return { ok: true } }
  const handled: string[] = []
  ws.on('message', (data) => {
    let msg: Record<string, unknown>
    try { msg = JSON.parse(data.toString()) } catch { return }
    if (msg.ev !== 'control-request') return
    handled.push(String(msg.action))
    void (conn as unknown as { handleControlRequest: (e: Record<string, unknown>) => Promise<void> })
      .handleControlRequest(msg)
  })
  return { handled }
}

let seq = 0
function task(over: Partial<Task>): Partial<Task> {
  seq++
  const born = new Date(Date.UTC(2026, 8, 1) + seq * 3_600_000).toISOString()
  return {
    id: `relay-${String(seq).padStart(3, '0')}`, title: `Task ${seq}`, project: 'Home', status: 'todo',
    phase: 'TODO', priority: 'none', source: 'local', created_at: born, updated_at: born, session_ids: [], ...over,
  }
}

async function seedBoard(): Promise<void> {
  _resetForTesting()
  await listTasksSlim({ minimal: true })
  const rows: Array<Partial<Task>> = [
    task({ title: 'Garden plan', project: 'Ask Walnut', walnut_agent: true, session_id: 'sess-garden', session_ids: ['sess-garden'], last_session_update: '2026-09-20T09:00:00.000Z' }),
    task({ title: 'Trip checklist', project: 'Ask Walnut', walnut_agent: true }),
    task({ title: 'Moved to Home, still an ask', project: 'Home', walnut_agent: true }),
    task({ title: 'Filed by hand', project: 'ASK WALNUT' }),
    task({ title: 'Finished one', project: 'Ask Walnut', walnut_agent: true, status: 'done', phase: 'COMPLETE' }),
    task({ title: 'Weekly reflection', project: 'Ask Mentor', walnut_agent: true, agent_id: 'mentor' }),
  ]
  for (let i = 0; i < 200; i++) rows.push(task({ title: `Chore ${i}`, project: i % 2 ? 'Home' : 'Work' }))
  const db = getDb()!
  for (const t of rows) {
    const row = taskToRow(t)
    const cols = Object.keys(row)
    db.prepare(`INSERT INTO tasks (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`).run(row)
  }
  _resetForTesting()
}

let primary: { handled: string[] }

beforeAll(async () => {
  savedGrace = process.env.WALNUT_BRIDGE_BLIP_GRACE_MS
  process.env.WALNUT_BRIDGE_BLIP_GRACE_MS = '0'
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-asks-relay-'))
  closeDb()
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true })
  fs.mkdirSync(WALNUT_HOME, { recursive: true })
  await seedBoard()

  // The replica's bridge endpoint: a local WS server handing each socket to the
  // real registry, authenticated as the Mac's own machine token would be.
  cloud = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((resolve) => cloud.on('listening', resolve))
  cloud.on('connection', (ws) => attachBridge(ws as unknown as WebSocket, 'bridge-local'))
  const address = cloud.address()
  const cloudPort = typeof address === 'object' && address ? address.port : 0

  await spawnDaemon()
  ctl = await connectWs(daemonPort)
  primary = servePrimary(ctl)
  const conf = await rpc(ctl, 1, 'bridge.configure', {
    enabled: true, url: `ws://127.0.0.1:${cloudPort}/bridge`, token: 'test-machine-token', hostAlias: PRIMARY_ALIAS,
  })
  expect(conf.ok).toBe(true)
  await waitFor(() => bridgeForHost(PRIMARY_ALIAS).connected)
}, 60_000)

afterAll(async () => {
  closeAllBridges()
  try { ctl?.close() } catch { /* already closed */ }
  await stopDaemon()
  await new Promise<void>((resolve) => cloud ? cloud.close(() => resolve()) : resolve())
  closeDb()
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true })
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
  if (savedGrace === undefined) delete process.env.WALNUT_BRIDGE_BLIP_GRACE_MS
  else process.env.WALNUT_BRIDGE_BLIP_GRACE_MS = savedGrace
})

describe('GET /api/v1/asks on a replica, over a real bridge and daemon', () => {
  it("answers exactly the primary's list, launch flag included", async () => {
    for (const agentId of ['general', 'mentor']) {
      const res = await request(createApp()).get(`/api/v1/asks?agentId=${agentId}&limit=1000`)
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      const direct = await computeAgentAsks({ agentId, limit: 1000 })
      expect(res.body).toEqual(JSON.parse(JSON.stringify(direct)))
      expect(res.body.launch).toBe(true)
    }
    // The walnut list is the real one: stamps, moves and hand-filed rows.
    const walnut = await request(createApp()).get('/api/v1/asks')
    expect(walnut.body.asks.map((r: { title: string }) => r.title)).toEqual([
      'Garden plan', 'Finished one', 'Filed by hand', 'Moved to Home, still an ask', 'Trip checklist',
    ])
    expect(walnut.body.asks[0]).toMatchObject({ sessionId: 'sess-garden', state: 'idle' })
    expect(primary.handled.filter((a) => a === 'server.asks').length).toBeGreaterThanOrEqual(3)
  })

  it('a search and a limit ride the relay', async () => {
    const res = await request(createApp()).get('/api/v1/asks?q=%20TRIP%20&limit=1')
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(1)
    expect(res.body.asks.map((r: { title: string }) => r.title)).toEqual(['Trip checklist'])
  })

  it("the primary's 404 for an agent it does not have comes back as a 404", async () => {
    const res = await request(createApp()).get('/api/v1/asks?agentId=ghost')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })

  it('a limit the replica refuses never reaches the primary', async () => {
    const before = primary.handled.length
    const res = await request(createApp()).get('/api/v1/asks?limit=0')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
    expect(primary.handled.length).toBe(before)
  })

  it('with the Mac gone, 503 bridge_offline (never a list of its own)', async () => {
    await stopDaemon()
    await waitFor(() => !bridgeForHost(PRIMARY_ALIAS).connected)
    const res = await request(createApp()).get('/api/v1/asks')
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
  })
})
