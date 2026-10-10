/**
 * The whole trip of a trigger fire while the Mac is away, through the REAL
 * server and a REAL daemon (source twin, with its trigger sidecar):
 *
 *   server --direct WS--> devbox daemon --- session S (stopped by the idle reaper)
 *     1. the routine (a check on devbox, delivering to S's task) is pushed;
 *     2. the server stops (the Mac goes away), the check fires, nobody claims;
 *     3. the daemon starts S again with its own command, the fire as its first
 *        message, journals a `resume` record (trigger-host-resume-v1);
 *     4. the server comes back: its handover drains the record and looks at S
 *        again (its record said stopped by the reaper, which the plain
 *        reconnect pass never probes), so S reads live again; the fire's replay
 *        is recorded as "devbox resumed session ...", never delivered twice.
 *
 * Only the CLI is a mock (it logs its argv and every user message it reads).
 * Isolation: mock constants (temp WALNUT_HOME), a temp daemon dir, the daemon
 * killed by the pid it wrote there.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { buildSync } from 'esbuild'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-trigger-host-resume-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { getDirectDaemonConnection, pushHostSliceToAllHosts } from '../../src/providers/daemon-connection.js'
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const SID = 'feedface-8888-4888-8888-888888888888'
const HOST = 'devbox'

const MOCK_CLI = `
const fs = require('fs')
const argv = process.argv.slice(2)
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : '' }
const sid = opt('--mock-sid'), inbox = opt('--mock-inbox')
fs.appendFileSync(opt('--mock-argv'), JSON.stringify(argv) + '\\n')
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: sid, model: 'mock-model', tools: [] })
out({ type: 'result', subtype: 'success', is_error: false, result: 'ready', session_id: sid })
out({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8')
  let nl
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    let msg; try { msg = JSON.parse(line) } catch { continue }
    if (msg.type !== 'user') continue
    fs.appendFileSync(inbox, JSON.stringify({ content: msg.message && msg.message.content }) + '\\n')
    out({ type: 'system', subtype: 'session_state_changed', state: 'running' })
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }] }, session_id: sid })
    out({ type: 'result', subtype: 'success', is_error: false, result: 'on it', session_id: sid })
    out({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
  }
})
setInterval(() => {}, 1 << 30)
`

let dir = ''
let daemon: ChildProcess | null = null
let daemonPid = 0
let daemonPort = 0
let server: HttpServer | null = null
let port = 0
let argvLog = ''
let inbox = ''
let itemsFile = ''
let wrapper = ''
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

/** A raw socket to the daemon, as any trusted client: one command, then gone. */
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

const spawns = (): string[][] => {
  try { return fs.readFileSync(argvLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) } catch { return [] }
}
const triggerMessages = (): string[] => {
  try {
    return fs.readFileSync(inbox, 'utf8').trim().split('\n').filter(Boolean).map((l) => String(JSON.parse(l).content))
      .filter((c) => c.includes('<walnut-message kind="trigger"'))
  } catch { return [] }
}

async function bootServer(): Promise<void> {
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  await getDirectDaemonConnection(HOST, `ws://127.0.0.1:${daemonPort}`)
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-trigresume-e2e-'))
  argvLog = path.join(dir, 'argv.jsonl')
  inbox = path.join(dir, 'inbox.jsonl')
  itemsFile = path.join(dir, 'items.json')
  fs.writeFileSync(itemsFile, JSON.stringify({ fire: false }) + '\n')
  const mock = path.join(dir, 'mock-cli.cjs')
  fs.writeFileSync(mock, MOCK_CLI)
  wrapper = path.join(dir, 'claude')
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${mock}" "$@"\n`, { mode: 0o755 })

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
    WALNUT_TRIGGER_HOST_GRACE_MS: '1500',
    WALNUT_TRIGGER_REPLAY_MS: '60000',
    WALNUT_DAEMON_PARENT_PID: String(process.pid),
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  daemon = spawn(process.execPath, [script, '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  if (process.env.DEBUG_DAEMON) daemon.stderr?.on('data', (b) => process.stderr.write(b))
  await waitFor(() => fs.existsSync(path.join(dir, 'daemon.port')) && fs.existsSync(path.join(dir, 'daemon.pid')), 30_000, 'the daemon')
  daemonPort = parseInt(fs.readFileSync(path.join(dir, 'daemon.port'), 'utf8').trim(), 10)
  daemonPid = parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10)

  await bootServer()
  const created = await api('POST', '/api/tasks', { title: 'Watch the review', project: 'Acme' })
  expect(created.status, JSON.stringify(created.json)).toBeLessThan(300)
  taskId = created.json.task.id
  // The session, as the server would have started it on devbox.
  const started = await daemonCmd({
    cmd: 'start', sid: SID, cwd: dir, message: 'init', mode: 'default', origin: { home: WALNUT_HOME, task: taskId },
    args: [wrapper, '-p', '--model', 'opus', '--permission-mode', 'default', '--session-id', SID,
      '--mock-sid', SID, '--mock-inbox', inbox, '--mock-argv', argvLog],
  })
  expect(started.ok, JSON.stringify(started)).toBe(true)
  await createSessionRecord(SID, taskId, 'Acme', dir, { host: HOST, title: 'Review loop', initialProcessStatus: 'idle' })
  await waitFor(() => spawns().length === 1, 20_000, 'the first spawn')

  const routine = await api('POST', '/api/routines', {
    name: 'Review watch',
    schedule: { kind: 'every', everyMs: 3_600_000 },
    check: { run: `cat ${itemsFile}`, cwd: dir, host: HOST },
    executor: { type: 'session', config: { target: taskId, prompt: 'New review comments. Read each one.' } },
  })
  expect(routine.status, JSON.stringify(routine.json)).toBe(201)
  jobId = routine.json.job.id
  // Armed on devbox, with the host delivery spec.
  await waitFor(() => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'triggers.json'), 'utf8')).triggers.some((t: any) => t.id === jobId && t.deliver?.taskId === taskId) } catch { return false }
  }, 20_000, 'the trigger armed with deliver')

  // The idle reaper stops it: the CLI goes, the record says why.
  const stopped = await daemonCmd({ cmd: 'stop', sid: SID, reason: 'idle', home: WALNUT_HOME })
  expect(stopped.ok, JSON.stringify(stopped)).toBe(true)
  await waitFor(async () => (await daemonCmd({ cmd: 'status', sid: SID })).alive === false, 20_000, 'the CLI stopped')
  await updateSessionRecord(SID, { process_status: 'stopped', status_reason: 'idle_timeout', status_changed_by: 'daemon', last_status_change: new Date(Date.now() - 3 * 3_600_000).toISOString() } as any)
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

describe('a trigger fire while the Mac is away reaches a stopped session, and the Mac takes it back', () => {
  it('with the server gone, the host resumes the session with the fire', async () => {
    await stopServer()
    server = null
    fs.writeFileSync(itemsFile, JSON.stringify({ fire: true, items: [{ id: 'rc-1', text: 'Please rename the flag.' }] }) + '\n')
    expect((await daemonCmd({ cmd: 'triggers.run', triggerId: jobId })).ok).toBe(true)
    await waitFor(() => spawns().length === 2, 30_000, 'the host resume')
    const resumed = spawns()[1]
    expect(resumed[resumed.indexOf('--resume') + 1]).toBe(SID)
    expect(resumed).not.toContain('--session-id')
    expect(resumed[resumed.indexOf('--model') + 1]).toBe('opus')
    await waitFor(() => triggerMessages().some((m) => m.includes('rc-1')), 20_000, 'the fire in the session')
    expect(triggerMessages()).toHaveLength(1)
    expect((await daemonCmd({ cmd: 'status', sid: SID })).alive).toBe(true)
    // The Mac's record still says stopped: nothing told it yet.
    expect((await getSessionByClaudeId(SID))?.process_status).toBe('stopped')
  }, 90_000)

  it('the server comes back: the session reads live, the fire is recorded once as resumed on the host', async () => {
    await bootServer()
    const live = await waitFor(async () => {
      const r = await getSessionByClaudeId(SID)
      return r && (r.process_status === 'idle' || r.process_status === 'running') ? r : null
    }, 45_000, 'the record to read live again')
    expect(live.archived).toBeFalsy()
    const row = await waitFor(async () => {
      const job = (await api('GET', `/api/routines/${jobId}`)).json.job
      return job?.state?.fireLog?.[0] ?? null
    }, 45_000, 'the fire recorded')
    expect(row.delivery).toMatchObject({ status: 'ok', sessionId: SID })
    expect(row.delivery.summary).toMatch(/^devbox resumed session /)
    // Recorded, never delivered again.
    await sleep(3_000)
    expect(triggerMessages()).toHaveLength(1)
    expect(spawns()).toHaveLength(2)
    // The journal is empty: everything the host did alone was taken back.
    const drained = await daemonCmd({ cmd: 'offline.drain', home: WALNUT_HOME })
    expect(drained.records).toEqual([])
  }, 120_000)
})
