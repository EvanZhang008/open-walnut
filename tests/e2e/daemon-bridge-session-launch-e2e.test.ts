/**
 * Bridge session.launch E2E — spawn the REAL daemon-source.ts template,
 * connect a fake cloud WS server AND a fake primary walnut server (a trusted
 * ctl client), and drive the narrow launch relay over the bridge socket
 * exactly the way the cloud companion does for phone session creation
 * (routes/session-launch-v1.ts relayLaunchAction).
 *
 * Covers: the request is forwarded UP as a launch-request event (relayId +
 * action + params intact) and the trusted client's launch-result travels back
 * to the bridge caller (both success and errorKind-carrying failure); no
 * trusted client → fail fast; the daemon spawns nothing; and the bridge
 * containment stays intact (the raw spawn command is still refused).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

const HOST_ALIAS = 'bridge-launch-e2e-host'

interface DaemonProc { proc: ChildProcess; port: number }

let scriptPath: string
let daemonDir: string
let daemon: DaemonProc
let ctl: WebSocket
let cloud: FakeCloud
let bridgeSideWs: WebSocket

function writeDaemonScript(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-launch-e2e-'))
  const p = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(p, getDaemonSource(), { mode: 0o755 })
  return p
}

async function spawnDaemon(): Promise<DaemonProc> {
  const proc = spawn('node', [scriptPath, '--start'], {
    env: { ...process.env, WALNUT_DAEMON_DIR: daemonDir },
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
      if (msg.id === id) {
        clearTimeout(timer)
        ws.off('message', onMessage)
        resolve(msg)
      }
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
  connections: Array<{ ws: WebSocket; url: string; frames: Array<Record<string, unknown>> }>
  close: () => Promise<void>
}

async function startFakeCloud(): Promise<FakeCloud> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((resolve) => wss.on('listening', resolve))
  const address = wss.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const fake: FakeCloud = {
    wss,
    port,
    connections: [],
    close: () => new Promise((resolve) => {
      for (const c of fake.connections) { try { c.ws.close() } catch {} }
      wss.close(() => resolve())
    }),
  }
  wss.on('connection', (ws, req) => {
    const entry = { ws: ws as unknown as WebSocket, url: req.url ?? '', frames: [] as Array<Record<string, unknown>> }
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

/** Drive one RPC over the daemon's outbound bridge socket (the cloud's view). */
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

/**
 * Play the primary walnut server for ONE relay: wait for the next
 * launch-request event on the trusted ctl socket and answer it with the
 * given launch-result payload (relayId is echoed automatically).
 */
function answerNextLaunchRequest(
  reply: (req: { relayId: number; action: string; params: Record<string, unknown> }) => Record<string, unknown>,
): Promise<{ relayId: number; action: string; params: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ctl.off('message', onMessage); reject(new Error('no launch-request arrived')) }, 15_000)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.ev !== 'launch-request') return
      clearTimeout(timer)
      ctl.off('message', onMessage)
      const req = {
        relayId: msg.relayId as number,
        action: msg.action as string,
        params: (msg.params ?? {}) as Record<string, unknown>,
      }
      // Answer as the walnut server would: a launch-result command frame.
      ctl.send(JSON.stringify({ id: 90_000 + req.relayId, cmd: 'launch-result', relayId: req.relayId, ...reply(req) }))
      resolve(req)
    }
    ctl.on('message', onMessage)
  })
}

beforeAll(async () => {
  scriptPath = writeDaemonScript()
  daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-launch-dir-'))
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
})

describe('session.launch over the cloud bridge (real source daemon)', () => {
  it('relays a launch to the trusted client and returns its success result', async () => {
    const params = { cwd: '/home/user/repo', host: 'devbox', message: 'hi from the phone', mode: 'plan' }
    const answered = answerNextLaunchRequest(() => ({
      result: { sessionId: 'sid-e2e-1', taskId: 'task-e2e-1', title: 'Session: repo' },
    }))
    const res = await bridgeRpc(901, 'session.launch', { action: 'launch', params })
    const req = await answered
    // The request crossed the daemon intact — validation happens on the primary.
    expect(req.action).toBe('launch')
    expect(req.params).toEqual(params)
    expect(typeof req.relayId).toBe('number')
    // The primary's result came back to the bridge caller verbatim.
    expect(res.ok).toBe(true)
    expect(res.result).toEqual({ sessionId: 'sid-e2e-1', taskId: 'task-e2e-1', title: 'Session: repo' })
  })

  it('relays launch-options and returns the hosts/dirs result', async () => {
    const options = {
      hosts: [{ alias: '', label: 'This Mac' }],
      dirs: [{ cwd: '/home/user/repo', host: '', lastUsed: '2026-08-06T00:00:00Z', count: 2 }],
    }
    const answered = answerNextLaunchRequest(() => ({ result: options }))
    const res = await bridgeRpc(902, 'session.launch', { action: 'options' })
    const req = await answered
    expect(req.action).toBe('options')
    expect(res.ok).toBe(true)
    expect(res.result).toEqual(options)
  })

  it('carries the primary\'s validation failure back with its errorKind', async () => {
    const answered = answerNextLaunchRequest(() => ({
      error: 'cwd must be an absolute path', errorKind: 'bad_request',
    }))
    const res = await bridgeRpc(903, 'session.launch', {
      action: 'launch', params: { cwd: 'relative/path' },
    })
    await answered
    expect(res.ok).toBe(false)
    expect(res.error).toBe('cwd must be an absolute path')
    expect(res.errorKind).toBe('bad_request')
  })

  it('rejects a session.launch with no action', async () => {
    const res = await bridgeRpc(904, 'session.launch', {})
    expect(res.ok).not.toBe(true)
    expect(String(res.error ?? '')).toContain('missing action')
  })

  it('fails fast when no trusted client is connected (primary server down)', async () => {
    // Drop the trusted ctl socket — only the bridge socket remains.
    ctl.close()
    await new Promise((r) => setTimeout(r, 300))
    const res = await bridgeRpc(905, 'session.launch', { action: 'options' })
    expect(res.ok).not.toBe(true)
    expect(String(res.error ?? '')).toContain('no primary server connected')
    // Restore the trusted client for any tests after this one.
    ctl = await connectWs(daemon.port)
  })

  it('containment intact: the raw spawn command is still refused over the bridge', async () => {
    const denied = await bridgeRpc(906, 'start', {
      sid: 'evil-sid', args: ['claude', '-p'], cwd: '/tmp',
    })
    expect(denied.ok).not.toBe(true)
    expect(String(denied.error ?? '')).toContain('not permitted over bridge')
  })
})
