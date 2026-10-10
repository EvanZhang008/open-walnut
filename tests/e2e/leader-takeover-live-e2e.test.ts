/**
 * The Mac is gone and the cloud companion takes over, with the real servers.
 *
 *   primary (real Walnut server, child process) + its own local daemon
 *     │ heartbeat: mobile-event → local daemon → /bridge → companion events-v1
 *     │ trusted WS (direct): host.slice, leader.configure, handover, claim
 *     ├──► devbox daemon (source twin, node)      ── session A (leader task)
 *     └──► oldbox daemon (standalone twin, bun)   ── session B (worker task)
 *   companion (real Walnut server, WALNUT_CLOUD_MODE=1, child process)
 *     ◄── /bridge from all three daemons (machine tokens)
 *     backup leader (server.ts startBackupLeader) + gateway (bridge-registry → backup-gateway)
 *
 * The Mac sleeps: SIGSTOP of the primary server AND its local daemon (a lid
 * close freezes both; their sockets stay open and go silent). The sessions are
 * a mock CLI; everything else is the shipped code. The companion leads both
 * hosts, carries A's question to B and B's answer back, B edits the team Board
 * on its host, and A updates a task outside every host's copy through the
 * companion. The Mac wakes (SIGCONT): it takes back what the hosts did alone
 * (the request rows, the Board write) and the lead, and the companion lets go.
 *
 * Isolation: every server has its own HOME, data dir and daemon dir under one
 * temp base; auth.json is written fresh with random tokens; both servers' PATH
 * lead with a `claude` that refuses to run; nothing is copied from user data.
 * Every process is stopped by the pid it wrote into its own temp dir.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { WebSocket } from 'ws'
import Database from 'better-sqlite3'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import type { GatewayResponse } from '../../src/providers/gateway-core.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))
const A = 'aaaaaaaa-1111-4111-8111-111111111111'
const B = 'bbbbbbbb-2222-4222-8222-222222222222'
/** A second session on oldbox, for the stop (A and B keep running for the wake). */
const C = 'cccccccc-3333-4333-8333-333333333333'
const T = 6_000
const BEAT = 2_500

const MOCK_CLI = `
const fs = require('fs')
const sid = process.argv[2]
const inbox = process.argv[3]
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: sid })
out({ type: 'result', subtype: 'success', is_error: false, result: 'ready', session_id: sid })
out({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
let buf = ''
let asked = 0
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8')
  let nl
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    let msg; try { msg = JSON.parse(line) } catch { continue }
    // A settings or mode change (leader.settings, leader.control): kept for the
    // test, answered as the CLI does (set_permission_mode echoes the mode).
    if (msg.type === 'control_request') {
      fs.appendFileSync(inbox.replace('.inbox.jsonl', '.ctrl.jsonl'), JSON.stringify(msg) + '\\n')
      const echo = msg.request && msg.request.subtype === 'set_permission_mode' ? { response: { mode: msg.request.mode } } : {}
      out({ type: 'control_response', response: Object.assign({ subtype: 'success', request_id: msg.request_id }, echo) })
      continue
    }
    // An answer to a permission prompt this CLI asked.
    if (msg.type === 'control_response') {
      fs.appendFileSync(inbox.replace('.inbox.jsonl', '.resp.jsonl'), JSON.stringify(msg) + '\\n')
      continue
    }
    if (msg.type !== 'user') continue
    fs.appendFileSync(inbox, JSON.stringify({ content: msg.message && msg.message.content }) + '\\n')
    // "ASK:" in a message: the CLI asks to run a tool, as Claude Code does in default mode.
    if (JSON.stringify(msg.message && msg.message.content).includes('ASK:')) {
      out({ type: 'control_request', request_id: 'perm-' + (++asked), request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls docs/' } } })
    }
  }
})
setInterval(() => {}, 1 << 30)
`

const sha256 = (t: string): string => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const newToken = (): string => crypto.randomBytes(16).toString('hex')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k]
  return env
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms
  let last: unknown
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v as T } catch (e) { last = e }
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}\n--- companion ---\n${companion.log.slice(-2500)}\n--- primary ---\n${primary.log.slice(-2500)}`)
}

let base = ''
const tokens = { mac: '', local: '', devbox: '', oldbox: '' }
interface Server { proc: ChildProcess | null; port: number; log: string; data: string; home: string; daemonDir: string }
const companion: Server = { proc: null, port: 0, log: '', data: '', home: '', daemonDir: '' }
const primary: Server & { ids: { lead: string; worker: string; far: string }; serverPid: number } = { proc: null, port: 0, log: '', data: '', home: '', daemonDir: '', ids: { lead: '', worker: '', far: '' }, serverPid: 0 }
interface Daemon { name: string; twin: 'source' | 'standalone'; proc: ChildProcess; dir: string; port: number; sock: string; pid: number }
const daemons: Daemon[] = []

function serverEnv(s: Server, extra: Record<string, string>): NodeJS.ProcessEnv {
  const stubBin = path.join(s.home, 'bin')
  return {
    ...process.env,
    PATH: `${stubBin}${path.delimiter}${process.env.PATH ?? ''}`,
    OPEN_WALNUT_HOME: s.data,
    HOME: s.home,
    USERPROFILE: s.home,
    SHELL: '/bin/sh',
    WALNUT_DAEMON_DIR: s.daemonDir,
    WALNUT_STREAMS_DIR: path.join(s.daemonDir, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(s.daemonDir, 'no-legacy'),
    WALNUT_SPAWN_JOURNAL: path.join(s.daemonDir, 'spawn-journal.jsonl'),
    WALNUT_DISABLE_BACKGROUND_AI: '1',
    WALNUT_DISABLE_SEARCH: '1',
    WALNUT_LOCAL_CLAUDE_PROBE: '0',
    WALNUT_LEADER_TAKEOVER_MS: String(T),
    WALNUT_TRUSTED_CLIENT_BEAT_MS: String(BEAT),
    VITEST: '', VITEST_WORKER_ID: '', VITEST_POOL_ID: '', VITEST_MODE: '', NODE_ENV: 'production',
    ...extra,
  }
}

async function prepare(s: Server, name: string): Promise<void> {
  s.home = path.join(base, name, 'home')
  s.data = path.join(base, name, 'data')
  s.daemonDir = path.join(base, name.slice(0, 2) + 'd')
  for (const d of [path.join(s.home, 'bin'), s.data, s.daemonDir]) await fsp.mkdir(d, { recursive: true })
  await fsp.writeFile(path.join(s.home, 'bin', 'claude'), '#!/bin/sh\necho "claude is disabled in this test" >&2\nexit 1\n', { mode: 0o755 })
}

/** Boot a server child with a boot script; it prints WALNUT_PORT= and then JSON lines. */
async function bootServer(s: Server, script: string, env: NodeJS.ProcessEnv, onLine?: (line: string) => void): Promise<void> {
  const file = path.join(base, `${path.basename(path.dirname(s.data))}-boot.mts`)
  await fsp.writeFile(file, script)
  const proc = spawn(TSX, [file], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  s.proc = proc
  proc.stderr!.on('data', (b: Buffer) => { s.log = (s.log + b.toString()).slice(-300_000) })
  if (process.env.DEBUG_LIVE) proc.stderr!.on('data', (b: Buffer) => process.stderr.write(b))
  s.port = await new Promise<number>((resolve, reject) => {
    let out = ''
    const t = setTimeout(() => reject(new Error(`server did not report a port in 180s\n${s.log.slice(-3000)}`)), 180_000)
    proc.stdout!.on('data', (b: Buffer) => {
      out += b.toString()
      const m = /WALNUT_PORT=(\d+)/.exec(out)
      if (m) { clearTimeout(t); resolve(Number(m[1])) }
      if (onLine) for (const l of out.split('\n')) if (l.startsWith('{')) onLine(l)
    })
    proc.once('exit', (code) => { clearTimeout(t); reject(new Error(`server exited early (${code})\n${s.log.slice(-3000)}`)) })
  })
}

async function startCompanion(): Promise<void> {
  await prepare(companion, 'companion')
  await fsp.mkdir(path.join(base, 'hub'), { recursive: true })
  await fsp.writeFile(path.join(companion.data, 'config.yaml'), 'version: 1\nuser:\n  name: Box\n')
  const now = new Date().toISOString()
  await fsp.writeFile(path.join(companion.data, 'auth.json'), JSON.stringify({ devices: [
    { name: 'mac-primary', tokenHash: sha256(tokens.mac), createdAt: now },
    { name: 'bridge-local', tokenHash: sha256(tokens.local), createdAt: now, kind: 'machine' },
    { name: 'bridge-devbox', tokenHash: sha256(tokens.devbox), createdAt: now, kind: 'machine' },
    { name: 'bridge-oldbox', tokenHash: sha256(tokens.oldbox), createdAt: now, kind: 'machine' },
  ] }), { mode: 0o600 })
  await bootServer(companion, `
const c = await import(${JSON.stringify(path.join(REPO_ROOT, 'src/constants.ts'))})
if (c.WALNUT_HOME !== ${JSON.stringify(companion.data)} || !c.CLOUD_MODE) { process.stderr.write('REFUSING: wrong home ' + c.WALNUT_HOME + '\\n'); process.exit(3) }
const { startServer, stopServer, armGracefulSignalExit } = await import(${JSON.stringify(path.join(REPO_ROOT, 'src/web/server.ts'))})
const server = await startServer({ port: 0, dev: true })
const addr = server.address()
process.stdout.write('WALNUT_PORT=' + (typeof addr === 'object' && addr ? addr.port : addr) + '\\n')
let closing = false
const close = async () => { if (closing) return; closing = true; try { await stopServer() } catch {} process.exit(0) }
process.on('SIGTERM', close)
process.on('SIGINT', close)
armGracefulSignalExit()
`, serverEnv(companion, { WALNUT_CLOUD_MODE: '1', WALNUT_GIT_HUB_DIR: path.join(base, 'hub'), WALNUT_LEADER_TICK_MS: '300' }))
}

async function spawnDaemon(name: string, twin: 'source' | 'standalone'): Promise<Daemon> {
  const dir = path.join(base, name.slice(0, 2))
  fs.mkdirSync(dir)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALNUT_DAEMON_DIR: dir,
    WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_GATEWAY_TIMEOUT_MS: '10000',
    WALNUT_LEADER_TAKEOVER_MS: String(T),
    WALNUT_TRUSTED_CLIENT_BEAT_MS: String(BEAT),
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  let proc: ChildProcess
  if (twin === 'source') {
    const script = path.join(dir, 'daemon.cjs')
    fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
    proc = spawn(process.execPath, [script, '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  } else {
    proc = spawn(BUN!, [path.join(REPO_ROOT, 'src/providers/daemon-standalone.ts'), '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'], cwd: REPO_ROOT })
  }
  const portFile = path.join(dir, 'daemon.port')
  const sock = path.join(dir, 'agent-gateway.sock')
  await waitFor(() => fs.existsSync(portFile) && fs.existsSync(sock) && fs.existsSync(path.join(dir, 'daemon.pid')), 60_000, `${name} daemon`)
  return {
    name, twin, proc, dir, sock,
    port: parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10),
    pid: parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10),
  }
}

async function startSession(d: Daemon, sid: string): Promise<void> {
  const mock = path.join(base, 'mock-cli.cjs')
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${d.port}`)
    s.once('open', () => resolve(s))
    s.once('error', reject)
  })
  const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('start timed out')), 20_000)
    ws.on('message', (m) => { const r = JSON.parse(String(m)); if (r.id === 1) { clearTimeout(t); resolve(r) } })
    ws.send(JSON.stringify({ id: 1, cmd: 'start', sid, cwd: d.dir, message: 'init', args: [process.execPath, mock, sid, path.join(d.dir, `${sid}.inbox.jsonl`)], origin: { home: primary.data } }))
  })
  ws.close()
  expect(reply.ok, JSON.stringify(reply)).toBe(true)
  await waitFor(() => { try { return fs.readFileSync(path.join(d.dir, 'streams', `${sid}.jsonl`), 'utf8').includes('"state":"idle"') } catch { return false } }, 30_000, `${sid} idle`)
}

async function startPrimary(dev: Daemon, old: Daemon): Promise<void> {
  await prepare(primary, 'primary')
  const domain = `127.0.0.1:${companion.port}`
  execFileSync('git', ['init', '-q', primary.data], { env: gitEnv() })
  execFileSync('git', ['-C', primary.data, 'remote', 'add', 'cloud', `http://mac:${tokens.mac}@${domain}/git/data.git`], { env: gitEnv() })
  await fsp.mkdir(path.join(primary.data, 'sync'), { recursive: true })
  await fsp.writeFile(path.join(primary.data, 'sync', 'bridge-tokens.json'), JSON.stringify({ 'bridge-local': tokens.local, 'bridge-devbox': tokens.devbox, 'bridge-oldbox': tokens.oldbox }), { mode: 0o600 })
  await fsp.writeFile(path.join(primary.data, 'config.yaml'), 'version: 1\nuser:\n  name: Tester\ndefaults:\n  priority: none\n  platform: local\nprovider:\n  type: claude-code\n')
  // What the hosts keep a copy of (docs/plan/walnut-control-plane.md "What a host keeps").
  await fsp.mkdir(path.join(primary.data, 'notes', 'Projects'), { recursive: true })
  await fsp.writeFile(path.join(primary.data, 'notes', 'Projects', 'Release.md'), '# Release\nShip on Friday after the rollback drill.\n')
  await fsp.mkdir(path.join(primary.data, 'memory'), { recursive: true })
  await fsp.writeFile(path.join(primary.data, 'memory', 'MEMORY.md'), '# Memory\n- deploy with the script\n')
  const src = (f: string) => JSON.stringify(path.join(REPO_ROOT, f))
  await bootServer(primary, `
const c = await import(${src('src/constants.ts')})
if (c.WALNUT_HOME !== ${JSON.stringify(primary.data)} || c.CLOUD_MODE) { process.stderr.write('REFUSING: wrong home ' + c.WALNUT_HOME + '\\n'); process.exit(3) }
const { startServer, stopServer, armGracefulSignalExit } = await import(${src('src/web/server.ts')})
const server = await startServer({ port: 0, dev: true })
const tm = await import(${src('src/core/task-manager.ts')})
const lead = (await tm.addTask({ title: 'Leader: ship the release', project: 'Acme' })).task
const worker = (await tm.addTask({ title: 'Worker: fix the build', project: 'Acme', parent_task_id: lead.id, description: 'Fix the flaky build step before Friday.' })).task
const far = (await tm.addTask({ title: 'Far task: release notes', project: 'Other' })).task
const st = await import(${src('src/core/session-tracker.ts')})
await st.createSessionRecord(${JSON.stringify(A)}, lead.id, 'Acme', ${JSON.stringify(dev.dir)}, { host: 'devbox', title: 'Leader', initialProcessStatus: 'idle' })
await st.createSessionRecord(${JSON.stringify(B)}, worker.id, 'Acme', ${JSON.stringify(old.dir)}, { host: 'oldbox', title: 'Worker', initialProcessStatus: 'idle' })
// C is newer than B by a clear margin: only the task's current session (B) makes B the address.
await new Promise((r) => setTimeout(r, 20))
await st.createSessionRecord(${JSON.stringify(C)}, worker.id, 'Acme', ${JSON.stringify(old.dir)}, { host: 'oldbox', title: 'Worker, second try', initialProcessStatus: 'idle' })
// B is the worker's session, as task_start links it: a message to the task goes to B, never to C.
await tm.linkSession(worker.id, ${JSON.stringify(B)})
const bs = await import(${src('src/core/boards/board-store.ts')})
await bs.setBoardHtml(lead.id, '<h1>Release</h1><p id="build">Build: red</p>', { by: 'human' })
const { localDaemon } = await import(${src('src/providers/local-daemon.ts')})
const dc = await import(${src('src/providers/daemon-connection.ts')})
if (localDaemon.wsUrl) await dc.getDirectDaemonConnection('__local__', localDaemon.wsUrl)
await dc.getDirectDaemonConnection('devbox', 'ws://127.0.0.1:${dev.port}')
await dc.getDirectDaemonConnection('oldbox', 'ws://127.0.0.1:${old.port}')
const addr = server.address()
process.stdout.write(JSON.stringify({ ids: { lead: lead.id, worker: worker.id, far: far.id }, pid: process.pid }) + '\\n')
process.stdout.write('WALNUT_PORT=' + (typeof addr === 'object' && addr ? addr.port : addr) + '\\n')
let closing = false
const close = async () => { if (closing) return; closing = true; try { await stopServer() } catch {} process.exit(0) }
process.on('SIGTERM', close)
process.on('SIGINT', close)
armGracefulSignalExit()
`, serverEnv(primary, { WALNUT_LEADER_HEARTBEAT_MS: '500' }), (line) => {
    try { const j = JSON.parse(line); if (j.ids) { primary.ids = j.ids; primary.serverPid = j.pid } } catch { /* partial */ }
  })
}

async function api(s: Server, p: string, init: RequestInit = {}): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(`http://127.0.0.1:${s.port}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${tokens.mac}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, any> }
}

function gatewayCall(d: Daemon, sid: string, name: string, args: Record<string, unknown> = {}): Promise<GatewayResponse> {
  return new Promise((resolve, reject) => {
    const s = net.connect(d.sock)
    let buf = ''
    const t = setTimeout(() => { s.destroy(); reject(new Error(`gateway ${name} timeout`)) }, 30_000)
    s.on('connect', () => s.write(JSON.stringify({ v: 1, op: 'tools.call', sid, args: { name, args } }) + '\n'))
    s.on('data', (c) => {
      buf += c.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl !== -1) { clearTimeout(t); s.destroy(); resolve(JSON.parse(buf.slice(0, nl))) }
    })
    s.on('error', (e) => { clearTimeout(t); reject(e) })
  })
}

function inboxOf(d: Daemon, sid: string): string[] {
  try {
    return fs.readFileSync(path.join(d.dir, `${sid}.inbox.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map((l) => String(JSON.parse(l).content))
  } catch { return [] }
}

/** The control requests a session's CLI got (the mock keeps them). */
function ctrlOf(d: Daemon, sid: string): Array<{ request_id: string; request: { subtype: string; settings: Record<string, string> } }> {
  try {
    return fs.readFileSync(path.join(d.dir, `${sid}.ctrl.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch { return [] }
}

/** The permission answers a session's CLI got (the mock keeps them). */
function respOf(d: Daemon, sid: string): Array<{ response: { request_id: string; response: Record<string, unknown> } }> {
  try {
    return fs.readFileSync(path.join(d.dir, `${sid}.resp.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch { return [] }
}

/** A session's record in the primary's own session store, read-only. */
function primaryRecord(sid: string): Record<string, any> {
  const db = new Database(path.join(primary.data, 'sessions.sqlite'), { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare('SELECT * FROM sessions WHERE claude_session_id = ?').get(sid) as Record<string, any> | undefined
    return { ...(row ?? {}), ...(row?.payload ? JSON.parse(row.payload) as Record<string, unknown> : {}) }
  } finally { db.close() }
}

/** A session's CLI model and effort in the primary's own session store, read-only. */
function primarySettings(sid: string): { cliModel: string | null; effort: string | null } {
  const db = new Database(path.join(primary.data, 'sessions.sqlite'), { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare('SELECT cli_model, payload FROM sessions WHERE claude_session_id = ?').get(sid) as { cli_model: string | null; payload: string | null } | undefined
    const extra = row?.payload ? JSON.parse(row.payload) as Record<string, unknown> : {}
    return { cliModel: row?.cli_model ?? null, effort: typeof extra.effort === 'string' ? extra.effort : null }
  } finally { db.close() }
}

function pidIn(dir: string): number | null {
  try { const n = Number(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim()); return Number.isInteger(n) && n > 1 ? n : null } catch { return null }
}

/**
 * The Mac: the primary server and its own local daemon. The server's own pid,
 * not the tsx wrapper's (tsx runs the script in a child node process).
 */
function macPids(): number[] {
  return [primary.serverPid, pidIn(primary.daemonDir) ?? 0].filter((p) => p > 1)
}

const companionLeads = async () => ((await api(companion, '/api/leader')).json.leading ?? []) as Array<{ host: string; epoch: number }>

/** A session as its host's daemon sees it (status, read-only). */
async function daemonStatus(d: Daemon, sid: string): Promise<Record<string, any>> {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${d.port}`)
    s.once('open', () => resolve(s))
    s.once('error', reject)
  })
  try {
    return await new Promise<Record<string, any>>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('status timed out')), 10_000)
      ws.on('message', (m) => { const r = JSON.parse(String(m)); if (r.id === 1) { clearTimeout(t); resolve(r) } })
      ws.send(JSON.stringify({ id: 1, cmd: 'status', sid }))
    })
  } finally { ws.close() }
}

/** What a host's copy of the primary's notes, memory and skills holds (replica.status). */
async function replicaStatus(d: Daemon): Promise<Record<string, { entries: number; pending: number }>> {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${d.port}`)
    s.once('open', () => resolve(s))
    s.once('error', reject)
  })
  try {
    const reply = await new Promise<Record<string, any>>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('replica.status timed out')), 10_000)
      ws.on('message', (m) => { const r = JSON.parse(String(m)); if (r.id === 1) { clearTimeout(t); resolve(r) } })
      ws.send(JSON.stringify({ id: 1, cmd: 'replica.status', home: primary.data }))
    })
    return (reply.kinds ?? {}) as Record<string, { entries: number; pending: number }>
  } finally { ws.close() }
}

describe('the Mac is gone and the cloud companion takes over (real servers, real daemons)', () => {
  let devbox: Daemon
  let oldbox: Daemon
  let requestId = ''
  let stopIdOfC = ''

  beforeAll(async () => {
    base = await fsp.mkdtemp(path.join(os.tmpdir(), 'wll-'))
    for (const k of Object.keys(tokens) as Array<keyof typeof tokens>) tokens[k] = newToken()
    await fsp.writeFile(path.join(base, 'mock-cli.cjs'), MOCK_CLI)
    await startCompanion()
    devbox = await spawnDaemon('devbox', 'source')
    oldbox = await spawnDaemon('oldbox', BUN ? 'standalone' : 'source')
    daemons.push(devbox, oldbox)
    primary.data = path.join(base, 'primary', 'data') // the sessions' origin
    await startSession(devbox, A)
    await startSession(oldbox, B)
    await startSession(oldbox, C)
    await startPrimary(devbox, oldbox)
    expect(primary.ids.lead).toMatch(/\S/)
    expect(primary.serverPid).toBeGreaterThan(1)
  }, 400_000)

  afterAll(async () => {
    for (const pid of macPids()) { try { process.kill(pid, 'SIGCONT') } catch { /* gone */ } }
    for (const s of [primary, companion]) {
      const proc = s.proc
      if (proc && proc.exitCode === null && proc.signalCode === null) {
        const exited = new Promise<void>((r) => proc.once('exit', () => r()))
        proc.kill('SIGTERM')
        await Promise.race([exited, sleep(30_000)])
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
      }
    }
    for (const dir of [primary.daemonDir, companion.daemonDir, ...daemons.map((d) => d.dir)]) {
      const pid = dir ? pidIn(dir) : null
      if (pid) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
    }
    if (process.env.DEBUG_LIVE) process.stderr.write(`--- companion ---\n${companion.log.slice(-6000)}\n--- primary ---\n${primary.log.slice(-6000)}\n`)
    await sleep(500)
    if (base && !process.env.KEEP_LEADER_LIVE) await fsp.rm(base, { recursive: true, force: true }).catch(() => {})
  }, 120_000)

  it('the Mac is up: it holds the lead of both hosts and the companion hears its heartbeat', async () => {
    await waitFor(async () => {
      const r = await api(primary, '/api/leader')
      return r.json.hosts?.devbox?.holder === 'primary' && r.json.hosts?.oldbox?.holder === 'primary' ? r : null
    }, 120_000, 'the primary to describe the Walnut to both hosts')
    const box = await waitFor(async () => {
      const r = await api(companion, '/api/leader')
      return r.json.primaryHeard === true ? r : null
    }, 120_000, 'the companion to hear the heartbeat')
    expect(box.json).toMatchObject({ role: 'backup', leading: [] })
    // The companion knows both sessions (the projection the primary pushes): it needs them to route.
    await waitFor(() => {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(companion.data, 'cache', 'projections', 'sessions.json'), 'utf8'))
        const text = JSON.stringify(p)
        return text.includes(A) && text.includes(B)
      } catch { return false }
    }, 120_000, 'the session projection on the companion')
    // Stays that way while the Mac is up.
    await sleep(2 * T)
    expect(await companionLeads()).toEqual([])
  }, 400_000)

  it('the Mac keeps the companion\'s copy of its task store: every task, at the Mac\'s own row', async () => {
    const held = await waitFor(() => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(companion.data, 'cache', 'task-replica.json'), 'utf8'))
        const ids = Object.values(primary.ids)
        return ids.every((id) => typeof s.hashes?.[id] === 'string') && s.registry ? s : null
      } catch { return null }
    }, 120_000, 'the companion to hold every task')
    expect(held.order).toEqual(expect.arrayContaining(Object.values(primary.ids)))
    // A task the Mac creates now reaches it within a few seconds (the round follows the change).
    const made = await api(primary, '/api/v1/tasks', { method: 'POST', body: JSON.stringify({ title: 'Release checklist', project: 'Acme', description: 'Rollback drill, smoke, tag.' }) })
    expect(made.status, JSON.stringify(made.json)).toBe(201)
    const id = String(made.json.task?.id ?? made.json.id)
    await waitFor(() => {
      try { return typeof JSON.parse(fs.readFileSync(path.join(companion.data, 'cache', 'task-replica.json'), 'utf8')).hashes?.[id] === 'string' } catch { return false }
    }, 30_000, 'the new task on the companion')
  }, 200_000)

  it('the Mac gives every host a copy of the notes, memory and skills, and a note written there reaches it', async () => {
    for (const d of [devbox, oldbox]) {
      await waitFor(async () => {
        const k = await replicaStatus(d)
        return k.notes?.entries >= 1 && k.notes.pending === 0 && k.memory?.entries >= 1 && k.skills?.entries >= 1 ? k : null
      }, 120_000, `${d.name}'s copy`)
    }
    // While the Mac is up a read is the Mac's, and so is a write.
    const read = await gatewayCall(devbox, A, 'note_read', { path: 'Projects/Release' })
    expect(read.ok, JSON.stringify(read)).toBe(true)
    if (read.ok) expect(read.result.offline).toBeUndefined()
    const wrote = await gatewayCall(devbox, A, 'note_write', { path: 'Projects/Standup', content: '# Standup\nThe drill passed; the build is green.\n' })
    expect(wrote.ok, JSON.stringify(wrote)).toBe(true)
    // The write's own event brings both copies up to date, with no sweep.
    for (const d of [devbox, oldbox]) {
      await waitFor(async () => ((await replicaStatus(d)).notes?.entries ?? 0) >= 2, 30_000, `the new note on ${d.name}`)
    }
  }, 300_000)

  it('the Mac sleeps (server and local daemon frozen): the companion leads both hosts', async () => {
    for (const pid of macPids()) process.kill(pid, 'SIGSTOP')
    const leads = await waitFor(async () => {
      const l = await companionLeads()
      return l.length === 2 ? l : null
    }, 6 * T, 'the companion to lead both hosts')
    expect(leads.map((l) => l.host).sort()).toEqual(['devbox', 'oldbox'])
  }, 120_000)

  it('while the Mac sleeps, sessions on both hosts read notes, memory and skills from their own copy', async () => {
    for (const [d, sid] of [[devbox, A], [oldbox, B]] as const) {
      const note = await gatewayCall(d, sid, 'note_read', { path: 'Projects/Standup' })
      expect(note, JSON.stringify(note)).toMatchObject({ ok: true, result: { path: 'Projects/Standup', offline: true } })
      if (note.ok) expect(String(note.result.content)).toContain('the build is green')
      const found = await gatewayCall(d, sid, 'note_search', { q: 'rollback drill' })
      expect(found.ok && (found.result.results as Array<{ path: string }>).map((r) => r.path)).toEqual(['Projects/Release'])
      const memory = await gatewayCall(d, sid, 'memory_read', { doc: 'global' })
      expect(memory.ok && String((memory.result.memory as { content: string }).content)).toContain('deploy with the script')
      const skill = await gatewayCall(d, sid, 'skill_read', { dirName: 'walnut-board' })
      expect(skill, JSON.stringify(skill).slice(0, 400)).toMatchObject({ ok: true, result: { skill: { dirName: 'walnut-board' }, offline: true } })
    }
  }, 120_000)

  it('while the Mac sleeps, the companion answers a task with every field from its own copy, at once', async () => {
    const started = Date.now()
    const r = await api(companion, `/api/v1/tasks/${primary.ids.worker}`)
    expect(r.status, JSON.stringify(r.json)).toBe(200)
    const t = r.json.task ?? r.json
    expect(t).toMatchObject({ id: primary.ids.worker, parent_task_id: primary.ids.lead, description: 'Fix the flaky build step before Friday.' })
    // No round trip to the sleeping Mac (that one waits 5s and gives up).
    expect(Date.now() - started).toBeLessThan(3_000)
  }, 60_000)

  it('A on devbox asks B on oldbox, and B answers, through the companion', async () => {
    const sent = await gatewayCall(devbox, A, 'task_send', { to: primary.ids.worker, text: 'Is the build green? \u4e2d' })
    expect(sent.ok, JSON.stringify(sent)).toBe(true)
    if (!sent.ok) return
    expect(sent.result).toMatchObject({ viaLeader: true, targetSessionId: B })
    requestId = String(sent.result.requestId)
    await waitFor(() => inboxOf(oldbox, B).some((m) => m.includes(requestId)), 15_000, 'B receives the question')
    expect(inboxOf(oldbox, B).find((m) => m.includes(requestId))).toContain('Is the build green? \u4e2d')

    const replied = await gatewayCall(oldbox, B, 'task_send', { in_reply_to: requestId, text: 'Green on main.' })
    expect(replied.ok, JSON.stringify(replied)).toBe(true)
    await waitFor(() => inboxOf(devbox, A).some((m) => m.includes('Green on main.')), 15_000, 'A receives the answer')
  }, 120_000)

  it('B edits the team Board on its host, and A updates a task outside every copy through the companion', async () => {
    const edit = await gatewayCall(oldbox, B, 'board_edit', { edits: [{ old: 'Build: red', new: 'Build: green' }] })
    expect(edit).toMatchObject({ ok: true, result: { queued: true } })
    const far = await gatewayCall(devbox, A, 'task_update', { id: primary.ids.far, description: 'Drafted while the Mac slept.' })
    expect(far.ok, JSON.stringify(far)).toBe(true)
    if (far.ok) expect(far.result.viaLeader).toBe(true)
    // The companion's own write: its row is no longer the Mac's, and is held until the Mac has it.
    await waitFor(() => {
      try { return JSON.parse(fs.readFileSync(path.join(companion.data, 'cache', 'task-replica.json'), 'utf8')).hashes?.[primary.ids.far] === undefined } catch { return false }
    }, 15_000, 'the companion to let go of the Mac\'s row of the far task')
  }, 120_000)

  it('while the Mac sleeps, the phone reads B\'s model picker from the companion and switches its model and effort on oldbox', async () => {
    const started = Date.now()
    const options = await api(companion, `/api/v1/sessions/${B}/model-options`)
    expect(options.status, JSON.stringify(options.json)).toBe(200)
    expect(options.json).toMatchObject({ offline: true })
    expect((options.json.models as Array<{ id: string }>).map((m) => m.id)).toContain('sonnet')
    // From the copy, with no round trip to the sleeping Mac.
    expect(Date.now() - started).toBeLessThan(3_000)

    const model = await api(companion, `/api/v1/sessions/${B}/model`, { method: 'POST', body: JSON.stringify({ model: 'sonnet' }) })
    expect(model.status, JSON.stringify(model.json)).toBe(200)
    expect(model.json).toMatchObject({ model: 'sonnet', cliModel: 'sonnet', appliedLive: true, viaCompanion: true })
    const effort = await api(companion, `/api/v1/sessions/${B}/effort`, { method: 'POST', body: JSON.stringify({ effort: 'low' }) })
    expect(effort.status, JSON.stringify(effort.json)).toBe(200)
    expect(effort.json).toMatchObject({ effort: 'low', appliedLive: true, viaCompanion: true })
    // B's own CLI got both, as the CLI's own settings lines.
    expect(ctrlOf(oldbox, B).map((c) => [c.request.subtype, c.request.settings])).toEqual([
      ['apply_flag_settings', { model: 'sonnet' }],
      ['apply_flag_settings', { effortLevel: 'low' }],
    ])
    // The picker shows what it now runs.
    const after = await api(companion, `/api/v1/sessions/${B}/model-options`)
    expect(after.json).toMatchObject({ current: 'sonnet', currentEffort: 'low', offline: true })
  }, 60_000)

  it('while the Mac sleeps, the phone answers B\'s permission prompt, changes A\'s mode and stops C, each on its host', async () => {
    // B asks to run a tool: the phone's message reaches it through the companion.
    const sent = await api(companion, `/api/v1/sessions/${B}/messages`, { method: 'POST', body: JSON.stringify({ text: 'ASK: list the docs' }) })
    expect(sent.status, JSON.stringify(sent.json)).toBe(202)
    // The detail shows the prompt the host keeps, at once (no wait on the sleeping Mac).
    const detail = await waitFor(async () => {
      const started = Date.now()
      const r = await api(companion, `/api/v1/sessions/${B}`)
      expect(Date.now() - started).toBeLessThan(3_000)
      return r.json.pendingPermissions?.length === 1 ? r : null
    }, 30_000, 'B\'s prompt in the detail')
    expect(detail.json).toMatchObject({ degraded: true, pendingPermissions: [{ toolName: 'Bash', input: { command: 'ls docs/' } }] })
    const requestId = String(detail.json.pendingPermissions[0].requestId)
    const answered = await api(companion, `/api/v1/sessions/${B}/permission`, { method: 'POST', body: JSON.stringify({ requestId, allow: true }) })
    expect(answered.status, JSON.stringify(answered.json)).toBe(200)
    expect(answered.json).toEqual({ status: 'resolved', requestId, allow: true, viaCompanion: true })
    await waitFor(() => respOf(oldbox, B).length === 1, 15_000, 'B\'s CLI to get the answer')
    expect(respOf(oldbox, B)[0].response).toMatchObject({ request_id: requestId, response: { behavior: 'allow', updatedInput: { command: 'ls docs/' } } })
    expect((await api(companion, `/api/v1/sessions/${B}`)).json.pendingPermissions).toEqual([])

    // A's mode: the phone's picker shows it, a change reaches A's CLI.
    const mode = await api(companion, `/api/v1/sessions/${A}`, { method: 'PATCH', body: JSON.stringify({ mode: 'plan' }) })
    expect(mode.status, JSON.stringify(mode.json)).toBe(200)
    expect(mode.json).toMatchObject({ session: { claudeSessionId: A, mode: 'plan' }, viaCompanion: true })
    expect(ctrlOf(devbox, A).map((c) => c.request).at(-1)).toEqual({ subtype: 'set_permission_mode', mode: 'plan' })
    const controls = await api(companion, `/api/v1/sessions/${A}/controls`)
    expect(controls.json).toMatchObject({ engine: 'claude', controls: [{ id: 'mode', currentValue: 'plan' }] })

    // C stops on oldbox; B keeps running.
    const stopped = await api(companion, `/api/v1/sessions/${C}/terminate`, { method: 'POST', body: JSON.stringify({}) })
    expect(stopped.status, JSON.stringify(stopped.json)).toBe(200)
    expect(stopped.json).toMatchObject({ status: 'terminated', sessionId: C, viaCompanion: true, stopRequest: { state: 'confirmed' } })
    stopIdOfC = String(stopped.json.stopRequest.id)
    expect(await daemonStatus(oldbox, C)).toMatchObject({ exists: true, alive: false })
    expect(await daemonStatus(oldbox, B)).toMatchObject({ exists: true, alive: true })
  }, 120_000)

  it('while the Mac sleeps, a session\'s search and the phone\'s both reach the companion\'s copy of every task', async () => {
    // The far task is in no host's copy: only the companion holds it.
    const fromHost = await gatewayCall(devbox, A, 'search', { q: 'release notes', types: 'task' })
    expect(fromHost.ok, JSON.stringify(fromHost)).toBe(true)
    if (fromHost.ok) expect((fromHost.result.results as Array<{ taskId?: string }>).map((r) => r.taskId)).toContain(primary.ids.far)
    const started = Date.now()
    const phone = await api(companion, '/api/v1/search?q=release%20notes&types=task')
    expect(phone.status, JSON.stringify(phone.json)).toBe(200)
    expect(phone.json).toMatchObject({ offline: true, degraded: 'offline-keyword' })
    expect((phone.json.results as Array<{ taskId?: string }>).map((r) => r.taskId)).toContain(primary.ids.far)
    expect(Date.now() - started).toBeLessThan(3_000)
  }, 60_000)

  it('the Mac wakes: it takes back what the hosts did, takes the lead back, and the companion lets go', async () => {
    for (const pid of macPids()) process.kill(pid, 'SIGCONT')
    const states = await waitFor(async () => {
      const r = await api(primary, '/api/leader')
      const h = r.json.hosts ?? {}
      return h.devbox?.tookBackAt && h.oldbox?.tookBackAt ? h : null
    }, 90_000, 'the primary to take both hosts back')
    expect(states.devbox).toMatchObject({ holder: 'primary', epoch: 3 })
    expect(states.oldbox).toMatchObject({ holder: 'primary', epoch: 3 })
    await waitFor(async () => (await companionLeads()).length === 0, 30_000, 'the companion to let go')

    // The reply request B's host held is the Mac's now, answered.
    const rows = await waitFor(() => {
      try {
        const file = JSON.parse(fs.readFileSync(path.join(primary.data, 'session-requests.json'), 'utf8'))
        const list = Array.isArray(file) ? file : (file.requests ?? Object.values(file))
        const row = (list as Array<Record<string, unknown>>).find((r) => r.id === requestId)
        return row && row.status === 'replied' ? row : null
      } catch { return null }
    }, 30_000, 'the request row on the Mac')
    expect(rows).toMatchObject({ fromSessionId: A, toSessionId: B })
    // B's Board write was replayed through the server's own op.
    const board = await waitFor(() => {
      try {
        const b = JSON.parse(fs.readFileSync(path.join(primary.data, 'boards', `${primary.ids.lead}.json`), 'utf8'))
        return String(b.html).includes('Build: green') ? b : null
      } catch { return null }
    }, 30_000, 'the Board write on the Mac')
    expect(board.version).toBe(2)
    // The model and effort the companion set on oldbox are B's on the Mac too.
    const settings = await waitFor(() => { const v = primarySettings(B); return v.cliModel === 'sonnet' ? v : null }, 30_000, 'B\'s model on the Mac')
    expect(settings.effort).toBe('low')
    // A's mode is A's on the Mac too, and C's stop is the Mac's own stop, by the id the phone saw.
    await waitFor(() => primaryRecord(A).mode === 'plan', 30_000, 'A\'s mode on the Mac')
    const c = await waitFor(() => { const r = primaryRecord(C); return r.stopRequest?.state === 'confirmed' ? r : null }, 30_000, 'C\'s stop on the Mac')
    expect(c.stopRequest.id).toBe(stopIdOfC)
    expect(c.process_status).toBe('stopped')
    // The task the companion changed for A reaches the Mac through the replica's queue.
    await waitFor(async () => {
      const r = await api(primary, `/api/v1/tasks/${primary.ids.far}`)
      const t = r.json.task ?? r.json
      return String(t.description ?? '').includes('Drafted while the Mac slept.') ? t : null
    }, 120_000, 'the far task change on the Mac')
    // And the companion's copy of that task is the Mac's row again, its own write delivered.
    await waitFor(() => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(companion.data, 'cache', 'task-replica.json'), 'utf8'))
        const queued = fs.existsSync(path.join(companion.data, 'cache', 'task-queue')) ? fs.readdirSync(path.join(companion.data, 'cache', 'task-queue')).filter((f) => f.endsWith('.json')) : []
        return typeof s.hashes?.[primary.ids.far] === 'string' && queued.length === 0
      } catch { return false }
    }, 120_000, 'the companion to hold the Mac\'s row of the far task again')
  }, 400_000)
})
