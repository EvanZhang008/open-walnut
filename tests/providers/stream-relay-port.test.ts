/**
 * Port streams ('port-stream-v1'): the daemon's relay (src/providers/stream-relay-core.ts
 * openPort) plugs a link stream into a TCP connection on the daemon's own loopback.
 * A real server endpoint (src/lib/link-stream.ts) on one side, real loopback sockets
 * on the other (servers this test owns), frames through a microtask as a socket
 * delivers them.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import { createStreamRelay, type PortSocket } from '../../src/providers/stream-relay-core.js'
import { createStreamEndpoint, type StreamEndpoint } from '../../src/lib/link-stream.js'

type Link = { ep: StreamEndpoint | null; up: boolean }

const servers: net.Server[] = []
afterEach(() => { for (const s of servers.splice(0)) s.close() })

function harness(opts: { window?: number; connect?: ((port: number, host: string) => PortSocket) | null; connectTimeoutMs?: number } = {}) {
  const dialled: Array<{ port: number; host: string; sock: PortSocket }> = []
  const connect = opts.connect === null ? undefined : (port: number, host: string) => {
    const sock = opts.connect ? opts.connect(port, host) : net.connect({ port, host, allowHalfOpen: true })
    dialled.push({ port, host, sock })
    return sock
  }
  const relay = createStreamRelay<Link>({
    send: (link, ev, data) => { queueMicrotask(() => { if (link.up) link.ep?.handle({ ev, ...data }) }) },
    log: () => {},
    ...(connect ? { connect } : {}),
    ...(opts.connectTimeoutMs ? { connectTimeoutMs: opts.connectTimeoutMs } : {}),
  })
  const primary: Link = { ep: null, up: true }
  primary.ep = createStreamEndpoint({
    window: opts.window,
    openTimeoutMs: 5_000,
    send: (frame) => {
      if (!primary.up) throw new Error('link down')
      queueMicrotask(() => {
        const cmd = String(frame.cmd)
        if (cmd === 'stream.open' && frame.to === 'port') relay.openPort(primary, frame.sid, frame.port, frame.host)
        else relay.frame(primary, cmd.slice('stream.'.length), frame)
      })
    },
  })
  return { relay, primary, ep: primary.ep, dialled }
}

async function listen(onConn: (c: net.Socket) => void, host = '127.0.0.1'): Promise<number> {
  // A cut stream reaches the service as a reset: an error the service expects.
  const s = net.createServer({ allowHalfOpen: true }, (c) => { c.on('error', () => {}); onConn(c) })
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject)
    s.listen(0, host, () => { s.off('error', reject); resolve() })
  })
  servers.push(s)
  return (s.address() as net.AddressInfo).port
}

/** A port with nothing behind it: bound once, then closed. */
async function freePort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  const port = (s.address() as net.AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

function readAll(s: Duplex): Promise<Buffer> {
  const parts: Buffer[] = []
  s.on('data', (b: Buffer) => parts.push(b))
  return new Promise((resolve, reject) => {
    s.on('end', () => resolve(Buffer.concat(parts)))
    s.on('error', reject)
  })
}

const binary = (n: number) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 131 + 7) & 0xff; return b }

describe('a port stream through the daemon', () => {
  it('carries binary both ways through an echo server, and is forgotten after both FINs', async () => {
    const port = await listen((c) => c.pipe(c))
    const h = harness()
    const s = await h.ep.openPort(port, '127.0.0.1')
    const big = binary(3 * 1024 * 1024 + 5)
    const got = readAll(s)
    s.end(big)
    expect((await got).equals(big)).toBe(true)
    await vi.waitFor(() => {
      expect(h.relay.count()).toBe(0)
      expect(h.ep.size()).toBe(0)
    }, { timeout: 10_000, interval: 10 })
    expect(h.dialled.map((d) => d.host)).toEqual(['127.0.0.1'])
  })

  it('passes a half close: the request ends, the answer still comes back', async () => {
    const port = await listen((c) => {
      const parts: Buffer[] = []
      c.on('data', (b) => parts.push(b))
      // Answer only after the client's FIN: a half-open socket keeps writing.
      c.on('end', () => c.end(Buffer.concat([Buffer.from('got:'), ...parts])))
    })
    const h = harness()
    const s = await h.ep.openPort(port, 'localhost')
    const got = readAll(s)
    s.end(Buffer.from([0, 255, 1, 254]))
    expect(await got).toEqual(Buffer.concat([Buffer.from('got:'), Buffer.from([0, 255, 1, 254])]))
    await vi.waitFor(() => { expect(h.relay.count()).toBe(0) }, { timeout: 10_000, interval: 10 })
  })

  it('stops reading the TCP socket while a window is unacked, and goes on once the reader takes it', async () => {
    // The service sends 4 MB at once; the server side does not read for a while.
    const total = 4 * 1024 * 1024
    const port = await listen((c) => c.end(binary(total)))
    let pauses = 0
    const h = harness({
      connect: (p, host) => {
        const sock = net.connect({ port: p, host, allowHalfOpen: true })
        const pause = sock.pause.bind(sock)
        sock.pause = () => { pauses++; return pause() }
        return sock
      },
    })
    const s = await h.ep.openPort(port, '127.0.0.1')
    s.pause()
    // The backpressure reaches the far socket: wait for that, not a clock.
    await vi.waitFor(() => expect(pauses).toBeGreaterThan(0), { timeout: 10_000 })
    // Nothing is lost while paused.
    const got = readAll(s)
    s.resume()
    s.end()
    expect((await got).equals(binary(total))).toBe(true)
  })

  it('acks the link only for bytes the socket took, so a slow service slows the sender', async () => {
    let far: net.Socket | null = null
    const port = await listen((c) => { far = c; c.pause() })
    const h = harness({ window: 64 * 1024 })
    const s = await h.ep.openPort(port, '127.0.0.1')
    let written = 0
    const chunk = Buffer.alloc(64 * 1024, 0xab)
    const cap = 64 * 1024 * 1024
    // Write as fast as the stream lets us until no drain comes: the kernel
    // buffers of the paused service are full and the daemon stopped acking.
    while (written < cap) {
      written += chunk.length
      if (s.write(chunk)) continue
      const drained = await Promise.race([
        new Promise<boolean>((r) => s.once('drain', () => r(true))),
        new Promise<boolean>((r) => setTimeout(() => r(false), 300)),
      ])
      if (!drained) break
    }
    expect(written).toBeLessThan(cap)
    let read = 0
    await vi.waitFor(() => { expect(far).not.toBeNull() }, { timeout: 5_000, interval: 10 })
    far!.on('data', (b: Buffer) => { read += b.length })
    far!.resume()
    await vi.waitFor(() => { expect(read).toBe(written) }, { timeout: 10_000, interval: 10 })
    s.destroy()
  })

  it('opens many streams at once, each with its own connection', async () => {
    const port = await listen((c) => c.pipe(c))
    const h = harness()
    const results = await Promise.all(Array.from({ length: 24 }, async (_, i) => {
      const s = await h.ep.openPort(port, '127.0.0.1')
      const got = readAll(s)
      s.end(Buffer.from(`stream-${i}`))
      return (await got).toString()
    }))
    expect(results).toEqual(Array.from({ length: 24 }, (_, i) => `stream-${i}`))
    expect(h.dialled).toHaveLength(24)
  })

  it('refuses a bad port and any host that is not this machine\'s loopback, without dialling', async () => {
    const h = harness()
    for (const bad of [0, -1, 65536, 1.5, Number.NaN, '8080' as unknown as number]) {
      await expect(h.ep.openPort(bad, '127.0.0.1')).rejects.toThrow(/not a TCP port/)
    }
    for (const host of ['10.0.0.8', '0.0.0.0', '::', 'example.test', 'localhost.example.test', '127.0.0.1.example.test', '127.0.0.300', '169.254.169.254', '']) {
      await expect(h.ep.openPort(8080, host)).rejects.toThrow(/only this host's own loopback/)
    }
    expect(h.dialled).toEqual([])
    expect(h.relay.count()).toBe(0)
  })

  it('says plainly when nothing listens on the port', async () => {
    const h = harness()
    await expect(h.ep.openPort(await freePort(), '127.0.0.1')).rejects.toThrow(/nothing is listening on port \d+ on this host/)
    expect(h.relay.count()).toBe(0)
  })

  it('without an IPv6 loopback, localhost that 127.0.0.1 refuses still says nothing listens', async () => {
    // A connect to ::1 that cannot even be made (EADDRNOTAVAIL on a host with no ::1).
    const h = harness({
      connect: (p, host) => {
        if (host !== '::1') return net.connect({ port: p, host, allowHalfOpen: true })
        const s = new net.Socket()
        queueMicrotask(() => s.emit('error', Object.assign(new Error('connect EADDRNOTAVAIL ::1'), { code: 'EADDRNOTAVAIL' })))
        return s as unknown as PortSocket
      },
    })
    await expect(h.ep.openPort(await freePort(), 'localhost')).rejects.toThrow(/nothing is listening on port \d+ on this host/)
    expect(h.dialled.map((d) => d.host)).toEqual(['127.0.0.1', '::1'])
  })

  it('tries ::1 for localhost when 127.0.0.1 refuses', async () => {
    let port: number
    try { port = await listen((c) => c.end('v6'), '::1') } catch { return /* no IPv6 loopback on this machine */ }
    // Taken on ::1 only: the IPv4 dial of the same number may still find something there.
    const h = harness()
    const s = await h.ep.openPort(port, 'localhost')
    s.end()
    expect((await readAll(s)).toString()).toBe('v6')
    expect(h.dialled.map((d) => d.host).at(-1)).toBe('::1')
  })

  it('gives up on a connection that never answers, by its deadline', async () => {
    // A socket that never connects and never errors: only the deadline ends it.
    const hung = () => {
      const fake = { on: () => fake, write: () => true, end: () => {}, destroy: vi.fn(), pause: () => {}, resume: () => {} }
      return fake as unknown as PortSocket
    }
    const h = harness({ connect: hung, connectTimeoutMs: 60 })
    await expect(h.ep.openPort(8080, '127.0.0.1')).rejects.toThrow(/nothing answered on port 8080 on this host within/)
    expect((h.dialled[0].sock as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy).toHaveBeenCalled()
    expect(h.relay.count()).toBe(0)
  })

  it('a link that drops resets its connections, and the service sees them close', async () => {
    let closed = 0
    let resets = 0
    // Half open on purpose: a FIN alone would leave these open; the reset closes them.
    const port = await listen((c) => { c.on('close', () => { closed++ }); c.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'ECONNRESET') resets++ }); c.resume() })
    const h = harness()
    const a = await h.ep.openPort(port, '127.0.0.1')
    const b = await h.ep.openPort(port, '127.0.0.1')
    a.on('error', () => {}); b.on('error', () => {})
    expect(h.relay.count(h.primary)).toBe(2)
    h.primary.up = false
    h.relay.dropLink(h.primary)
    h.ep.closeAll('the link closed')
    expect(h.relay.count()).toBe(0)
    await vi.waitFor(() => { expect(closed).toBe(2) }, { timeout: 5_000, interval: 10 })
    expect(resets).toBe(2)
  })

  it('a service that resets reaches the link as a close with a reason', async () => {
    const port = await listen((c) => { c.resetAndDestroy() })
    const h = harness()
    const s = await h.ep.openPort(port, '127.0.0.1').catch((e: Error) => e)
    if (s instanceof Error) {
      // The reset can come before the connect is seen: then the open itself fails.
      expect(s.message).toMatch(/port \d+ on this host|closed/)
    } else {
      const why = await new Promise<Error | null>((r) => { s.once('error', r); s.once('close', () => r(null)) })
      expect(why === null || /port \d+|closed/.test(why.message)).toBe(true)
    }
    await vi.waitFor(() => { expect(h.relay.count()).toBe(0) }, { timeout: 5_000, interval: 10 })
  })

  it('a relay without connect, a reused id or an opener id of the wrong shape is refused', () => {
    const sent: Array<[string, string, Record<string, unknown>]> = []
    const plain = createStreamRelay<string>({ send: (l, ev, d) => sent.push([l, ev, d]), log: () => {} })
    plain.openPort('a', 'o1', 8080, '127.0.0.1')
    plain.openPort('a', 'r1', 8080, '127.0.0.1')
    expect(sent).toEqual([['a', 'stream-close', { sid: 'o1', error: 'this daemon opens no port streams' }]])
    const sent2: Array<[string, string, Record<string, unknown>]> = []
    const never = () => ({ on() { return this }, write: () => true, end() {}, destroy() {}, pause() {}, resume() {} }) as unknown as PortSocket
    const relay = createStreamRelay<string>({ send: (l, ev, d) => sent2.push([l, ev, d]), log: () => {}, connect: never, connectTimeoutMs: 60_000 })
    relay.openPort('a', 'o1', 8080, '127.0.0.1')
    relay.openPort('a', 'o1', 8081, '127.0.0.1')
    expect(sent2).toEqual([['a', 'stream-close', { sid: 'o1', error: 'that stream id is already in use' }]])
    expect(relay.count('a')).toBe(1)
    relay.dropLink('a')
    expect(relay.count()).toBe(0)
  })

  it('data before the connection is open, or after the link ended, ends the stream', () => {
    const sent: Array<[string, string, Record<string, unknown>]> = []
    const destroy = vi.fn()
    const sock = { on() { return sock }, write: () => true, end() {}, destroy, pause() {}, resume() {} } as unknown as PortSocket
    const relay = createStreamRelay<string>({ send: (l, ev, d) => sent.push([l, ev, d]), log: () => {}, connect: () => sock, connectTimeoutMs: 60_000 })
    relay.openPort('a', 'o1', 8080, '127.0.0.1')
    relay.frame('a', 'data', { sid: 'o1', d: 'AAAA' })
    expect(sent).toEqual([['a', 'stream-close', { sid: 'o1', error: 'bad data frame' }]])
    expect(destroy).toHaveBeenCalled()
    expect(relay.count()).toBe(0)
  })

  it('one id space per link: a pair cannot take a port stream\'s id, nor the other way round', () => {
    const sent: string[] = []
    const never = () => ({ on() { return this }, write: () => true, end() {}, destroy() {}, pause() {}, resume() {} }) as unknown as PortSocket
    const relay = createStreamRelay<string>({ send: (l, ev, d) => sent.push(`${l}:${ev}:${String(d.error ?? '')}`), log: () => {}, connect: never, connectTimeoutMs: 60_000 })
    relay.openPort('a', 'o1', 8080, '127.0.0.1')
    relay.open('a', 'o1', 'b', {})
    relay.open('a', 'o2', 'b', {})
    relay.openPort('a', 'o2', 8080, '127.0.0.1')
    expect(sent).toEqual([
      'a:stream-close:that stream id is already in use',
      'b:stream-open:',
      'a:stream-close:that stream id is already in use',
    ])
    expect(relay.count('a')).toBe(2)
    relay.dropLink('a')
  })
})
