/**
 * Regression: the agent-gateway unix socket must deliver replies LARGER than
 * one kernel socket buffer (~8KB) — real Bun binary, real unix socket.
 *
 * Bun.listen raw sockets do partial writes: socket.write() returns only the
 * bytes the kernel accepted, and end() right after silently truncated the
 * rest. Every gateway reply over ~8KB (tools.list ~9KB, skill_read ~11KB)
 * arrived cut off, so the wn client reported "agent socket closed without a
 * response" while small replies (walnut_status) looked healthy. The fix
 * buffers the remainder and finishes from drain() (daemon-standalone.ts,
 * startGatewayListener).
 *
 * Shape mirrors daemon-ws-backpressure.test.ts: spawn the compiled darwin
 * binary against an ISOLATED daemon dir (never /tmp/open-walnut), fake the
 * Mac hub with a bare WS client, and answer the gateway-request frame with a
 * payload well past one buffer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'

const ROOT = path.resolve(__dirname, '../..')
const BINARY = path.join(ROOT, 'dist', 'daemon-binaries', `daemon-${process.platform}-${process.arch}`)

const DAEMON_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-gw-large-'))
const PORT_FILE = path.join(DAEMON_DIR, 'daemon.port')
const PID_FILE = path.join(DAEMON_DIR, 'daemon.pid')
const SOCK_PATH = path.join(DAEMON_DIR, 'agent-gateway.sock')

const hasBinary = fs.existsSync(BINARY)
const d = hasBinary ? describe : describe.skip

let daemonPid: number | null = null
let port = 0

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return cond()
}

function sendCmd(ws: WebSocket, cmd: Record<string, unknown>, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const id = Math.floor(Math.random() * 1e9)
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', handler); reject(new Error(`cmd ${cmd.cmd} timed out`)) }, timeoutMs)
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

function waitForEvent(ws: WebSocket, predicate: (m: Record<string, unknown>) => boolean, timeoutMs = 10_000): Promise<Record<string, unknown>> {
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

/** Raw NDJSON request as the wn CLI sends it; resolves with the COMPLETE reply. */
function gatewayRequest(req: Record<string, unknown>, timeoutMs = 15_000): Promise<{ raw: string; parsed: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCK_PATH)
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
      finish(() => resolve({ raw: buf.slice(0, nl), parsed: JSON.parse(buf.slice(0, nl)) as Record<string, unknown> }))
    })
    sock.on('error', (err) => finish(() => reject(err)))
    // The exact prod symptom: the daemon truncated the reply and closed.
    sock.on('close', () => finish(() => reject(new Error('socket closed without a response'))))
  })
}

d('agent gateway large replies (real binary)', () => {
  beforeAll(async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, WALNUT_DAEMON_DIR: DAEMON_DIR }
    delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID
    delete env.VITEST_POOL_ID; delete env.OPEN_WALNUT_HOME
    const proc = spawn(BINARY, ['--start'], { detached: true, stdio: 'ignore', env })
    proc.unref()

    const ok = await waitFor(() => fs.existsSync(PORT_FILE) && fs.existsSync(SOCK_PATH), 10_000)
    if (!ok) throw new Error('daemon did not write port file / gateway socket')
    port = parseInt(fs.readFileSync(PORT_FILE, 'utf-8').trim(), 10)
    daemonPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10)
  }, 30_000)

  afterAll(() => {
    if (daemonPid) {
      try { process.kill(daemonPid, 'SIGTERM') } catch {}
    }
    try { fs.rmSync(DAEMON_DIR, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(`${DAEMON_DIR}-streams`, { recursive: true, force: true }) } catch {}
  })

  it('delivers a reply far past one kernel socket buffer, newline-terminated', async () => {
    const ws = new WebSocket(`ws://localhost:${port}`)
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej) })

    // Track a session so resolveCallerSid accepts the request (CLI = sleep).
    const sid = `gw-large-${Date.now()}`
    const started = await sendCmd(ws, { cmd: 'start', sid, args: ['/bin/sleep', '60'], cwd: '/tmp', message: 'init\n' })
    expect(started.ok).toBe(true)

    const frameP = waitForEvent(ws, (m) => m.ev === 'gateway-request')
    const respP = gatewayRequest({ v: 1, op: 'tools.call', sid, args: { name: 'skill_read', args: { dirName: 'walnut' } } })

    // Answer as the hub would, with a payload ~8x one kernel buffer. Before
    // the drain() fix the socket delivered exactly ~8192 bytes and closed.
    const frame = await frameP
    const big = 'x'.repeat(64 * 1024)
    const ack = await sendCmd(ws, { cmd: 'gateway-result', relayId: frame.relayId, result: { content: big } })
    expect(ack.ok).toBe(true)

    const { raw, parsed } = await respP
    expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThan(64 * 1024)
    expect(parsed.ok).toBe(true)
    expect((parsed as { result: { content: string } }).result.content).toBe(big)
    ws.close()
  }, 30_000)
})
