/**
 * Cloud file-content relay E2E — the FULL production chain, zero HTTP mocks:
 *
 *   phone-style fetch (Bearer device token)
 *     → REAL startServer() in CLOUD_MODE (GET /api/v1/file-content)
 *       → REAL /bridge WS upgrade (machine token, bridge-registry)
 *         → REAL daemon-source.ts template process (fs.readBounded,
 *           host-side sandbox + 2MB cap)
 *
 * This is the local pre-verification for the phone HTML preview through the
 * cloud companion (the P1 "File previews aren't available through the cloud
 * companion" dead end): a real HTML file's bytes come back with text/html
 * (raw=1) and as the JSON viewer payload; oversize → 413 too_large; secret
 * path → 403; missing → viewer not-found contract; daemon offline → 503
 * bridge_offline.
 *
 * MACHINE SAFETY: isolated WALNUT_DAEMON_DIR + mock-constants WALNUT_HOME
 * temp dirs; daemon killed in afterAll; never touches /tmp/open-walnut or
 * prod :3456.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-cloud-fileread-relay', { CLOUD_MODE: true }))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createDevice, _resetDeviceAuthForTesting } from '../../src/core/device-auth.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

const HOST_ALIAS = 'relaybox'
const HTML = '<!doctype html>\n<html><body><h1>works from anywhere</h1></body></html>\n'

let server: HttpServer
let port: number
let deviceToken: string
let machineToken: string
let daemonProc: ChildProcess | null = null
let daemonPort = 0
let ctl: WebSocket | null = null
let daemonDir: string
let filesDir: string
let scriptPath: string

function apiUrl(p: string): string {
  return `http://127.0.0.1:${port}${p}`
}

function authedFetch(p: string): Promise<Response> {
  return fetch(apiUrl(p), { headers: { Authorization: `Bearer ${deviceToken}` } })
}

async function spawnDaemon(): Promise<void> {
  const proc = spawn(process.execPath, [scriptPath, '--start'], {
    env: { ...process.env, WALNUT_DAEMON_DIR: daemonDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  daemonPort = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 20_000)
    proc.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })
  daemonProc = proc
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

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await pred()) return
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function bridgeConnected(): Promise<boolean> {
  const res = await authedFetch('/api/v1/file-content?path=/definitely/missing.txt&host=' + HOST_ALIAS)
  // Any answer other than bridge_offline means the bridge is up (the file
  // doesn't exist, so a live bridge yields the 200 viewer not-found payload).
  if (res.status !== 503) { await res.text(); return true }
  await res.text()
  return false
}

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  _resetDeviceAuthForTesting()

  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  ;({ token: deviceToken } = await createDevice('phone'))
  ;({ token: machineToken } = await createDevice(`bridge-${HOST_ALIAS}`, { kind: 'machine' }))

  // Target files served by the daemon.
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-relay-files-'))
  fs.writeFileSync(path.join(filesDir, 'index.html'), HTML)
  fs.writeFileSync(path.join(filesDir, 'whale.html'), Buffer.alloc(2 * 1024 * 1024 + 16, 0x61))
  fs.writeFileSync(path.join(filesDir, 'server.pem'), 'FAKE PEM\n')

  // Real daemon process dialing the REAL /bridge endpoint.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-relay-daemon-'))
  scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
  daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-relay-dir-'))
  await spawnDaemon()
  ctl = await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${daemonPort}`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
  const conf = await rpc(ctl, 1, 'bridge.configure', {
    enabled: true,
    url: `ws://127.0.0.1:${port}/bridge`,
    token: machineToken,
    hostAlias: HOST_ALIAS,
  })
  expect(conf.ok).toBe(true)
  await waitFor(bridgeConnected)
}, 90_000)

afterAll(async () => {
  try { ctl?.close() } catch { /* already closed */ }
  if (daemonProc && daemonProc.exitCode === null) {
    daemonProc.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { try { daemonProc?.kill('SIGKILL') } catch {} resolve() }, 3000)
      daemonProc!.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
  await stopServer()
  fs.rmSync(path.dirname(scriptPath), { recursive: true, force: true })
  fs.rmSync(daemonDir, { recursive: true, force: true })
  fs.rmSync(filesDir, { recursive: true, force: true })
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('phone → cloud server → /bridge → real daemon → file bytes', () => {
  it('raw=1 serves the HTML bytes with text/html (the WKWebView preview URL)', async () => {
    const p = encodeURIComponent(path.join(filesDir, 'index.html'))
    const res = await authedFetch(`/api/v1/file-content?path=${p}&host=${HOST_ALIAS}&raw=1`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toBe(HTML)
  })

  it('JSON mode serves the viewer payload with contentHash', async () => {
    const p = encodeURIComponent(path.join(filesDir, 'index.html'))
    const res = await authedFetch(`/api/v1/file-content?path=${p}&host=${HOST_ALIAS}`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.content).toBe(HTML)
    expect(body.binary).toBe(false)
    expect(body.truncated).toBe(false)
    expect(typeof body.contentHash).toBe('string')
  })

  it('a >2MB file answers 413 too_large with the friendly message', async () => {
    const p = encodeURIComponent(path.join(filesDir, 'whale.html'))
    const res = await authedFetch(`/api/v1/file-content?path=${p}&host=${HOST_ALIAS}&raw=1`)
    expect(res.status).toBe(413)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('too_large')
    expect(body.error.message).toContain('open it on your Mac')
  })

  it('a key file answers 403 (daemon host-side denylist)', async () => {
    const p = encodeURIComponent(path.join(filesDir, 'server.pem'))
    const res = await authedFetch(`/api/v1/file-content?path=${p}&host=${HOST_ALIAS}`)
    expect(res.status).toBe(403)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('not_supported_cloud')
  })

  it('a missing file keeps the legacy viewer contract (200 + error) in JSON mode', async () => {
    const p = encodeURIComponent(path.join(filesDir, 'gone.html'))
    const res = await authedFetch(`/api/v1/file-content?path=${p}&host=${HOST_ALIAS}`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.error).toBe('File not found')
    expect(body.content).toBeNull()
  })

  it('an unknown host answers 503 bridge_offline (degraded, not a hang)', async () => {
    const p = encodeURIComponent(path.join(filesDir, 'index.html'))
    const started = Date.now()
    const res = await authedFetch(`/api/v1/file-content?path=${p}&host=no-such-host`)
    expect(res.status).toBe(503)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('bridge_offline')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('daemon gone → 503 bridge_offline for the real host too', async () => {
    // Kill the daemon and wait for the registry to drop the socket.
    daemonProc!.kill('SIGKILL')
    await waitFor(async () => {
      const p = encodeURIComponent(path.join(filesDir, 'index.html'))
      const res = await authedFetch(`/api/v1/file-content?path=${p}&host=${HOST_ALIAS}`)
      const ok = res.status === 503
      await res.text()
      return ok
    }, 15_000)
  })
})
