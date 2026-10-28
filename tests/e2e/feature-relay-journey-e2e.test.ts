// Real authenticated relay on isolated state and loopback sockets; signal only our child with pid > 1, never a CLI or production daemon.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { WebSocket } from '#ws'
import { z } from 'zod'
import { createMockConstants } from '../helpers/mock-constants.js'
import { childExecGuardEnv, guardedPath } from '../setup/exec-guard.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
vi.mock('../../src/constants.js', () => createMockConstants('feature-journey-e2e', { CLOUD_MODE: true }))
import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createDevice } from '../../src/core/device-auth.js'
import { bridgeHosts } from '../../src/web/ws/bridge-registry.js'
import { featureNodeStore, featureNodeHub } from '../../src/web/ws/feature-node-runtime.js'
import { FeatureNodeClient } from '../../src/core/feature-nodes/feature-client.js'
import { decodeFrame, identifierSchema, type ReadFrame } from '../../src/core/feature-nodes/protocol.js'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

const NODE = 'catalog-node', ACCOUNT = 'catalog-account'
const grant = { capability: { id: 'catalog.page', version: 1 }, fingerprint: 'catalog-v1' }
const rows = Array.from({ length: 205 }, (_, i) => ({
  id: `row-${String(i).padStart(3, '0')}`, title: `Catalog \u8bfb\u53d6 ${i}`,
}))
const inputSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('count') }),
  z.strictObject({ operation: z.literal('page'), offset: z.number().int().min(0).max(205),
    limit: z.number().int().min(1).max(100) }),
])
const outputSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('count'), count: z.literal(205) }),
  z.strictObject({ operation: z.literal('page'), count: z.literal(205),
    offset: z.number().int().min(0).max(205),
    items: z.array(z.strictObject({ id: z.string(), title: z.string() })).max(100),
    nextOffset: z.number().int().min(1).max(205).nullable() }),
])
const readySchema = z.strictObject({ protocolVersion: z.literal(1), type: z.literal('ready'),
  generation: identifierSchema, nodeId: z.literal(NODE), accountId: z.literal(ACCOUNT) })
type Input = z.infer<typeof inputSchema>
// Explicitly limited to unrelated void methods on THIS instance. Never patch its
// prototype, setConnected, connectDirect, verifyCapabilities, send, or handleMessage.
type Background = Record<'pushBridgeConfig' | 'pushDaemonHooks' | 'pushSkillSync' |
  'pushTriggers' | 'pushHostSlice' | 'pushHostReplica' | 'refreshLeader' |
  'startBridgeRepush' | 'startPing' | 'dialBulkChannel', () => void>
const sockets = new Set<WebSocket>()
let root = '', port = 0, serverStarted = false
let daemon: ChildProcess | undefined
let connection: DaemonConnection | undefined
let reader: FeatureNodeClient | undefined

async function until(check: () => boolean, what: string, ms = 8_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() >= end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
}
async function bounded<T>(promise: Promise<T>, what: string, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), ms)
    })])
  } finally { if (timer) clearTimeout(timer) }
}
function own(ws: WebSocket): WebSocket {
  sockets.add(ws)
  ws.on('error', () => { /* The fixture's bounded waits report transport failure. */ })
  return ws
}
async function disconnectFeature(ws: WebSocket): Promise<void> {
  if (!sockets.has(ws)) throw new Error('Refusing an unowned feature socket')
  if (ws.readyState !== WebSocket.CLOSED) ws.terminate()
  await until(() => ws.readyState === WebSocket.CLOSED, 'exact feature socket close')
}
function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}
function signalOwnedDaemon(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (child !== daemon || !Number.isInteger(child.pid) || child.pid! <= 1) {
    throw new Error('Refusing an unowned or unsafe daemon pid')
  }
  if (!hasExited(child)) child.kill(signal)
}
async function stopOwnedDaemon(): Promise<void> {
  const child = daemon
  if (!child || hasExited(child)) return
  signalOwnedDaemon(child, 'SIGTERM')
  try { await until(() => hasExited(child), 'owned daemon SIGTERM exit', 3_000) }
  catch {
    signalOwnedDaemon(child, 'SIGKILL')
    await until(() => hasExited(child), 'owned daemon fallback exit', 5_000)
  }
}

async function bootDaemon(): Promise<number> {
  // The short mkdtemp root also keeps any generated Unix socket under OS limits.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fj-')))
  for (const dir of ['home', 'data', 'daemon', 'state', 'streams', 'tmp', 'tasks', 'source',
    'config', 'cache', 'runtime', 'home/.claude']) fs.mkdirSync(path.join(root, dir), { recursive: true })
  const script = path.join(root, 'source', 'daemon.cjs')
  fs.writeFileSync(script, getDaemonSource(), { mode: 0o700 })
  if (SOURCE_TWIN.runtime === 'node') {
    fs.mkdirSync(path.join(root, 'source', 'node_modules'))
    fs.symlinkSync(path.dirname(createRequire(import.meta.url).resolve('ws/package.json')),
      path.join(root, 'source', 'node_modules', 'ws'))
  }
  const env: NodeJS.ProcessEnv = {
    ...childExecGuardEnv(), HOME: path.join(root, 'home'), WALNUT_HOME_OVERRIDE: path.join(root, 'home'),
    SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'), TMPDIR: path.join(root, 'tmp'),
    XDG_STATE_HOME: path.join(root, 'state'), XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_CACHE_HOME: path.join(root, 'cache'), XDG_RUNTIME_DIR: path.join(root, 'runtime'),
    CLAUDE_CONFIG_DIR: path.join(root, 'home', '.claude'),
    OPEN_WALNUT_HOME: path.join(root, 'data'), WALNUT_HOME: path.join(root, 'data'),
    OPEN_WALNUT_API_URL: `http://127.0.0.1:${port}`,
    WALNUT_DAEMON_DIR: path.join(root, 'daemon'), WALNUT_DAEMON_STATE_DIR: path.join(root, 'state'),
    WALNUT_STREAMS_DIR: path.join(root, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'),
    WALNUT_TASK_DIR_ROOT: path.join(root, 'tasks'), WALNUT_DAEMON_KEEP_SESSIONS: '0',
  }
  daemon = spawn(SOURCE_TWIN.file, [script, '--start'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const child = daemon // Ownership is registered before any asynchronous startup wait.
  let stdout = '', stderr = '', failed: Error | undefined
  child.stdout!.on('data', (chunk) => { stdout = (stdout + String(chunk)).slice(-16_384) })
  child.stderr!.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-8_192) })
  child.on('error', (error) => { failed = error })
  await until(() => {
    if (failed) throw failed
    if (hasExited(child)) throw new Error(`Owned daemon exited during startup: ${stderr}`)
    return /^\d+$/m.test(stdout)
  }, 'owned source daemon port', 60_000)
  const daemonPort = Number(stdout.match(/^\d+$/m)![0])
  expect(Number.isSafeInteger(daemonPort) && daemonPort > 0 && daemonPort <= 65535).toBe(true)
  expect(daemonPort).not.toBe(3456)
  return daemonPort
}

class FeaturePeer {
  readonly ws: WebSocket
  readonly reads: ReadFrame[] = []
  readonly errors: Error[] = []
  generation = ''
  holdNext = false
  constructor(token: string) {
    this.ws = own(new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
      headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 5_000,
    }))
    this.ws.on('message', (data) => {
      try {
        const text = data.toString()
        const ready = readySchema.safeParse(JSON.parse(text))
        if (ready.success) { this.generation = ready.data.generation; return }
        const decoded = decodeFrame(text)
        if (!decoded.success) throw new Error('Invalid synthetic peer frame')
        if (decoded.payload.type === 'cancel') return
        if (decoded.payload.type !== 'read') throw new Error('Unexpected synthetic peer frame')
        const frame = decoded.payload
        this.reads.push(frame)
        if (this.holdNext) { this.holdNext = false; return }
        const input = inputSchema.parse(frame.input)
        const payload = input.operation === 'count' ? { operation: 'count', count: rows.length } : {
          operation: 'page', count: rows.length, offset: input.offset,
          items: rows.slice(input.offset, input.offset + input.limit),
          nextOffset: input.offset + input.limit < rows.length ? input.offset + input.limit : null,
        }
        this.ws.send(JSON.stringify({ protocolVersion: 1, type: 'result',
          generation: frame.generation, correlationId: frame.correlationId, success: true, payload }))
      } catch (error) { this.errors.push(error instanceof Error ? error : new Error(String(error))) }
    })
  }
  async ready(): Promise<this> {
    await until(() => {
      if (this.ws.readyState === WebSocket.CLOSED) throw new Error('Synthetic peer refused')
      return !!this.generation
    }, 'authenticated feature ready')
    this.ws.send(JSON.stringify({ protocolVersion: 1, type: 'manifest', capabilities: [grant.capability] }))
    await expect.poll(async () => (await featureNodeHub().lookup(NODE))?.capabilities).toEqual([grant.capability])
    return this
  }
}
async function refusedToken(token: string): Promise<number> {
  const ws = own(new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
    headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 5_000,
  }))
  return bounded(new Promise<number>((resolve, reject) => {
    ws.once('unexpected-response', (request, response) => {
      response.resume()
      const status = response.statusCode ?? 0
      request.destroy()
      resolve(status)
    })
    ws.once('open', () => { ws.close(); resolve(101) })
    ws.once('error', reject)
  }), 'feature token HTTP refusal', 6_000).finally(() => {
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate()
  })
}
function read(input: Input, accountId = ACCOUNT) {
  return reader!.read({ nodeId: NODE, accountId, capability: grant.capability, input })
}
async function listed(authority: unknown, generation: string): Promise<void> {
  expect(await reader!.list()).toEqual({ success: true, payload: [
    { authority, generation, capabilities: [grant.capability] },
  ] })
}
function resourcesReleased(): void {
  expect(reader!.resources).toEqual({ calls: 0, bytes: 0 })
  expect(featureNodeHub().resources).toEqual({ calls: 0, bytes: 0, verification: 0 })
}

beforeAll(async () => {
  // This is a fresh companion, not a production snapshot. Only its bridge door
  // is enabled: no execution, backup leader, public push, or exposure runtime.
  vi.stubEnv('WALNUT_ROLE', 'replica')
  vi.stubEnv('WALNUT_PLACEMENT', 'cloud')
  vi.stubEnv('WALNUT_HOST_SERVER', '0')
  vi.stubEnv('WALNUT_CAPABILITIES', 'bridge-door')
  vi.stubEnv('WALNUT_NATIVE_HELPERS', '0')
  vi.stubEnv('WALNUT_SEARCH_V2_SEMANTIC', '0')
  const server = await startServer({ port: 0, dev: true })
  serverStarted = true
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Isolated companion port missing')
  port = address.port
  expect(port).not.toBe(3456)
  await fs.promises.mkdir(path.join(WALNUT_HOME, 'secrets'), { recursive: true, mode: 0o700 })
  const daemonPort = await bootDaemon()
  connection = new DaemonConnection('__local__', null)
  const background = connection as unknown as Background
  for (const method of ['pushBridgeConfig', 'pushDaemonHooks', 'pushSkillSync', 'pushTriggers',
    'pushHostSlice', 'pushHostReplica', 'refreshLeader', 'startBridgeRepush', 'startPing', 'dialBulkChannel'] as const) {
    vi.spyOn(background, method).mockImplementation(() => {})
  }
  await connection.connectDirect(`ws://127.0.0.1:${daemonPort}`)
  const callerSocket = (connection as unknown as { ws: WebSocket | null }).ws
  if (!callerSocket) throw new Error('Real DaemonConnection socket missing')
  own(callerSocket)
  expect(connection.connected).toBe(true)
  expect(connection.capabilitiesKnown).toBe(true)
  expect(connection.hasCapability('feature-relay-v1')).toBe(true)
  const machine = await createDevice('bridge-local', { kind: 'machine' })
  expect(await connection.send('leader.configure', { home: WALNUT_HOME, walnutId: 'fixture-primary', backup: false }))
    .toMatchObject({ ok: true })
  expect(await connection.send('bridge.configure', { enabled: true, home: WALNUT_HOME,
    url: `ws://127.0.0.1:${port}/bridge`, token: machine.token, hostAlias: '__local__' }))
    .toMatchObject({ ok: true, applied: true })
  await until(() => bridgeHosts().some((host) => host.hostAlias === '__local__'), 'actual primary bridge hello')
  expect(bridgeHosts().map((host) => host.hostAlias)).toEqual(['__local__'])
  reader = new FeatureNodeClient(() => connection)
  reader.register({ ...grant, input: inputSchema, output: outputSchema })
}, 90_000)

afterAll(async () => {
  const errors: unknown[] = []
  const attempt = async (action: () => unknown | Promise<unknown>) => {
    try { await action() } catch (error) { errors.push(error) }
  }
  reader?.dispose()
  // Disable retries/timers before ending the one daemon we own. Do not use the
  // connection pool, localDaemon singleton, daemon --stop, or any pid discovery.
  await attempt(() => connection?.disconnect())
  await attempt(stopOwnedDaemon)
  for (const ws of sockets) await attempt(() => {
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate()
  })
  // stopServer also handles a partially failed boot; it only owns the mocked home.
  await attempt(() => bounded(stopServer(), 'isolated companion shutdown', 20_000))
  serverStarted = false
  await attempt(() => until(() => [...sockets].every((ws) => ws.readyState === WebSocket.CLOSED), 'owned sockets closed'))
  if (reader) await attempt(() => bounded(reader!.quiet(), 'feature client quiescence'))
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  // Keep evidence and child ownership on any teardown failure. Never delete a
  // live child's state. This removes ONLY the exact root returned by mkdtemp.
  if (errors.length) throw new AggregateError(errors, 'Feature journey teardown failed')
  if (root) fs.rmSync(root, { recursive: true, force: true })
  sockets.clear()
}, 45_000)

describe(`real authenticated feature relay journey on source twin (${SOURCE_TWIN.runtime})`, () => {
  it('reads exact dense pages and survives feature lifecycle and credential changes', async () => {
    expect(serverStarted).toBe(true)
    expect(await reader!.list()).toEqual({ success: true, payload: [] })
    const created = await featureNodeStore().provision({ nodeId: NODE, accountId: ACCOUNT, grants: [grant] })
    const peers: FeaturePeer[] = []
    const first = await new FeaturePeer(created.token).ready()
    peers.push(first)
    await listed(created.authority, first.generation)
    expect(bridgeHosts().map((host) => host.hostAlias)).toEqual(['__local__'])
    for (let round = 0; round < 3; round++) {
      expect(await read({ operation: 'count' })).toEqual({ success: true, payload: { operation: 'count', count: 205 } })
      const received: typeof rows = []
      for (const offset of [0, 100, 200]) {
        const items = rows.slice(offset, offset + 100)
        expect(await read({ operation: 'page', offset, limit: 100 })).toEqual({ success: true, payload: {
          operation: 'page', count: 205, offset, items, nextOffset: offset < 200 ? offset + 100 : null,
        } })
        received.push(...items)
      }
      expect(received).toEqual(rows)
    }
    expect(await read({ operation: 'page', offset: 205, limit: 100 })).toEqual({ success: true, payload: {
      operation: 'page', count: 205, offset: 205, items: [], nextOffset: null,
    } })
    const readsBeforeRefusal = first.reads.length
    expect(await read({ operation: 'count' }, 'other-account')).toEqual({ success: false, code: 'denied' })
    expect(await reader!.read({ nodeId: NODE, accountId: ACCOUNT, capability: grant.capability,
      input: { operation: 'count', unexpected: true } })).toEqual({ success: false, code: 'invalid_input' })
    expect(first.reads).toHaveLength(readsBeforeRefusal)
    resourcesReleased()

    first.holdNext = true
    const pending = read({ operation: 'page', offset: 100, limit: 100 })
    await until(() => first.reads.length === readsBeforeRefusal + 1, 'slow read reaching actual feature peer')
    expect(first.reads.at(-1)).toMatchObject({ nodeId: NODE, accountId: ACCOUNT,
      generation: first.generation, permissionVersion: 1, capability: grant.capability,
      fingerprint: grant.fingerprint, input: { operation: 'page', offset: 100, limit: 100 } })
    expect(reader!.resources.calls).toBe(1)
    expect(featureNodeHub().resources.calls).toBe(1)
    await disconnectFeature(first.ws)
    expect(await pending).toEqual({ success: false, code: 'offline' })
    expect(await reader!.list()).toEqual({ success: true, payload: [] })
    expect(await read({ operation: 'count' })).toEqual({ success: false, code: 'offline' })
    expect(connection!.connected).toBe(true)
    expect(bridgeHosts().map((host) => host.hostAlias)).toEqual(['__local__'])
    resourcesReleased()

    const second = await new FeaturePeer(created.token).ready()
    peers.push(second)
    expect(second.generation).not.toBe(first.generation)
    await listed(created.authority, second.generation)
    expect(await read({ operation: 'count' })).toEqual({ success: true, payload: { operation: 'count', count: 205 } })
    const rotated = await featureNodeStore().rotate(NODE)
    expect(rotated.authority.permissionVersion).toBe(created.authority.permissionVersion + 1)
    // Real discovery re-verifies and drops the stale connection; no hub method
    // is used to synthesize an authority response or a disconnect.
    expect(await reader!.list()).toEqual({ success: true, payload: [] })
    await until(() => second.ws.readyState === WebSocket.CLOSED, 'old permission connection closed')
    expect(await refusedToken(created.token)).toBe(401)
    const latest = await new FeaturePeer(rotated.token).ready()
    peers.push(latest)
    expect(latest.generation).not.toBe(second.generation)
    await listed(rotated.authority, latest.generation)
    expect(await read({ operation: 'page', offset: 200, limit: 100 })).toEqual({ success: true, payload: {
      operation: 'page', count: 205, offset: 200, items: rows.slice(200), nextOffset: null,
    } })
    expect(latest.reads.at(-1)).toMatchObject({ generation: latest.generation, permissionVersion: 2 })
    resourcesReleased()

    await featureNodeStore().revoke(NODE)
    expect(await read({ operation: 'count' })).toEqual({ success: false, code: 'offline' })
    expect(await reader!.list()).toEqual({ success: true, payload: [] })
    await until(() => latest.ws.readyState === WebSocket.CLOSED, 'revoked feature socket closed')
    expect(await refusedToken(rotated.token)).toBe(401)
    expect(await connection!.send('ping', {})).toMatchObject({ ok: true, pong: true })
    expect(bridgeHosts().map((host) => host.hostAlias)).toEqual(['__local__'])
    for (const peer of peers) expect(peer.errors).toEqual([])
    resourcesReleased()
  }, 90_000)
})
