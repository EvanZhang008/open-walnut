/**
 * The cloud box gets every feature a link host has, end to end: a port forward (the
 * session's Web preview, the embedded VS Code), a script run and a checked upload (a
 * plugin job's code), through the companion's real /daemon-tunnel handler
 * (web/ws/daemon-tunnel.ts) to the real standalone daemon twin under bun, the build the
 * companion runs as the box's tunnel daemon.
 *
 *   DaemonConnection('__cloudbox__') ─ws─▶ tunnel handler ─ws 127.0.0.1─▶ daemon twin
 *
 * What it proves beyond the host network's own tests: the tunnel passes port streams,
 * exec.run and fs.writePart on verbatim, and the daemon takes the tunnel's socket for the
 * Walnut server's own (a port stream is opened only for a server client). Every `ssh` is
 * refused here: none may run for the cloud box.
 *
 * Stubbed: the pairing lookup (which companion, which token), as in
 * daemon-connection-cloud-tunnel.test.ts; the tunnel's credential check is a table.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths, every service
 * is a server this test listens on, and the only process ended is the daemon this test
 * spawned, through its own handle (TERM, then KILL after a deadline).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-cloudbox-link-features'))

const sshSpawns = vi.hoisted(() => [] as string[][])
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return {
    ...original,
    spawn: vi.fn((cmd: string, args: string[], opts?: unknown) => {
      if (cmd === 'ssh') { sshSpawns.push(args); throw new Error('ssh refused by the test: the cloud box has no SSH') }
      return original.spawn(cmd, args, opts as never)
    }),
  }
})

const endpoint = vi.hoisted(() => ({ url: '', token: 'primary-machine-token' }))
vi.mock('../../src/core/hosts/cloud-box-probe.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/core/hosts/cloud-box-probe.js')>()
  const e = () => ({ url: endpoint.url, headers: { Authorization: `Bearer ${endpoint.token}` }, domain: '127.0.0.1', token: endpoint.token })
  return {
    ...original,
    resolveCloudTunnelEndpoint: vi.fn(async () => e()),
    openCloudTunnel: vi.fn(async (connect: (x: ReturnType<typeof e>) => Promise<void>) => connect(e())),
    refreshCloudBoxHost: vi.fn(async () => null),
  }
})

import { DaemonConnection, setPooledConnectionForTest } from '../../src/providers/daemon-connection.js'
import { closeAllDaemonTunnels, handleDaemonTunnelUpgrade } from '../../src/web/ws/daemon-tunnel.js'
import { CLOUD_BOX_HOST_ALIAS, resetCloudBoxStateForTest, setCloudBoxState } from '../../src/core/hosts/cloud-box-host.js'
import { testBun } from '../helpers/bun-runtime.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'
import { guardedPath } from '../setup/exec-guard.js'

const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')

let root = ''
let home = ''
let proc: ChildProcess | null = null
let tunnel: http.Server | null = null
let service: http.Server | null = null
let conn: DaemonConnection | null = null

async function bootDaemon(): Promise<number> {
  root = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'wclf-')))
  home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  const daemonDir = path.join(root, 'daemon')
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: guardedPath([], '/usr/bin:/bin'),
    HOME: home,
    WALNUT_DAEMON_DIR: daemonDir,
    WALNUT_STREAMS_DIR: path.join(root, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'),
  }
  proc = spawn(BUN!, [STANDALONE, '--start'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc!.on('error', (err) => { clearTimeout(timer); reject(err) })
    onDaemonEarlyExit(proc!, { daemonDir }, (err) => { clearTimeout(timer); reject(err) })
  })
}

/** The companion's tunnel route on a loopback server, in front of the daemon at `daemonPort`. */
async function startTunnel(daemonPort: number): Promise<number> {
  tunnel = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
  tunnel.on('upgrade', (req, socket, head) => {
    const token = req.headers.authorization?.replace(/^Bearer /, '')
    void handleDaemonTunnelUpgrade(req, socket, head, {
      verify: async () => (token === 'primary-machine-token' ? { name: 'bridge-local', kind: 'machine' as const } : null),
      execEnabled: async () => true,
      ensureDaemon: async () => `ws://127.0.0.1:${daemonPort}`,
      stillValid: async () => true,
    })
  })
  await new Promise<void>((resolve) => tunnel!.listen(0, '127.0.0.1', resolve))
  return (tunnel.address() as net.AddressInfo).port
}

async function stopOwnDaemon(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<boolean>((resolve) => child.once('exit', () => resolve(true)))
  const within = (ms: number) => Promise.race([exited, new Promise<boolean>((r) => setTimeout(() => r(false), ms))])
  child.kill('SIGTERM')
  if (await within(5_000)) return
  child.kill('SIGKILL')
  await within(3_000)
}

function get(port: number, p = '/'): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, agent: false }, (res) => {
      const parts: Buffer[] = []
      res.on('data', (b: Buffer) => parts.push(b))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts) }))
      res.on('error', reject)
      res.on('close', () => { if (!res.complete) reject(new Error('the answer was cut')) })
    })
    req.on('error', reject)
  })
}

const run = BUN ? describe : describe.skip

run('the cloud box, through the companion tunnel, with SSH refused', () => {
  beforeAll(async () => {
    const daemonPort = await bootDaemon()
    const tunnelPort = await startTunnel(daemonPort)
    endpoint.url = `ws://127.0.0.1:${tunnelPort}/daemon-tunnel`
    resetCloudBoxStateForTest()
    setCloudBoxState({ domain: `127.0.0.1:${tunnelPort}`, secure: false, capability: 'unknown', checkedAt: null })
    conn = new DaemonConnection(CLOUD_BOX_HOST_ALIAS, { hostname: `127.0.0.1:${tunnelPort}` })
    // The pool's connection: a checked upload's parts find the host's link there (daemon-transfer-client.ts).
    setPooledConnectionForTest(CLOUD_BOX_HOST_ALIAS, conn)
    await conn.connect()
  }, 90_000)

  afterAll(async () => {
    setPooledConnectionForTest(CLOUD_BOX_HOST_ALIAS, null)
    conn?.disconnect()
    closeAllDaemonTunnels()
    await new Promise<void>((r) => (tunnel ? tunnel.close(() => r()) : r()))
    await new Promise<void>((r) => (service ? service.close(() => r()) : r()))
    if (proc) await stopOwnDaemon(proc)
    if (root.includes('wclf-')) fs.rmSync(root, { recursive: true, force: true })
  }, 30_000)

  it('forwards a service on the box (the Web preview and the embedded VS Code), binary answers whole', async () => {
    expect(conn!.connected).toBe(true)
    expect(conn!.hasCapability('port-stream-v1')).toBe(true)
    // Its hello through the tunnel: the machine's own name (a preview URL naming it) and its dir.
    expect(conn!.daemonHostname).toBe(os.hostname())
    expect(conn!.daemonDir).toBe(path.join(root, 'daemon'))
    const body = Buffer.alloc(1024 * 1024 + 5)
    for (let i = 0; i < body.length; i++) body[i] = (i * 13) & 0xff
    service = http.createServer((req, res) => { if (req.url === '/bin') res.end(body); else res.end(`box ${req.url}`) })
    await new Promise<void>((r) => service!.listen(0, '127.0.0.1', () => r()))
    const svcPort = (service.address() as net.AddressInfo).port

    // The preview's own call (evictable, localhost), then the embedded VS Code's (default target).
    const local = await conn!.ensurePortForward(svcPort, 'localhost', { evictable: true })
    expect(local).not.toBe(svcPort)
    expect(await get(local, '/app?x=1')).toEqual({ status: 200, body: Buffer.from('box /app?x=1') })
    expect((await get(local, '/bin')).body.equals(body)).toBe(true)
    const parallel = await Promise.all(Array.from({ length: 4 }, (_, i) => get(local, `/p${i}`)))
    expect(parallel.map((r) => r.body.toString())).toEqual(Array.from({ length: 4 }, (_, i) => `box /p${i}`))
    const vscode = await conn!.ensurePortForward(svcPort)
    expect((await get(vscode, '/')).body.toString()).toBe('box /')
    // Never a non-loopback address on the box, in a sentence naming Cloud.
    await expect(conn!.ensurePortForward(svcPort, '10.0.0.8')).rejects.toThrow(/^Port forwarding on Cloud goes through the cloud companion and reaches only its own loopback/)
    expect(sshSpawns).toEqual([])
  }, 60_000)

  it('runs a script on the box and uploads a checked file, which a second upload skips', async () => {
    expect((await conn!.runRemoteScript('printf "on the box: %s" "$((40 + 2))"', 20_000)).trim()).toBe('on the box: 42')
    const data = crypto.randomBytes(600 * 1024 + 7)
    const sha256 = crypto.createHash('sha256').update(data).digest('hex')
    const file = path.join(home, '.open-walnut', 'tmp', 'plugin-jobs', 'bundles', `${sha256}.mjs`)
    expect(await conn!.uploadFile(file, data, { sha256 })).toEqual({ skipped: false })
    expect(fs.readFileSync(file).equals(data)).toBe(true)
    expect(await conn!.uploadFile(file, data, { sha256 })).toEqual({ skipped: true })
    expect(sshSpawns).toEqual([])
  }, 60_000)
})
