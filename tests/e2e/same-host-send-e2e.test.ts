/**
 * Two sessions of one Walnut on one host, with the server UP: their messages are
 * the host's to deliver, and the server still speaks with one voice
 * (offline-host-core.ts handleLocal, docs/plan/daemon-first-hosts.md).
 *
 * What's real: the Express server and its session runner, tracker, request
 * store and turn-end hooks (startServer); the session daemon (the JS twin) with
 * its agent-gateway socket; the host copy the server pushes; the drain the
 * daemon's nudge starts. The sessions are a long-running mock CLI that speaks
 * stream-json on its FIFO, takes a moment per turn as a model call does, and,
 * like an agent, answers a request through its host's gateway socket when asked
 * to (PLEASE-REPLY). SSH is a refusing stand-in.
 *
 * Pinned:
 *   - a message from the leader to its worker is delivered by the host
 *     (`via: 'host'`), and the server takes the request it opened;
 *   - the worker's turn ends without an answer: the leader hears it ONCE (the
 *     server's notice; no second one from the host, no "stopped" subtask notice);
 *   - the worker answers through its host: the leader gets the reply once, no
 *     "finished without replying", and the server's row is `replied`;
 *   - a name only the server resolves (a task prefix) still goes to the server,
 *     which delivers it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { WebSocket } from 'ws'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startDaemonTwin, type DaemonTwin } from '../helpers/daemon-twin.js'
import type { GatewayResponse } from '../../src/providers/gateway-core.js'

/** A long-running stream-json CLI: one turn per user line, an answer through the gateway on PLEASE-REPLY. */
const PERSISTENT_MOCK = `
const fs = require('fs'), net = require('net'), path = require('path'), crypto = require('crypto')
const argv = process.argv.slice(2)
const flag = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null }
const sid = flag('--session-id') || flag('--resume') || crypto.randomUUID()
const inboxDir = process.env.MOCK_INBOX_DIR
const out = (o) => process.stdout.write(JSON.stringify(Object.assign({}, o, { session_id: sid })) + '\\n')
let cost = 0
out({ type: 'system', subtype: 'init', cwd: process.cwd(), model: 'mock-model', tools: [], mcp_servers: [], permissionMode: 'default' })
function gateway(args) {
  return new Promise((resolve) => {
    const s = net.connect(process.env.WALNUT_AGENT_SOCKET)
    let buf = ''
    s.on('connect', () => s.write(JSON.stringify({ v: 1, op: 'tools.call', sid: process.env.WALNUT_SESSION_ID || sid, args }) + '\\n'))
    s.on('data', (c) => { buf += c; const nl = buf.indexOf('\\n'); if (nl !== -1) { s.destroy(); resolve(JSON.parse(buf.slice(0, nl))) } })
    s.on('error', (e) => resolve({ ok: false, error: { message: String(e) } }))
  })
}
async function turn(line) {
  const c = line.message.content
  const text = typeof c === 'string' ? c : JSON.stringify(c)
  if (inboxDir) fs.appendFileSync(path.join(inboxDir, sid + '.jsonl'), JSON.stringify({ content: text }) + '\\n')
  if (line.uuid) out({ type: 'command_lifecycle', command_uuid: line.uuid, state: 'started' })
  out({ type: 'system', subtype: 'session_state_changed', state: 'running' })
  // A real turn takes a model round trip; the server sees it running before it ends.
  await new Promise((r) => setTimeout(r, 1500))
  let answer = 'Checked: all green.'
  const rq = /PLEASE-REPLY/.test(text) && /rq-[a-f0-9]{6,}/.exec(text)
  if (rq) {
    const r = await gateway({ name: 'task_send', args: { in_reply_to: rq[0], text: 'Build is green.' } })
    answer = 'Replied through ' + ((r.ok && r.result && r.result.via) || 'error ' + JSON.stringify(r).slice(0, 300))
  }
  out({ type: 'assistant', message: { id: 'msg_' + crypto.randomBytes(6).toString('hex'), type: 'message', role: 'assistant', model: 'mock-model', content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }, parent_tool_use_id: null })
  cost = Math.round((cost + 0.001) * 1e6) / 1e6
  out({ type: 'result', subtype: 'success', is_error: false, result: answer, duration_ms: 5, duration_api_ms: 4, num_turns: 1, total_cost_usd: cost, usage: { input_tokens: 10, output_tokens: 5 } })
  if (line.uuid) out({ type: 'command_lifecycle', command_uuid: line.uuid, state: 'completed' })
  out({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
}
let queue = Promise.resolve()
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8')
  let nl
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const raw = buf.slice(0, nl); buf = buf.slice(nl + 1)
    let msg; try { msg = JSON.parse(raw) } catch { continue }
    if (msg.type === 'control_request') { process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } }) + '\\n'); continue }
    if (msg.type !== 'user' || !msg.message) continue
    queue = queue.then(() => turn(msg)).catch(() => {})
  }
})
setInterval(() => {}, 1 << 30)
`

let server: HttpServer
let port = 0
let daemon: DaemonTwin | null = null
const savedEnv: Record<string, string | undefined> = {}
const inboxDir = path.join(WALNUT_HOME, 'mock-inbox')

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function rpc(ws: WebSocket, method: string, payload: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 20_000)
    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>
      if (msg.id === id) { clearTimeout(timer); ws.removeListener('message', handler); resolve(msg) }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ type: 'req', id, method, payload }))
  })
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms
  let last: unknown
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v as T } catch (e) { last = e }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`)
}

async function api(method: string, p: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({})) as Record<string, unknown>
  expect(res.ok, `${method} ${p} → ${res.status} ${JSON.stringify(json)}`).toBe(true)
  return json
}

function gateway(sid: string, name: string, args: Record<string, unknown>): Promise<GatewayResponse> {
  return new Promise((resolve, reject) => {
    const s = net.connect(path.join(daemon!.dir, 'agent-gateway.sock'))
    let buf = ''
    const t = setTimeout(() => { s.destroy(); reject(new Error(`gateway ${name} timeout`)) }, 20_000)
    s.on('connect', () => s.write(JSON.stringify({ v: 1, op: 'tools.call', sid, args: { name, args } }) + '\n'))
    s.on('data', (c) => {
      buf += c.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl !== -1) { clearTimeout(t); s.destroy(); resolve(JSON.parse(buf.slice(0, nl))) }
    })
    s.on('error', (e) => { clearTimeout(t); reject(e) })
  })
}

function inboxOf(sid: string): string[] {
  try {
    return fsSync.readFileSync(path.join(inboxDir, `${sid}.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map((l) => String(JSON.parse(l).content))
  } catch { return [] }
}

function requestRow(id: string): Record<string, unknown> | undefined {
  try {
    const store = JSON.parse(fsSync.readFileSync(path.join(WALNUT_HOME, 'session-requests.json'), 'utf8')) as { requests?: Array<Record<string, unknown>> }
    return store.requests?.find((r) => r.id === id)
  } catch { return undefined }
}

/** Every slice the host holds names both sessions (the server pushed its copy). */
function hostCopyHas(sids: string[]): boolean {
  try {
    const dir = path.join(daemon!.dir, 'offline-host')
    return fsSync.readdirSync(dir).filter((f) => f.startsWith('slice-')).some((f) => {
      const text = fsSync.readFileSync(path.join(dir, f), 'utf8')
      return sids.every((sid) => text.includes(sid))
    })
  } catch { return false }
}

const notices = (sid: string, requestId: string) => inboxOf(sid).filter((m) => m.includes('kind="notification"') && m.includes(requestId))

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(path.dirname(TASKS_FILE), { recursive: true })
  await fs.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }))
  await fs.mkdir(inboxDir, { recursive: true })
  await fs.writeFile(path.join(WALNUT_HOME, 'config.yaml'), [
    'version: 1', 'user:', '  name: TestUser', 'defaults:', '  priority: none', '  category: Inbox',
  ].join('\n') + '\n')
  const shimDir = path.join(WALNUT_HOME, 'bin-shim')
  await fs.mkdir(shimDir, { recursive: true })
  await fs.writeFile(path.join(shimDir, 'ssh'), '#!/bin/sh\necho "ssh: disabled in this test" >&2\nexit 255\n', { mode: 0o755 })
  for (const k of ['PATH', 'WALNUT_HOME_OVERRIDE']) savedEnv[k] = process.env[k]
  process.env.PATH = `${shimDir}:${process.env.PATH}`
  process.env.WALNUT_HOME_OVERRIDE = WALNUT_HOME
  const mock = path.join(WALNUT_HOME, 'persistent-mock.cjs')
  await fs.writeFile(mock, PERSISTENT_MOCK)
  daemon = await startDaemonTwin({ home: WALNUT_HOME, mockCli: mock, env: { MOCK_INBOX_DIR: inboxDir } })
  sessionRunner.setCliCommand(mock)
  sessionRunner.setTestDaemonUrl(daemon.url)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 90_000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 60_000)

describe('same-host messages with the server up (real server, real daemon)', () => {
  let leadTask = ''
  let workerTask = ''
  let lead = ''
  let worker = ''

  it('a leader and its worker run on one host, and the host holds the server\'s copy of both', async () => {
    leadTask = String(((await api('POST', '/api/tasks', { title: 'Leader: ship the release', project: 'Acme' })).task as { id: string }).id)
    workerTask = String(((await api('POST', '/api/tasks', { title: 'Worker: fix the build', project: 'Acme', parent_task_id: leadTask })).task as { id: string }).id)
    const ws = await connectWs()
    try {
      for (const taskId of [leadTask, workerTask]) {
        // On this machine, as on the Mac: the server's own daemon (here the twin) runs both.
        const started = await rpc(ws, 'session:start', { taskId, message: 'Getting ready', cwd: '/tmp' })
        expect(started.error, JSON.stringify(started)).toBeUndefined()
      }
    } finally { ws.close() }
    const sessionOf = async (taskId: string) => waitFor(async () => {
      const t = (await api('GET', `/api/tasks/${taskId}`)).task as { session_ids?: string[]; session_id?: string }
      return t.session_ids?.[0] ?? t.session_id ?? null
    }, 30_000, `a session for ${taskId}`)
    lead = await sessionOf(leadTask)
    worker = await sessionOf(workerTask)
    await waitFor(() => inboxOf(lead).length > 0 && inboxOf(worker).length > 0, 30_000, 'both first turns')
    await waitFor(() => hostCopyHas([lead, worker]), 30_000, 'the host copy of both sessions')
  }, 90_000)

  let ask = ''
  let baseline = 0

  it('the leader\'s message is delivered by the host, and the server takes the request', async () => {
    baseline = inboxOf(lead).length
    const r = await gateway(lead, 'task_send', { to: workerTask, text: 'Please check the build.', title: 'Build check' })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (!r.ok) return
    expect(r.result).toMatchObject({ via: 'host', targetTaskId: workerTask, targetSessionId: worker })
    ask = String(r.result.requestId)
    expect(ask).toMatch(/^rq-[a-f0-9]+$/)
    await waitFor(() => inboxOf(worker).some((m) => m.includes(ask) && m.includes('Please check the build.')), 15_000, 'the worker reads the envelope')
    await waitFor(() => requestRow(ask), 15_000, 'the server to import the request')
  }, 60_000)

  it('its turn ends without an answer: the leader hears it once, from one voice', async () => {
    await waitFor(() => notices(lead, ask).length > 0, 30_000, 'the "finished without replying" notice')
    await new Promise((r) => setTimeout(r, 5_000))
    expect(notices(lead, ask)).toHaveLength(1)
    // The server's own notice (its wording and quoting are pinned in its own tests).
    expect(notices(lead, ask)[0]).toContain('outcome="completed"')
    expect(notices(lead, ask)[0]).toContain(`about-task="${workerTask}"`)
    expect(requestRow(ask)?.status).toBe('notified')
    // No "stopped" subtask notice besides it: the request fallback spoke for this edge.
    // The worker's STARTUP turn may still be told here, when it lands while the
    // leader is busy (a notice to an idle leader waits): a different edge, which
    // names the user as the one who started it.
    const others = inboxOf(lead).slice(baseline)
      .filter((m) => m.includes('kind="notification"') && !m.includes(ask) && !m.includes('was started by the user'))
    expect(others, others.join('\n----\n')).toEqual([])
  }, 60_000)

  it('the worker answers through its host: the reply arrives once, nothing says it did not', async () => {
    const before = inboxOf(lead).length
    const r = await gateway(lead, 'task_send', { to: workerTask, text: 'Is it green now? PLEASE-REPLY', title: 'Green?' })
    expect(r.ok && r.result.via, JSON.stringify(r)).toBe('host')
    const second = String(r.ok && r.result.requestId)
    await waitFor(() => inboxOf(lead).slice(before).some((m) => m.includes('kind="reply"') && m.includes('Build is green.')), 30_000, 'the reply')
    await waitFor(() => requestRow(second)?.status === 'replied', 15_000, 'the server row to read replied')
    await new Promise((r) => setTimeout(r, 5_000))
    const after = inboxOf(lead).slice(before)
    expect(after.filter((m) => m.includes('kind="reply"'))).toHaveLength(1)
    expect(after.filter((m) => m.includes('kind="notification"'))).toEqual([])
    // The worker said it answered through its host.
    expect(inboxOf(worker).length).toBeGreaterThan(0)
  }, 60_000)

  it('a name only the server resolves still goes to the server, which delivers it', async () => {
    const r = await gateway(lead, 'task_send', { to: workerTask.slice(0, 8), text: 'By a prefix', expect_reply: false })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.ok && r.result.via).toBeUndefined()
    await waitFor(() => inboxOf(worker).some((m) => m.includes('By a prefix')), 20_000, 'the server delivery')
  }, 60_000)
})
