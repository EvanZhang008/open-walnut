/**
 * A session pauses its trigger while the Mac is away, through the REAL server
 * and a REAL daemon (source twin, with its trigger sidecar), and the Mac takes
 * the pause back (offline-triggers-v1):
 *
 *   server --direct WS--> devbox daemon --- session S (live, idle)
 *     1. the routine (a check on devbox, delivering to S's task) is pushed;
 *     2. the server stops (the Mac goes away); S calls trigger_list and
 *        trigger_pause through the daemon's gateway socket, as its `walnut` CLI
 *        does: answered on the host, and the check stops at once;
 *     3. the server comes back: its handover replays the pause through the
 *        trigger_pause op, the routine reads paused, the set it pushes no longer
 *        carries the trigger, and the journal is empty;
 *     4. S resumes it while the server answers: the ordinary path, armed again.
 *
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

vi.mock('../../src/constants.js', () => createMockConstants('walnut-offline-triggers-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { getDirectDaemonConnection, pushHostSliceToAllHosts } from '../../src/providers/daemon-connection.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import type { GatewayResponse } from '../../src/providers/gateway-core.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const SID = 'feedface-9999-4999-8999-999999999999'
const HOST = 'devbox'

const MOCK_CLI = `
const sid = process.argv[2]
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: sid, model: 'mock-model', tools: [] })
out({ type: 'result', subtype: 'success', is_error: false, result: 'ready', session_id: sid })
out({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
process.stdin.on('data', () => {})
setInterval(() => {}, 1 << 30)
`

let dir = ''
let daemon: ChildProcess | null = null
let daemonPid = 0
let daemonPort = 0
let server: HttpServer | null = null
let port = 0
let taskId = ''
let jobId = ''

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

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

const armedOnDisk = (): string[] => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'triggers.json'), 'utf8')).triggers.map((t: { id: string }) => t.id) } catch { return [] }
}

async function bootServer(): Promise<void> {
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  await getDirectDaemonConnection(HOST, `ws://127.0.0.1:${daemonPort}`)
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-offtrig-e2e-'))
  const mock = path.join(dir, 'mock-cli.cjs')
  fs.writeFileSync(mock, MOCK_CLI)
  fs.writeFileSync(path.join(dir, 'check.sh'), 'echo \'{"fire":false}\'\n')
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
    WALNUT_TRIGGER_REPLAY_MS: '60000',
    WALNUT_GATEWAY_TIMEOUT_MS: '3000',
    WALNUT_DAEMON_PARENT_PID: String(process.pid),
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  daemon = spawn(process.execPath, [script, '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  if (process.env.DEBUG_DAEMON) daemon.stderr?.on('data', (b) => process.stderr.write(b))
  await waitFor(() => fs.existsSync(path.join(dir, 'daemon.port')) && fs.existsSync(path.join(dir, 'daemon.pid')), 30_000, 'the daemon')
  daemonPort = parseInt(fs.readFileSync(path.join(dir, 'daemon.port'), 'utf8').trim(), 10)
  daemonPid = parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10)

  await bootServer()
  const created = await api('POST', '/api/tasks', { title: 'Watch the build', project: 'Acme' })
  expect(created.status, JSON.stringify(created.json)).toBeLessThan(300)
  taskId = created.json.task.id
  const started = await daemonCmd({
    cmd: 'start', sid: SID, cwd: dir, message: 'init', mode: 'default', origin: { home: WALNUT_HOME, task: taskId },
    args: [process.execPath, mock, SID],
  })
  expect(started.ok, JSON.stringify(started)).toBe(true)
  await createSessionRecord(SID, taskId, 'Acme', dir, { host: HOST, title: 'Build watch', initialProcessStatus: 'idle' })
  const routine = await api('POST', '/api/routines', {
    name: 'Build watch',
    schedule: { kind: 'every', everyMs: 3_600_000 },
    check: { run: `sh ${path.join(dir, 'check.sh')}`, cwd: dir, host: HOST },
    executor: { type: 'session', config: { target: taskId, prompt: 'The build finished. Look at it.' } },
  })
  expect(routine.status, JSON.stringify(routine.json)).toBe(201)
  jobId = routine.json.job.id
  await waitFor(() => armedOnDisk().includes(jobId), 20_000, 'the trigger armed on devbox')
  // The host's copy lists the session (a record made by hand fires no bus event).
  pushHostSliceToAllHosts()
  await waitFor(() => {
    try { return fs.readdirSync(path.join(dir, 'offline-host')).some((f) => f.startsWith('slice-') && fs.readFileSync(path.join(dir, 'offline-host', f), 'utf8').includes(SID)) } catch { return false }
  }, 20_000, 'the host copy with the session')
}, 180_000)

afterAll(async () => {
  try { await stopServer() } catch { /* best effort */ }
  if (daemonPid > 1) { try { process.kill(daemonPid, 'SIGTERM') } catch { /* gone */ } }
  try { daemon?.kill('SIGTERM') } catch { /* gone */ }
  await sleep(500)
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
})

describe('a trigger paused on its host while the Mac is away', () => {
  it('with the server gone, the session lists and pauses it on the host, and the check stops', async () => {
    await stopServer()
    server = null
    await sleep(300)
    const listed = await gateway('trigger_list')
    expect(listed.ok, JSON.stringify(listed)).toBe(true)
    expect(listed.ok && (listed.result.triggers as Array<{ id: string }>).map((t) => t.id)).toEqual([jobId])
    const paused = await gateway('trigger_pause', { id: jobId })
    expect(paused.ok, JSON.stringify(paused)).toBe(true)
    expect(paused.ok && paused.result).toMatchObject({ state: 'paused', changed: true, offline: true })
    expect((await daemonCmd({ cmd: 'triggers.run', triggerId: jobId })).ok).toBe(false)
  }, 60_000)

  it('the server comes back: the pause is replayed, the routine reads paused, and nothing re-arms it', async () => {
    await bootServer()
    const job = await waitFor(async () => {
      const j = (await api('GET', `/api/routines/${jobId}`)).json.job
      return j && j.enabled === false ? j : null
    }, 45_000, 'the routine paused on the server')
    expect(job.state.pausedAtMs).toEqual(expect.any(Number))
    await waitFor(() => !armedOnDisk().includes(jobId), 20_000, 'the pushed set without the trigger')
    expect((await daemonCmd({ cmd: 'triggers.run', triggerId: jobId })).ok).toBe(false)
    const drained = await daemonCmd({ cmd: 'offline.drain', home: WALNUT_HOME })
    expect(drained.records).toEqual([])
  }, 120_000)

  it('a resume while the server answers takes the ordinary path and arms it again', async () => {
    const resumed = await gateway('trigger_resume', { id: jobId })
    expect(resumed.ok, JSON.stringify(resumed)).toBe(true)
    expect(resumed.ok && resumed.result.offline).toBeUndefined()
    await waitFor(() => armedOnDisk().includes(jobId), 20_000, 'the trigger armed again')
    expect((await daemonCmd({ cmd: 'triggers.run', triggerId: jobId })).ok).toBe(true)
  }, 60_000)
})
