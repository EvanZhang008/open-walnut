/**
 * Bridge image.save E2E — spawn the REAL daemon-source.ts template, connect a
 * fake cloud WS server, and drive the narrow image-save command over the
 * bridge socket exactly the way the cloud companion does for phone image
 * attachments (routes/session-stream-v1.ts saveImagesViaBridge).
 *
 * Covers: a real PNG lands byte-exact in the fixed daemon-owned directory
 * with a generated filename; oversized payloads, non-allowlisted mediaTypes,
 * and non-image bytes are rejected; caller-supplied path fields are ignored;
 * and the bridge containment stays intact (generic fs.write still refused).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

const HOST_ALIAS = 'bridge-image-e2e-host'

// 1x1 transparent PNG — a REAL image (passes the daemon's magic-byte gate).
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

interface DaemonProc { proc: ChildProcess; port: number }

let scriptPath: string
let daemonDir: string
let daemon: DaemonProc
let ctl: WebSocket
let cloud: FakeCloud
let bridgeSideWs: WebSocket

function writeDaemonScript(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-image-save-e2e-'))
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

beforeAll(async () => {
  scriptPath = writeDaemonScript()
  daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-image-save-dir-'))
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

describe('image.save over the cloud bridge (real source daemon)', () => {
  it('saves a real PNG into the fixed daemon-owned dir and returns its generated path', async () => {
    const res = await bridgeRpc(801, 'image.save', { data: TINY_PNG_BASE64, mediaType: 'image/png' })
    expect(res.ok).toBe(true)
    const savedPath = res.path as string
    const imagesDir = path.join(daemonDir, 'images', 'mobile')
    // Fixed directory the daemon owns — never a caller-influenced location.
    expect(path.dirname(savedPath)).toBe(imagesDir)
    // Generated filename: timestamp + random hex + allowlist-derived extension.
    expect(path.basename(savedPath)).toMatch(/^\d+-[0-9a-f]{8}\.png$/)
    // Byte-exact round trip.
    const onDisk = fs.readFileSync(savedPath)
    expect(onDisk.equals(Buffer.from(TINY_PNG_BASE64, 'base64'))).toBe(true)
    expect(res.size).toBe(onDisk.length)
  })

  it('ignores caller-supplied path/filename fields entirely (no path components cross the bridge)', async () => {
    const res = await bridgeRpc(802, 'image.save', {
      data: TINY_PNG_BASE64,
      mediaType: 'image/png',
      path: '/etc/pwned.png',
      filename: '../../escape.png',
    })
    expect(res.ok).toBe(true)
    const savedPath = res.path as string
    expect(path.dirname(savedPath)).toBe(path.join(daemonDir, 'images', 'mobile'))
    expect(savedPath).not.toContain('escape')
    expect(savedPath).not.toContain('pwned')
    expect(fs.existsSync('/etc/pwned.png')).toBe(false)
  })

  it('rejects a mediaType outside the allowlist (svg would be XSS-able, scripts are not images)', async () => {
    for (const [id, mediaType] of [[803, 'image/svg+xml'], [804, 'application/x-sh'], [805, 'text/html']] as const) {
      const res = await bridgeRpc(id, 'image.save', { data: TINY_PNG_BASE64, mediaType })
      expect(res.ok).not.toBe(true)
      expect(String(res.error ?? '')).toContain('unsupported mediaType')
    }
    // Nothing landed on disk from the rejected calls (only the 2 earlier saves).
    const files = fs.readdirSync(path.join(daemonDir, 'images', 'mobile'))
    expect(files.length).toBe(2)
  })

  it('rejects non-image bytes even with an allowlisted mediaType (magic-byte gate)', async () => {
    const notAnImage = Buffer.from('#!/bin/sh\nrm -rf --no-preserve-root /\n').toString('base64')
    const res = await bridgeRpc(806, 'image.save', { data: notAnImage, mediaType: 'image/png' })
    expect(res.ok).not.toBe(true)
    expect(String(res.error ?? '')).toContain('not an image')
  })

  it('rejects an oversized image (decoded > 10MB)', async () => {
    // 10,490,000 bytes: over the 10MB decoded cap, but its base64 (~13.99M
    // chars) is under the 14M pre-decode gate — exercises the DECODED cap.
    const big = Buffer.alloc(10_490_000)
    big[0] = 0x89; big[1] = 0x50; big[2] = 0x4e; big[3] = 0x47 // PNG magic
    const res = await bridgeRpc(807, 'image.save', { data: big.toString('base64'), mediaType: 'image/png' })
    expect(res.ok).not.toBe(true)
    expect(String(res.error ?? '')).toContain('too large')
  }, 40_000)

  it('containment intact: generic fs.write is still refused over the bridge', async () => {
    const victimFile = path.join(daemonDir, 'pwned-via-bridge.txt')
    const denied = await bridgeRpc(808, 'fs.write', {
      path: victimFile,
      data: Buffer.from('pwned').toString('base64'),
    })
    expect(denied.ok).not.toBe(true)
    expect(String(denied.error ?? '')).toContain('not permitted over bridge')
    expect(fs.existsSync(victimFile)).toBe(false)
  })
})
