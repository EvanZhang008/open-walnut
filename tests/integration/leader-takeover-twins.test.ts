/**
 * The Mac is gone and the cloud companion takes over, on REAL daemon processes
 * (docs/plan/walnut-control-plane.md).
 *
 *   fake primary (child process) ══trusted WS══► devbox daemon (source twin, node)  ── session A
 *        │  heartbeat                  ╚═══════► oldbox daemon (standalone twin, bun) ── session B
 *        ▼                                            │ bridge (each daemon dials it)
 *   companion (this process): a /bridge server + the REAL backup leader and gateway
 *
 * What's real: both daemon twins as processes, their leader books on disk, the
 * agent-gateway unix socket as the `walnut` CLI speaks it, the bridge protocol
 * (hello, ping markers, commands, events), the offline host, and the
 * companion's decision loop (backup-leader.ts) and gateway (backup-gateway.ts).
 * The sessions are a mock CLI reading its FIFO. The primary is a small child
 * process holding trusted sockets the way a Walnut server does (host.slice,
 * leader.configure, drain then claim), so its sleep is a real SIGSTOP: its
 * sockets stay open and go silent, exactly what a lid close does. What's not
 * here: the real Walnut servers (tests/e2e/leader-takeover-live-e2e.test.ts).
 *
 * Hygiene: every dir is a temp dir; daemons are stopped by the pid they wrote
 * into their own dir; the fake primary is ours and is killed at the end.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import type { GatewayResponse } from '../../src/providers/gateway-core.js'
import type { HostSlice, OfflineRecord } from '../../src/providers/offline-host-core.js'
import { createBackupLeader } from '../../src/core/leader/backup-leader.js'
import { createBackupGateway } from '../../src/core/leader/backup-gateway.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const HOME = '/fixture/walnut-home'
const WALNUT = 'wprimarytest01'
const A = 'aaaaaaaa-1111-4111-8111-111111111111'
const B = 'bbbbbbbb-2222-4222-8222-222222222222'
const TASK_A = 'mleadaaa-0001'
const TASK_B = 'mworkbbb-0002'
/** The takeover window, and the daemon's keepalive beat (a silent primary socket is closed after 8). */
const T = 5_000
const BEAT = 2_000

const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))
const WS_PATH = createRequire(import.meta.url).resolve('ws')

const MOCK_CLI = `
const fs = require('fs')
const sid = process.argv[2]
const inbox = process.argv[3]
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: sid })
out({ type: 'result', subtype: 'success', is_error: false, result: 'ready', session_id: sid })
out({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8')
  let nl
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    let msg; try { msg = JSON.parse(line) } catch { continue }
    // A settings change (leader.settings): kept for the test, answered as the CLI does.
    if (msg.type === 'control_request') {
      fs.appendFileSync(inbox.replace('.inbox.jsonl', '.ctrl.jsonl'), JSON.stringify(msg) + '\\n')
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } })
      continue
    }
    if (msg.type !== 'user') continue
    fs.appendFileSync(inbox, JSON.stringify({ content: msg.message && msg.message.content }) + '\\n')
  }
})
setInterval(() => {}, 1 << 30)
`

/** A Walnut server as a daemon sees it: trusted sockets, a copy, a heartbeat, drain-then-claim. */
const FAKE_PRIMARY = `
const WebSocket = require(${JSON.stringify(WS_PATH)})
const fs = require('fs')
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const out = (o) => fs.appendFileSync(cfg.out, JSON.stringify(Object.assign({ t: Date.now() }, o)) + '\\n')
let heartbeat = true
process.on('SIGUSR1', () => { heartbeat = !heartbeat; out({ ev: 'heartbeat', on: heartbeat }) })
let companion = null
function dialCompanion() {
  const ws = new WebSocket(cfg.companionUrl)
  ws.on('open', () => { companion = ws })
  ws.on('close', () => { companion = null; setTimeout(dialCompanion, 200) })
  ws.on('error', () => {})
}
dialCompanion()
setInterval(() => {
  if (heartbeat && companion && companion.readyState === 1) companion.send(JSON.stringify({ ev: 'leader-heartbeat', walnutId: cfg.walnutId, backup: true }))
}, 300)
function connect(h) {
  const ws = new WebSocket('ws://127.0.0.1:' + h.port)
  let id = 0
  const pending = new Map()
  const call = (cmd, params) => new Promise((resolve, reject) => {
    const my = ++id
    const timer = setTimeout(() => { pending.delete(my); reject(new Error(cmd + ' timed out')) }, 15000)
    pending.set(my, (m) => { clearTimeout(timer); resolve(m) })
    ws.send(JSON.stringify(Object.assign({ id: my, cmd }, params)))
  })
  let busy = false
  async function handover(why) {
    if (busy) return
    busy = true
    try {
      for (;;) {
        const r = await call('offline.drain', { home: cfg.home })
        const records = r.records || []
        if (!records.length) break
        out({ ev: 'drained', host: h.name, records })
        await call('offline.ack', { home: cfg.home, upTo: Math.max(...records.map((x) => x.seq)) })
      }
      const c = await call('leader.configure', { home: cfg.home, walnutId: cfg.walnutId, backup: true })
      out({ ev: 'configured', host: h.name, epoch: c.epoch, holder: c.holder, why })
      if (c.holder === 'backup') {
        const k = await call('leader.claim', { home: cfg.home })
        out({ ev: 'claimed', host: h.name, epoch: k.epoch, holder: k.holder, why })
      }
    } catch (err) { out({ ev: 'error', host: h.name, error: String(err) }) }
    busy = false
  }
  ws.on('open', async () => {
    out({ ev: 'connected', host: h.name })
    try { await call('host.slice', { slice: h.slice }) } catch (err) { out({ ev: 'error', host: h.name, error: String(err) }) }
    await handover('connect')
  })
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(String(d)) } catch { return }
    if (typeof m.id === 'number' && pending.has(m.id)) { const f = pending.get(m.id); pending.delete(m.id); f(m); return }
    if (m.ev === 'leader-lost') { out({ ev: 'leader-lost', host: h.name }); void handover('leader-lost'); return }
    if (m.ev === 'gateway-request') {
      out({ ev: 'gateway-request', host: h.name, op: m.payload && m.payload.name })
      ws.send(JSON.stringify({ id: ++id, cmd: 'gateway-result', relayId: m.relayId, result: { answeredBy: 'primary' } }))
    }
  })
  ws.on('close', () => { out({ ev: 'closed', host: h.name }); setTimeout(() => connect(h), 200) })
  ws.on('error', () => {})
}
for (const h of cfg.hosts) connect(h)
setInterval(() => {}, 1 << 30)
`

interface Daemon { name: string; twin: 'source' | 'standalone'; proc: ChildProcess; dir: string; port: number; sock: string; pid: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms: number, label: string): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for ' + label)
    await sleep(50)
  }
}

let base = ''
const daemons: Daemon[] = []
let primary: ChildProcess | null = null
let primaryOut = ''
let wss: WebSocketServer | null = null
let tickTimer: ReturnType<typeof setInterval> | null = null
const conns = new Map<string, WebSocket>()
const pendingReplies = new Map<number, (m: Record<string, unknown>) => void>()
let nextId = 10_000

function request(host: string, cmd: string, params: Record<string, unknown>, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const ws = conns.get(host)
  if (!ws) return Promise.reject(new Error(`no bridge to ${host}`))
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingReplies.delete(id); reject(new Error(`bridge request timed out: ${cmd} -> ${host}`)) }, timeoutMs)
    pendingReplies.set(id, (m) => { clearTimeout(timer); resolve(m) })
    ws.send(JSON.stringify({ id, cmd, ...params }))
  })
}

const leader = createBackupLeader({ now: () => Date.now(), takeoverMs: T, hosts: () => [...conns.keys()], request, stateFile: null })
const gateway = createBackupGateway({
  leader,
  request,
  sessions: async () => [
    { id: A, host: 'devbox', task_id: TASK_A, title: 'Leader', process_status: 'idle', last_active_at: '2026-10-05T11:00:00Z' },
    { id: B, host: 'oldbox', task_id: TASK_B, title: 'Worker', process_status: 'idle', last_active_at: '2026-10-05T11:00:00Z' },
  ],
  findTask: async (ref) => [{ id: TASK_A, title: 'Leader: ship it' }, { id: TASK_B, title: 'Worker: fix the build' }].find((t) => t.id.startsWith(ref)) ?? null,
  executeOp: async (name, args) => ({ ok: true, result: { name, args } }),
})

async function startCompanion(): Promise<number> {
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((r) => wss!.on('listening', () => r()))
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/primary') {
      // The primary's heartbeat (in production it rides the primary's own bridge).
      ws.on('message', (d) => { try { const m = JSON.parse(String(d)); if (m.ev === 'leader-heartbeat') leader.noteHeartbeat(m) } catch { /* not json */ } })
      return
    }
    let alias = ''
    ws.on('message', (d) => {
      let f: Record<string, unknown>
      try { f = JSON.parse(String(d)) } catch { return }
      if (f.ev === 'hello') { alias = String(f.hostAlias); conns.set(alias, ws); return }
      if (f.ev === 'bridge-ping') { try { ws.send(JSON.stringify({ id: nextId++, cmd: 'ping', ackSeq: f.seq })) } catch { /* closed */ } return }
      if (f.ev === 'gateway-request') { void gateway.handle(alias, f); return }
      if (typeof f.id === 'number' && pendingReplies.has(f.id)) { const r = pendingReplies.get(f.id)!; pendingReplies.delete(f.id); r(f) }
    })
    ws.on('close', () => { if (conns.get(alias) === ws) conns.delete(alias) })
  })
  tickTimer = setInterval(() => { void leader.tick() }, 250)
  return (wss.address() as net.AddressInfo).port
}

async function spawnDaemon(name: string, twin: 'source' | 'standalone'): Promise<Daemon> {
  // Short: the gateway's unix socket path must fit in 104 bytes on macOS.
  const dir = path.join(base, name.slice(0, 2))
  fs.mkdirSync(dir)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALNUT_DAEMON_DIR: dir,
    WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_GATEWAY_TIMEOUT_MS: '8000',
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
    proc = spawn(BUN!, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'], cwd: ROOT })
  }
  if (process.env.DEBUG_DAEMON) proc.stderr?.on('data', (b) => process.stderr.write(`[${name}] ` + b.toString()))
  const portFile = path.join(dir, 'daemon.port')
  const sock = path.join(dir, 'agent-gateway.sock')
  await waitFor(() => fs.existsSync(portFile) && fs.existsSync(sock) && fs.existsSync(path.join(dir, 'daemon.pid')), 60_000, `${name} daemon`)
  return {
    name, twin, proc, dir, sock,
    port: parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10),
    pid: parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10),
  }
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
function cmd(ws: WebSocket, body: Record<string, unknown>): Promise<Record<string, unknown>> {
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

function gatewayCall(d: Daemon, sid: string, name: string, args: Record<string, unknown> = {}): Promise<GatewayResponse> {
  return new Promise((resolve, reject) => {
    const s = net.connect(d.sock)
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

function primaryEvents(): Array<Record<string, any>> {
  try { return fs.readFileSync(primaryOut, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
}

function daemonLog(d: Daemon, re: RegExp): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const f of fs.readdirSync(d.dir).filter((n) => /^daemon-.*\.log$/.test(n))) {
    for (const l of fs.readFileSync(path.join(d.dir, f), 'utf8').split('\n')) {
      if (!l) continue
      try { const r = JSON.parse(l) as Record<string, unknown>; if (re.test(String(r.msg))) out.push(r) } catch { /* not a record */ }
    }
  }
  return out
}

function slice(host: string, sessions: HostSlice['sessions']): HostSlice {
  return {
    v: 1, home: HOME, hash: `h-${host}`, asOf: Date.now(), host, sessions,
    tasks: [
      { id: TASK_A, title: 'Leader: ship it', phase: 'IN_PROGRESS', project: 'Acme' },
      { id: TASK_B, title: 'Worker: fix the build', phase: 'IN_PROGRESS', project: 'Acme', parent_task_id: TASK_A },
    ],
    requests: [],
    boards: [{ taskId: TASK_A, html: '<h1>Release</h1><p id="build">Build: red</p>', version: 1 }],
    boardOf: { [TASK_A]: TASK_A, [TASK_B]: TASK_A },
  }
}

const leadingHosts = () => leader.status().leading.map((l) => `${l.host}@${l.epoch}`).sort()

describe('the Mac is gone and the cloud companion takes over (real daemon twins)', () => {
  let devbox: Daemon
  let oldbox: Daemon
  let requestId = ''

  beforeAll(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wlt-'))
    const cport = await startCompanion()
    devbox = await spawnDaemon('devbox', 'source')
    oldbox = await spawnDaemon('oldbox', BUN ? 'standalone' : 'source')
    daemons.push(devbox, oldbox)
    const mock = path.join(base, 'mock-cli.cjs')
    fs.writeFileSync(mock, MOCK_CLI)
    for (const [d, sid, task] of [[devbox, A, TASK_A], [oldbox, B, TASK_B]] as const) {
      const ws = await connectWs(d.port)
      const started = await cmd(ws, { cmd: 'start', sid, cwd: d.dir, message: 'init', args: [process.execPath, mock, sid, path.join(d.dir, `${sid}.inbox.jsonl`)], origin: { home: HOME, task } })
      expect(started.ok, JSON.stringify(started)).toBe(true)
      const bridged = await cmd(ws, { cmd: 'bridge.configure', enabled: true, url: `ws://127.0.0.1:${cport}/bridge`, token: 't', hostAlias: d.name })
      expect(bridged.ok, JSON.stringify(bridged)).toBe(true)
      ws.close()
      await waitFor(() => { try { return fs.readFileSync(path.join(d.dir, 'streams', `${sid}.jsonl`), 'utf8').includes('"state":"idle"') } catch { return false } }, 30_000, `${sid} idle`)
    }
    await waitFor(() => conns.has('devbox') && conns.has('oldbox'), 20_000, 'both bridges')
    // The primary comes up.
    primaryOut = path.join(base, 'primary.jsonl')
    const cfgFile = path.join(base, 'primary.json')
    fs.writeFileSync(cfgFile, JSON.stringify({
      home: HOME, walnutId: WALNUT, out: primaryOut, companionUrl: `ws://127.0.0.1:${cport}/primary`,
      hosts: [
        { name: 'devbox', port: devbox.port, slice: slice('devbox', [{ sid: A, taskId: TASK_A, title: 'Leader: ship it' }]) },
        { name: 'oldbox', port: oldbox.port, slice: slice('oldbox', [{ sid: B, taskId: TASK_B, title: 'Worker: fix the build' }]) },
      ],
    }))
    const script = path.join(base, 'fake-primary.cjs')
    fs.writeFileSync(script, FAKE_PRIMARY)
    primary = spawn(process.execPath, [script, cfgFile], { stdio: ['ignore', 'ignore', 'pipe'] })
    primary.stderr?.on('data', (b) => process.stderr.write('[primary] ' + b.toString()))
    await waitFor(() => primaryEvents().filter((e) => e.ev === 'configured').length >= 2, 20_000, 'the primary configured both hosts')
  }, 180_000)

  afterAll(async () => {
    if (tickTimer) clearInterval(tickTimer)
    if (primary && primary.exitCode === null) { try { primary.kill('SIGCONT') } catch { /* gone */ } try { primary.kill('SIGKILL') } catch { /* gone */ } }
    for (const d of daemons) {
      if (d.pid > 1) { try { process.kill(d.pid, 'SIGTERM') } catch { /* gone */ } }
      try { d.proc.kill('SIGTERM') } catch { /* gone */ }
    }
    for (const c of wss?.clients ?? []) c.terminate()
    await new Promise<void>((r) => (wss ? wss.close(() => r()) : r()))
    await sleep(500)
    if (base && !process.env.KEEP_LEADER_TWINS) fs.rmSync(base, { recursive: true, force: true })
  }, 60_000)

  it('runs one twin of each kind', () => {
    expect(devbox.twin).toBe('source')
    if (BUN) expect(oldbox.twin).toBe('standalone')
  })

  it('while the Mac is up, the companion leads nothing and a call between hosts goes to the Mac', async () => {
    await sleep(2 * T)
    expect(leader.isLeading()).toBe(false)
    const r = await gatewayCall(devbox, A, 'task_send', { to: TASK_B, text: 'status?' })
    expect(r).toMatchObject({ ok: true, result: { answeredBy: 'primary' } })
    expect(inboxOf(oldbox, B).filter((m) => m.includes('status?'))).toHaveLength(0)
  }, 60_000)

  it('a link-only cut (heartbeat lost, hosts still hear the Mac) takes nothing over', async () => {
    primary!.kill('SIGUSR1') // heartbeat off; the trusted sockets keep answering
    await sleep(3 * T)
    expect(leader.isLeading()).toBe(false)
    expect(leader.status().lastDecision).toMatch(/still hears the primary/)
    primary!.kill('SIGUSR1') // heartbeat on
    await sleep(1_000)
  }, 60_000)

  it('the Mac sleeps (SIGSTOP): after the window the companion leads both hosts', async () => {
    primary!.kill('SIGSTOP')
    const t0 = Date.now()
    await waitFor(() => leadingHosts().length === 2, 4 * T, 'the companion to lead both hosts')
    expect(leadingHosts()).toEqual(['devbox@2', 'oldbox@2'])
    // Not before the window: both views had to agree.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(T - 1_000)
  }, 60_000)

  it('a message from devbox reaches oldbox through the companion, with its reply request', async () => {
    const r = await gatewayCall(devbox, A, 'task_send', { to: TASK_B, text: 'Is the build green? \u4e2d' })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (!r.ok) return
    expect(r.result).toMatchObject({ viaLeader: true, targetSessionId: B, targetHost: 'oldbox' })
    requestId = String(r.result.requestId)
    await waitFor(() => inboxOf(oldbox, B).some((m) => m.includes(requestId)), 10_000, 'B receives the envelope')
    const envelope = inboxOf(oldbox, B).find((m) => m.includes(requestId))!
    expect(envelope).toContain('Is the build green? \u4e2d')
    expect(envelope).toContain('devbox')
    expect(envelope).toContain(`"in_reply_to":"${requestId}"`)
  }, 60_000)

  it('the reply from oldbox travels back through the companion into devbox', async () => {
    const r = await gatewayCall(oldbox, B, 'task_send', { in_reply_to: requestId, text: 'Green on main.' })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    await waitFor(() => inboxOf(devbox, A).some((m) => m.includes('Green on main.')), 10_000, 'A receives the reply')
    const reply = inboxOf(devbox, A).find((m) => m.includes('Green on main.'))!
    expect(reply).toContain('kind="reply"')
    expect(reply).toContain(requestId)
    const status = await gatewayCall(oldbox, B, 'request_get', { id: requestId })
    expect(status.ok && (status.result.request as { status: string }).status).toBe('replied')
  }, 60_000)

  it('the Board keeps working on the host, and a call outside every copy is answered by the companion', async () => {
    const edit = await gatewayCall(oldbox, B, 'board_edit', { edits: [{ old: 'Build: red', new: 'Build: green' }], version: 1 })
    expect(edit).toMatchObject({ ok: true, result: { queued: true, version: 2 } })
    const far = await gatewayCall(devbox, A, 'note_read', { path: 'plans/release.md' })
    expect(far).toMatchObject({ ok: true, result: { name: 'note_read', viaLeader: true } })
  }, 60_000)

  it('while it leads, the companion changes a live session\'s model or effort on its host, and the host keeps it for the Mac', async () => {
    const model = await request('oldbox', 'leader.settings', { walnutId: WALNUT, epoch: 2, sid: B, model: 'sonnet[1m]' })
    expect(model, JSON.stringify(model)).toMatchObject({ ok: true, appliedLive: true })
    expect(ctrlOf(oldbox, B).map((c) => c.request)).toEqual([{ subtype: 'apply_flag_settings', settings: { model: 'sonnet[1m]' } }])
    const effort = await request('devbox', 'leader.settings', { walnutId: WALNUT, epoch: 2, sid: A, effort: 'low' })
    expect(effort, JSON.stringify(effort)).toMatchObject({ ok: true, appliedLive: true })
    expect(ctrlOf(devbox, A).map((c) => c.request)).toEqual([{ subtype: 'apply_flag_settings', settings: { effortLevel: 'low' } }])
    // A value the CLI would ACK and ignore never reaches it; nor does another host's session.
    const bad = await request('oldbox', 'leader.settings', { walnutId: WALNUT, epoch: 2, sid: B, effort: 'turbo' })
    expect(bad).toMatchObject({ ok: false })
    expect(String(bad.error)).toMatch(/effort must be one of/)
    const elsewhere = await request('oldbox', 'leader.settings', { walnutId: WALNUT, epoch: 2, sid: A, model: 'opus' })
    expect(elsewhere).toMatchObject({ ok: false })
    expect(String(elsewhere.error)).toMatch(/not a session of this Walnut/)
    expect(ctrlOf(oldbox, B)).toHaveLength(1)
  }, 60_000)

  it('the Mac wakes on the same sockets: the daemons tell it, it drains, takes the lead back, and the companion lets go', async () => {
    // Still inside the keepalive: the sleeping primary's sockets were never closed.
    expect(daemonLog(devbox, /client silent, closing it/)).toHaveLength(0)
    expect(daemonLog(oldbox, /client silent, closing it/)).toHaveLength(0)
    primary!.kill('SIGCONT')
    await waitFor(() => primaryEvents().filter((e) => e.ev === 'claimed').length >= 2, 15_000, 'the primary to take both hosts back')
    const claims = primaryEvents().filter((e) => e.ev === 'claimed')
    expect(claims.map((c) => [c.host, c.epoch, c.why]).sort()).toEqual([['devbox', 3, 'leader-lost'], ['oldbox', 3, 'leader-lost']])
    // It drained before it claimed: the journal of each host, in order.
    const drained = (host: string) => primaryEvents().filter((e) => e.ev === 'drained' && e.host === host).flatMap((e) => e.records as OfflineRecord[])
    expect(drained('oldbox').map((r) => (r.kind === 'op' ? `op:${r.op}` : r.kind))).toEqual(['row', 'delivery', 'row', 'op:board_edit', 'settings'])
    expect(drained('oldbox')[0]).toMatchObject({ row: { id: requestId, fromSessionId: A, toSessionId: B, fromHost: 'devbox', status: 'pending' } })
    expect(drained('oldbox')[2]).toMatchObject({ row: { id: requestId, status: 'replied' } })
    expect(drained('oldbox')[4]).toMatchObject({ kind: 'settings', sid: B, cliModel: 'sonnet[1m]' })
    expect(drained('devbox')).toEqual([
      expect.objectContaining({ kind: 'delivery', fromSessionId: B, toSessionId: A, requestId, reply: true }),
      expect.objectContaining({ kind: 'settings', sid: A, effort: 'low' }),
    ])
    await waitFor(() => !leader.isLeading(), 10_000, 'the companion to let go')
  }, 60_000)

  it('the old lead is fenced off: a delivery at the old epoch is refused by the host', async () => {
    const before = inboxOf(devbox, A).length
    const r = await request('devbox', 'leader.deliver', { walnutId: WALNUT, epoch: 2, delivery: { kind: 'text', toSid: A, text: 'from an old leader' } })
    expect(r).toMatchObject({ ok: false })
    expect(['stale_epoch', 'not_leader']).toContain(r.errorKind)
    expect(inboxOf(devbox, A)).toHaveLength(before)
    const settings = await request('devbox', 'leader.settings', { walnutId: WALNUT, epoch: 2, sid: A, effort: 'high' })
    expect(settings).toMatchObject({ ok: false })
    expect(['stale_epoch', 'not_leader']).toContain(settings.errorKind)
    expect(ctrlOf(devbox, A)).toHaveLength(1)
    // And a call between hosts goes to the Mac again.
    const back = await gatewayCall(devbox, A, 'task_send', { to: TASK_B, text: 'status?' })
    expect(back).toMatchObject({ ok: true, result: { answeredBy: 'primary' } })
  }, 60_000)

  it('a long sleep: the daemons close the silent sockets, the companion leads at the next epoch, and the Mac takes it back on reconnect', async () => {
    primary!.kill('SIGSTOP')
    await waitFor(() => leadingHosts().join() === 'devbox@4,oldbox@4', 4 * T, 'the companion to lead again')
    await waitFor(() => daemonLog(devbox, /client silent, closing it/).length > 0 && daemonLog(oldbox, /client silent, closing it/).length > 0, 10 * BEAT, 'the keepalive to close the silent sockets')
    const claimedBefore = primaryEvents().filter((e) => e.ev === 'claimed').length
    primary!.kill('SIGCONT')
    await waitFor(() => primaryEvents().filter((e) => e.ev === 'claimed').length >= claimedBefore + 2, 20_000, 'the primary to take both hosts back')
    const claims = primaryEvents().filter((e) => e.ev === 'claimed').slice(claimedBefore)
    expect(claims.map((c) => [c.host, c.epoch]).sort()).toEqual([['devbox', 5], ['oldbox', 5]])
    await waitFor(() => !leader.isLeading(), 10_000, 'the companion to let go')
  }, 120_000)
})
