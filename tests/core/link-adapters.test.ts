/**
 * The Mac's two transports as Links (src/core/link/{daemon-connection-link,bridge-link}.ts,
 * replica plan WP13): `heard()` counts frames, never socket state; requests and
 * events go through as they are; each opens streams only where its daemon lets it.
 */
import { describe, expect, it } from 'vitest'
import { PassThrough, type Duplex } from 'node:stream'
import { createDaemonConnectionLink, type DaemonConnectionLike } from '../../src/core/link/daemon-connection-link.js'
import { createBridgeLink, type BridgeRegistryLike } from '../../src/core/link/bridge-link.js'

function fakeConn(over: Partial<DaemonConnectionLike> = {}) {
  let handler: ((e: never) => void) | null = null
  const sent: Array<{ cmd: string; params?: Record<string, unknown>; timeoutMs?: number }> = []
  const opened: Array<{ to: string; purpose?: string }> = []
  const conn = {
    hostKey: 'marina', connected: true, heardAt: 0,
    lastHeardAt() { return this.heardAt },
    async send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number) { sent.push({ cmd, params, timeoutMs }); return { ok: true, cmd } },
    onEvent(h: (e: never) => void) { handler = h; return () => { handler = null } },
    async openStream(to: 'follower', purpose?: string): Promise<Duplex> { opened.push({ to, purpose }); return new PassThrough() },
    ...over,
  }
  return { conn, sent, opened, emit: (e: Record<string, unknown>) => handler?.(e as never), subscribed: () => handler !== null }
}

describe('the DaemonConnection Link', () => {
  it('heard is the last frame or pong, Infinity before any; state follows connected', () => {
    let now = 10_000
    const f = fakeConn()
    const link = createDaemonConnectionLink({ conn: f.conn, walnutId: 'w-acme', now: () => now })
    expect(link.peer).toEqual({ host: 'marina', walnutId: 'w-acme' })
    expect(link.heard()).toBe(Infinity)
    f.conn.heardAt = 9_000
    expect(link.heard()).toBe(1_000)
    now = 12_000
    expect(link.heard()).toBe(3_000)
    expect(link.state()).toBe('up')
    f.conn.connected = false
    expect(link.state()).toBe('down')
    link.close()
  })

  it('requests go through as they are; daemon events fan out by name; close unsubscribes', async () => {
    const f = fakeConn()
    const link = createDaemonConnectionLink({ conn: f.conn, walnutId: 'w' })
    expect(await link.request('status', { sid: 's1' }, 5_000)).toEqual({ ok: true, cmd: 'status' })
    expect(f.sent).toEqual([{ cmd: 'status', params: { sid: 's1' }, timeoutMs: 5_000 }])
    const got: unknown[] = []
    const off = link.on('jsonl', (d) => got.push(d))
    f.emit({ ev: 'jsonl', sid: 's1' })
    f.emit({ type: 'exit', sid: 's1' })
    off()
    f.emit({ ev: 'jsonl', sid: 's2' })
    expect(got).toEqual([{ ev: 'jsonl', sid: 's1' }])
    link.close()
    expect(f.subscribed()).toBe(false)
  })

  it('state events while someone listens; streams to the follower only, the door as purpose', async () => {
    const f = fakeConn()
    const link = createDaemonConnectionLink({ conn: f.conn, walnutId: 'w', stateEveryMs: 10 })
    const states: unknown[] = []
    const off = link.on('state', (s) => states.push(s))
    f.conn.connected = false
    await new Promise((r) => setTimeout(r, 40))
    expect(states).toEqual(['down'])
    off()
    await link.openStream('follower', 'replica')
    expect(f.opened).toEqual([{ to: 'follower', purpose: 'replica' }])
    await expect(link.openStream('primary', 'web')).rejects.toThrow(/follower only/)
    await expect(link.openStream('companion', 'web')).rejects.toThrow(/follower only/)
    link.close()
  })

  it('an off called twice counts once: the other listener keeps its state events', async () => {
    const f = fakeConn()
    const link = createDaemonConnectionLink({ conn: f.conn, walnutId: 'w', stateEveryMs: 10 })
    const a: unknown[] = []
    const b: unknown[] = []
    const offA = link.on('state', (s) => a.push(s))
    const offB = link.on('state', (s) => b.push(s))
    offA()
    offA()
    f.conn.connected = false
    await new Promise((r) => setTimeout(r, 40))
    expect(a).toEqual([])
    expect(b).toEqual(['down'])
    offB()
    link.close()
  })

  it('an off after close never takes the count below zero; a closed link arms no watch', async () => {
    const f = fakeConn()
    const link = createDaemonConnectionLink({ conn: f.conn, walnutId: 'w', stateEveryMs: 10 })
    const off = link.on('state', () => {})
    link.close()
    off()
    // Subscribing after close starts nothing that close() could no longer stop (the
    // count left at -1 used to arm a watch on the second subscriber).
    const late: unknown[] = []
    const offLate1 = link.on('state', (s) => late.push(s))
    const offLate2 = link.on('state', (s) => late.push(s))
    f.conn.connected = false
    await new Promise((r) => setTimeout(r, 40))
    expect(late).toEqual([])
    offLate1()
    offLate2()
    link.close()
  })
})

function fakeRegistry(over: Partial<{ connected: boolean; inbound: number | null; caps: string[] }> = {}) {
  const st = { connected: true, inbound: null as number | null, caps: ['bridge-stream-v1'], ...over }
  const handlers = new Set<(a: string) => void>()
  const opened: Array<{ alias: string; to: string; purpose?: string }> = []
  const requests: unknown[] = []
  const registry: BridgeRegistryLike = {
    bridgeForHost: () => ({ connected: st.connected }),
    bridgeLastInbound: () => st.inbound,
    bridgeHasCapability: (_a, cap) => st.caps.includes(cap),
    bridgeRequest: async (alias, cmd, params, timeoutMs) => { requests.push({ alias, cmd, params, timeoutMs }); return { ok: true } },
    openBridgeStream: async (alias, to, purpose) => { opened.push({ alias, to, purpose }); return new PassThrough() },
    addBridgeConnectedHandler: (h) => { handlers.add(h); return () => { handlers.delete(h) } },
  }
  return { st, registry, opened, requests, connect: (alias: string) => { for (const h of handlers) h(alias) }, handlers }
}

describe('the bridge Link', () => {
  it('heard is the last frame of the bridge; state, requests and the redial event', async () => {
    let now = 50_000
    const r = fakeRegistry()
    const link = createBridgeLink({ hostAlias: '__local__', walnutId: 'w', registry: r.registry, now: () => now })
    expect(link.heard()).toBe(Infinity)
    r.st.inbound = 49_000
    expect(link.heard()).toBe(1_000)
    now = 52_500
    expect(link.heard()).toBe(3_500)
    expect(link.state()).toBe('up')
    r.st.connected = false
    expect(link.state()).toBe('down')
    expect(await link.request('ping', { nonce: 'n' }, 2_000)).toEqual({ ok: true })
    expect(r.requests).toEqual([{ alias: '__local__', cmd: 'ping', params: { nonce: 'n' }, timeoutMs: 2_000 }])
    const states: unknown[] = []
    link.on('state', (s) => states.push(s))
    r.connect('marina')
    r.connect('__local__')
    expect(states).toEqual(['up'])
    link.close()
    expect(r.handlers.size).toBe(0)
  })

  it('streams to the primary only, and only from a daemon that said bridge-stream-v1', async () => {
    const r = fakeRegistry()
    const link = createBridgeLink({ hostAlias: '__local__', walnutId: 'w', registry: r.registry })
    expect(link.streams()).toBe(true)
    await link.openStream('primary', 'web')
    expect(r.opened).toEqual([{ alias: '__local__', to: 'primary', purpose: 'web' }])
    await expect(link.openStream('follower', 'web')).rejects.toThrow(/primary only/)
    r.st.caps = []
    expect(link.streams()).toBe(false)
    await expect(link.openStream('primary', 'web')).rejects.toThrow(/no bridge-stream-v1/)
    expect(r.opened).toHaveLength(1)
    link.close()
  })
})
