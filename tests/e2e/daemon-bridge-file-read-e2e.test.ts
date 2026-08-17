/**
 * Bridge fs.readBounded E2E — spawn the REAL daemon-source.ts template,
 * connect a fake cloud WS server, and drive the narrow bounded file read over
 * the bridge socket exactly the way the cloud companion does for phone file
 * previews (routes/file-content-bridge.ts serveCloudFileContent).
 *
 * Covers: a real HTML file rides back byte-exact (base64); the 2MB cap
 * refuses with EFBIG; secret paths (.ssh, key files, .env, config.yaml)
 * refuse with EDENIED; a symlink into ~/.ssh refuses (realpath laundering);
 * traversal and relative paths refuse; a FIFO refuses (ENOTFILE — the
 * stat-before-open guard); missing files tag ENOENT; and the bridge
 * containment stays intact (unbounded fs.read still refused on the bridge,
 * fs.readBounded still allowed from the trusted ctl socket).
 *
 * MACHINE SAFETY: isolated WALNUT_DAEMON_DIR temp dir, never /tmp/open-walnut;
 * daemon killed in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

const HOST_ALIAS = 'bridge-fileread-e2e-host'
const HTML = '<!doctype html>\n<html><body><h1>loggroup explainer</h1></body></html>\n'

interface DaemonProc { proc: ChildProcess; port: number }

let scriptPath: string
let daemonDir: string
let filesDir: string
let fakeHome: string
let daemon: DaemonProc
let ctl: WebSocket
let cloud: FakeCloud
let bridgeSideWs: WebSocket

function writeDaemonScript(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fileread-e2e-'))
  const p = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(p, getDaemonSource(), { mode: 0o755 })
  return p
}

async function spawnDaemon(): Promise<DaemonProc> {
  const proc = spawn(process.execPath, [scriptPath, '--start'], {
    // WALNUT_HOME_OVERRIDE pins HOME_DIR so the ~-expansion + HOME-relative
    // denylist tests are deterministic.
    env: { ...process.env, WALNUT_DAEMON_DIR: daemonDir, WALNUT_HOME_OVERRIDE: fakeHome },
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
  daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fileread-dir-'))
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fileread-files-'))
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fileread-home-'))

  // Target files: a small HTML page and a >2MB whale.
  fs.writeFileSync(path.join(filesDir, 'index.html'), HTML)
  fs.writeFileSync(path.join(filesDir, 'whale.html'), Buffer.alloc(2 * 1024 * 1024 + 16, 0x61))
  // Secret-shaped files the daemon must refuse.
  fs.mkdirSync(path.join(fakeHome, '.ssh'), { recursive: true })
  fs.writeFileSync(path.join(fakeHome, '.ssh', 'id_ed25519'), 'FAKE PRIVATE KEY\n')
  fs.writeFileSync(path.join(filesDir, 'server.pem'), 'FAKE PEM\n')
  fs.writeFileSync(path.join(filesDir, '.env'), 'SECRET=1\n')
  fs.writeFileSync(path.join(filesDir, 'config.yaml'), 'provider: {}\n')
  // Symlink laundering: an innocent-looking path pointing into ~/.ssh.
  fs.symlinkSync(path.join(fakeHome, '.ssh', 'id_ed25519'), path.join(filesDir, 'innocent.txt'))
  // FIFO: fs.readBounded must refuse it via stat-before-open (ENOTFILE).
  execFileSync('mkfifo', [path.join(filesDir, 'pipe.fifo')])

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
  fs.rmSync(filesDir, { recursive: true, force: true })
  fs.rmSync(fakeHome, { recursive: true, force: true })
})

describe('fs.readBounded over the cloud bridge (real source daemon)', () => {
  it('serves a real HTML file byte-exact (base64) with its size', async () => {
    const res = await bridgeRpc(901, 'fs.readBounded', { path: path.join(filesDir, 'index.html') })
    expect(res.ok).toBe(true)
    expect(Buffer.from(res.data as string, 'base64').toString('utf-8')).toBe(HTML)
    expect(res.size).toBe(Buffer.byteLength(HTML))
    expect(res.encoding).toBe('base64')
  })

  it("hello RPC lists 'fs.readBounded' (the server's capability gate)", async () => {
    const res = await rpc(ctl, 902, 'hello')
    expect(res.ok).toBe(true)
    expect(res.capabilities as string[]).toContain('fs.readBounded')
  })

  it('refuses a >2MB file with EFBIG (the bridge frame protection)', async () => {
    const res = await bridgeRpc(903, 'fs.readBounded', { path: path.join(filesDir, 'whale.html') })
    expect(res.ok).not.toBe(true)
    expect(String(res.error)).toContain('(EFBIG)')
  })

  it('refuses key material and secret-shaped files with EDENIED', async () => {
    const denied = [
      path.join(fakeHome, '.ssh', 'id_ed25519'), // HOME-relative denied dir
      path.join(filesDir, 'server.pem'),          // key extension
      path.join(filesDir, '.env'),                // env file
      path.join(filesDir, 'config.yaml'),         // provider secrets pattern
    ]
    let id = 910
    for (const p of denied) {
      const res = await bridgeRpc(id++, 'fs.readBounded', { path: p })
      expect(res.ok, p).not.toBe(true)
      expect(String(res.error), p).toContain('(EDENIED)')
    }
  })

  it('refuses a symlink that points into ~/.ssh (realpath laundering)', async () => {
    const res = await bridgeRpc(920, 'fs.readBounded', { path: path.join(filesDir, 'innocent.txt') })
    expect(res.ok).not.toBe(true)
    expect(String(res.error)).toContain('(EDENIED)')
  })

  it('refuses traversal and relative paths', async () => {
    const trav = await bridgeRpc(921, 'fs.readBounded', { path: filesDir + '/../../etc/passwd' })
    expect(trav.ok).not.toBe(true)
    expect(String(trav.error)).toContain('(EDENIED)')
    const rel = await bridgeRpc(922, 'fs.readBounded', { path: 'relative/path.txt' })
    expect(rel.ok).not.toBe(true)
    expect(String(rel.error)).toContain('(EDENIED)')
  })

  it('refuses a FIFO (stat-before-open — never wedge an fs thread)', async () => {
    const res = await bridgeRpc(923, 'fs.readBounded', { path: path.join(filesDir, 'pipe.fifo') })
    expect(res.ok).not.toBe(true)
    expect(String(res.error)).toContain('(ENOTFILE)')
  })

  it('tags a missing file ENOENT (the replica maps it to the viewer not-found contract)', async () => {
    const res = await bridgeRpc(924, 'fs.readBounded', { path: path.join(filesDir, 'gone.html') })
    expect(res.ok).not.toBe(true)
    expect(String(res.error)).toContain('(ENOENT)')
  })

  it('containment intact: unbounded fs.read is still refused on the bridge', async () => {
    const res = await bridgeRpc(925, 'fs.read', { path: path.join(filesDir, 'index.html') })
    expect(res.ok).not.toBe(true)
    expect(String(res.error)).toContain('not permitted over bridge')
  })

  it('trusted ctl socket can still use fs.readBounded (same handler, no origin gate)', async () => {
    const res = await rpc(ctl, 926, 'fs.readBounded', { path: path.join(filesDir, 'index.html') })
    expect(res.ok).toBe(true)
    expect(Buffer.from(res.data as string, 'base64').toString('utf-8')).toBe(HTML)
  })
})
