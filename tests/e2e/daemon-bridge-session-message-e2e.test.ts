/**
 * Bridge session.message E2E — spawn the REAL daemon-source.ts template,
 * connect a fake cloud WS server AND a fake primary walnut server (trusted
 * ctl client), and drive the narrow durable-send relay over the bridge
 * socket exactly the way the cloud companion does for phone sends
 * (routes/session-stream-v1.ts cloudSend).
 *
 * Covers: the request is forwarded UP as a message-request event (relayId +
 * sessionId + message + messageId intact — the idempotence anchor), the
 * trusted client's message-result travels back to the bridge caller (success
 * and errorKind failure), no trusted client → fail fast (which is what lets
 * the route fall back to the direct sequence when the Mac is offline), the
 * daemon delivers NOTHING itself, and message-result stays OFF the bridge.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

const HOST_ALIAS = 'bridge-msg-e2e-host'

interface DaemonProc { proc: ChildProcess; port: number }

let scriptPath: string
let daemonDir: string
let streamsDir: string
let daemon: DaemonProc
let ctl: WebSocket
let cloud: FakeCloud
let bridgeSideWs: WebSocket

function writeDaemonScript(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-msg-e2e-'))
  const p = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(p, getDaemonSource(), { mode: 0o755 })
  return p
}

async function spawnDaemon(): Promise<DaemonProc> {
  const proc = spawn(process.execPath, [scriptPath, '--start'], {
    env: { ...process.env, WALNUT_DAEMON_DIR: daemonDir, WALNUT_STREAMS_DIR: streamsDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 10_000)
    proc.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })
  return { proc, port }
}

async function stopDaemon(d: DaemonProc): Promise<void> {
  if (d.proc.exitCode === null) {
    d.proc.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { try { d.proc.kill('SIGKILL') } catch {} resolve() }, 3000)
      d.proc.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
}

function rpc(ws: WebSocket, id: number, cmd: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`rpc timeout: ${cmd}`)), 20_000)
    const onMessage = (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>
      if (msg.id === id) { clearTimeout(timer); ws.off('message', onMessage); resolve(msg) }
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, cmd, ...params }))
  })
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

interface FakeCloud {
  wss: WebSocketServer
  port: number
  connections: Array<{ ws: WebSocket; frames: Array<Record<string, unknown>> }>
  close: () => Promise<void>
}

async function startFakeCloud(): Promise<FakeCloud> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((resolve) => wss.on('listening', resolve))
  const address = wss.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const fake: FakeCloud = {
    wss, port, connections: [],
    close: () => new Promise((resolve) => {
      for (const c of fake.connections) { try { c.ws.close() } catch {} }
      wss.close(() => resolve())
    }),
  }
  wss.on('connection', (ws) => {
    const entry = { ws: ws as unknown as WebSocket, frames: [] as Array<Record<string, unknown>> }
    fake.connections.push(entry)
    ws.on('message', (data) => {
      try { entry.frames.push(JSON.parse(data.toString())) } catch { /* ignore */ }
    })
  })
  return fake
}

async function waitFor(pred: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (pred()) return
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 100))
  }
}

function bridgeRpc(id: number, cmd: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`bridge rpc timeout: ${cmd}`)), 20_000)
    const onMessage = (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>
      if (msg.id === id) { clearTimeout(timer); bridgeSideWs.off('message', onMessage); resolve(msg) }
    }
    bridgeSideWs.on('message', onMessage)
    bridgeSideWs.send(JSON.stringify({ id, cmd, ...params }))
  })
}

/** Play the primary walnut server for ONE relay: answer the next
 *  message-request on the trusted ctl socket with the given result. */
function answerNextMessageRequest(
  reply: (req: { relayId: number; sessionId: string; message: string; messageId: string }) => Record<string, unknown>,
): Promise<{ relayId: number; sessionId: string; message: string; messageId: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ctl.off('message', onMessage); reject(new Error('no message-request arrived')) }, 15_000)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.ev !== 'message-request') return
      clearTimeout(timer)
      ctl.off('message', onMessage)
      const req = {
        relayId: msg.relayId as number,
        sessionId: msg.sessionId as string,
        message: msg.message as string,
        messageId: msg.messageId as string,
      }
      ctl.send(JSON.stringify({ id: 91_000 + req.relayId, cmd: 'message-result', relayId: req.relayId, ...reply(req) }))
      resolve(req)
    }
    ctl.on('message', onMessage)
  })
}

beforeAll(async () => {
  scriptPath = writeDaemonScript()
  daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-msg-dir-'))
  streamsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-msg-streams-'))
  cloud = await startFakeCloud()
  daemon = await spawnDaemon()
  ctl = await connectWs(daemon.port)
  const conf = await rpc(ctl, 1, 'bridge.configure', {
    enabled: true,
    url: `ws://127.0.0.1:${cloud.port}/bridge`,
    token: 'test-machine-token',
    hostAlias: HOST_ALIAS,
  })
  expect(conf.ok).toBe(true)
  await waitFor(() => cloud.connections.some((c) =>
    c.frames.some((f) => f.ev === 'hello' && f.hostAlias === HOST_ALIAS)))
  bridgeSideWs = cloud.connections[0].ws
}, 60_000)

afterAll(async () => {
  try { ctl.close() } catch { /* already closed */ }
  await stopDaemon(daemon)
  await cloud.close()
  fs.rmSync(path.dirname(scriptPath), { recursive: true, force: true })
  fs.rmSync(daemonDir, { recursive: true, force: true })
  fs.rmSync(streamsDir, { recursive: true, force: true })
})

describe('session.message over the cloud bridge (real source daemon)', () => {
  it('relays the send to the trusted client with messageId intact and returns success', async () => {
    const answered = answerNextMessageRequest(() => ({
      result: { messageId: 'qm-mobile-e2e-1' },
    }))
    const res = await bridgeRpc(901, 'session.message', {
      sessionId: 'sid-msg-1', message: 'hello from the phone', messageId: 'qm-mobile-e2e-1',
    })
    const req = await answered
    expect(req.sessionId).toBe('sid-msg-1')
    expect(req.message).toBe('hello from the phone')
    expect(req.messageId).toBe('qm-mobile-e2e-1')
    expect(typeof req.relayId).toBe('number')
    expect(res.ok).toBe(true)
    expect(res.result).toEqual({ messageId: 'qm-mobile-e2e-1' })
    // The daemon delivered nothing itself: no session ever existed for this sid.
    const status = await bridgeRpc(902, 'status', { sid: 'sid-msg-1' })
    expect(status.exists).toBe(false)
  })

  it("carries the primary's failure back with its errorKind", async () => {
    const answered = answerNextMessageRequest(() => ({
      error: 'Session not found: ghost', errorKind: 'not_found',
    }))
    const res = await bridgeRpc(903, 'session.message', {
      sessionId: 'ghost', message: 'x', messageId: 'qm-mobile-e2e-2',
    })
    await answered
    expect(res.ok).toBe(false)
    expect(res.error).toBe('Session not found: ghost')
    expect(res.errorKind).toBe('not_found')
  })

  it('rejects a session.message with missing fields', async () => {
    const res = await bridgeRpc(904, 'session.message', { sessionId: 'sid', message: 'no id' })
    expect(res.ok).not.toBe(true)
    expect(String(res.error ?? '')).toContain('missing sessionId, message, or messageId')
  })

  it('containment intact: message-result is refused over the bridge', async () => {
    const denied = await bridgeRpc(905, 'message-result', { relayId: 1, result: {} })
    expect(denied.ok).not.toBe(true)
    expect(String(denied.error ?? '')).toContain('not permitted over bridge')
  })

  it('fails fast when no trusted client is connected (route falls back to direct)', async () => {
    ctl.close()
    await new Promise((r) => setTimeout(r, 300))
    const res = await bridgeRpc(906, 'session.message', {
      sessionId: 'sid-msg-1', message: 'x', messageId: 'qm-mobile-e2e-3',
    })
    expect(res.ok).not.toBe(true)
    expect(String(res.error ?? '')).toContain('no primary server connected')
    ctl = await connectWs(daemon.port)
  })
})
