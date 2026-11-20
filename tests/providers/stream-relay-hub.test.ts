/**
 * Hub streams ('hub-forward-v1'): the daemon's relay (src/providers/stream-relay-core.ts openOut)
 * opens a stream to the primary for a connection it accepted, and the primary's endpoint
 * (src/lib/link-stream.ts) accepts it, maybe later (an async acceptor), or refuses it. Real
 * loopback sockets on both ends (servers this test owns), frames through a microtask as a socket
 * delivers them.
 */
import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import { createStreamRelay, type PortSocket } from '../../src/providers/stream-relay-core.js'
import { createStreamEndpoint, spliceStream, type IncomingStreamInfo, type StreamEndpoint, type StreamPlug } from '../../src/lib/link-stream.js'

type Link = { ep: StreamEndpoint | null; up: boolean }

const servers: net.Server[] = []
const sockets: net.Socket[] = []
afterEach(() => {
  for (const s of sockets.splice(0)) s.destroy()
  for (const s of servers.splice(0)) s.close()
})

function harness(accept: (info: IncomingStreamInfo) => StreamPlug | Promise<StreamPlug>, opts: { window?: number; connectTimeoutMs?: number } = {}) {
  const relay = createStreamRelay<Link>({
    send: (link, ev, data) => { queueMicrotask(() => { if (link.up) link.ep?.handle({ ev, ...data }) }) },
    log: () => {},
    ...(opts.connectTimeoutMs ? { connectTimeoutMs: opts.connectTimeoutMs } : {}),
  })
  const primary: Link = { ep: null, up: true }
  const frames: Array<Record<string, unknown>> = []
  primary.ep = createStreamEndpoint({
    window: opts.window,
    send: (frame) => {
      if (!primary.up) throw new Error('link down')
      frames.push(frame)
      queueMicrotask(() => relay.frame(primary, String(frame.cmd).slice('stream.'.length), frame))
    },
    accept,
  })
  return { relay, primary, frames }
}

/** A loopback listener whose every connection the relay takes as a hub stream (what hub-forward-core.ts does). */
async function forwardPort(relay: ReturnType<typeof harness>['relay'], primary: Link, gone: Array<{ opened: boolean; error?: string }>, opened: number[] = []): Promise<number> {
  const srv = net.createServer({ allowHalfOpen: true }, (c) => {
    c.on('error', () => {})
    relay.openOut(primary, c as unknown as PortSocket, { from: 'hub', port: 4242 }, {
      opened: () => opened.push(1),
      gone: (o, error) => gone.push({ opened: o, ...(error ? { error } : {}) }),
    })
  })
  servers.push(srv)
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  return (srv.address() as net.AddressInfo).port
}

async function service(onConn: (c: net.Socket) => void): Promise<number> {
  const s = net.createServer({ allowHalfOpen: true }, (c) => { c.on('error', () => {}); onConn(c) })
  servers.push(s)
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  return (s.address() as net.AddressInfo).port
}

function dial(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const c = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true }, () => resolve(c))
    sockets.push(c)
    c.on('error', reject)
  })
}

function readAll(s: Duplex): Promise<Buffer> {
  const parts: Buffer[] = []
  s.on('data', (b: Buffer) => parts.push(b))
  return new Promise((resolve, reject) => {
    s.on('end', () => resolve(Buffer.concat(parts)))
    s.on('error', reject)
  })
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await new Promise((r) => setImmediate(r))
  expect(check()).toBe(true)
}

const closed = (s: net.Socket) => new Promise<void>((r) => { if (s.destroyed) r(); else s.once('close', () => r()) })
const binary = (n: number) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 131 + 7) & 0xff; return b }

describe('a hub stream through the daemon', () => {
  it('carries 1 MB both ways with half closes, to what the primary plugs it into', async () => {
    const svc = await service((c) => {
      const parts: Buffer[] = []
      c.on('data', (b) => parts.push(b))
      c.on('end', () => c.end(Buffer.concat(parts).reverse()))
    })
    const infos: IncomingStreamInfo[] = []
    const { relay, primary } = harness((info) => {
      infos.push(info)
      return (stream) => spliceStream(stream, net.connect({ port: svc, host: '127.0.0.1', allowHalfOpen: true }))
    })
    const gone: Array<{ opened: boolean; error?: string }> = []
    const opened: number[] = []
    const local = await forwardPort(relay, primary, gone, opened)
    const c = await dial(local)
    const big = binary(1024 * 1024 + 17)
    const got = readAll(c)
    c.end(big)
    expect((await got).equals(Buffer.from(big).reverse())).toBe(true)
    expect(infos[0]).toMatchObject({ from: 'hub', port: 4242 })
    expect(infos[0].sid).toMatch(/^r/)
    expect(opened).toEqual([1])
    await closed(c)
    await until(() => gone.length > 0)
    expect(gone).toEqual([{ opened: true }])
    expect(relay.count()).toBe(0)
  })

  it('bytes sent before an async accept are held and go once it comes', async () => {
    const svc = await service((c) => c.pipe(c))
    let release!: () => void
    const decided = new Promise<void>((r) => { release = r })
    let asked = false
    const { relay, primary } = harness(async () => {
      asked = true
      await decided
      return (stream) => spliceStream(stream, net.connect({ port: svc, host: '127.0.0.1', allowHalfOpen: true }))
    })
    const local = await forwardPort(relay, primary, [])
    const c = await dial(local)
    const got = readAll(c)
    c.write('early ')
    // The primary is deciding while the early bytes wait in the daemon.
    await until(() => asked)
    release()
    c.end('late')
    expect((await got).toString()).toBe('early late')
  })

  it('a refusal (null, a rejected acceptor, an older primary with no acceptor) closes the connection and says why', async () => {
    const cases: Array<[((info: IncomingStreamInfo) => StreamPlug | Promise<StreamPlug>) | undefined, RegExp]> = [
      [() => null, /this server does not take that stream/],
      [async () => { throw new Error('port 4242 on this Walnut is not open to home-pc (net.hub_ports, or a plugin grant)') }, /not open to home-pc/],
      // An older primary: its endpoint has no acceptor for a hub stream.
      [undefined, /this server does not take that stream/],
    ]
    for (const [accept, why] of cases) {
      const relay = createStreamRelay<Link>({ send: (link, ev, data) => { queueMicrotask(() => { if (link.up) link.ep?.handle({ ev, ...data }) }) }, log: () => {} })
      const primary: Link = { ep: null, up: true }
      primary.ep = createStreamEndpoint({
        send: (frame) => queueMicrotask(() => relay.frame(primary, String(frame.cmd).slice('stream.'.length), frame)),
        ...(accept ? { accept } : {}),
      })
      const gone: Array<{ opened: boolean; error?: string }> = []
      const local = await forwardPort(relay, primary, gone)
      const c = await dial(local)
      c.on('error', () => {})
      c.write('secret')
      await closed(c)
      expect(gone).toHaveLength(1)
      expect(gone[0].opened).toBe(false)
      expect(gone[0].error).toMatch(why)
      expect(relay.count()).toBe(0)
    }
  })

  it('no answer from the primary within the open deadline cuts the connection', async () => {
    const relay = createStreamRelay<Link>({ send: () => {}, log: () => {}, connectTimeoutMs: 200 })
    const primary: Link = { ep: null, up: true }
    const gone: Array<{ opened: boolean; error?: string }> = []
    const local = await forwardPort(relay, primary, gone)
    const c = await dial(local)
    c.on('error', () => {})
    await closed(c)
    expect(gone[0]).toEqual({ opened: false, error: 'the primary did not answer within 0s' })
  })

  it('a client that leaves before the primary answers is no refusal: its stream ends once it is open', async () => {
    let release!: () => void
    const decided = new Promise<void>((r) => { release = r })
    // The primary's side ends once the client's FIN reaches it, as a service would.
    let asked = false
    const { relay, primary } = harness(async () => { asked = true; await decided; return (stream) => { stream.resume(); stream.on('end', () => stream.end()) } })
    const gone: Array<{ opened: boolean; error?: string; local?: boolean }> = []
    const srv = net.createServer({ allowHalfOpen: true }, (c) => {
      c.on('error', () => {})
      relay.openOut(primary, c as unknown as PortSocket, { from: 'hub', port: 4242 }, { opened: () => {}, gone: (o, error, local) => gone.push({ opened: o, error, local }) })
    })
    servers.push(srv)
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
    const c = await dial((srv.address() as net.AddressInfo).port)
    c.destroy()
    // The paused socket reads its end only once the primary accepts.
    await until(() => asked)
    release()
    await until(() => relay.count() === 0)
    expect(relay.count()).toBe(0)
    expect(gone).toHaveLength(1)
    expect(gone[0].opened || gone[0].local).toBe(true)
  })

  it('an acceptor that decides after the link dropped sends nothing and is never plugged', async () => {
    let release!: () => void
    const decided = new Promise<void>((r) => { release = r })
    let plugged = 0
    const frames: Array<Record<string, unknown>> = []
    const ep = createStreamEndpoint({ send: (f) => { frames.push(f) }, accept: async () => { await decided; return () => { plugged++ } } })
    ep.handle({ ev: 'stream-open', sid: 'r1', from: 'hub', port: 1 })
    ep.closeAll('the link closed')
    release()
    await decided
    // The acceptor's answer is taken a few microtasks after it resolves.
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(frames).toEqual([])
    expect(plugged).toBe(0)
    // A daemon that restarted reuses r1 for a new stream: that one is answered on its own.
    ep.handle({ ev: 'stream-open', sid: 'r1', from: 'hub', port: 1 })
    await until(() => frames.length > 0)
    expect(frames).toEqual([{ cmd: 'stream.accept', sid: 'r1' }])
  })

  it('the link dropping cuts every forwarded connection, and the owner hears each', async () => {
    let held: net.Socket | null = null
    const svc = await service((c) => { held = c; c.resume() })
    const { relay, primary } = harness(() => (stream) => spliceStream(stream, net.connect({ port: svc, host: '127.0.0.1', allowHalfOpen: true })))
    const gone: Array<{ opened: boolean; error?: string }> = []
    const local = await forwardPort(relay, primary, gone)
    const c = await dial(local)
    c.on('error', () => {})
    c.write('hello')
    for (let i = 0; i < 100 && !held; i++) await new Promise((r) => setTimeout(r, 10))
    expect(held).not.toBeNull()
    primary.up = false
    relay.dropLink(primary)
    primary.ep!.closeAll('the link closed')
    await closed(c)
    expect(gone).toEqual([{ opened: true, error: 'the link to the other side closed' }])
    expect(relay.count()).toBe(0)
  })

  it('a slow reader on the primary side slows the connection: the daemon stops reading past its window', async () => {
    // The primary's plug never reads: it acks only what its stream buffered, and the relay stops reading the socket.
    let sent = 0
    const relay = createStreamRelay<Link>({
      send: (link, ev, data) => {
        if (ev === 'stream-data') sent += Buffer.from(String(data.d), 'base64').length
        queueMicrotask(() => { if (link.up) link.ep?.handle({ ev, ...data }) })
      },
      log: () => {},
    })
    const primary: Link = { ep: null, up: true }
    let acked = 0
    primary.ep = createStreamEndpoint({
      send: (frame) => {
        if (frame.cmd === 'stream.ack') acked += Number(frame.n)
        queueMicrotask(() => relay.frame(primary, String(frame.cmd).slice('stream.'.length), frame))
      },
      accept: () => (stream) => { stream.pause() },
    })
    const local = await forwardPort(relay, primary, [])
    const c = await dial(local)
    c.on('error', () => {})
    c.write(binary(4 * 1024 * 1024))
    await new Promise((r) => setTimeout(r, 300))
    expect(sent).toBeGreaterThan(0)
    // Of 4 MB written, the daemon took no more than its window (256 KB) plus the socket's last
    // reads before the pause took (a runtime reads up to a few hundred KB at once): bounded.
    expect(sent).toBeLessThan(1024 * 1024)
    expect(acked).toBeLessThan(sent)
    const before = sent
    await new Promise((r) => setTimeout(r, 200))
    expect(sent).toBe(before)
  })
})
