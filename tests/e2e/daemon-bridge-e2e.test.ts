/**
 * Daemon cloud-bridge E2E — spawn the REAL daemon-source.ts template as a
 * child process and point its bridge at a fake cloud WS server.
 *
 * Covers: bridge.configure → outbound dial + hello, RPC over the bridge
 * (ping/status), bridge.json persistence → self-heal redial on daemon
 * restart WITHOUT a new configure, server drop → exponential redial, and
 * disable-on-push.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

const HOST_ALIAS = 'bridge-e2e-host'

interface DaemonProc { proc: ChildProcess; port: number }

let scriptPath: string
let daemonDir: string
/** TCP server that never completes the WS upgrade (wedged-dial test). */
let blackHole: net.Server | null = null

function writeDaemonScript(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-bridge-e2e-'))
  const p = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(p, getDaemonSource(), { mode: 0o755 })
  return p
}

async function spawnDaemon(extraEnv: Record<string, string> = {}): Promise<DaemonProc> {
  const proc = spawn('node', [scriptPath, '--start'], {
    env: { ...process.env, WALNUT_DAEMON_DIR: daemonDir, ...extraEnv },
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
    const timer = setTimeout(() => reject(new Error(`rpc timeout: ${cmd}`)), 8000)
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

/** Fake cloud: bare WS server that records connections + frames per socket. */
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
  const cloud: FakeCloud = {
    wss,
    port,
    connections: [],
    close: () => new Promise((resolve) => {
      for (const c of cloud.connections) { try { c.ws.close() } catch {} }
      wss.close(() => resolve())
    }),
  }
  wss.on('connection', (ws, req) => {
    const entry = { ws: ws as unknown as WebSocket, url: req.url ?? '', frames: [] as Array<Record<string, unknown>> }
    cloud.connections.push(entry)
    ws.on('message', (data) => {
      try { entry.frames.push(JSON.parse(data.toString())) } catch { /* ignore */ }
    })
  })
  return cloud
}

async function waitFor(pred: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (pred()) return
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 100))
  }
}

beforeAll(() => {
  scriptPath = writeDaemonScript()
  daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-bridge-e2e-dir-'))
})

afterAll(() => {
  fs.rmSync(path.dirname(scriptPath), { recursive: true, force: true })
  fs.rmSync(daemonDir, { recursive: true, force: true })
})

describe('daemon cloud bridge (real source daemon)', () => {
  it('bridge.configure → dial + hello; RPC works over the bridge; bridge.json self-heals across restart; disable stops it', async () => {
    const cloud = await startFakeCloud()
    let daemon = await spawnDaemon()
    let ctl = await connectWs(daemon.port)
    try {
      // Configure the bridge over the normal control socket.
      const conf = await rpc(ctl, 1, 'bridge.configure', {
        enabled: true,
        url: `ws://127.0.0.1:${cloud.port}/bridge`,
        token: 'test-machine-token',
        hostAlias: HOST_ALIAS,
      })
      expect(conf.ok).toBe(true)

      // Daemon dials out and says hello (token rides the query string).
      await waitFor(() => cloud.connections.some((c) =>
        c.frames.some((f) => f.ev === 'hello' && f.hostAlias === HOST_ALIAS)))
      const conn1 = cloud.connections[0]
      expect(conn1.url).toContain('token=test-machine-token')

      // The bridge socket speaks the full RPC protocol: drive a ping + status.
      const bridgeSideWs = conn1.ws
      const pong = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('bridge rpc timeout')), 8000)
        bridgeSideWs.on('message', (data: Buffer) => {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>
          if (msg.id === 501) { clearTimeout(timer); resolve(msg) }
        })
        bridgeSideWs.send(JSON.stringify({ id: 501, cmd: 'ping' }))
      })
      expect(pong.ok).toBe(true)
      expect(pong.pong).toBe(true)

      // bridge.json persisted beside the registry.
      const bridgeFile = path.join(daemonDir, 'bridge.json')
      expect(fs.existsSync(bridgeFile)).toBe(true)
      const persisted = JSON.parse(fs.readFileSync(bridgeFile, 'utf-8'))
      expect(persisted.enabled).toBe(true)
      expect(persisted.hostAlias).toBe(HOST_ALIAS)

      // Restart the daemon WITHOUT re-pushing configure → self-heal redial.
      const before = cloud.connections.length
      ctl.close()
      await stopDaemon(daemon)
      daemon = await spawnDaemon()
      ctl = await connectWs(daemon.port)
      await waitFor(() => cloud.connections.length > before
        && cloud.connections.slice(before).some((c) => c.frames.some((f) => f.ev === 'hello')))

      // Disable via configure → daemon closes its bridge socket.
      const liveBefore = cloud.connections.filter((c) => c.ws.readyState === 1).length
      expect(liveBefore).toBeGreaterThan(0)
      const off = await rpc(ctl, 2, 'bridge.configure', { enabled: false })
      expect(off.ok).toBe(true)
      await waitFor(() => cloud.connections.every((c) => c.ws.readyState !== 1))
      const persistedOff = JSON.parse(fs.readFileSync(bridgeFile, 'utf-8'))
      expect(persistedOff.enabled).toBe(false)
    } finally {
      try { ctl.close() } catch { /* already closed */ }
      await stopDaemon(daemon)
      await cloud.close()
    }
  }, 60_000)

  // Security regression (CRITICAL-1): the cloud box is a PUBLIC relay, so a
  // frame arriving over the bridge socket must be restricted to the phone-proxy
  // command set. Privileged commands (fs.write / start / bridge.configure) that
  // a compromised cloud box could use for RCE/exfil must be refused — they stay
  // reachable only over the trusted SSH control socket.
  it('bridge socket cannot invoke privileged commands (fs.write refused, status allowed)', async () => {
    const cloud = await startFakeCloud()
    const daemon = await spawnDaemon()
    const ctl = await connectWs(daemon.port)
    const victimFile = path.join(daemonDir, 'pwned-via-bridge.txt')
    try {
      await rpc(ctl, 1, 'bridge.configure', {
        enabled: true,
        url: `ws://127.0.0.1:${cloud.port}/bridge`,
        token: 't',
        hostAlias: HOST_ALIAS,
      })
      await waitFor(() => cloud.connections.some((c) => c.frames.some((f) => f.ev === 'hello')))
      const bridgeSideWs = cloud.connections[0].ws

      // Drive an RPC over the bridge socket and await its {id} response.
      const bridgeRpc = (id: number, cmd: string, params: Record<string, unknown> = {}) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`bridge rpc timeout: ${cmd}`)), 8000)
          const onMessage = (data: Buffer) => {
            const msg = JSON.parse(data.toString()) as Record<string, unknown>
            if (msg.id === id) { clearTimeout(timer); bridgeSideWs.off('message', onMessage); resolve(msg) }
          }
          bridgeSideWs.on('message', onMessage)
          bridgeSideWs.send(JSON.stringify({ id, cmd, ...params }))
        })

      // fs.write is NOT in the allowlist → refused, and no file is created.
      const denied = await bridgeRpc(701, 'fs.write', {
        path: victimFile,
        data: Buffer.from('pwned').toString('base64'),
      })
      expect(denied.ok).not.toBe(true)
      expect(String(denied.error ?? '')).toContain('not permitted over bridge')
      expect(fs.existsSync(victimFile)).toBe(false)

      // status IS allowlisted → still works over the bridge.
      const ok = await bridgeRpc(702, 'status', { sid: 'no-such-session' })
      expect(ok.ok).toBe(true)
    } finally {
      try { ctl.close() } catch { /* already closed */ }
      await stopDaemon(daemon)
      await cloud.close()
    }
  }, 60_000)

  // RC1 of the 2-day cloud-bridge wedge: a dial stuck before the WS upgrade
  // completes (TCP established, onopen never fires) was NEVER torn down —
  // the silence watchdog only started in onopen. The dial timeout must
  // abandon the wedged socket and redial until the cloud answers properly.
  //
  // PINNING NOTE (why the assertion is an accept COUNT): a wedged socket that
  // is later destroyed sends a TCP reset, which fires onclose even from
  // CONNECTING — so any variant that tears the black hole down before
  // asserting lets PRE-FIX code pass too (verified empirically). Here the
  // black hole STAYS wedged for the whole assertion window: accepted sockets
  // are never destroyed and never answered, so the ONLY thing that can
  // abandon a CONNECTING socket and produce a second accept is the dial
  // timeout itself. Pre-fix = exactly 1 accept forever; post-fix = a fresh
  // accept every dial-timeout + backoff cycle (measured 1 vs 6 in 8s).
  it('wedged dial (TCP accepted, upgrade never completes) → dial timeout keeps redialing; recovery connects', async () => {
    // Black hole: accepts TCP, never answers the HTTP upgrade. Sockets are
    // destroyed ONLY in closeBlackHole(), which runs strictly AFTER the
    // accept-count assertions (see pinning note above).
    const blackHoleSockets: net.Socket[] = []
    let acceptCount = 0
    const closeBlackHole = () => new Promise<void>((r) => {
      for (const s of blackHoleSockets) { try { s.destroy() } catch {} }
      if (blackHole) blackHole.close(() => r()); else r()
      blackHole = null
    })
    const blackHolePort = await new Promise<number>((resolve) => {
      const srv = net.createServer((sock) => { acceptCount++; blackHoleSockets.push(sock) })
      srv.listen(0, '127.0.0.1', () => resolve((srv.address() as net.AddressInfo).port))
      blackHole = srv
    })

    // Lowered dial timeout so several timeout→redial cycles fit in seconds.
    const daemon = await spawnDaemon({ WALNUT_BRIDGE_DIAL_TIMEOUT_MS: '1000' })
    const ctl = await connectWs(daemon.port)
    let cloud: FakeCloud | null = null
    try {
      await rpc(ctl, 1, 'bridge.configure', {
        enabled: true,
        url: `ws://127.0.0.1:${blackHolePort}/bridge`,
        token: 't',
        hostAlias: HOST_ALIAS,
      })

      // Progress only the dial timeout can produce: ≥3 accepts while wedged.
      // Cycle ≈ 1s dial timeout + 1s/2s/… backoff → 3rd accept lands ~5s in;
      // 20s is generous under CI load. Pre-fix this waitFor times out at 1.
      await waitFor(() => acceptCount >= 3, 20_000)
      expect(acceptCount).toBeGreaterThanOrEqual(3)

      // Now END the wedge (assertions above are done): free the port and
      // stand up a real cloud on it — the next redial must complete a
      // healthy WS connect + hello (redial recovers, not just churns).
      await closeBlackHole()
      cloud = await new Promise<FakeCloud>((resolve, reject) => {
        const wss = new WebSocketServer({ port: blackHolePort, host: '127.0.0.1' })
        const c: FakeCloud = {
          wss, port: blackHolePort, connections: [],
          close: () => new Promise((res) => { for (const conn of c.connections) { try { conn.ws.close() } catch {} } wss.close(() => res()) }),
        }
        wss.on('connection', (ws, req) => {
          const entry = { ws: ws as unknown as WebSocket, url: req.url ?? '', frames: [] as Array<Record<string, unknown>> }
          c.connections.push(entry)
          ws.on('message', (data) => { try { entry.frames.push(JSON.parse(data.toString())) } catch {} })
        })
        wss.on('listening', () => resolve(c))
        wss.on('error', reject)
      })
      // Backoff may have grown to ~8-16s by now; allow a full cycle.
      await waitFor(() => cloud!.connections.some((c) => c.frames.some((f) => f.ev === 'hello')), 40_000)
      const conf = await rpc(ctl, 2, 'bridge.configure', {
        enabled: true, url: `ws://127.0.0.1:${blackHolePort}/bridge`, token: 't', hostAlias: HOST_ALIAS,
      })
      expect(conf.connected).toBe(true)
    } finally {
      // Teardown only — all socket destruction happens after assertions.
      try { ctl.close() } catch { /* already closed */ }
      await stopDaemon(daemon)
      if (cloud) await cloud.close()
      await closeBlackHole()
    }
  }, 90_000)

  // RC2 companion: an identical config push against a HEALTHY bridge must be
  // a no-op (no reconnect churn), while still reporting connected:true.
  it('identical config push on a healthy bridge does not reconnect (reconcile no-op)', async () => {
    const cloud = await startFakeCloud()
    const daemon = await spawnDaemon()
    const ctl = await connectWs(daemon.port)
    try {
      const cfg = {
        enabled: true,
        url: `ws://127.0.0.1:${cloud.port}/bridge`,
        token: 't',
        hostAlias: HOST_ALIAS,
      }
      await rpc(ctl, 1, 'bridge.configure', cfg)
      await waitFor(() => cloud.connections.some((c) => c.frames.some((f) => f.ev === 'hello')))
      const before = cloud.connections.length

      const again = await rpc(ctl, 2, 'bridge.configure', cfg)
      expect(again.ok).toBe(true)
      expect(again.connected).toBe(true)
      // No new dial: the healthy adapter short-circuits the reconcile.
      await new Promise((r) => setTimeout(r, 1000))
      expect(cloud.connections.length).toBe(before)
    } finally {
      try { ctl.close() } catch { /* already closed */ }
      await stopDaemon(daemon)
      await cloud.close()
    }
  }, 60_000)

  it('cloud drop → daemon redials with backoff', async () => {
    let cloud = await startFakeCloud()
    const cloudPort = cloud.port
    const daemon = await spawnDaemon()
    const ctl = await connectWs(daemon.port)
    try {
      await rpc(ctl, 1, 'bridge.configure', {
        enabled: true,
        url: `ws://127.0.0.1:${cloudPort}/bridge`,
        token: 't',
        hostAlias: HOST_ALIAS,
      })
      await waitFor(() => cloud.connections.some((c) => c.frames.some((f) => f.ev === 'hello')))

      // Kill the cloud → daemon should redial once it's back on the same port.
      await cloud.close()
      await new Promise((r) => setTimeout(r, 500))
      cloud = await new Promise<FakeCloud>((resolve, reject) => {
        const wss = new WebSocketServer({ port: cloudPort, host: '127.0.0.1' })
        const c: FakeCloud = {
          wss, port: cloudPort, connections: [],
          close: () => new Promise((res) => { for (const conn of c.connections) { try { conn.ws.close() } catch {} } wss.close(() => res()) }),
        }
        wss.on('connection', (ws, req) => {
          const entry = { ws: ws as unknown as WebSocket, url: req.url ?? '', frames: [] as Array<Record<string, unknown>> }
          c.connections.push(entry)
          ws.on('message', (data) => { try { entry.frames.push(JSON.parse(data.toString())) } catch {} })
        })
        wss.on('listening', () => resolve(c))
        wss.on('error', reject)
      })
      await waitFor(() => cloud.connections.some((c) => c.frames.some((f) => f.ev === 'hello')), 20_000)
    } finally {
      try { ctl.close() } catch { /* already closed */ }
      await stopDaemon(daemon)
      await cloud.close()
    }
  }, 60_000)
})
