import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('bridge-credential-lifecycle', { CLOUD_MODE: true }))

import { attachBridge, bridgeForHost, bridgeRequest, closeAllBridges } from '../../../src/web/ws/bridge-registry.js'
import { notifyRevoked } from '../../../src/core/device-auth.js'

class Peer extends EventEmitter {
  closed: number | null = null
  readyState = 1
  sent: Record<string, unknown>[] = []
  send(raw: string): void { this.sent.push(JSON.parse(raw)) }
  close(code?: number): void {
    this.readyState = 3
    this.closed = code ?? 1000
    this.emit('close', this.closed, Buffer.from(''))
  }
  hello(): void {
    this.emit('message', Buffer.from(JSON.stringify({ ev: 'hello', hostAlias: 'peer', sids: [] })))
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

function attach(peer: Peer, stillValid: () => Promise<boolean>): void {
  attachBridge(peer as never, 'bridge-peer', { stillValid })
}

afterEach(() => {
  closeAllBridges()
  vi.useRealTimers()
})

describe('bridge credential lifetime', () => {
  it('rechecks the credential after upgrade and refuses a revoked hello', async () => {
    const peer = new Peer()
    attach(peer, async () => false)
    peer.hello()
    await flush()
    expect(peer.closed).toBe(4001)
    expect(bridgeForHost('peer').connected).toBe(false)
  })

  it('a revoke during hello verification cannot be undone by its late result', async () => {
    let resolve!: (valid: boolean) => void
    const peer = new Peer()
    let calls = 0
    attach(peer, () => ++calls === 1 ? new Promise((done) => { resolve = done }) : Promise.resolve(false))
    peer.hello()
    notifyRevoked(['bridge-peer'])
    await flush()
    expect(peer.closed).toBe(4001)
    resolve(true)
    await flush()
    expect(bridgeForHost('peer').connected).toBe(false)
  })

  it('a disconnected hello cannot register when verification finishes', async () => {
    let resolve!: (valid: boolean) => void
    const peer = new Peer()
    attach(peer, () => new Promise((done) => { resolve = done }))
    peer.hello()
    peer.close()
    resolve(true)
    await flush()
    expect(bridgeForHost('peer').connected).toBe(false)
  })

  it('a separate-process revocation is caught by the credential clock', async () => {
    vi.useFakeTimers()
    let valid = true
    const peer = new Peer()
    const check = vi.fn(async () => valid)
    attach(peer, check)
    peer.hello()
    await flush()
    expect(bridgeForHost('peer').connected).toBe(true)
    valid = false
    await vi.advanceTimersByTimeAsync(30_000)
    expect(check).toHaveBeenCalledTimes(2)
    expect(peer.closed).toBe(4001)
    expect(bridgeForHost('peer').connected).toBe(false)
  })

  it('a failed credential read closes the link rather than keeping stale authority', async () => {
    const peer = new Peer()
    attach(peer, async () => { throw new Error('registry unavailable') })
    peer.hello()
    await flush()
    expect(peer.closed).toBe(4001)
    expect(bridgeForHost('peer').connected).toBe(false)
  })

  it('a stalled credential read is bounded and refuses registration', async () => {
    vi.useFakeTimers()
    const peer = new Peer()
    attach(peer, () => new Promise(() => {}))
    peer.hello()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(peer.closed).toBe(4001)
    expect(bridgeForHost('peer').connected).toBe(false)
  })

  it('a delayed old name notification preserves a new valid token', async () => {
    const peer = new Peer()
    attach(peer, async () => true)
    peer.hello()
    await flush()
    notifyRevoked(['bridge-peer'])
    await flush()
    expect(peer.closed).toBeNull()
    expect(bridgeForHost('peer').connected).toBe(true)
  })

  it('a closing socket cannot replace a healthy connection after its hello check', async () => {
    let resolve!: (valid: boolean) => void
    const old = new Peer()
    attach(old, () => new Promise((done) => { resolve = done }))
    old.hello()
    const fresh = new Peer()
    attach(fresh, async () => true)
    fresh.hello()
    await flush()
    old.readyState = 2
    resolve(true)
    await flush()
    expect(fresh.closed).toBeNull()
    expect(bridgeForHost('peer').connected).toBe(true)
  })

  it('hello verification completing out of order keeps the newer socket', async () => {
    let resolve!: (valid: boolean) => void
    const old = new Peer()
    attach(old, () => new Promise((done) => { resolve = done }))
    old.hello()
    const fresh = new Peer()
    attach(fresh, async () => true)
    fresh.hello()
    await flush()
    resolve(true)
    await flush()
    expect(old.closed).toBe(4000)
    expect(fresh.closed).toBeNull()
  })

  it('buffers frames during hello verification and processes them after registration', async () => {
    let resolve!: (valid: boolean) => void
    const peer = new Peer()
    attach(peer, () => new Promise((done) => { resolve = done }))
    peer.hello()
    peer.emit('message', Buffer.from('{"ev":"bridge-ping","seq":10}'))
    peer.emit('message', Buffer.from('{"ev":"bridge-ping","seq":20}'))
    expect(peer.sent).toHaveLength(0)
    resolve(true)
    await flush()
    expect(peer.sent).toEqual([{ id: 1, cmd: 'ping', ackSeq: 10 }, { id: 2, cmd: 'ping', ackSeq: 20 }])
    peer.emit('message', Buffer.from('{"id":1,"ok":true,"pong":true}'))
    peer.emit('message', Buffer.from('{"id":2,"ok":true,"pong":true}'))
  })

  it('bounds the handshake buffer and never registers an overflowing peer', async () => {
    let resolve!: (valid: boolean) => void
    const peer = new Peer()
    attach(peer, () => new Promise((done) => { resolve = done }))
    peer.hello()
    for (let i = 0; i < 65; i++) peer.emit('message', Buffer.from('{"ev":"bridge-ping"}'))
    expect(peer.closed).toBe(1009)
    resolve(true)
    await flush()
    expect(bridgeForHost('peer').connected).toBe(false)
  })

  it('enforces the handshake byte limit independently of the frame count', async () => {
    let resolve!: (valid: boolean) => void
    const peer = new Peer()
    attach(peer, () => new Promise((done) => { resolve = done }))
    peer.hello()
    peer.emit('message', Buffer.alloc(1_048_576, 32))
    expect(peer.closed).toBeNull()
    peer.emit('message', Buffer.from(' '))
    expect(peer.closed).toBe(1009)
    resolve(true)
    await flush()
    expect(bridgeForHost('peer').connected).toBe(false)
  })

  it('malformed JSON shapes cannot crash the bridge before or after hello', async () => {
    const peer = new Peer()
    attach(peer, async () => true)
    for (const raw of ['null', '[]', 'true', '"text"']) expect(() => peer.emit('message', Buffer.from(raw))).not.toThrow()
    peer.hello()
    await flush()
    for (const raw of ['null', '[]', '{"ev":42}', '{"ev":{}}']) expect(() => peer.emit('message', Buffer.from(raw))).not.toThrow()
    expect(bridgeForHost('peer').connected).toBe(true)
  })

  it('status-only hello is byte-bounded before JSON parsing', async () => {
    const peer = new Peer()
    attachBridge(peer as never, 'bridge-peer', { stillValid: async () => true, scope: 'status-only' })
    peer.emit('message', Buffer.alloc(65_537, 32))
    expect(peer.closed).toBe(1009)
    expect(bridgeForHost('peer').connected).toBe(false)
  })

  it('status-only buffered denial stops remaining frame processing', async () => {
    let resolve!: (valid: boolean) => void
    const peer = new Peer()
    attachBridge(peer as never, 'bridge-peer', { stillValid: () => new Promise((done) => { resolve = done }), scope: 'status-only' })
    peer.hello()
    peer.emit('message', Buffer.from('{"ev":"gateway-request","relayId":1}'))
    peer.emit('message', Buffer.from('{"ev":"bridge-ping"}'))
    resolve(true)
    await flush()
    expect(peer.closed).toBe(4001)
    expect(peer.sent).toHaveLength(0)
  })

  it('a late pong cannot settle the next request after a deadline', async () => {
    vi.useFakeTimers()
    const peer = new Peer()
    attach(peer, async () => true)
    peer.hello()
    await flush()
    const first = bridgeRequest('peer', 'ping', { nonce: 'a' }, 5_000).catch(() => 'timed_out')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await first).toBe('timed_out')
    let settled = false
    const second = bridgeRequest('peer', 'ping', { nonce: 'b' }, 5_000).then((reply) => { settled = true; return reply })
    peer.emit('message', Buffer.from('{"id":1,"ok":true,"pong":true,"nonce":"a"}'))
    await flush()
    expect(settled).toBe(false)
    peer.emit('message', Buffer.from('{"id":2,"ok":true,"pong":true,"nonce":"b"}'))
    expect(await second).toMatchObject({ nonce: 'b' })
  })

  it('a stale credential check cannot close a replacement connection', async () => {
    vi.useFakeTimers()
    let resolveOld!: (valid: boolean) => void
    let calls = 0
    const old = new Peer()
    attach(old, () => ++calls === 1 ? Promise.resolve(true) : new Promise((done) => { resolveOld = done }))
    old.hello()
    await flush()
    await vi.advanceTimersByTimeAsync(30_000)
    const fresh = new Peer()
    attach(fresh, async () => true)
    fresh.hello()
    await flush()
    expect(old.closed).toBe(4000)
    resolveOld(false)
    await flush()
    expect(fresh.closed).toBeNull()
    expect(bridgeForHost('peer').connected).toBe(true)
  })
})
