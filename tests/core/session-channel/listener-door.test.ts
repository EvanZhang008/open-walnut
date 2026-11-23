/**
 * The cloud companion's listener door (src/core/session-channel/listener-door.ts), on a real
 * loopback socket: it takes only a host's own bridge machine token (never a device token, a
 * status-only one or the Mac's own), opens only while it knows the Walnut it serves, closes 4001 on
 * a hello naming another Walnut or another host than the token's, and welcomes the listener role
 * with no proof. Once linked the companion answers the host's channel hello with `listen` and
 * never confirms anything (no resume, ack or resync, whatever the host sends).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-listener-door'))
vi.mock('../../../src/web/routes/events-v1.js', () => ({ handleBridgeMobileEvent: () => {} }))

import { aliasOfBridgeToken, attachListenerSocket, handleHostListenUpgrade, type ListenerCredential } from '../../../src/core/session-channel/listener-door.js'
import { _resetCompanionListenerForTesting, listenedRow, listenerLinked } from '../../../src/core/session-channel/companion-listener.js'

const WALNUT = 'ab'.repeat(16)
let server: http.Server | null = null
let cred: ListenerCredential | null = null
let walnut: string | null = WALNUT

beforeEach(() => {
  cred = { name: 'bridge-devbox', kind: 'machine', stillValid: async () => true }
  walnut = WALNUT
  _resetCompanionListenerForTesting()
})
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = null
})

async function door(): Promise<string> {
  server = http.createServer()
  server.on('upgrade', (req, socket, head) => { void handleHostListenUpgrade(req, socket, head, { verify: async () => cred, walnut: async () => walnut }) })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  return `ws://127.0.0.1:${(server.address() as { port: number }).port}/host-listen`
}

/** Dial, send `hello`; collect frames until `until` says enough or the socket closes. */
async function dial(url: string, hello: Record<string, unknown>, after?: (ws: WebSocket, frames: any[]) => void): Promise<{ status?: number; code?: number; frames: any[] }> {
  const ws = new WebSocket(url, { headers: { authorization: 'Bearer x'.padEnd(40, 'y') } })
  const frames: any[] = []
  return new Promise((resolve) => {
    ws.on('unexpected-response', (_q, res) => { resolve({ status: res.statusCode, frames }); ws.terminate() })
    ws.on('error', () => {})
    ws.on('open', () => ws.send(JSON.stringify({ ch: 'door', op: 'hello', v: 1, role: 'listener', walnutId: WALNUT, hostAlias: 'devbox', ...hello })))
    ws.on('message', (m) => { frames.push(JSON.parse(String(m))); after?.(ws, frames) })
    ws.on('close', (code) => resolve({ code, frames }))
    setTimeout(() => { ws.close(); }, 1500)
  })
}

describe('the listener door', () => {
  it('names a token\'s host by its bridge record, never the Mac\'s own', () => {
    expect(aliasOfBridgeToken('bridge-devbox')).toBe('devbox')
    expect(aliasOfBridgeToken('bridge-local')).toBeNull()
    expect(aliasOfBridgeToken('my-phone')).toBeNull()
  })

  it('refuses 401 anything but a host\'s own bridge machine token', async () => {
    const url = await door()
    for (const c of [
      null,
      { name: 'my-phone', kind: 'device', stillValid: async () => true },
      { name: 'bridge-devbox', kind: 'machine', bridgeScope: 'status-only' as const, stillValid: async () => true },
      { name: 'bridge-local', kind: 'machine', stillValid: async () => true },
      { name: 'devbox', kind: 'machine', stillValid: async () => true },
    ]) {
      cred = c
      expect((await dial(url, {})).status, JSON.stringify(c)).toBe(401)
    }
  })

  it('is shut (503) while the companion knows no Walnut it serves with the switch on', async () => {
    const url = await door()
    walnut = null
    expect((await dial(url, {})).status).toBe(503)
  })

  it('closes 4001 on a hello naming another Walnut or another host than the token\'s', async () => {
    const url = await door()
    expect((await dial(url, { walnutId: 'cd'.repeat(16) })).code).toBe(4001)
    expect((await dial(url, { hostAlias: 'otherbox' })).code).toBe(4001)
    expect((await dial(url, { role: 'leader' })).code).toBe(4001)
    expect(listenerLinked('devbox')).toBe(false)
  })

  it('welcomes the listener role with no proof, answers the channel hello with listen, and never confirms', async () => {
    const url = await door()
    const row = { claudeSessionId: 's1', taskId: 't1', judge: 'host', host: 'devbox', process_status: 'idle', startedAt: '', lastActiveAt: '' }
    const r = await dial(url, {}, (ws, frames) => {
      const last = frames[frames.length - 1]
      if (last.op === 'welcome') ws.send(JSON.stringify({ ch: 'sf', op: 'hello', walnutId: WALNUT, hostId: 'devbox', logId: 'L', floor: 1, head: 3 }))
      if (last.op === 'listen') {
        ws.send(JSON.stringify({ ch: 'sf', op: 'rows', rows: [row], upTo: 3, rowsAt: 3, logId: 'L' }))
        ws.send(JSON.stringify({ ch: 'sf', op: 'facts', recs: [{ seq: 4, sid: 's1', name: 'live', data: { state: { turnRunning: false } } }] }))
      }
    })
    expect(r.frames[0]).toEqual({ ch: 'door', op: 'welcome', role: 'listener', walnutId: WALNUT })
    expect(r.frames[1]).toEqual({ ch: 'sf', op: 'listen', walnutId: WALNUT })
    // Nothing else: no resume, no ack, no resync.
    expect(r.frames.map((f) => f.op)).toEqual(['welcome', 'listen'])
    // Read as the socket closes: the row stays for the grace (its live state is unknown once the close is taken, review L2).
    expect(listenedRow('s1')).toMatchObject({ alias: 'devbox', row: { claudeSessionId: 's1' } })
  })

  it('closes a socket whose token no longer stands at its recheck', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    let valid = true
    wss.on('connection', (ws) => attachListenerSocket(ws, { alias: 'devbox', walnutId: WALNUT, name: 'bridge-devbox', stillValid: async () => valid, recheckMs: 50 }))
    const port = (wss.address() as { port: number }).port
    const r = dial(`ws://127.0.0.1:${port}`, {}, () => { valid = false })
    expect((await r).code).toBe(4003)
    await new Promise<void>((res) => wss.close(() => res()))
  })
})
