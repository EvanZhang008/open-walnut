/** Real cloud HTTP/WS and credential store; only the daemon bridge is a stand-in. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import http, { type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('bridge-session-stream', { CLOUD_MODE: true }))

import { startServer, stopServer } from '../../src/web/server.js'
import { createDevice, mutateDeviceRecords, notifyRevoked } from '../../src/core/device-auth.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { _resetAuthRateLimitForTesting } from '../../src/web/middleware/auth-rate-limit.js'
import { seedLaunchedSession, _resetLaunchSeedsForTesting } from '../../src/core/sessions/launch-seed.js'
import * as sessionHosts from '../../src/core/sessions/cloud-session-host.js'
import {
  addBridgeConnectedHandler, addBridgeSessionEventHandler, bridgeForHost, bridgeRequest, closeAllBridges,
} from '../../src/web/ws/bridge-registry.js'
import { closeAllBridgeSessionStreams } from '../../src/web/ws/bridge-session-stream.js'
import { clientCount } from '../../src/web/ws/handler.js'
import { _sseEventIdsForTesting, closeAllSseChannels } from '../../src/web/sse-channels.js'
import { wsProtocolsFor, WS_APP_PROTOCOL } from '../../src/lib/ws-bearer-protocol.js'

const HOST = 'remote-peer'
const SID = 'session-native-01'
const CAPS = ['send-dedupe-v1', 'send-lost-line-v1']
const STREAM_PATH = '/bridge/session-stream'
const API_KEY = 'fixture-api-credential'
const sockets = new Set<WebSocket>()
let server: Server
let port = 0
let primaryToken = ''
let peerToken = ''
let deviceToken = ''

function socket(path: string, token?: string, protocols?: string[]): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}, handshakeTimeout: 20_000,
  })
  sockets.add(ws)
  ws.on('error', () => {})
  return ws
}

function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
}

function closed(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
}

function streamPath(offset = 0, sid = SID, host = HOST): string {
  return `${STREAM_PATH}?${new URLSearchParams({ host, sessionId: sid, fromOffset: String(offset) })}`
}

function upgrade(path = streamPath(), token?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port, path,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('stream-gate-test').toString('base64'),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })
    request.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0) })
    request.on('upgrade', (_res, conn) => { conn.destroy(); resolve(101) })
    request.on('error', reject)
    request.end()
  })
}

interface NativeReader {
  ws: WebSocket
  events: Record<string, unknown>[]
  wait: (ev: string) => Promise<Record<string, unknown>>
}
function reader(offset = 0, sid = SID, host = HOST, protocols?: string[]): NativeReader {
  const ws = socket(streamPath(offset, sid, host), protocols ? undefined : primaryToken, protocols)
  const events: Record<string, unknown>[] = []
  const waiters = new Set<() => void>()
  ws.on('message', (data) => { events.push(JSON.parse(data.toString())); for (const wake of [...waiters]) wake() })
  return {
    ws, events,
    wait: (ev) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(wake); reject(new Error(`missing event: ${ev}`)) }, 5_000)
      const wake = () => {
        const found = events.find((event) => event.ev === ev)
        if (found) { clearTimeout(timer); waiters.delete(wake); resolve(found) }
      }
      waiters.add(wake)
      wake()
    }),
  }
}

interface Peer {
  ws: WebSocket
  commands: Record<string, unknown>[]
  send: (event: Record<string, unknown>) => void
  barrier: () => Promise<void>
}
async function peer(options: {
  host?: string; capabilities?: string[]
  attach?: (cmd: Record<string, unknown>, send: Peer['send']) => void
} = {}): Promise<Peer> {
  const host = options.host ?? HOST
  const token = host === HOST ? peerToken : (await createDevice(`bridge-${host}`, { kind: 'machine' })).token
  const ws = socket('/bridge', token)
  const commands: Record<string, unknown>[] = []
  const send = (event: Record<string, unknown>) => ws.send(JSON.stringify(event))
  ws.on('message', (data) => {
    const cmd = JSON.parse(data.toString()) as Record<string, unknown>
    commands.push(cmd)
    if (cmd.cmd === 'attach') {
      if (options.attach) options.attach(cmd, send)
      else send({ id: cmd.id, ok: true, pid: 4242, alive: true, state: 'running', currentOffset: 800, pendingCtrl: null })
    } else if (cmd.cmd === 'read-history') send({ id: cmd.id, ok: true, main: '', subagents: {} })
    else send({ id: cmd.id, ok: true })
  })
  const registered = new Promise<void>((resolve) => {
    const off = addBridgeConnectedHandler((alias) => { if (alias === host) { off(); resolve() } })
  })
  await opened(ws)
  send({ ev: 'hello', hostAlias: host, sids: [SID], capabilities: options.capabilities ?? CAPS })
  await registered
  return { ws, commands, send, barrier: async () => { await bridgeRequest(host, 'ping') } }
}

interface Phone { deltas: string[]; close: () => void }
async function phone(): Promise<Phone> {
  const controller = new AbortController()
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/${SID}/stream`, {
    signal: controller.signal, headers: { Authorization: `Bearer ${deviceToken}` },
  })
  expect(response.status).toBe(200)
  if (!response.body) throw new Error('missing phone body')
  const body = response.body.getReader()
  const deltas: string[] = []
  void (async () => {
    let buffer = ''
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const part = await body.read()
        if (part.done) return
        buffer += decoder.decode(part.value, { stream: true })
        let end: number
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          if (frame.includes('event: text-delta\n')) {
            const data = frame.split('\n').find((line) => line.startsWith('data: '))
            if (data) deltas.push(JSON.parse(data.slice(6)).delta)
          }
        }
      }
    } catch { /* this isolated consumer was aborted */ }
  })()
  return { deltas, close: () => controller.abort() }
}
function delta(text: string, v: number, sid = SID): Record<string, unknown> {
  return { ev: 'jsonl', sid, v, line: JSON.stringify({ type: 'stream_event', event: {
    type: 'content_block_delta', delta: { type: 'text_delta', text },
  } }) }
}

beforeAll(async () => {
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as AddressInfo).port
  await updateConfig({ api_keys: [{ name: 'fixture-client', key: API_KEY }] })
}, 120_000)
beforeEach(async () => {
  _resetAuthRateLimitForTesting()
  _resetLaunchSeedsForTesting()
  await mutateDeviceRecords(() => ({ devices: [], result: undefined }))
  primaryToken = (await createDevice('bridge-local', { kind: 'machine' })).token
  peerToken = (await createDevice(`bridge-${HOST}`, { kind: 'machine' })).token
  deviceToken = (await createDevice('phone')).token
  seedLaunchedSession(SID, { host: HOST })
})
afterEach(async () => {
  closeAllBridgeSessionStreams()
  closeAllSseChannels()
  closeAllBridges()
  await Promise.all([...sockets].map(async (ws) => {
    if (ws.readyState === WebSocket.CLOSED) return
    const done = closed(ws)
    ws.terminate()
    await done
  }))
  sockets.clear()
  vi.restoreAllMocks()
})
afterAll(async () => { await stopServer() })

describe('read-only native session stream', () => {
  it('checks identity before query or host details and rejects every other credential kind', async () => {
    const lookup = vi.spyOn(sessionHosts, 'resolveCloudSessionHost')
    for (const [token, status] of [[undefined, 401], ['fixture-unknown', 401], [deviceToken, 403], [API_KEY, 403], [peerToken, 403]] as const) {
      expect(await upgrade(`${STREAM_PATH}?host=bad%2Fpath`, token)).toBe(status)
    }
    await mutateDeviceRecords((records) => ({ devices: records.map((r) => r.name === 'bridge-local' ? { ...r, bridgeScope: 'status-only' } : r), result: undefined }))
    expect(await upgrade(streamPath(), primaryToken)).toBe(403)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('validates lexical ids and safe byte offsets before lookup and forbids local hosts', async () => {
    const lookup = vi.spyOn(sessionHosts, 'resolveCloudSessionHost')
    for (const query of [
      'host=..%2Fpeer&sessionId=one&fromOffset=0', 'host=peer&sessionId=..%2Fone&fromOffset=0',
      'host=__local__&sessionId=one&fromOffset=0', 'host=__cloudbox__&sessionId=one&fromOffset=0',
      'host=peer&sessionId=one&fromOffset=-1', 'host=peer&sessionId=one&fromOffset=1.5',
      'host=peer&sessionId=one&fromOffset=9007199254740992', 'host=peer&sessionId=one&fromOffset=1e3',
      'host=peer&sessionId=one', 'host=peer&sessionId=one&fromOffset=0&host=other',
    ]) expect(await upgrade(`${STREAM_PATH}?${query}`, primaryToken)).toBe(400)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('refuses offline or unsupported bridges with 503 and a different session host with 409', async () => {
    expect(await upgrade(streamPath(), primaryToken)).toBe(503)
    for (const capabilities of [[], ['send-dedupe-v1'], ['send-lost-line-v1']]) {
      const daemon = await peer({ capabilities })
      expect(await upgrade(streamPath(), primaryToken)).toBe(503)
      daemon.ws.close()
      await expect.poll(() => bridgeForHost(HOST).connected).toBe(false)
    }
    const daemon = await peer()
    seedLaunchedSession(SID, { host: 'another-peer' })
    expect(await upgrade(streamPath(), primaryToken)).toBe(409)
    expect(daemon.commands.some((c) => c.cmd === 'attach')).toBe(false)
  })

  it('delivers original catch-up before attached, with offsets, control state and long Unicode intact', async () => {
    const original = delta('line '.repeat(40_000) + String.fromCodePoint(0x4e2d, 0x6587), 9007199254740000)
    const reply = { ok: true, pid: 4242, alive: true, state: 'running', exitCode: null, currentOffset: original.v,
      pendingCtrl: { reqId: 'prompt-1', toolName: 'Read', request: { subtype: 'can_use_tool' } } }
    const daemon = await peer({ attach: (cmd, send) => { send(original); send({ id: cmd.id, ...reply }) } })
    const native = reader(9007199254730000, SID, HOST, wsProtocolsFor(primaryToken))
    expect(await native.wait('attached')).toMatchObject(reply)
    expect(native.ws.protocol).toBe(WS_APP_PROTOCOL)
    expect(native.events[0]).toEqual(original)
    expect(native.events[1].ev).toBe('attached')
    expect(daemon.commands.filter((c) => c.cmd === 'attach')).toEqual([
      { id: 1, cmd: 'attach', sid: SID, fromOffset: 9007199254730000 },
    ])
    expect(clientCount()).toBe(0)
    expect(_sseEventIdsForTesting(`session:${SID}`)).toEqual([])
  })

  it('filters unrelated hosts and sessions and reassembles chunks before forwarding native events', async () => {
    const daemon = await peer()
    const other = await peer({ host: 'other-peer' })
    const native = reader()
    await native.wait('attached')
    daemon.send(delta('unrelated', 100, 'another-session'))
    other.send(delta('unrelated-host', 100))
    const record = delta('joined', 101)
    const raw = JSON.stringify(record)
    daemon.send({ ev: 'chunk', cid: 'frame-1', i: 0, n: 2, part: raw.slice(0, 20) })
    await daemon.barrier()
    expect(native.events).toHaveLength(1)
    daemon.send({ ev: 'chunk', cid: 'frame-1', i: 1, n: 2, part: raw.slice(20) })
    expect(await native.wait('jsonl')).toEqual(record)
    for (const event of [
      { ev: 'snapshot', sid: SID, snapshot: { revision: 7, cursor: 101 } },
      { ev: 'stderr_tail', sid: SID, tail: 'diagnostic', extra: { untouched: true } },
      { ev: 'session_state', sid: SID, state: 'dead', pid: 4242 },
      { ev: 'exit', sid: SID, code: 0, reason: 'completed' },
    ]) { daemon.send(event); expect(await native.wait(String(event.ev))).toEqual(event) }
    expect(native.events.some((event) => event.ev === 'chunk')).toBe(false)
  })

  it.each(['start', 'stop', 'ping', 'malformed', 'binary'])('rejects a client %s data frame without forwarding commands', async (command) => {
    const daemon = await peer()
    const native = reader()
    await native.wait('attached')
    const before = daemon.commands.length
    const done = closed(native.ws)
    native.ws.send(command === 'binary' ? Buffer.from('data') : command === 'malformed' ? '{' : JSON.stringify({ id: 22, cmd: command, sid: SID }))
    expect((await done).code).toBe(1008)
    await daemon.barrier()
    expect(daemon.commands.slice(before).map((c) => c.cmd)).toEqual(['ping'])
  })

  it('permits WebSocket control ping and keeps the reader alive', async () => {
    await peer()
    const native = reader()
    await native.wait('attached')
    const pong = new Promise<void>((resolve) => native.ws.once('pong', () => resolve()))
    native.ws.ping('control-only')
    await pong
    expect(native.ws.readyState).toBe(WebSocket.OPEN)
  })

  it('closes a refused attach but preserves a successful dead-session reply without starting it', async () => {
    const daemon = await peer({ attach: (cmd, send) => send({ id: cmd.id, ok: false, error: 'no stream' }) })
    const native = reader()
    const done = closed(native.ws)
    expect(await native.wait('attached')).toMatchObject({ ok: false, error: 'no stream' })
    expect((await done).code).toBe(1011)
    const next = await peer({ attach: (cmd, send) => send({ id: cmd.id, ok: true, alive: false, pid: null, currentOffset: 0, pendingCtrl: null }) })
    const dead = reader()
    expect(await dead.wait('attached')).toMatchObject({ alive: false, pid: null })
    expect([...daemon.commands, ...next.commands].every((c) => c.cmd === 'attach')).toBe(true)
  })

  it('closes on bridge loss, reconnects from the requested cursor and ignores an old connection close', async () => {
    const first = await peer()
    const native = reader(10)
    await native.wait('attached')
    first.send(delta('first', 20))
    await native.wait('jsonl')
    const done = closed(native.ws)
    const second = await peer()
    expect((await done).code).toBe(1012)
    expect(native.events.at(-1)).toEqual({ ev: 'bridge-offline', sid: SID })
    const again = reader(20)
    await again.wait('attached')
    expect(second.commands.find((c) => c.cmd === 'attach')).toMatchObject({ fromOffset: 20 })
    if (first.ws.readyState !== WebSocket.CLOSED) await closed(first.ws)
    second.send(delta('second', 30))
    expect(await again.wait('jsonl')).toEqual(delta('second', 30))
    expect(again.ws.readyState).toBe(WebSocket.OPEN)
    const lost = closed(again.ws)
    second.ws.terminate()
    expect((await lost).code).toBe(1012)
    expect(await upgrade(streamPath(30), primaryToken)).toBe(503)
  })

  it('unsubscribes each reader on close and shutdown without touching CLI or other readers', async () => {
    const daemon = await peer()
    const first = reader()
    const second = reader()
    await Promise.all([first.wait('attached'), second.wait('attached')])
    const done = closed(first.ws)
    first.ws.close()
    await done
    daemon.send(delta('remaining', 801))
    expect(await second.wait('jsonl')).toEqual(delta('remaining', 801))
    expect(first.events).toHaveLength(1)
    const stopped = closed(second.ws)
    closeAllBridgeSessionStreams()
    await stopped
    expect(bridgeForHost(HOST).connected).toBe(true)
    expect(daemon.commands.every((cmd) => cmd.cmd === 'attach')).toBe(true)
  })

  it('does not replay raw catch-up into an attached phone and keeps phone live interest after reader close', async () => {
    const daemon = await peer({ attach: (cmd, send) => {
      if (cmd.fromOffset !== Number.MAX_SAFE_INTEGER) {
        send(delta('old-history', 700))
        send(delta('already-live', 900))
        send(delta('new-live', 1_000))
      }
      send({ id: cmd.id, ok: true, alive: true, currentOffset: 800, pendingCtrl: null })
    } })
    const mobile = await phone()
    try {
      daemon.send(delta('already-live', 900))
      await expect.poll(() => mobile.deltas).toEqual(['already-live'])
      const native = reader(0)
      await native.wait('attached')
      await expect.poll(() => mobile.deltas).toEqual(['already-live', 'new-live'])
      expect(native.events.filter((e) => e.ev === 'jsonl')).toHaveLength(3)
      const done = closed(native.ws)
      native.ws.close()
      await done
      daemon.send(delta('after-reader', 1_100))
      await expect.poll(() => mobile.deltas).toEqual(['already-live', 'new-live', 'after-reader'])
      expect(daemon.commands.filter((c) => c.cmd === 'attach')).toHaveLength(2)
    } finally { mobile.close() }
  })

  it('catches same-process revocation and preserves a fresh valid credential on a delayed name notice', async () => {
    await peer()
    const native = reader()
    await native.wait('attached')
    notifyRevoked(['bridge-local'])
    // A control pong is a network barrier while the real credential recheck settles.
    const pong = new Promise<void>((resolve) => native.ws.once('pong', () => resolve()))
    native.ws.ping()
    await pong
    expect(native.ws.readyState).toBe(WebSocket.OPEN)
    const done = closed(native.ws)
    await mutateDeviceRecords((records) => ({ devices: records.filter((r) => r.name !== 'bridge-local'), result: undefined }))
    notifyRevoked(['bridge-local'])
    expect((await done).code).toBe(4401)
    expect(await upgrade(streamPath(), primaryToken)).toBe(401)
  })

  it('revalidates on a real heartbeat and terminates a stalled reader', async () => {
    await peer()
    const interval = globalThis.setInterval
    let beat: (() => void) | undefined
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms: number) => {
      if (ms === 30_000) beat = fn
      return interval(fn, ms)
    }) as typeof setInterval)
    const native = reader()
    await native.wait('attached')
    const done = closed(native.ws)
    await mutateDeviceRecords((records) => ({ devices: records.filter((r) => r.name !== 'bridge-local'), result: undefined }))
    beat!()
    expect((await done).code).toBe(4401)
    primaryToken = (await createDevice('bridge-local', { kind: 'machine' })).token
    const stalled = reader()
    await stalled.wait('attached')
    const stopped = closed(stalled.ws)
    // Two beats without allowing the socket to return a pong model the stalled peer.
    beat!(); beat!()
    expect((await stopped).code).toBe(1006)
  })

  it('fans out the original native wire string without serializing a large event per reader', async () => {
    const daemon = await peer()
    const first = reader()
    const second = reader()
    await Promise.all([first.wait('attached'), second.wait('attached')])
    const event = delta('native '.repeat(100_000), 1234)
    const raw = `  ${JSON.stringify(event)}  `
    const delivered: string[] = []
    first.ws.on('message', (data) => delivered.push(data.toString()))
    second.ws.on('message', (data) => delivered.push(data.toString()))
    const nativeStringify = JSON.stringify
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementation((...args: Parameters<typeof JSON.stringify>) => {
      if ((args[0] as Record<string, unknown> | undefined)?.ev === 'jsonl') throw new Error('native record was serialized again')
      return nativeStringify(...args)
    })
    try {
      daemon.ws.send(raw)
      expect(await first.wait('jsonl')).toEqual(event)
      expect(await second.wait('jsonl')).toEqual(event)
      expect(delivered).toEqual([raw, raw])
    } finally { stringify.mockRestore() }
  })

  it('raw callback cleanup never clears phone subscriptions or another session handler', async () => {
    const daemon = await peer()
    const received: Record<string, unknown>[] = []
    const other: Record<string, unknown>[] = []
    const wire: Array<{ raw?: string; bytes?: number }> = []
    const off = addBridgeSessionEventHandler(HOST, SID, (ev) => received.push(ev))
    const offOther = addBridgeSessionEventHandler(HOST, 'another-session', (ev, raw, bytes) => { other.push(ev); wire.push({ raw, bytes }) })
    try {
      off(); off()
      const original = JSON.stringify(delta('other', 10, 'another-session'))
      daemon.ws.send(original)
      await daemon.barrier()
      expect(received).toEqual([])
      expect(other).toEqual([delta('other', 10, 'another-session')])
      expect(wire).toEqual([{ raw: original, bytes: Buffer.byteLength(original) }])
    } finally { off(); offOther() }
  })
})
