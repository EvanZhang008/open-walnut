/**
 * Integration tests for the P1 agent gateway (plan §8 ①-⑥) — REAL daemon
 * process + REAL unix-socket round-trips + a fake "Mac hub" WS client.
 *
 * What's real:
 *   - Actual daemon process (DAEMON_SOURCE template run via `node`) in an
 *     ISOLATED WALNUT_DAEMON_DIR (never touches the production daemon)
 *   - Real agent-gateway unix socket + NDJSON protocol
 *   - Real gateway-request / gateway-result reverse-RPC over a real WS
 *
 * What's faked:
 *   - The Mac hub is a bare WS client in this test (no capability router —
 *     we answer gateway-request frames by hand)
 *   - Claude CLI replaced by `/bin/sleep` (the gateway only needs the sid
 *     tracked in the daemon's sessions map, not a live CLI)
 *
 * Hygiene: every test spawns its own daemon in its own tmp dir and afterEach
 * ALWAYS kills it — leaked isolated daemons have starved this machine before.
 * The isolated dir also makes the daemon reap its children on exit.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import type { GatewayResponse } from '../../src/providers/gateway-core.js'
import { pullArgsFile } from '../../src/core/peers/gateway-args-file.js'
import { HUMAN_INBOX_CHUNK_BYTES } from '../../src/core/human-inbox/types.js'

// Short hub timeout so the ② timeout scenario doesn't wait the real 20s.
const TEST_HUB_TIMEOUT_MS = 2000

interface DaemonProc {
  proc: ChildProcess
  port: number
  daemonDir: string
  sockPath: string
}

async function writeDaemonScript(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-gw-script-'))
  const scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
  return scriptPath
}

async function spawnDaemon(scriptPath: string, daemonDir: string): Promise<DaemonProc> {
  const proc = spawn('node', [scriptPath, '--start'], {
    env: {
      ...process.env,
      WALNUT_DAEMON_DIR: daemonDir,
      WALNUT_STREAMS_DIR: path.join(daemonDir, 'streams'),
      WALNUT_GATEWAY_TIMEOUT_MS: String(TEST_HUB_TIMEOUT_MS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (process.env.DEBUG_DAEMON) {
    proc.stderr?.on('data', (b) => process.stderr.write('[daemon] ' + b.toString()))
  }
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 10_000)
    proc.stdout?.on('data', (chunk) => {
      const m = chunk.toString().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })
  const sockPath = path.join(daemonDir, 'agent-gateway.sock')
  // The gateway listener starts alongside the HTTP listener — wait for the file.
  for (let i = 0; i < 40 && !fs.existsSync(sockPath); i++) {
    await new Promise((r) => setTimeout(r, 50))
  }
  if (!fs.existsSync(sockPath)) throw new Error('gateway socket never appeared: ' + sockPath)
  return { proc, port, daemonDir, sockPath }
}

async function stopDaemon(d: DaemonProc): Promise<void> {
  if (d.proc.exitCode === null) {
    d.proc.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { try { d.proc.kill('SIGKILL') } catch {}; resolve() }, 3000)
      d.proc.once('exit', () => { clearTimeout(t); resolve() })
    })
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

function sendCmd(
  ws: WebSocket,
  cmd: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const id = Math.floor(Math.random() * 1e9)
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.off('message', handler)
      reject(new Error(`cmd ${cmd.cmd} timed out`))
    }, timeoutMs)
    const handler = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>
        if (msg.id === id) { clearTimeout(t); ws.off('message', handler); resolve(msg) }
      } catch {}
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ id, ...cmd }))
  })
}

function waitForEvent(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', handler); reject(new Error('event wait timeout')) }, timeoutMs)
    const handler = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>
        if (predicate(msg)) { clearTimeout(t); ws.off('message', handler); resolve(msg) }
      } catch {}
    }
    ws.on('message', handler)
  })
}

/** One NDJSON request over the agent gateway unix socket (as the wn CLI does). */
function gatewayRequest(
  sockPath: string,
  req: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<GatewayResponse> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath)
    let buf = ''
    let done = false
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      sock.destroy()
      fn()
    }
    const timer = setTimeout(() => finish(() => reject(new Error('gateway socket timeout'))), timeoutMs)
    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'))
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf-8')
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      finish(() => resolve(JSON.parse(buf.slice(0, nl)) as GatewayResponse))
    })
    sock.on('error', (err) => finish(() => reject(err)))
    sock.on('close', () => finish(() => reject(new Error('socket closed without a response'))))
  })
}

async function startTrackedSession(ws: WebSocket, sid: string): Promise<void> {
  const started = await sendCmd(ws, {
    cmd: 'start', sid, args: ['/bin/sleep', '60'], cwd: '/tmp', message: 'init\n',
  })
  expect(started.ok).toBe(true)
}

// ════════════════════════════════════════════════════════════════════════

describe('agent gateway — real daemon + unix socket + fake Mac hub client', () => {
  let scriptPath: string
  let daemonDir: string
  let daemon: DaemonProc | null = null

  beforeAll(async () => {
    scriptPath = await writeDaemonScript()
  })

  beforeEach(async () => {
    daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-gw-'))
    daemon = await spawnDaemon(scriptPath, daemonDir)
  })

  afterEach(async () => {
    if (daemon) { await stopDaemon(daemon); daemon = null }
    try { await fsp.rm(daemonDir, { recursive: true, force: true }) } catch {}
  })

  afterAll(async () => {
    try { await fsp.rm(path.dirname(scriptPath), { recursive: true, force: true }) } catch {}
  })

  // ─── ① full round-trip: socket → gateway-request frame → gateway-result → socket ───
  it('① relays tools.list to the trusted client and returns its result to the socket', async () => {
    const ws = await connectWs(daemon!.port)
    const sid = `gw-roundtrip-${Date.now()}`
    await startTrackedSession(ws, sid)

    const frameP = waitForEvent(ws, (m) => m.ev === 'gateway-request')
    const respP = gatewayRequest(daemon!.sockPath, { v: 1, op: 'tools.list', sid, args: {} })

    const frame = await frameP
    expect(typeof frame.relayId).toBe('number')
    expect(frame.capability).toBe('tools.list')
    expect(frame.callerSid).toBe(sid)

    // Answer as the Mac hub would (capability router output).
    const ops = [{ name: 'session_send', title: 'Send a message to a session', readonly: false, remote: 'allow' }]
    const ack = await sendCmd(ws, { cmd: 'gateway-result', relayId: frame.relayId, result: { ops } })
    expect(ack.ok).toBe(true)

    const resp = await respP
    expect(resp.ok).toBe(true)
    if (resp.ok) expect(resp.result.ops).toEqual(ops)
    ws.close()
  })

  it('① error results carry errorCode + detail back to the socket (retryAfterMs lifted)', async () => {
    const ws = await connectWs(daemon!.port)
    const sid = `gw-err-${Date.now()}`
    await startTrackedSession(ws, sid)

    const frameP = waitForEvent(ws, (m) => m.ev === 'gateway-request')
    const respP = gatewayRequest(daemon!.sockPath, {
      v: 1, op: 'tools.call', sid, args: { name: 'session_send', args: { to: 'nope', text: 'hello' } },
    })
    const frame = await frameP
    expect(frame.capability).toBe('tools.call')
    // The whole payload rides through the relay untouched — the daemon is a pipe,
    // never a parser of op arguments.
    expect((frame.payload as Record<string, unknown>).name).toBe('session_send')
    expect((frame.payload as { args?: Record<string, unknown> }).args).toEqual({ to: 'nope', text: 'hello' })

    await sendCmd(ws, {
      cmd: 'gateway-result', relayId: frame.relayId,
      error: 'peer send throttled', errorCode: 'throttled', detail: { retryAfterMs: 41_000 },
    })

    const resp = await respP
    expect(resp.ok).toBe(false)
    if (!resp.ok) {
      expect(resp.error.code).toBe('throttled')
      expect(resp.error.retryAfterMs).toBe(41_000)
      expect(resp.error.detail).toEqual({ retryAfterMs: 41_000 })
    }
    ws.close()
  })

  // ─── ② hub never answers → hub_timeout ───
  it('② unanswered relay times out with hub_timeout', async () => {
    const ws = await connectWs(daemon!.port)
    const sid = `gw-timeout-${Date.now()}`
    await startTrackedSession(ws, sid)

    const frameP = waitForEvent(ws, (m) => m.ev === 'gateway-request')
    const t0 = Date.now()
    const respP = gatewayRequest(
      daemon!.sockPath,
      { v: 1, op: 'tools.list', sid, args: {} },
      TEST_HUB_TIMEOUT_MS + 5000,
    )
    await frameP // the daemon DID relay — we just never answer

    const resp = await respP
    expect(resp.ok).toBe(false)
    if (!resp.ok) expect(resp.error.code).toBe('hub_timeout')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(TEST_HUB_TIMEOUT_MS - 100)
    ws.close()
  })

  // ─── ③ only a bridge-origin client connected → hub_unreachable ───
  it('③ refuses with hub_unreachable when the only client is the cloud bridge', async () => {
    // Fake cloud companion: accept the daemon's outbound bridge dial.
    const cloud = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    const cloudPort = await new Promise<number>((resolve) => {
      cloud.on('listening', () => resolve((cloud.address() as { port: number }).port))
    })
    const bridgeConnected = new Promise<void>((resolve) => {
      cloud.on('connection', (sock) => {
        sock.on('message', () => {}) // swallow hello; keep the socket open
        resolve()
      })
    })

    const ws = await connectWs(daemon!.port)
    const sid = `gw-bridge-${Date.now()}`
    await startTrackedSession(ws, sid)

    const conf = await sendCmd(ws, {
      cmd: 'bridge.configure', enabled: true,
      url: `ws://127.0.0.1:${cloudPort}`, token: 'test-token', hostAlias: 'test-host',
    })
    expect(conf.ok).toBe(true)
    await bridgeConnected

    // Drop the trusted client — the bridge adapter is now the ONLY wsClient.
    ws.close()
    await new Promise((r) => setTimeout(r, 300))

    const resp = await gatewayRequest(daemon!.sockPath, { v: 1, op: 'tools.list', sid, args: {} })
    expect(resp.ok).toBe(false)
    if (!resp.ok) expect(resp.error.code).toBe('hub_unreachable')

    // ws's server.close() callback waits for every client socket to go away,
    // and the daemon keeps its bridge socket open (and redials) — terminate
    // the clients first or this await never resolves.
    for (const client of cloud.clients) client.terminate()
    await new Promise<void>((resolve) => cloud.close(() => resolve()))
  })

  // ─── ④ stale relayId → ack {stale:true}, dropped ───
  it('④ acks a stale gateway-result instead of crashing or resolving anything', async () => {
    const ws = await connectWs(daemon!.port)
    const ack = await sendCmd(ws, { cmd: 'gateway-result', relayId: 999_999, result: { ops: [] } })
    expect(ack.ok).toBe(true)
    expect(ack.stale).toBe(true)
    ws.close()
  })

  // ─── ⑤ unknown sid → unknown_caller, request never reaches the hub ───
  it('⑤ rejects an unknown caller locally without relaying', async () => {
    const ws = await connectWs(daemon!.port)
    const frames: Record<string, unknown>[] = []
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>
        if (msg.ev === 'gateway-request') frames.push(msg)
      } catch {}
    })

    const resp = await gatewayRequest(daemon!.sockPath, {
      v: 1, op: 'tools.list', sid: 'never-spawned-sid', args: {},
    })
    expect(resp.ok).toBe(false)
    if (!resp.ok) expect(resp.error.code).toBe('unknown_caller')

    await new Promise((r) => setTimeout(r, 300))
    expect(frames).toEqual([]) // the request must never leave the host
    ws.close()
  })

  // ─── ⑥ rename: env still carries the OLD sid → resolves to the CURRENT sid ───
  it('⑥ resolves a renamed session via the alias table and reports the CURRENT sid', async () => {
    const ws = await connectWs(daemon!.port)
    const oldSid = `gw-tmp-${Date.now()}`
    const newSid = `gw-final-${Date.now()}`
    await startTrackedSession(ws, oldSid)

    const renamed = await sendCmd(ws, { cmd: 'rename', oldSid, newSid })
    expect(renamed.ok).toBe(true)

    const frameP = waitForEvent(ws, (m) => m.ev === 'gateway-request')
    const respP = gatewayRequest(daemon!.sockPath, { v: 1, op: 'tools.list', sid: oldSid, args: {} })
    const frame = await frameP
    expect(frame.callerSid).toBe(newSid) // daemon-authoritative attribution

    await sendCmd(ws, { cmd: 'gateway-result', relayId: frame.relayId, result: { ops: [] } })
    const resp = await respP
    expect(resp.ok).toBe(true)
    ws.close()
  })

  // ─── protocol edge cases straight off the socket ───
  it('rejects bad protocol input with typed errors', async () => {
    const badVersion = await gatewayRequest(daemon!.sockPath, { v: 9, op: 'tools.list', sid: 'x', args: {} })
    expect(badVersion.ok).toBe(false)
    if (!badVersion.ok) expect(badVersion.error.code).toBe('unsupported_version')

    const badOp = await gatewayRequest(daemon!.sockPath, { v: 1, op: 'fs.read', sid: 'x', args: {} })
    expect(badOp.ok).toBe(false)
    if (!badOp.ok) expect(badOp.error.code).toBe('bad_request')
  })

  // peers.list / peers.send are tombstones: the HUB answers them with a pointer
  // to session_list / session_send, which only works if the daemon still lets
  // them onto the wire and relays them. A daemon that rejected them locally
  // would turn a stale `walnut peers send` into an unexplained protocol error.
  it('still relays the retired peers capabilities so the hub can answer with a pointer', async () => {
    const ws = await connectWs(daemon!.port)
    const sid = `gw-tombstone-${Date.now()}`
    await startTrackedSession(ws, sid)

    for (const op of ['peers.list', 'peers.send']) {
      const frameP = waitForEvent(ws, (m) => m.ev === 'gateway-request')
      const respP = gatewayRequest(daemon!.sockPath, { v: 1, op, sid, args: { target: 'x', text: 'hi' } })
      const frame = await frameP
      expect(frame.capability).toBe(op)
      // Answer as the real router does: bad_request naming the replacement.
      await sendCmd(ws, {
        cmd: 'gateway-result', relayId: frame.relayId,
        error: `${op} was replaced`, errorCode: 'bad_request',
      })
      const resp = await respP
      expect(resp.ok).toBe(false)
      if (!resp.ok) {
        expect(resp.error.code).toBe('bad_request')
        expect(resp.error.message).toContain('was replaced')
      }
    }
    ws.close()
  })

  it('the gateway socket is owner-only (0600)', async () => {
    const mode = fs.statSync(daemon!.sockPath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  // ─── ⑦ big payloads: the request carries a PATH, the hub pulls it in batches ───
  /**
   * The joint the unit layer cannot reach. Three pieces each have their own test
   * (the CLI emits `argsFile`, `pullArgsFile` reassembles bounded slices, the twin
   * matches the binary), but the thing that actually had to work is the SEAM: the
   * real CLI writes a path, the real daemon relays it untouched, and the hub reads
   * the bytes back through that same daemon's `fs.readRange`.
   *
   * Everything here is real except the capability router: the real `pullArgsFile`
   * runs with deps that issue `fs.readRange` over the same WS the frame arrived on,
   * which is exactly what DaemonFileReader does in production.
   */
  it('⑦ a multi-MB @file arrives as a path and the hub reassembles it byte-exactly', async () => {
    const ws = await connectWs(daemon!.port)
    const sid = `gw-argsfile-${Date.now()}`
    await startTrackedSession(ws, sid)

    // Multi-byte characters throughout, so 2MB slice boundaries land mid-character:
    // decoding per slice would corrupt the JSON and the parse below would throw.
    // Repeat count derived from the slice size, so the payload cannot quietly
    // shrink under "needs several slices" when the fragment is reworded.
    const FRAGMENT = '<p>é 中 🎧 overnight</p>'
    const REPEATS = Math.ceil((4 * HUMAN_INBOX_CHUNK_BYTES) / Buffer.byteLength(FRAGMENT))
    const html = `<h1>Digest</h1>${FRAGMENT.repeat(REPEATS)}<p>TAIL-a71c</p>`
    const payloadFile = path.join(daemonDir, 'payload.json')
    const payloadJson = JSON.stringify({ subject: 'Overnight digest', type: 'info', html })
    await fsp.writeFile(payloadFile, payloadJson, 'utf-8')
    const fileBytes = Buffer.byteLength(payloadJson)
    expect(fileBytes).toBeGreaterThan(3 * HUMAN_INBOX_CHUNK_BYTES)

    // The REAL wn CLI shipped inside the twin, pointed at the REAL gateway socket.
    const frameP = waitForEvent(ws, (m) => m.ev === 'gateway-request', 20_000)
    const cli = spawn(process.execPath, [scriptPath, 'wn', 'tools', 'call', 'human_inbox_send', `@${payloadFile}`], {
      env: {
        ...process.env,
        WALNUT_DAEMON_DIR: daemonDir,
        WALNUT_AGENT_SOCKET: daemon!.sockPath,
        WALNUT_SESSION_ID: sid,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let cliOut = ''
    cli.stdout?.on('data', (b) => { cliOut += b.toString() })
    cli.stderr?.on('data', (b) => { cliOut += b.toString() })

    const frame = await frameP
    const payload = frame.payload as { name?: string; argsFile?: string; args?: unknown }
    expect(frame.capability).toBe('tools.call')
    expect(payload.name).toBe('human_inbox_send')
    // The path, not the payload — and NOT both (a stale duplicate would be a
    // second 4MB copy on a wire whose whole problem was size).
    expect(payload.argsFile).toBe(payloadFile)
    expect(payload.args).toBeUndefined()
    // The frame itself stays tiny. This is the claim the feature rests on.
    expect(JSON.stringify(frame).length).toBeLessThan(4096)

    // Now be the hub: pull the file back through the daemon that just relayed it.
    const reads: Array<{ start: number; length: number }> = []
    const args = await pullArgsFile('test-host', payload.argsFile!, {
      async readRange(_host, p, start, length) {
        reads.push({ start, length })
        const res = await sendCmd(ws, { cmd: 'fs.readRange', path: p, start, length }, 20_000)
        // The daemon spreads its payload onto the reply envelope (sendOk), so the
        // fields sit at the top level — there is no `result` wrapper on fs.*.
        if (res.ok !== true) return null
        const r = res as unknown as { data: string; fileSize: number; eof: boolean }
        return { buf: Buffer.from(r.data, 'base64'), fileSize: r.fileSize, eof: r.eof }
      },
    })

    // Byte-exact after reassembly, across real slice boundaries in real base64.
    expect(args.html).toBe(html)
    expect(args.subject).toBe('Overnight digest')
    expect(reads.length).toBeGreaterThan(3)
    for (const r of reads) expect(r.length).toBeLessThanOrEqual(HUMAN_INBOX_CHUNK_BYTES)

    // Answer as the router would, so the CLI completes rather than timing out.
    await sendCmd(ws, { cmd: 'gateway-result', relayId: frame.relayId, result: { id: 'lt-test-1' } })
    const code = await new Promise<number | null>((resolve) => cli.once('exit', resolve))
    expect(code, `wn CLI output: ${cliOut}`).toBe(0)
    ws.close()
  })
})
