/**
 * A session creates a trigger while its Walnut server is away, through the REAL
 * server and a REAL daemon (source twin, with its trigger sidecar):
 *
 *   server --direct WS--> devbox daemon --- session S (live, idle)
 *     1. the server stops (the Mac goes away); S calls trigger_create through the
 *        daemon's gateway socket, as its `walnut` CLI does: answered on the host
 *        (queued, an id the host gave), and the check runs there at once;
 *     2. the check fires on time and the host delivers the fire into S itself;
 *     3. the server comes back: its handover replays the create under the same id,
 *        so there is ONE routine with that id, its history holds the fire the host
 *        delivered, the set it pushes carries the trigger, and the journal is empty;
 *     4. the same create replayed again stores nothing new; another trigger under
 *        that id is refused.
 *
 * Why: on 2026-11-03 a lead could not arm a trigger for a review request due at
 * 9:07 the next morning while the server was down, and wrote the to-do into a file.
 * Only the CLI is a mock. Isolation: mock constants (temp WALNUT_HOME), a temp
 * daemon dir, the daemon killed by the pid it wrote there.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { buildSync } from 'esbuild'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-offline-trigger-create-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { walnutScopeDir } from '../helpers/walnut-scope-dir.js'
import { getDirectDaemonConnection, pushHostSliceToAllHosts } from '../../src/providers/daemon-connection.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { HOST_TRIGGER_ID_RE } from '../../src/core/routines/trigger-api.js'
import type { GatewayResponse } from '../../src/providers/gateway-core.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const SID = 'feedface-7777-4777-8777-777777777777'
const HOST = 'devbox'

// Every line written into the session (its FIFO stdin) goes to received.log beside it.
const MOCK_CLI = `
const fs = require('node:fs')
const sid = process.argv[2]
const log = process.argv[3]
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: sid, model: 'mock-model', tools: [] })
out({ type: 'result', subtype: 'success', is_error: false, result: 'ready', session_id: sid })
out({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
process.stdin.on('data', (b) => fs.appendFileSync(log, b))
setInterval(() => {}, 1 << 30)
`

let dir = ''
let daemon: ChildProcess | null = null
let daemonPid = 0
let daemonPort = 0
let server: HttpServer | null = null
let port = 0
let taskId = ''
let hostId = ''
let check = ''
let received = ''

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms: number, what: string): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}

async function api(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, any> }
}

async function daemonCmd(body: Record<string, unknown>): Promise<Record<string, any>> {
  const ws = new WebSocket(`ws://127.0.0.1:${daemonPort}`)
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej) })
  try {
    return await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${body.cmd} timed out`)), 15_000)
      ws.on('message', (raw) => {
        const m = JSON.parse(String(raw))
        if (m.id === 1) { clearTimeout(t); resolve((m.data && typeof m.data === 'object') ? { ...m, ...m.data } : m) }
      })
      ws.send(JSON.stringify({ id: 1, ...body }))
    })
  } finally { ws.close() }
}

/** One `walnut tools call` from session S, over the daemon's gateway socket. */
function gateway(name: string, args: Record<string, unknown> = {}): Promise<GatewayResponse> {
  return new Promise((resolve, reject) => {
    const s = net.connect(path.join(dir, 'agent-gateway.sock'))
    let buf = ''
    const t = setTimeout(() => { s.destroy(); reject(new Error('gateway timeout')) }, 20_000)
    s.on('connect', () => s.write(JSON.stringify({ v: 1, op: 'tools.call', sid: SID, args: { name, args } }) + '\n'))
    s.on('data', (c) => {
      buf += c.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl !== -1) { clearTimeout(t); s.destroy(); resolve(JSON.parse(buf.slice(0, nl))) }
    })
    s.on('error', (e) => { clearTimeout(t); reject(e) })
  })
}

/** The set the server last pushed for this Walnut (what triggers.json keeps). */
const pushedSet = (): string[] => {
  try { return JSON.parse(fs.readFileSync(path.join(walnutScopeDir(dir, WALNUT_HOME), 'triggers.json'), 'utf8')).triggers.map((t: { id: string }) => t.id) } catch { return [] }
}

/** Some file under the daemon dir names `needle` (the leader book that holds the drains). */
function anyFileHas(root: string, needle: string): boolean {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name)
    if (entry.isDirectory()) { if (entry.name !== 'streams' && anyFileHas(p, needle)) return true; continue }
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    try { if (fs.readFileSync(p, 'utf8').includes(needle)) return true } catch { /* racing a write */ }
  }
  return false
}

async function bootServer(): Promise<void> {
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  await getDirectDaemonConnection(HOST, `ws://127.0.0.1:${daemonPort}`)
}

async function routinesNamedBy(run: string): Promise<Array<Record<string, any>>> {
  const jobs = (await api('GET', '/api/routines?includeDisabled=true')).json.jobs as Array<Record<string, any>> | undefined
  return (jobs ?? []).filter((j) => j.check?.run === run)
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-offcreate-e2e-'))
  const mock = path.join(dir, 'mock-cli.cjs')
  received = path.join(dir, 'received.log')
  fs.writeFileSync(mock, MOCK_CLI)
  check = path.join(dir, 'check.sh')
  // Fires once on its item: the review request is due.
  fs.writeFileSync(check, 'echo \'{"fire":true,"items":[{"id":"review-0907","title":"Review request due"}]}\'\n')
  const script = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
  buildSync({
    entryPoints: [path.join(ROOT, 'src/providers/trigger-check-sidecar.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: path.join(dir, 'trigger-check-core.cjs'), logLevel: 'silent',
  })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALNUT_DAEMON_DIR: dir,
    WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_TRIGGER_REPLAY_MS: '2000',
    WALNUT_TRIGGER_HOST_GRACE_MS: '1000',
    WALNUT_GATEWAY_TIMEOUT_MS: '3000',
    WALNUT_DAEMON_PARENT_PID: String(process.pid),
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  daemon = spawn(SOURCE_TWIN.file, [script, '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  if (process.env.DEBUG_DAEMON) daemon.stderr?.on('data', (b) => process.stderr.write(b))
  await waitFor(() => fs.existsSync(path.join(dir, 'daemon.port')) && fs.existsSync(path.join(dir, 'daemon.pid')), 30_000, 'the daemon')
  daemonPort = parseInt(fs.readFileSync(path.join(dir, 'daemon.port'), 'utf8').trim(), 10)
  daemonPid = parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10)

  await bootServer()
  const created = await api('POST', '/api/tasks', { title: 'Send the review request', project: 'Acme' })
  expect(created.status, JSON.stringify(created.json)).toBeLessThan(300)
  taskId = created.json.task.id
  const started = await daemonCmd({
    cmd: 'start', sid: SID, cwd: dir, message: 'init', mode: 'default', origin: { home: WALNUT_HOME, task: taskId },
    args: [process.execPath, mock, SID, received],
  })
  expect(started.ok, JSON.stringify(started)).toBe(true)
  await createSessionRecord(SID, taskId, 'Acme', dir, { host: HOST, title: 'Review sender', initialProcessStatus: 'idle' })
  pushHostSliceToAllHosts()
  await waitFor(() => {
    try { return fs.readdirSync(path.join(dir, 'offline-host')).some((f) => f.startsWith('slice-') && fs.readFileSync(path.join(dir, 'offline-host', f), 'utf8').includes(SID)) } catch { return false }
  }, 20_000, 'the host copy with the session')
  // This Mac said it replays a trigger made on the host under the host's id.
  await waitFor(() => anyFileHas(dir, '"trigger-create"'), 20_000, 'the leader book naming trigger-create')
}, 180_000)

afterAll(async () => {
  try { await stopServer() } catch { /* best effort */ }
  if (daemonPid > 1) { try { process.kill(daemonPid, 'SIGTERM') } catch { /* gone */ } }
  try { daemon?.kill('SIGTERM') } catch { /* gone */ }
  await sleep(500)
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
})

describe('a trigger created on its host while the Mac is away', () => {
  it('with the server gone, the host takes the create, runs the check and delivers the fire itself', async () => {
    await stopServer()
    server = null
    await sleep(300)
    const r = await gateway('trigger_create', {
      run: `sh ${check}`, every: '10s', prompt: 'Send the review request now.',
      description: 'Fires when the review request is due; the session then sends it.',
    })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const res = r.ok ? r.result as Record<string, any> : {}
    expect(res).toMatchObject({ queued: true, offline: true, host: HOST })
    hostId = String(res.id)
    expect(hostId).toMatch(HOST_TRIGGER_ID_RE)
    const listed = await gateway('trigger_list')
    expect(listed.ok && (listed.result.triggers as Array<Record<string, unknown>>)).toEqual([
      expect.objectContaining({ id: hostId, state: 'armed', changedHere: 'created', queued: true, task: taskId }),
    ])
    // The first check runs about 5 s after it is armed; with no server to claim it, the host delivers.
    const text = await waitFor(() => { try { const t = fs.readFileSync(received, 'utf8'); return t.includes('review-0907') ? t : null } catch { return null } }, 45_000, 'the fire in the session')
    expect(text).toContain('kind=\\"trigger\\"')
    expect(text).toContain('Send the review request now.')
  }, 90_000)

  it('the server comes back: one routine under the host\'s id, with the fire in its history', async () => {
    await bootServer()
    const job = await waitFor(async () => {
      const jobs = await routinesNamedBy(`sh ${check}`)
      return jobs.length && jobs[0].state?.fireCount >= 1 ? jobs : null
    }, 60_000, 'the routine with its host fire recorded')
    expect(job.map((j) => j.id)).toEqual([hostId])
    expect(job[0]).toMatchObject({
      enabled: true, description: 'Fires when the review request is due; the session then sends it.',
      schedule: { kind: 'every', everyMs: 10_000 }, check: { run: `sh ${check}`, host: HOST, cwd: dir },
      executor: { type: 'session', config: { target: taskId, prompt: 'Send the review request now.' } },
    })
    const log = (job[0].state.checkLog ?? []) as Array<Record<string, any>>
    expect(log.some((e) => /sent it to session/.test(String(e.summary ?? e.detail ?? JSON.stringify(e))))).toBe(true)
    await waitFor(() => pushedSet().includes(hostId), 20_000, 'the pushed set with the trigger')
    expect((await daemonCmd({ cmd: 'offline.drain', home: WALNUT_HOME })).records).toEqual([])
    // Delivered once: the host's fire was recorded, not sent again.
    await sleep(3_000)
    const deliveries = fs.readFileSync(received, 'utf8').split('review-0907').length - 1
    expect(deliveries).toBe(1)
  }, 120_000)

  it('the same create again stores nothing new; another trigger under that id is refused', async () => {
    const body = {
      id: hostId, run: `sh ${check}`, every: 10_000, prompt: 'Send the review request now.', name: 'Send the review request now.',
      description: 'Fires when the review request is due; the session then sends it.', session: taskId, host: HOST, cwd: dir,
    }
    const again = await api('POST', '/api/v1/routines/trigger', body, { 'x-walnut-caller-sid': SID })
    expect(again.status, JSON.stringify(again.json)).toBe(201)
    expect(again.json.job.id).toBe(hostId)
    expect((await routinesNamedBy(`sh ${check}`)).map((j) => j.id)).toEqual([hostId])
    const other = await api('POST', '/api/v1/routines/trigger', { ...body, run: 'sh other.sh' }, { 'x-walnut-caller-sid': SID })
    expect(other.status, JSON.stringify(other.json)).toBe(409)
    const shaped = await api('POST', '/api/v1/routines/trigger', { ...body, id: 'mhk2x9ab-1f2e' }, { 'x-walnut-caller-sid': SID })
    expect(shaped.status).toBe(400)
  }, 60_000)
})
