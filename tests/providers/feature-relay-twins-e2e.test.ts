// Real relay, isolated homes and owned loopback sockets; signal only our child with pid > 1, never a CLI or production daemon.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from '#ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { REQUIRED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'
import { childExecGuardEnv, guardedPath } from '../setup/exec-guard.js'
import { bunRuntime } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'

const STANDALONE = path.resolve(import.meta.dirname, '../../src/providers/daemon-standalone.ts')
const WS_PACKAGE = path.dirname(createRequire(import.meta.url).resolve('ws/package.json'))
const BUN = bunRuntime()
type Twin = { name: string; executable: string; standalone: boolean; withWs: boolean; wsClient?: 'builtin' | 'ws' }
const TWINS: Twin[] = [
  { name: 'source twin (bun)', executable: BUN, standalone: false, withWs: false },
  ...(SOURCE_TWIN.runtime === 'node' ? [
    { name: 'source twin (node), builtin WebSocket', executable: SOURCE_TWIN.file, standalone: false, withWs: false, wsClient: 'builtin' as const },
    { name: 'source twin (node), installed ws', executable: SOURCE_TWIN.file, standalone: false, withWs: true, wsClient: 'ws' as const },
  ] : []),
  { name: 'standalone twin (bun)', executable: BUN, standalone: true, withWs: false },
]

type Frame = Record<string, unknown>
let root = ''
let nextId = 1
const children = new Set<ChildProcess>()
const sockets = new Set<WebSocket>()
const servers: Array<() => Promise<void>> = []
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function until(check: () => boolean, what: string, ms = 8_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() >= end) throw new Error(`Timed out waiting for ${what}`)
    await pause(20)
  }
}

class Peer {
  readonly frames: Frame[] = []
  constructor(readonly ws: WebSocket) {
    sockets.add(ws)
    ws.on('error', () => { /* The open/RPC deadlines report connection failure. */ })
    ws.on('message', (data) => { this.frames.push(JSON.parse(String(data)) as Frame) })
  }
  send(frame: Frame): number {
    const id = typeof frame.id === 'number' ? frame.id : nextId++
    this.ws.send(JSON.stringify({ ...frame, id }))
    return id
  }
  replies(id: number): Frame[] { return this.frames.filter((f) => f.id === id) }
  async reply(id: number, index = 0): Promise<Frame> {
    await until(() => this.replies(id).length > index, `RPC ${id}`)
    return this.replies(id)[index]
  }
  async rpc(frame: Frame): Promise<Frame> { return this.reply(this.send(frame)) }
  requests(): Frame[] { return this.frames.filter((f) => f.ev === 'feature-request') }
  async request(index = 0): Promise<Frame> {
    await until(() => this.requests().length > index, `feature-request ${index}`)
    return this.requests()[index]
  }
}

async function connect(port: number): Promise<Peer> {
  expect(port).not.toBe(3456)
  const peer = new Peer(new WebSocket(`ws://127.0.0.1:${port}`))
  await until(() => peer.ws.readyState === WebSocket.OPEN, 'local socket open')
  return peer
}

async function closePeer(peer: Peer): Promise<void> {
  if (peer.ws.readyState === WebSocket.CLOSED) return
  peer.ws.terminate() // This exact socket was created or accepted by this fixture.
  await until(() => peer.ws.readyState === WebSocket.CLOSED, 'owned socket close')
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fr-'))) // Short enough for macOS Unix sockets.
  nextId = 1
})

afterEach(async () => {
  const errors: unknown[] = []
  // End our daemon before closing its loopback bridge, so no redial outlives teardown.
  for (const child of children) {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        if (!Number.isInteger(child.pid) || child.pid! <= 1) throw new Error('Refusing an unowned or unsafe daemon pid')
        child.kill('SIGTERM')
        try { await until(() => child.exitCode !== null || child.signalCode !== null, 'owned daemon exit', 3_000) }
        catch { child.kill('SIGKILL'); await until(() => child.exitCode !== null || child.signalCode !== null, 'owned daemon kill', 5_000) }
      }
    } catch (error) { errors.push(error) }
  }
  for (const ws of sockets) {
    try { if (ws.readyState !== WebSocket.CLOSED) ws.terminate() }
    catch (error) { errors.push(error) }
  }
  for (const close of servers.splice(0).reverse()) {
    try { await close() } catch (error) { errors.push(error) }
  }
  try { await until(() => [...sockets].every((ws) => ws.readyState === WebSocket.CLOSED), 'all owned WebSockets closed') }
  catch (error) { errors.push(error) }
  // Do not delete a live child's state or forget ownership when teardown failed.
  if (errors.length) throw new AggregateError(errors, 'Fixture teardown failed')
  children.clear()
  sockets.clear()
  fs.rmSync(root, { recursive: true, force: true }) // Only our mkdtemp root.
  root = ''
}, 30_000)

async function boot(twin: Twin, companionPort: number): Promise<{ caller: Peer; port: number }> {
  const dirs = ['home', 'data', 'daemon', 'daemon-state', 'streams', 'tmp', 'task-dirs', 'source']
  for (const dir of dirs) fs.mkdirSync(path.join(root, dir), { recursive: true })
  const script = path.join(root, 'source', 'daemon.cjs')
  const entry = twin.standalone ? STANDALONE : script
  if (!twin.standalone) {
    const source = getDaemonSource()
    const legacyCryptoSource = twin.wsClient
      ? source.replace(/^(#![^\n]*\n)/, "$1Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });\n") : source
    fs.writeFileSync(script, legacyCryptoSource, { mode: 0o700 })
    if (twin.withWs) {
      fs.mkdirSync(path.join(root, 'source', 'node_modules'))
      fs.symlinkSync(WS_PACKAGE, path.join(root, 'source', 'node_modules', 'ws'))
    }
  }
  // Do not inherit a bridge URL, credential, HOME override, sidecar path or real
  // API root from the calling session. Preserve only the test exec guard hooks.
  const env: NodeJS.ProcessEnv = {
    ...childExecGuardEnv(),
    HOME: path.join(root, 'home'), WALNUT_HOME_OVERRIDE: path.join(root, 'home'),
    SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'), TMPDIR: path.join(root, 'tmp'),
    XDG_STATE_HOME: path.join(root, 'home', '.local', 'state'),
    XDG_CONFIG_HOME: path.join(root, 'home', '.config'), XDG_CACHE_HOME: path.join(root, 'home', '.cache'),
    CLAUDE_CONFIG_DIR: path.join(root, 'home', '.claude'),
    OPEN_WALNUT_HOME: path.join(root, 'data'), WALNUT_HOME: path.join(root, 'data'),
    OPEN_WALNUT_API_URL: `http://127.0.0.1:${companionPort}`,
    WALNUT_DAEMON_DIR: path.join(root, 'daemon'), WALNUT_DAEMON_STATE_DIR: path.join(root, 'daemon-state'),
    WALNUT_STREAMS_DIR: path.join(root, 'streams'), WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'),
    WALNUT_TASK_DIR_ROOT: path.join(root, 'task-dirs'), WALNUT_DAEMON_KEEP_SESSIONS: '0',
  }
  const child = spawn(twin.executable, [entry, '--start'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child) // Register before awaiting startup, including partial startup failure.
  let stdout = '', stderr = '', failed: Error | undefined
  child.stdout!.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr!.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-8_192) })
  child.on('error', (error) => { failed = error })
  await until(() => {
    if (failed) throw failed
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Daemon exited during startup: ${stderr}`)
    return /^\d+$/m.test(stdout)
  }, `daemon port (${twin.name}); stderr: ${stderr}`, 60_000)
  const port = Number(stdout.match(/^\d+$/m)![0])
  expect(Number.isSafeInteger(port) && port > 0 && port <= 65535).toBe(true)
  return { caller: await connect(port), port }
}

async function companion() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  let failed: Error | undefined
  wss.on('error', (error) => { failed = error })
  const peers: Peer[] = []
  servers.push(() => new Promise<void>((resolve, reject) => wss.close((error) => error ? reject(error) : resolve())))
  wss.on('connection', (ws) => {
    const peer = new Peer(ws)
    peers.push(peer)
    ws.on('message', (data) => {
      const f = JSON.parse(String(data)) as Frame
      if (f.ev === 'bridge-ping') peer.send({ cmd: 'ping', ackSeq: f.seq })
    })
  })
  await until(() => { if (failed) throw failed; return wss.address() !== null }, 'owned companion listener')
  return {
    port: (wss.address() as net.AddressInfo).port,
    async peer(index = 0): Promise<Peer> {
      await until(() => peers.length > index && peers[index].frames.some((f) => f.ev === 'hello'), `bridge hello ${index}`)
      return peers[index]
    },
  }
}

async function configure(caller: Peer, port: number, hostAlias = '__local__'): Promise<void> {
  expect(port).not.toBe(3456)
  const home = path.join(root, 'data')
  expect(await caller.rpc({ cmd: 'leader.configure', home, walnutId: 'fixture-primary', backup: false }))
    .toMatchObject({ ok: true })
  expect(await caller.rpc({ cmd: 'bridge.configure', enabled: true, home,
    url: `ws://127.0.0.1:${port}/bridge`, token: 'fixture-only', hostAlias }))
    .toMatchObject({ ok: true, applied: true })
}

async function rig(twin: Twin, hostAlias = '__local__') {
  const cloud = await companion()
  const { caller, port } = await boot(twin, cloud.port)
  await configure(caller, cloud.port, hostAlias)
  const bridge = await cloud.peer()
  if (twin.wsClient) expect(daemonLogs().filter((f) => f.msg === 'bridge-conn-open').map((f) => f.wsClient)).toEqual([twin.wsClient])
  return { cloud, caller, port, bridge }
}

async function pending(caller: Peer, id: number): Promise<void> {
  // A later reply on the same socket proves the feature command was dispatched.
  expect(await caller.rpc({ cmd: 'ping' })).toMatchObject({ ok: true, pong: true })
  await pause(100)
  expect(caller.replies(id), 'uplink acceptance must not settle the request').toEqual([])
}

async function result(bridge: Peer, request: Frame, payload: unknown, accepted = true) {
  expect(await bridge.rpc({ cmd: 'feature.result', requestId: request.requestId, result: payload }))
    .toMatchObject({ ok: true, accepted })
}

function daemonLogs(): Frame[] {
  const dir = path.join(root, 'daemon')
  return fs.readdirSync(dir).filter((f) => /^daemon-.*\.log$/.test(f)).flatMap((f) =>
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n')).flatMap((line) => {
      try { return [JSON.parse(line) as Frame] } catch { return [] }
    })
}

function localDisconnects(): number {
  return daemonLogs().filter((f) => f.msg === 'client disconnected').length
}

describe.each(TWINS)('feature relay on $name', (twin) => {
  it('advertises the optional capability on the real local and bridge hellos', async () => {
    const { caller, bridge } = await rig(twin)
    const hello = await caller.rpc({ cmd: 'hello' })
    expect(hello.ok).toBe(true)
    expect(hello.capabilities).toContain('feature-relay-v1')
    expect(bridge.frames.find((f) => f.ev === 'hello')).toMatchObject({ hostAlias: '__local__' })
    expect(bridge.frames.find((f) => f.ev === 'hello')!.capabilities).toContain('feature-relay-v1')
    expect([...REQUIRED_DAEMON_CAPABILITIES]).not.toContain('feature-relay-v1')
  }, 90_000)

  it('forwards exact list/read frames and settles only the actual ACK, out of order', async () => {
    const { caller, bridge } = await rig(twin)
    const unicode = String.fromCodePoint(0x8bfb, 0x53d6)
    const read = JSON.stringify({ nodeId: 'fixture-node', feature: 'reader', operation: 'list',
      input: { query: unicode, text: 'line\n'.repeat(2_000) } })
    const listId = caller.send({ cmd: 'feature.request', frame: null })
    const readId = caller.send({ cmd: 'feature.request', frame: read })
    const listRequest = await bridge.request(0), readRequest = await bridge.request(1)
    expect(listRequest.frame).toBeNull()
    expect(readRequest.frame).toBe(read)
    expect(typeof listRequest.requestId).toBe('string')
    expect(readRequest.requestId).not.toBe(listRequest.requestId)
    await pending(caller, listId); await pending(caller, readId)
    const payload = { success: true, payload: { rows: [{ id: 'fixture-row', title: unicode }] } }
    await result(bridge, readRequest, payload)
    expect(await caller.reply(readId)).toEqual({ id: readId, ok: true, result: payload })
    await pending(caller, listId)
    await result(bridge, listRequest, { success: true, payload: [] })
    expect(await caller.reply(listId)).toEqual({ id: listId, ok: true, result: { success: true, payload: [] } })
    // A subsequent request also carries a feature failure unchanged, not a false success.
    const retryId = caller.send({ cmd: 'feature.request', frame: read })
    await result(bridge, await bridge.request(2), { success: false, code: 'unavailable' })
    expect(await caller.reply(retryId)).toMatchObject({ result: { success: false, code: 'unavailable' } })
    expect(caller.replies(readId)).toHaveLength(1)
  }, 90_000)

  it('refuses a forged result from another local socket or the caller, and rejects duplicate ACKs', async () => {
    const { caller, port, bridge } = await rig(twin)
    const imposter = await connect(port)
    const id = caller.send({ cmd: 'feature.request', frame: 'fixture-read' })
    const request = await bridge.request()
    for (const local of [imposter, caller]) {
      expect(await local.rpc({ cmd: 'feature.result', requestId: request.requestId,
        result: { success: true, payload: 'forged' } })).toMatchObject({ ok: false, error: 'Feature result refused' })
      await pending(caller, id)
    }
    await result(bridge, request, { success: true, payload: 'owned' })
    expect(await caller.reply(id)).toMatchObject({ result: { payload: 'owned' } })
    await result(bridge, request, { success: true, payload: 'duplicate' }, false)
    expect(caller.replies(id)).toHaveLength(1)
  }, 90_000)

  it('refuses bridge-origin feature.request without relaying or allocating a pending request', async () => {
    const { caller, bridge } = await rig(twin)
    expect(await bridge.rpc({ cmd: 'feature.request', frame: null })).toMatchObject({
      ok: false, error: 'command not permitted over bridge: feature.request',
    })
    expect(await bridge.rpc({ cmd: 'ping' })).toMatchObject({ ok: true, pong: true })
    expect(bridge.requests()).toEqual([])
    const id = caller.send({ cmd: 'feature.request', frame: null })
    await result(bridge, await bridge.request(), { success: true, payload: [] })
    expect(await caller.reply(id)).toMatchObject({ result: { success: true } })
  }, 90_000)

  it('refuses a trusted local request when the configured host alias is nonlocal', async () => {
    const { caller, bridge } = await rig(twin, 'fixture-host')
    for (const frame of [null, 'fixture-read']) {
      expect(await caller.rpc({ cmd: 'feature.request', frame }))
        .toMatchObject({ ok: false, error: 'Feature request refused' })
    }
    expect(await bridge.rpc({ cmd: 'ping' })).toMatchObject({ ok: true })
    expect(bridge.requests()).toEqual([])
  }, 90_000)

  it('refuses unbound callers and other Walnut homes without forwarding', async () => {
    const { caller, port, bridge } = await rig(twin)
    const other = await connect(port)
    expect(await other.rpc({ cmd: 'feature.request', frame: null }))
      .toMatchObject({ ok: false, error: 'Feature request refused' })
    expect(await other.rpc({ cmd: 'leader.configure', home: path.join(root, 'other-data'),
      walnutId: 'fixture-other', backup: false })).toMatchObject({ ok: true })
    expect(await other.rpc({ cmd: 'feature.request', frame: null }))
      .toMatchObject({ ok: false, error: 'Feature request refused' })
    expect(bridge.requests()).toEqual([])
    const id = caller.send({ cmd: 'feature.request', frame: null })
    await result(bridge, await bridge.request(), { success: true, payload: [] })
    expect(await caller.reply(id)).toMatchObject({ result: { success: true } })
  }, 90_000)

  it.each(['leader.configure', 'leader.claim', 'host.slice'])('drops an in-flight read when %s changes its home, even if it returns', async (command) => {
    const { caller, bridge, port } = await rig(twin)
    const home = path.join(root, 'data'), other = path.join(root, 'other-data')
    if (command === 'leader.claim') {
      const registration = await connect(port)
      expect(await registration.rpc({ cmd: 'leader.configure', home: other,
        walnutId: 'fixture-other', backup: false })).toMatchObject({ ok: true })
    }
    const id = caller.send({ cmd: 'feature.request', frame: 'before-rebind' })
    const request = await bridge.request()
    const binding = command === 'host.slice'
      ? { cmd: command, slice: { v: 1, home: other, hash: 'fixture-slice', asOf: Date.now(), host: '__local__',
        sessions: [], tasks: [], requests: [] } }
      : { cmd: command, home: other, walnutId: 'fixture-other', backup: false }
    expect(await caller.rpc(binding)).toMatchObject({ ok: true })
    expect(await caller.rpc({ cmd: 'leader.claim', home })).toMatchObject({ ok: true })
    await result(bridge, request, { success: true, payload: 'stale-private-result' }, false)
    expect(await caller.rpc({ cmd: 'ping' })).toMatchObject({ ok: true })
    expect(caller.replies(id)).toEqual([])
    const next = caller.send({ cmd: 'feature.request', frame: 'after-rebind' })
    await result(bridge, await bridge.request(1), { success: true, payload: 'fresh' })
    expect(await caller.reply(next)).toMatchObject({ result: { payload: 'fresh' } })
  }, 90_000)

  it('an older bridge configuration with no owner remains usable but cannot serve features', async () => {
    const { caller, bridge, cloud } = await rig(twin)
    expect(await caller.rpc({ cmd: 'bridge.configure', enabled: true,
      url: `ws://127.0.0.1:${cloud.port}/bridge`, token: 'fixture-only', hostAlias: '__local__' }))
      .toMatchObject({ ok: true })
    expect(await caller.rpc({ cmd: 'feature.request', frame: null }))
      .toMatchObject({ ok: false, error: 'Feature request refused' })
    const replacement = await cloud.peer(1)
    expect(await replacement.rpc({ cmd: 'ping' })).toMatchObject({ ok: true })
    expect(bridge.requests()).toEqual([])
  }, 90_000)

  it('rejects object and oversized envelopes before forwarding, then permits a valid read', async () => {
    const { caller, bridge } = await rig(twin)
    for (const frame of [{ cmd: 'start' }, 'x'.repeat(65_537)]) {
      expect(await caller.rpc({ cmd: 'feature.request', frame }))
        .toMatchObject({ ok: false, error: 'Invalid feature relay request' })
    }
    expect(await bridge.rpc({ cmd: 'ping' })).toMatchObject({ ok: true })
    expect(bridge.requests()).toEqual([])
    const id = caller.send({ cmd: 'feature.request', frame: null })
    await result(bridge, await bridge.request(), { success: true, payload: [] })
    expect(await caller.reply(id)).toMatchObject({ result: { success: true } })
  }, 90_000)

  it('drains pending requests offline on a real bridge disconnect and recovers on redial', async () => {
    const { cloud, caller, bridge } = await rig(twin)
    const ids = [null, 'one', 'two'].map((frame) => caller.send({ cmd: 'feature.request', frame }))
    await bridge.request(2)
    await closePeer(bridge)
    for (const id of ids) expect(await caller.reply(id)).toEqual({ id, ok: true, result: { success: false, code: 'offline' } })
    const replacement = await cloud.peer(1)
    const next = caller.send({ cmd: 'feature.request', frame: 'after-redial' })
    await result(replacement, await replacement.request(), { success: true, payload: 'recovered' })
    expect(await caller.reply(next)).toMatchObject({ result: { payload: 'recovered' } })
    for (const id of ids) expect(caller.replies(id)).toHaveLength(1)
  }, 90_000)

  it('reclaims all 64 pending slots when the trusted caller disconnects', async () => {
    const { caller, port, bridge } = await rig(twin)
    for (let i = 0; i < 64; i++) caller.send({ cmd: 'feature.request', frame: null })
    await bridge.request(63)
    expect(await caller.rpc({ cmd: 'feature.request', frame: null }))
      .toMatchObject({ result: { success: false, code: 'busy' } })
    const closedBefore = localDisconnects()
    await closePeer(caller)
    await until(() => localDisconnects() > closedBefore, 'daemon observing the owned caller disconnect')
    await result(bridge, bridge.requests()[0], { success: true, payload: 'late' }, false)
    const next = await connect(port)
    expect(await next.rpc({ cmd: 'leader.claim', home: path.join(root, 'data') })).toMatchObject({ ok: true })
    const ids = Array.from({ length: 64 }, () => next.send({ cmd: 'feature.request', frame: null }))
    await bridge.request(127) // Would time out if the old caller leaked its pending entries.
    expect(ids.flatMap((id) => next.replies(id))).toEqual([])
    const ackIds = ids.map((_, i) => bridge.send({ cmd: 'feature.result',
      requestId: bridge.requests()[64 + i].requestId, result: { success: true, payload: i } }))
    // Release the full batch at once, rather than making 64 serial round trips
    // race the relay's fixed 10-second deadline on a loaded machine.
    const acknowledgements = await Promise.all(ackIds.map((ackId) => bridge.reply(ackId)))
    expect(acknowledgements.every((ack) => ack.ok === true && ack.accepted === true)).toBe(true)
    const answers = await Promise.all(ids.map((id) => next.reply(id)))
    answers.forEach((answer, i) => expect(answer).toMatchObject({ result: { success: true, payload: i } }))
  }, 90_000)

  it('a delayed old ACK cannot finish a new request after bridge replacement', async () => {
    const firstCloud = await companion(), secondCloud = await companion()
    const { caller } = await boot(twin, firstCloud.port)
    await configure(caller, firstCloud.port)
    const old = await firstCloud.peer()
    const id = 30_000
    caller.send({ id, cmd: 'feature.request', frame: 'before-replacement' })
    const staleRequest = await old.request()
    await configure(caller, secondCloud.port)
    expect(await caller.reply(id)).toMatchObject({ result: { success: false, code: 'offline' } })
    const current = await secondCloud.peer()
    caller.send({ id, cmd: 'feature.request', frame: 'after-replacement' }) // Reuse caller id deliberately.
    const currentRequest = await current.request()
    expect(currentRequest.requestId).not.toBe(staleRequest.requestId)
    // Send the old target's delayed response over the replacement's REAL socket.
    // This also proves the old request was removed, rather than merely answered offline.
    await result(current, staleRequest, { success: true, payload: 'stale-target' }, false)
    expect(await current.rpc({ cmd: 'ping' })).toMatchObject({ ok: true })
    expect(await caller.rpc({ cmd: 'ping' })).toMatchObject({ ok: true })
    await pause(100)
    expect(caller.replies(id)).toHaveLength(1) // Only the old request's offline result exists.
    await result(current, currentRequest, { success: true, payload: 'new-target' })
    expect(await caller.reply(id, 1)).toEqual({ id, ok: true, result: { success: true, payload: 'new-target' } })
    expect(caller.replies(id)).toHaveLength(2)
  }, 90_000)
})
