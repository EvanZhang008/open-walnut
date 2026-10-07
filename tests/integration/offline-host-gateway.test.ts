/**
 * Offline host, end to end on a REAL daemon (both twins): two sessions on one
 * host keep talking while their Walnut server is away, and the server takes the
 * record back when it reconnects (docs/plan/daemon-first-hosts.md).
 *
 * What's real:
 *   - the daemon process: the source twin (DAEMON_SOURCE under node) and the
 *     standalone twin (daemon-standalone.ts under bun, when bun is installed),
 *     each in its own temp dir with its own spawn journal;
 *   - the agent-gateway unix socket, NDJSON, exactly as the `walnut` CLI speaks it;
 *   - the sessions: a mock CLI (node) reading its FIFO and writing stream-json,
 *     so delivery, the turn-opening marker and the result line are the real path.
 * What's faked: the Walnut server is a bare WS client that pushes host.slice,
 * disconnects, and later drains.
 *
 * Hygiene: every daemon is killed in afterAll by the pid IT wrote into its own
 * temp dir; nothing touches the production daemon dir or journal.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import type { GatewayResponse } from '../../src/providers/gateway-core.js'
import type { HostSlice, OfflineRecord } from '../../src/providers/offline-host-core.js'
import { buildPeerWrapper } from '../../src/core/peers/peer-wrapper.js'

const ROOT = path.resolve(__dirname, '../..')
const HOME = '/fixture/walnut-home'
const OTHER_HOME = '/fixture/test-server-home'
const A = 'aaaaaaaa-1111-4111-8111-111111111111'
const B = 'bbbbbbbb-2222-4222-8222-222222222222'
const TASK_A = 'mtaskaaa-0001'
const TASK_B = 'mtaskbbb-0002'

const bunPath = (() => {
  // BUN_INSTALL first: the test setup swaps HOME for a fake one and points this at the real bun.
  for (const p of [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']) if (p && fs.existsSync(p)) return p
  try { return execFileSync('which', ['bun'], { encoding: 'utf8' }).trim() || null } catch { return null }
})()

/** The mock CLI: stream-json on stdout, one result line per message that asks for one. */
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
    if (msg.type !== 'user') continue
    const content = msg.message && msg.message.content
    fs.appendFileSync(inbox, JSON.stringify({ content }) + '\\n')
    if (typeof content === 'string' && content.includes('ASK-PERMISSION')) {
      out({ type: 'system', subtype: 'session_state_changed', state: 'running' })
      out({ type: 'control_request', request_id: 'perm-' + sid.slice(0, 8), request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } })
    }
    if (typeof content === 'string' && content.includes('FINISH-TURN')) {
      out({ type: 'system', subtype: 'session_state_changed', state: 'running' })
      out({ type: 'result', subtype: 'success', is_error: false, result: 'Built the page; tests pass.', session_id: sid })
      out({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    }
  }
})
setInterval(() => {}, 1 << 30)
`

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `walnut-offline-${twin}-`))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALNUT_DAEMON_DIR: dir,
    WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_GATEWAY_TIMEOUT_MS: '3000',
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  let proc: ChildProcess
  if (twin === 'source') {
    const script = path.join(dir, 'daemon.cjs')
    fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
    proc = spawn(process.execPath, [script, '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  } else {
    proc = spawn(bunPath!, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'], cwd: ROOT })
  }
  if (process.env.DEBUG_DAEMON) proc.stderr?.on('data', (b) => process.stderr.write(`[${twin}] ` + b.toString()))
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
  // Only the pid the isolated daemon wrote into its own temp dir.
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
    const on = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>
        if (msg.id === id) { clearTimeout(t); ws.off('message', on); resolve(msg) }
      } catch { /* not json */ }
    }
    ws.on('message', on)
    ws.send(JSON.stringify({ id, ...body }))
  })
}

function data(reply: Record<string, unknown>): Record<string, unknown> {
  // Daemon replies are {id, ok, data?} or flattened; accept both.
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

function inboxOf(dir: string, sid: string): Array<{ content: string }> {
  try {
    return fs.readFileSync(path.join(dir, `${sid}.inbox.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch { return [] }
}

function slice(overrides: Partial<HostSlice> = {}): HostSlice {
  return {
    v: 1, home: HOME, hash: 'h1', asOf: Date.now(), host: 'devbox',
    sessions: [{ sid: A, taskId: TASK_A, title: 'Parent work' }, { sid: B, taskId: TASK_B, title: 'Child: build the page' }],
    tasks: [
      { id: TASK_A, title: 'Parent work', phase: 'IN_PROGRESS', project: 'Acme', updated_at: '2026-09-28T09:00:00.000Z' },
      { id: TASK_B, title: 'Child: build the page', phase: 'IN_PROGRESS', project: 'Acme', parent_task_id: TASK_A },
    ],
    requests: [],
    ...overrides,
  }
}

const twins: Array<'source' | 'standalone'> = bunPath ? ['source', 'standalone'] : ['source']

describe.each(twins)('offline host on the real %s daemon', (twin) => {
  let d: Daemon
  let mock: string

  beforeAll(async () => {
    d = await spawnDaemon(twin)
    mock = path.join(d.dir, 'mock-cli.cjs')
    fs.writeFileSync(mock, MOCK_CLI)
    const ws = await connectWs(d.port)
    for (const sid of [A, B]) {
      const started = await cmd(ws, {
        cmd: 'start', sid, cwd: d.dir, message: 'init',
        args: [process.execPath, mock, sid, path.join(d.dir, `${sid}.inbox.jsonl`)],
        origin: { home: HOME, task: sid === A ? TASK_A : TASK_B },
      })
      expect(started.ok, JSON.stringify(started)).toBe(true)
    }
    // Both CLIs booted and idle (their startup turn is on disk), as a sibling
    // waiting for work is. A message to a CLI still in its first turn is the
    // mid-turn case, covered in offline-host-core.test.ts.
    for (const sid of [A, B]) {
      await waitFor(() => {
        try { return fs.readFileSync(path.join(d.dir, 'streams', `${sid}.jsonl`), 'utf8').includes('"state":"idle"') } catch { return false }
      }, 20_000, `${sid} idle`)
    }
    // The server pushes its copy, then goes away (the Mac falls asleep).
    const pushed = await cmd(ws, { cmd: 'host.slice', slice: slice() })
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true)
    ws.close()
    await new Promise((r) => setTimeout(r, 300))
  }, 60_000)

  afterAll(() => { if (d) stopDaemon(d) })

  it('answers task_get from the copy instead of hub_unreachable', async () => {
    const r = await gateway(d.sock, A, 'task_get', { id: TASK_B })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (!r.ok) return
    expect(r.result).toMatchObject({ offline: true, task: { id: TASK_B, title: 'Child: build the page', execution: { state: 'running' } } })
  })

  it('refuses an op that needs the server, naming what works offline', async () => {
    const r = await gateway(d.sock, A, 'note_search', { q: 'x' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('hub_unreachable')
    expect(r.error.message).toContain('task_send')
  })

  it('delivers a message to the sibling, which reads the same envelope the server builds', async () => {
    const text = 'Build the page and tell me. FINISH-TURN é中'
    const r = await gateway(d.sock, A, 'task_send', { to: TASK_B, text })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (!r.ok) return
    const requestId = String(r.result.requestId)
    await waitFor(() => inboxOf(d.dir, B).some((m) => m.content.includes(requestId)), 10_000, 'B receives the envelope')
    const got = inboxOf(d.dir, B).find((m) => m.content.includes(requestId))!.content
    expect(got.startsWith(buildPeerWrapper(text, {
      title: 'Parent work', shortId: A.slice(0, 8), sessionId: A, taskId: TASK_A, host: 'devbox', requestId,
    }))).toBe(true)
    expect(got).toContain(`Reply when done: walnut tools call task_send '{"in_reply_to":"${requestId}"`)
    // The stream file shows the message as a turn start (the UI reads it back).
    const stream = fs.readFileSync(path.join(d.dir, 'streams', `${B}.jsonl`), 'utf8')
    expect(stream).toContain('"subtype":"walnut-injected"')
  })

  it('tells the asker when the sibling finishes without replying, quoting its final text', async () => {
    await waitFor(() => inboxOf(d.dir, A).some((m) => m.content.includes('kind="notification"')), 15_000, 'A receives the notice')
    const notice = inboxOf(d.dir, A).find((m) => m.content.includes('kind="notification"'))!.content
    expect(notice).toContain('outcome="completed"')
    expect(notice).toContain('Built the page; tests pass.')
    expect(notice).toContain(`about-task="${TASK_B}"`)
  })

  it('routes an explicit reply back to the asker', async () => {
    const sent = await gateway(d.sock, A, 'task_send', { to: TASK_B, text: 'One more question (no finish)' })
    expect(sent.ok).toBe(true)
    if (!sent.ok) return
    const requestId = String(sent.result.requestId)
    const reply = await gateway(d.sock, B, 'task_send', { in_reply_to: requestId, text: 'The answer is 42.' })
    expect(reply.ok, JSON.stringify(reply)).toBe(true)
    await waitFor(() => inboxOf(d.dir, A).some((m) => m.content.includes('kind="reply"') && m.content.includes('The answer is 42.')), 10_000, 'A receives the reply')
    const status = await gateway(d.sock, A, 'request_get', { id: requestId })
    expect(status.ok && (status.result.request as { status: string }).status).toBe('replied')
  })

  it('the installed walnut CLI (a Mac session) reaches the same answers when the server is down', async () => {
    const saved = { url: process.env.OPEN_WALNUT_API_URL, sock: process.env.WALNUT_AGENT_SOCKET, sid: process.env.WALNUT_SESSION_ID }
    const dead = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) })
    })
    process.env.OPEN_WALNUT_API_URL = `http://127.0.0.1:${dead}`
    process.env.WALNUT_AGENT_SOCKET = d.sock
    process.env.WALNUT_SESSION_ID = A
    let out = ''
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]) => {
      out += String(chunk)
      ;(rest.find((r) => typeof r === 'function') as (() => void) | undefined)?.()
      return true
    }) as typeof process.stdout.write)
    const errs = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write)
    try {
      const { runTools } = await import('../../src/commands/tools.js')
      process.exitCode = undefined
      await runTools(['call', 'task_get', JSON.stringify({ id: TASK_B })], {})
      expect(process.exitCode ?? 0).toBe(0)
    } finally {
      write.mockRestore(); errs.mockRestore()
      process.exitCode = undefined
      for (const [k, v] of [['OPEN_WALNUT_API_URL', saved.url], ['WALNUT_AGENT_SOCKET', saved.sock], ['WALNUT_SESSION_ID', saved.sid]] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
    expect(JSON.parse(out)).toMatchObject({ offline: true, task: { id: TASK_B } })
  })

  it('queues task_complete and shows it in reads', async () => {
    const r = await gateway(d.sock, B, 'task_complete', { id: TASK_B })
    expect(r.ok && r.result.queued).toBe(true)
    const got = await gateway(d.sock, A, 'task_get', { id: TASK_B })
    expect(got.ok && (got.result.task as { phase: string }).phase).toBe('COMPLETE')
  })

  it('persists the journal: the server drains it on reconnect, and only then gets relays', async () => {
    const ws = await connectWs(d.port)
    const hub: string[] = []
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>
      if (msg.ev === 'gateway-request') {
        const ev = (msg.data ?? msg) as { relayId: number; payload: { name?: string } }
        hub.push(String(ev.payload?.name))
        ws.send(JSON.stringify({ id: nextId++, cmd: 'gateway-result', relayId: ev.relayId, result: { fromHub: true } }))
      }
    })
    // Tagged but not drained yet: the daemon still answers itself.
    await cmd(ws, { cmd: 'host.slice', slice: slice({ hash: 'h2' }) })
    const during = await gateway(d.sock, A, 'task_get', { id: TASK_A })
    expect(during.ok && during.result.offline).toBe(true)
    expect(hub).toEqual([])

    const drained = data(await cmd(ws, { cmd: 'offline.drain', home: HOME }))
    const records = drained.records as OfflineRecord[]
    const kinds = records.map((r) => r.kind)
    expect(kinds).toContain('row')
    expect(kinds).toContain('delivery')
    expect(kinds).toContain('op')
    const rows = records.filter((r): r is Extract<OfflineRecord, { kind: 'row' }> => r.kind === 'row').map((r) => r.row)
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(['pending', 'notified', 'replied']))
    const acked = data(await cmd(ws, { cmd: 'offline.ack', home: HOME, upTo: Math.max(...records.map((r) => r.seq)) }))
    expect(acked.remaining).toBe(0)

    const after = await gateway(d.sock, A, 'task_get', { id: TASK_A })
    expect(after.ok && after.result.fromHub).toBe(true)
    expect(hub).toEqual(['task_get'])
    ws.close()
  })

  it('never relays a Walnut\'s call to another Walnut\'s server', async () => {
    const other = await connectWs(d.port)
    const seen: unknown[] = []
    other.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.ev === 'gateway-request') seen.push(m) })
    await cmd(other, { cmd: 'host.slice', slice: slice({ home: OTHER_HOME, hash: 'o1', sessions: [], tasks: [] }) })
    const r = await gateway(d.sock, A, 'task_get', { id: TASK_A })
    expect(r.ok && r.result.offline).toBe(true)
    expect(seen).toEqual([])
    other.close()
  })
})

/**
 * The same host with its server CONNECTED: a message between two sessions here
 * is still the host's to deliver (offline-host-core.ts handleLocal); the server
 * is nudged and drains it, and everything else goes to the server as before.
 */
describe.each(twins)('same-host messages while the server answers, on the real %s daemon', (twin) => {
  const C = 'cccccccc-3333-4333-8333-333333333333'
  const TASK_C = 'mtaskccc-0003'
  let d: Daemon
  let server: WebSocket
  const relayed: Array<{ name: string; args: Record<string, unknown> }> = []
  let nudges = 0
  const live = () => slice({
    sessions: [...slice().sessions, { sid: C, taskId: TASK_C, title: 'Reviewer' }],
    tasks: [...slice().tasks, { id: TASK_C, title: 'Reviewer', phase: 'IN_PROGRESS', project: 'Acme' }],
  })

  beforeAll(async () => {
    d = await spawnDaemon(twin)
    const mock = path.join(d.dir, 'mock-cli.cjs')
    fs.writeFileSync(mock, MOCK_CLI)
    server = await connectWs(d.port)
    server.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>
      if (msg.ev === 'offline-journal') nudges++
      if (msg.ev === 'gateway-request') {
        const ev = (msg.data ?? msg) as { relayId: number; payload: { name?: string; args?: Record<string, unknown> } }
        relayed.push({ name: String(ev.payload?.name), args: ev.payload?.args ?? {} })
        server.send(JSON.stringify({ id: nextId++, cmd: 'gateway-result', relayId: ev.relayId, result: { fromHub: true } }))
      }
    })
    for (const [sid, task] of [[A, TASK_A], [B, TASK_B], [C, TASK_C]] as const) {
      const started = await cmd(server, {
        cmd: 'start', sid, cwd: d.dir, message: 'init',
        args: [process.execPath, mock, sid, path.join(d.dir, `${sid}.inbox.jsonl`)],
        origin: { home: HOME, task },
      })
      expect(started.ok, JSON.stringify(started)).toBe(true)
    }
    for (const sid of [A, B, C]) {
      await waitFor(() => {
        try { return fs.readFileSync(path.join(d.dir, 'streams', `${sid}.jsonl`), 'utf8').includes('"state":"idle"') } catch { return false }
      }, 20_000, `${sid} idle`)
    }
    const pushed = await cmd(server, { cmd: 'host.slice', slice: live() })
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true)
  }, 60_000)

  afterAll(() => {
    try { server?.close() } catch { /* closed */ }
    if (d) stopDaemon(d)
  })

  let firstAsk = ''
  let second = ''

  const finishedTurns = (sid: string) => {
    try { return fs.readFileSync(path.join(d.dir, 'streams', `${sid}.jsonl`), 'utf8').split('Built the page; tests pass.').length - 1 } catch { return 0 }
  }

  it('a message to a sibling is delivered by the host, never relayed, and the server is nudged', async () => {
    const text = 'Check the page layout. FINISH-TURN'
    const r = await gateway(d.sock, A, 'task_send', { to: TASK_B, text, title: 'Layout check' })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (!r.ok) return
    expect(r.result).toMatchObject({ via: 'host', targetTaskId: TASK_B, targetSessionId: B })
    expect(r.result.offline).toBeUndefined()
    firstAsk = String(r.result.requestId)
    await waitFor(() => inboxOf(d.dir, B).some((m) => m.content.includes(firstAsk)), 10_000, 'B receives the envelope')
    const got = inboxOf(d.dir, B).find((m) => m.content.includes(firstAsk))!.content
    expect(got.startsWith(buildPeerWrapper(text, {
      title: 'Parent work', shortId: A.slice(0, 8), sessionId: A, taskId: TASK_A, host: 'devbox', requestId: firstAsk,
    }, { title: 'Layout check' }))).toBe(true)
    expect(relayed.filter((x) => x.name === 'task_send')).toEqual([])
    await waitFor(() => nudges > 0, 5_000, 'the offline-journal nudge')
    // B's turn ends without an answer while the server answers this host and has
    // not taken the request: the server says so, never this host.
    await waitFor(() => finishedTurns(B) === 1, 10_000, 'B finishes its turn')
    await new Promise((r) => setTimeout(r, 1_000))
    expect(inboxOf(d.dir, A).some((m) => m.content.includes('kind="notification"'))).toBe(false)
  })

  it('every other call still goes to the server while that journal waits for it', async () => {
    const r = await gateway(d.sock, A, 'task_get', { id: TASK_B })
    expect(r.ok && r.result.fromHub).toBe(true)
    expect(relayed.map((x) => x.name)).toEqual(['task_get'])
  })

  it('the reply comes back through the host as well', async () => {
    const r = await gateway(d.sock, B, 'task_send', { in_reply_to: firstAsk, text: 'Layout is fine.' })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.ok && r.result).toMatchObject({ via: 'host', repliedTo: firstAsk, targetSessionId: A })
    await waitFor(() => inboxOf(d.dir, A).some((m) => m.content.includes('kind="reply"') && m.content.includes('Layout is fine.')), 10_000, 'A receives the reply')
    expect(relayed.filter((x) => x.name === 'task_send')).toEqual([])
  })

  it('what the host cannot be sure of goes to the server, carrying the host\'s message id', async () => {
    const r = await gateway(d.sock, A, 'task_send', { to: 'mtaskbbb', text: 'By a prefix' })
    expect(r.ok && r.result.fromHub).toBe(true)
    const sent = relayed.filter((x) => x.name === 'task_send')
    expect(sent).toHaveLength(1)
    expect(sent[0].args).toMatchObject({ to: 'mtaskbbb', text: 'By a prefix', messageId: expect.stringMatching(/^qm-host-[a-f0-9]{16}$/) })
    expect(inboxOf(d.dir, B).some((m) => m.content.includes('By a prefix'))).toBe(false)
  })

  it('a session waiting on a permission prompt is the server\'s to message (it parks the text)', async () => {
    const first = await gateway(d.sock, A, 'task_send', { to: TASK_C, text: 'Please run it. ASK-PERMISSION', expect_reply: false })
    expect(first.ok && first.result.via).toBe('host')
    await waitFor(() => {
      try { return fs.readFileSync(path.join(d.dir, 'streams', `${C}.jsonl`), 'utf8').includes('"can_use_tool"') } catch { return false }
    }, 10_000, 'C asks for a permission')
    await new Promise((r) => setTimeout(r, 300))
    const second = await gateway(d.sock, A, 'task_send', { to: TASK_C, text: 'While you wait' })
    expect(second.ok && second.result.fromHub).toBe(true)
    expect(inboxOf(d.dir, C).some((m) => m.content.includes('While you wait'))).toBe(false)
  })

  it('a turn that ends unanswered while the server answers is the server\'s to report, drained or not', async () => {
    const before = finishedTurns(B)
    const asked = await gateway(d.sock, A, 'task_send', { to: TASK_B, text: 'A second question. FINISH-TURN' })
    expect(asked.ok && asked.result.via).toBe('host')
    second = String(asked.ok && asked.result.requestId)
    await waitFor(() => finishedTurns(B) > before, 10_000, 'B finishes its turn')
    await new Promise((r) => setTimeout(r, 1_000))
    expect(inboxOf(d.dir, A).some((m) => m.content.includes('kind="notification"'))).toBe(false)
  })

  it('the server drains it all as online records, still pending for it to report', async () => {
    const drained = data(await cmd(server, { cmd: 'offline.drain', home: HOME }))
    const records = drained.records as OfflineRecord[]
    expect(records.length).toBeGreaterThan(0)
    expect(records.every((r) => r.online === true)).toBe(true)
    const rows = records.filter((r): r is Extract<OfflineRecord, { kind: 'row' }> => r.kind === 'row').map((r) => [r.row.id, r.row.status])
    expect(rows).toEqual([[firstAsk, 'pending'], [firstAsk, 'replied'], [second, 'pending']])
    const acked = data(await cmd(server, { cmd: 'offline.ack', home: HOME, upTo: Math.max(...records.map((r) => r.seq)) }))
    expect(acked.remaining).toBe(0)
  })

  it('once the server has gone, a row it already took is still never reported from here', async () => {
    server.close()
    await new Promise((r) => setTimeout(r, 300))
    // Offline now: a message is still delivered, and B's next turn end says
    // nothing about the request the server took.
    const before = finishedTurns(B)
    const finish = await gateway(d.sock, A, 'task_send', { to: TASK_B, text: 'FINISH-TURN now', expect_reply: false })
    expect(finish.ok && finish.result.offline).toBe(true)
    await waitFor(() => finishedTurns(B) > before, 10_000, 'B finishes another turn')
    await new Promise((r) => setTimeout(r, 1_000))
    expect(inboxOf(d.dir, A).some((m) => m.content.includes('kind="notification"') && m.content.includes(second))).toBe(false)
    server = await connectWs(d.port)
    await cmd(server, { cmd: 'host.slice', slice: live() })
    // The offline delivery goes to the server first, then calls are relayed again.
    const drained = data(await cmd(server, { cmd: 'offline.drain', home: HOME }))
    const records = drained.records as OfflineRecord[]
    expect(records.map((r) => `${r.kind}:${r.online === true}`)).toEqual(['delivery:false'])
    await cmd(server, { cmd: 'offline.ack', home: HOME, upTo: Math.max(...records.map((r) => r.seq)) })
  })

  it('the Mac\'s installed walnut CLI sends through the daemon too, never over HTTP', async () => {
    const hits: string[] = []
    const http = await import('node:http')
    const api = http.createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.writeHead(500).end() })
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', () => resolve()))
    const saved = { url: process.env.OPEN_WALNUT_API_URL, sock: process.env.WALNUT_AGENT_SOCKET, sid: process.env.WALNUT_SESSION_ID }
    process.env.OPEN_WALNUT_API_URL = `http://127.0.0.1:${(api.address() as net.AddressInfo).port}`
    process.env.WALNUT_AGENT_SOCKET = d.sock
    process.env.WALNUT_SESSION_ID = A
    let out = ''
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]) => {
      out += String(chunk)
      ;(rest.find((r) => typeof r === 'function') as (() => void) | undefined)?.()
      return true
    }) as typeof process.stdout.write)
    // tools.ts prints with console.log, which vitest routes around process.stdout.
    const logs = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out += a.map(String).join(' ') + '\n' })
    let errOut = ''
    const errs = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => { errOut += String(chunk); return true }) as typeof process.stderr.write)
    const errLogs = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errOut += a.map(String).join(' ') + '\n' })
    try {
      const { runTools } = await import('../../src/commands/tools.js')
      process.exitCode = undefined
      await runTools(['call', 'task_send', JSON.stringify({ to: TASK_B, text: 'From the installed CLI', expect_reply: false })], {})
      expect(process.exitCode ?? 0, errOut).toBe(0)
    } finally {
      write.mockRestore(); errs.mockRestore(); logs.mockRestore(); errLogs.mockRestore()
      process.exitCode = undefined
      for (const [k, v] of [['OPEN_WALNUT_API_URL', saved.url], ['WALNUT_AGENT_SOCKET', saved.sock], ['WALNUT_SESSION_ID', saved.sid]] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      await new Promise<void>((resolve) => api.close(() => resolve()))
    }
    expect(out, `stderr: ${errOut}; http: ${hits.join(', ')}`).not.toBe('')
    expect(JSON.parse(out)).toMatchObject({ via: 'host', targetTaskId: TASK_B })
    await waitFor(() => inboxOf(d.dir, B).some((m) => m.content.includes('From the installed CLI')), 10_000, 'B receives the CLI message')
    expect(hits).toEqual([])
  })
})
