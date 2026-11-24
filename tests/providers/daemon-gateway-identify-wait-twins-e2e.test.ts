/**
 * A session's Walnut call made while the server is starting waits for it, on the real
 * session daemon (daemon-standalone.ts under bun, when bun is installed).
 *
 * 2026-11-23 00:07:04: a session's task_create through `walnut mcp-server` failed with
 * hub_unreachable 13 s after a deploy restarted the Walnut server. The daemon logged "no server
 * of this Walnut connected ... unidentified: 1": the new server's socket was connected but had
 * not said whose Walnut it is yet. The MCP server sent no wait, so the daemon answered at once;
 * the same call through `walnut tools call` names a wait and would have gone through.
 *
 * Here: the MCP handler and its real gateway line (wn-cli.ts mcpGatewayRequest, gateway-request.ts)
 * against the real daemon, while the server's socket is between its hello and its bind; a line
 * that names no wait (an older MCP server or CLI) the same way for a moment (GATEWAY_IDENTIFY_WAIT_MS),
 * and with a socket that opened and has not said hello yet, whose relay then keeps the whole hub
 * timeout; a socket that never binds (the old answer, a moment later, never sent to it); no server
 * at all, and a line that chose not to wait (`waitMs: 0`), both the old answer at once; and a
 * caller that hangs up while it waits (never sent).
 *
 * MACHINE SAFETY: HOME, the daemon dir, the streams dir and the spawn journal are temp paths under
 * /tmp; the only processes signalled are the daemon and the stand-in CLIs this file started. This
 * process's own Walnut session env is dropped first, so no request can reach a real Walnut.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { GATEWAY_IDENTIFY_WAIT_MS } from '../../src/providers/gateway-core.js'
import { createWalnutMcpHandler } from '../../src/providers/walnut-mcp-stdio.js'
import { formatErrorLines, mcpGatewayRequest } from '../../src/providers/wn-cli.js'
import { guardedPath } from '../setup/exec-guard.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'
import { testBun } from '../helpers/bun-runtime.js'

// A run started inside a Walnut session would post its lines to that session's host call entry.
for (const k of ['WALNUT_CALL_SOCKET', 'WALNUT_CALL_TOKEN', 'WALNUT_AGENT_SOCKET', 'WALNUT_SESSION_ID', 'WALNUT_TEST_RUN']) delete process.env[k]

const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
let cliPath = ''

/** One relay attempt's time (the daemon's hub timeout); a relay after an identify wait keeps all of it. */
const HUB_MS = 11_000
/** How long a call that names no wait waits for an identifying socket, from its arrival. */
const IDENTIFY_WINDOW_MS = GATEWAY_IDENTIFY_WAIT_MS
const BEAT = 400
const HOME_A = '/home/alice/.open-walnut'

// The stand-in CLI: says init and stays (a session the daemon tracks).
const FAKE_CLI = `
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake' }) + '\\n')
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1000)
`

type Frame = Record<string, any>
interface Sock { name: string; ws: WebSocket; requests: Frame[]; pinger?: ReturnType<typeof setInterval> }

let root = ''
let daemonDir = ''
let proc: ChildProcess | null = null
const socks: Sock[] = []
const sids: string[] = []
let rpcId = 1

const gatewaySock = () => path.join(daemonDir, 'agent-gateway.sock')
const walnutIdOf = (home: string) => `w${crypto.createHash('sha1').update(home).digest('hex').slice(0, 12)}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(check: () => boolean, ms = 10_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await sleep(25)
  }
  return check()
}

function rpc(ws: WebSocket, cmd: Record<string, unknown>, timeoutMs = 20_000): Promise<Frame> {
  const id = rpcId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Frame
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); ws.off('message', onMessage); resolve(msg) }
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, ...cmd }))
  })
}

async function boot(): Promise<number> {
  root = fs.realpathSync(fs.mkdtempSync('/tmp/wgi-'))
  daemonDir = path.join(root, 'd')
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: guardedPath([], '/usr/bin:/bin'),
    HOME: path.join(root, 'home'),
    CLAUDE_CONFIG_DIR: undefined,
    WALNUT_DAEMON_DIR: daemonDir,
    WALNUT_STREAMS_DIR: path.join(root, 's'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'home', 'spawn-journal.jsonl'),
    WALNUT_GATEWAY_TIMEOUT_MS: String(HUB_MS),
    WALNUT_TRUSTED_CLIENT_BEAT_MS: String(BEAT),
  }
  proc = spawn(BUN!, [STANDALONE, '--start'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 60_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc!.on('error', (err) => { clearTimeout(timer); reject(err) })
    onDaemonEarlyExit(proc!, { daemonDir }, (err) => { clearTimeout(timer); reject(err) })
  })
  expect(await waitFor(() => fs.existsSync(gatewaySock()), 30_000)).toBe(true)
  return port
}

/**
 * A server socket that answers the daemon's pings. `hello`: what it says first (a run, said to
 * bind), or nothing yet; `home`: bound with leader.configure at once.
 */
async function open(port: number, name: string, hello: { run: string } | null, home?: string): Promise<Sock> {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}`)
    w.on('open', () => resolve(w))
    w.on('error', reject)
  })
  const s: Sock = { name, ws, requests: [] }
  ws.on('message', (data: Buffer) => {
    try { const m = JSON.parse(data.toString()) as Frame; if (m.ev === 'gateway-request') s.requests.push(m) } catch { /* not a frame */ }
  })
  s.pinger = setInterval(() => { try { ws.send(JSON.stringify({ id: rpcId++, cmd: 'ping' })) } catch { /* closed */ } }, Math.round(BEAT / 2))
  socks.push(s)
  if (hello) await sayHello(s, hello.run)
  if (home) await bind(s, home)
  return s
}
async function sayHello(s: Sock, run: string): Promise<void> {
  expect((await rpc(s.ws, { cmd: 'hello', run, binds: true })).ok).toBe(true)
}
async function bind(s: Sock, home: string): Promise<void> {
  const r = await rpc(s.ws, { cmd: 'leader.configure', home, walnutId: walnutIdOf(home), backup: false })
  expect(r.ok, JSON.stringify(r)).toBe(true)
}
async function cut(s: Sock): Promise<void> {
  clearInterval(s.pinger)
  s.pinger = undefined
  try { s.ws.terminate() } catch { /* closed */ }
  expect(await waitFor(() => s.ws.readyState === WebSocket.CLOSED)).toBe(true)
  // The daemon has seen it go.
  await sleep(150)
}

async function startSession(via: Sock, home: string): Promise<string> {
  const sid = crypto.randomUUID()
  const sh = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} "$@"`
  const r = await rpc(via.ws, {
    cmd: 'start', sid, cwd: root, message: '', resume: true, mode: 'default',
    origin: { home }, args: ['/bin/sh', '-c', sh, 'sh', '--resume', sid],
  })
  expect(r.ok, JSON.stringify(r)).toBe(true)
  sids.push(sid)
  return sid
}

/**
 * One gateway line naming the session, with a wait (a newer client), 0 (a client that chose not to
 * wait) or none (an older one). `hangUp()` closes the socket before an answer came (the answer is then null).
 */
function rawCallOpen(sid: string, waitMs?: number): { answer: Promise<{ resp: Frame | null; ms: number }>; hangUp: () => void } {
  const t0 = Date.now()
  let done: (resp: Frame | null) => void = () => {}
  const answer = new Promise<{ resp: Frame | null; ms: number }>((resolve) => {
    const sock = net.connect(gatewaySock())
    let buf = ''
    let over = false
    done = (resp) => { if (over) return; over = true; clearTimeout(timer); sock.destroy(); resolve({ resp, ms: Date.now() - t0 }) }
    const timer = setTimeout(() => done({ ok: false, error: { code: 'test_timeout' } }), 45_000)
    sock.on('connect', () => {
      sock.write(JSON.stringify({ v: 1, op: 'tools.call', sid, args: { name: 'task_create', args: { title: 'x' }, callId: `oc-${crypto.randomUUID()}` }, ...(waitMs !== undefined ? { waitMs } : {}) }) + '\n')
    })
    sock.on('data', (c) => {
      buf += c.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl !== -1) done(JSON.parse(buf.slice(0, nl)) as Frame)
    })
    sock.on('error', () => done({ ok: false, error: { code: 'socket_error' } }))
  })
  return { answer, hangUp: () => done(null) }
}
const rawCall = (sid: string, waitMs?: number) => rawCallOpen(sid, waitMs).answer

function daemonLogHas(text: string): boolean {
  if (!fs.existsSync(daemonDir)) return false
  return fs.readdirSync(daemonDir)
    .filter((f) => /^daemon-.*\.log$/.test(f) && !f.startsWith('daemon-exit-'))
    .some((f) => { try { return fs.readFileSync(path.join(daemonDir, f), 'utf8').includes(text) } catch { return false } })
}

/** A session of Walnut A whose server's socket just went: the state a restart leaves. */
async function sessionWithServerGone(port: number): Promise<string> {
  const main = await open(port, 'mainA', { run: 'run-a' }, HOME_A)
  const sid = await startSession(main, HOME_A)
  await cut(main)
  return sid
}

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-identify-wait-src-'))
  cliPath = path.join(dir, 'fake-claude.cjs')
  fs.writeFileSync(cliPath, FAKE_CLI)
})

afterEach(async () => {
  const live = socks.find((s) => s.ws.readyState === WebSocket.OPEN)
  for (const sid of sids.splice(0)) if (live) await rpc(live.ws, { cmd: 'stop', sid }, 10_000).catch(() => undefined)
  for (const s of socks.splice(0)) { clearInterval(s.pinger); try { s.ws.terminate() } catch { /* closed */ } }
  if (proc && proc.exitCode === null) {
    proc.kill('SIGKILL')
    await new Promise<void>((resolve) => { const t = setTimeout(resolve, 3000); proc!.once('exit', () => { clearTimeout(t); resolve() }) })
  }
  proc = null
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

describe.skipIf(!BUN)('a call while the server is starting waits for it, standalone daemon (bun)', () => {
  it('an MCP call made while the server socket is unidentified succeeds once it identifies', async () => {
    const port = await boot()
    const sid = await sessionWithServerGone(port)
    // The restarted server's socket: hello said, leader.configure not yet.
    const next = await open(port, 'mainA-2', { run: 'run-a-2' })
    const progress: Array<Record<string, unknown>> = []
    const handle = createWalnutMcpHandler({
      request: mcpGatewayRequest(gatewaySock(), sid, undefined, { WALNUT_MCP_WAIT_MS: '20000' }),
      formatError: formatErrorLines,
      callWaitMs: 20_000,
      waitNoticeMs: 500,
      progress: (p) => { progress.push(p) },
    })
    const t0 = Date.now()
    const reply = handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'task_create', arguments: { title: 'from mcp' }, _meta: { progressToken: 'p-7' } } })
    // Past the moment a call that names no wait would be given (IDENTIFY_WINDOW_MS): only the
    // MCP server's own wait keeps this call alive now.
    await sleep(IDENTIFY_WINDOW_MS + 1_500)
    // Nothing went to a socket that has not said whose it is.
    expect(next.requests).toEqual([])
    // The client was told the call waits, out of band.
    expect(progress).toEqual([{ progressToken: 'p-7', progress: 0, message: 'Walnut: no answer yet; this call waits up to 20s' }])
    await bind(next, HOME_A)
    expect(await waitFor(() => next.requests.length === 1)).toBe(true)
    const relay = next.requests[0]!
    expect(relay.callerSid).toBe(sid)
    expect(relay.payload?.name).toBe('task_create')
    expect(relay.payload?.args).toEqual({ title: 'from mcp' })
    expect((await rpc(next.ws, { cmd: 'gateway-result', relayId: relay.relayId, result: { task: { id: 't-1', title: 'from mcp' } } })).ok).toBe(true)
    const r = (await reply) as { id: number; result: { isError?: boolean; content: Array<{ text: string }> } }
    expect(r.id).toBe(7)
    expect(r.result.isError).toBeUndefined()
    expect(JSON.parse(r.result.content[0]!.text)).toEqual({ task: { id: 't-1', title: 'from mcp' } })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(IDENTIFY_WINDOW_MS + 1_500)
    // Sent once.
    await sleep(300)
    expect(next.requests).toHaveLength(1)
  }, 90_000)

  it('a call that names no wait (an older client) waits a moment for an identifying socket, and only for one', async () => {
    const port = await boot()
    const sid = await sessionWithServerGone(port)

    // No server socket at all: the old answer, at once.
    const none = await rawCall(sid)
    expect(none.resp).toMatchObject({ ok: false, error: { code: 'hub_unreachable' } })
    expect(none.ms).toBeLessThan(1_500)

    // Between its hello and its bind: a line that chose not to wait (waitMs 0, the Mac's own CLI,
    // a display record) is answered at once, as before; nothing is sent.
    const pending = await open(port, 'pending', { run: 'run-a-2' })
    const chose = await rawCall(sid, 0)
    expect(chose.resp).toMatchObject({ ok: false, error: { code: 'hub_unreachable' } })
    expect(chose.ms).toBeLessThan(1_500)
    expect(pending.requests).toEqual([])

    // One that names no wait waits, and goes once it binds.
    const call1 = rawCall(sid)
    await sleep(800)
    expect(pending.requests).toEqual([])
    await bind(pending, HOME_A)
    expect(await waitFor(() => pending.requests.length === 1)).toBe(true)
    expect((await rpc(pending.ws, { cmd: 'gateway-result', relayId: pending.requests[0]!.relayId, result: { created: 1 } })).ok).toBe(true)
    expect((await call1).resp).toEqual({ ok: true, result: { created: 1 } })
    await cut(pending)

    // Opened and not said hello yet: the same. It names its Walnut late in the moment, and the
    // server answers after most of a hub timeout: the relay keeps the whole hub timeout.
    const fresh = await open(port, 'fresh', null)
    const call2 = rawCall(sid)
    await sleep(IDENTIFY_WINDOW_MS - 1_500)
    expect(fresh.requests).toEqual([])
    await sayHello(fresh, 'run-a-3')
    await bind(fresh, HOME_A)
    expect(await waitFor(() => fresh.requests.length === 1)).toBe(true)
    await sleep(HUB_MS - 3_000)
    expect((await rpc(fresh.ws, { cmd: 'gateway-result', relayId: fresh.requests[0]!.relayId, result: { created: 2 } })).ok).toBe(true)
    const second = await call2
    expect(second.resp).toEqual({ ok: true, result: { created: 2 } })
    // Past the call's first hub timeout: the wait moved its end, as it should.
    expect(second.ms).toBeGreaterThan(HUB_MS)
    await cut(fresh)

    // One that never binds: the old answer, after the moment the call's own time allows, and
    // nothing was sent to it.
    const silent = await open(port, 'silent', { run: 'run-a-4' })
    const call3 = await rawCall(sid)
    expect(call3.resp).toMatchObject({ ok: false, error: { code: 'hub_unreachable' } })
    expect(call3.ms).toBeGreaterThanOrEqual(IDENTIFY_WINDOW_MS - 500)
    expect(call3.ms).toBeLessThan(IDENTIFY_WINDOW_MS + 2_500)
    // Inside an older client's 30 s socket time, whatever the moment: the window and one hub timeout at most.
    expect(IDENTIFY_WINDOW_MS + HUB_MS).toBeLessThan(30_000)
    expect(silent.requests).toEqual([])
  }, 120_000)

  it('a waiting call whose caller hung up is never sent', async () => {
    const port = await boot()
    const sid = await sessionWithServerGone(port)
    const next = await open(port, 'mainA-2', { run: 'run-a-2' })
    const call = rawCallOpen(sid, 20_000)
    // It waits for the server (this daemon's first call), then its caller hangs up.
    expect(await waitFor(() => daemonLogHas('gateway: no server connected, waiting for one'), 15_000)).toBe(true)
    call.hangUp()
    expect((await call.answer).resp).toBeNull()
    await sleep(300)
    await bind(next, HOME_A)
    await sleep(1_500)
    expect(next.requests).toEqual([])
    expect(daemonLogHas('gateway: a waiting call ends, its caller left; nothing was sent')).toBe(true)
    // The next call of the session goes as usual.
    const after = rawCall(sid, 20_000)
    expect(await waitFor(() => next.requests.length === 1)).toBe(true)
    expect((await rpc(next.ws, { cmd: 'gateway-result', relayId: next.requests[0]!.relayId, result: { ok: 1 } })).ok).toBe(true)
    expect((await after).resp).toEqual({ ok: true, result: { ok: 1 } })
  }, 90_000)
})
