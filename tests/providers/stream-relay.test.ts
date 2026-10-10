/**
 * Streams between two servers through a daemon: the daemon's pair table
 * (src/providers/stream-relay-core.ts) wired to two real server endpoints
 * (src/lib/link-stream.ts), in memory. Frames go through a microtask, the way
 * a socket delivers them later than they were sent.
 */
import { describe, it, expect } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import { createStreamRelay } from '../../src/providers/stream-relay-core.js'
import { createStreamEndpoint, spliceStream, type IncomingStreamInfo, type StreamEndpoint } from '../../src/lib/link-stream.js'

type Link = { name: string; ep: StreamEndpoint | null; up: boolean; frames: number }

function harness(opts: { window?: number; accept?: (info: IncomingStreamInfo) => ((s: Duplex) => void) | null } = {}) {
  const relay = createStreamRelay<Link>({
    send: (link, ev, data) => { queueMicrotask(() => { if (link.up) link.ep?.handle({ ev, ...data }) }) },
    log: () => {},
  })
  const follower: Link = { name: 'follower', ep: null, up: true, frames: 0 }
  const primary: Link = { name: 'primary', ep: null, up: true, frames: 0 }
  const daemonGets = (from: Link) => (frame: Record<string, unknown>) => {
    if (!from.up) throw new Error('link down')
    from.frames++
    queueMicrotask(() => {
      const cmd = String(frame.cmd)
      if (cmd === 'stream.open') {
        const to = frame.to === 'primary' && from === follower ? primary : frame.to === 'follower' && from === primary ? follower : null
        relay.open(from, frame.sid, to && to.up ? to : null, { from: from.name, home: '/h' }, 'nobody there')
      } else {
        relay.frame(from, cmd.slice('stream.'.length), frame)
      }
    })
  }
  follower.ep = createStreamEndpoint({ send: daemonGets(follower), window: opts.window, openTimeoutMs: 2_000, accept: opts.accept })
  primary.ep = createStreamEndpoint({ send: daemonGets(primary), window: opts.window, openTimeoutMs: 2_000, accept: opts.accept })
  return { relay, follower, primary }
}

/** A server that echoes every byte back, as the primary's door. */
async function echoServer(): Promise<{ port: number; close: () => void }> {
  const s = net.createServer((c) => c.pipe(c))
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  return { port: (s.address() as net.AddressInfo).port, close: () => s.close() }
}

function readAll(s: Duplex): Promise<Buffer> {
  const parts: Buffer[] = []
  s.on('data', (b: Buffer) => parts.push(b))
  return new Promise((resolve, reject) => {
    s.on('end', () => resolve(Buffer.concat(parts)))
    s.on('error', reject)
  })
}

describe('a stream through the daemon', () => {
  it('carries bytes both ways, in order, and both ends are forgotten after both FINs', async () => {
    const echo = await echoServer()
    const h = harness({ accept: (info) => (info.from === 'follower' ? (s) => spliceStream(s, net.connect(echo.port, '127.0.0.1')) : null) })
    const s = await h.follower.ep!.open('primary')
    const big = Buffer.alloc(3 * 1024 * 1024 + 17)
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff
    const got = readAll(s)
    s.end(big)
    expect((await got).equals(big)).toBe(true)
    await new Promise((r) => setTimeout(r, 50))
    expect(h.relay.count()).toBe(0)
    expect(h.follower.ep!.size()).toBe(0)
    expect(h.primary.ep!.size()).toBe(0)
    echo.close()
  })

  it('keeps at most a window in flight: a reader that stops stops the writer', async () => {
    let far: Duplex | null = null
    const h = harness({ window: 64 * 1024, accept: () => (s) => { far = s; s.pause() } })
    const s = await h.follower.ep!.open('primary')
    let written = 0
    const chunk = Buffer.alloc(16 * 1024)
    // Write until the stream says wait, then a little longer.
    for (let i = 0; i < 200; i++) { written += chunk.length; if (!s.write(chunk)) break }
    await new Promise((r) => setTimeout(r, 50))
    const framesWhilePaused = h.follower.frames
    await new Promise((r) => setTimeout(r, 50))
    // Nothing more went out while nobody read.
    expect(h.follower.frames).toBe(framesWhilePaused)
    expect(written).toBeLessThan(1024 * 1024)
    // The reader takes it all, and the writer may go on.
    let read = 0
    far!.on('data', (b: Buffer) => { read += b.length })
    far!.resume()
    await new Promise((r) => setTimeout(r, 50))
    expect(read).toBe(written)
    expect(s.write(chunk)).toBe(true)
    s.destroy()
  })

  it('HTTP runs over it, with the stream as the socket', async () => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => { res.setHeader('x-host', String(req.headers.host)); res.end(`${req.method} ${req.url} ${body}`) })
    })
    const h = harness({ accept: () => (s) => server.emit('connection', s) })
    // The stream first, then a request that uses it as its socket.
    const s = await h.primary.ep!.open('follower')
    const answer = await new Promise<{ status: number; body: string; host: string }>((resolve, reject) => {
      const req = http.request({ method: 'POST', path: '/bridge/replica', headers: { host: 'follower.local' }, createConnection: () => s } as http.RequestOptions, (res) => {
        let body = ''
        res.on('data', (c) => { body += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, host: String(res.headers['x-host']) }))
      })
      req.on('error', reject)
      req.end('payload')
    })
    expect(answer).toEqual({ status: 200, body: 'POST /bridge/replica payload', host: 'follower.local' })
  })

  it('a stream nobody listens to ends quietly when its link drops, and one that is listened to hears why', async () => {
    // An HTTP client lets go of a socket whose upgrade was refused: no listener of any kind is left on it.
    const h = harness({ accept: () => (s) => { s.on('error', () => {}); s.resume() } })
    const unheard = await h.primary.ep!.open('follower')
    const heard = await h.primary.ep!.open('follower')
    const why = new Promise<Error>((r) => heard.once('error', r))
    const uncaught: unknown[] = []
    const saved = process.listeners('uncaughtException')
    process.removeAllListeners('uncaughtException')
    const onUncaught = (e: unknown) => uncaught.push(e)
    process.on('uncaughtException', onUncaught)
    try {
      const closed = new Promise((r) => unheard.once('close', r))
      h.follower.up = false
      h.relay.dropLink(h.follower)
      await closed
      expect((await why).message).toMatch(/no longer linked/)
      await new Promise((r) => setTimeout(r, 10))
      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', onUncaught)
      for (const l of saved) process.on('uncaughtException', l)
    }
  })

  it('an open to nobody, or one the other side refuses, fails with the reason', async () => {
    const h = harness({ accept: () => null })
    await expect(h.follower.ep!.open('companion')).rejects.toThrow('nobody there')
    await expect(h.follower.ep!.open('primary')).rejects.toThrow('does not take that stream')
    expect(h.relay.count()).toBe(0)
    h.primary.up = false
    await expect(h.follower.ep!.open('primary')).rejects.toThrow('nobody there')
  })

  it('a link that drops ends every stream on it, at the other side too', async () => {
    let far: Duplex | null = null
    const h = harness({ accept: () => (s) => { far = s; s.resume() } })
    const s = await h.follower.ep!.open('primary')
    const farClosed = new Promise<Error | undefined>((r) => far!.once('error', (e) => r(e)))
    const nearClosed = new Promise((r) => s.once('close', r))
    s.on('error', () => {})
    // The follower's link goes: the daemon drops it, the follower's server closes its own side.
    h.follower.up = false
    h.relay.dropLink(h.follower)
    h.follower.ep!.closeAll('the link to the daemon closed')
    expect((await farClosed)?.message).toMatch(/no longer linked/)
    await nearClosed
    expect(h.relay.count()).toBe(0)
    expect(h.primary.ep!.size()).toBe(0)
  })

  it('an abort on one side reaches the other with its reason', async () => {
    let far: Duplex | null = null
    const h = harness({ accept: () => (s) => { far = s; s.resume() } })
    const s = await h.follower.ep!.open('primary')
    await new Promise((r) => setTimeout(r, 10))
    const gotErr = new Promise<Error>((r) => far!.once('error', r))
    s.on('error', () => {})
    s.destroy(new Error('the browser went away'))
    expect((await gotErr).message).toBe('the browser went away')
    await new Promise((r) => setTimeout(r, 10))
    expect(h.relay.count()).toBe(0)
  })

  it('the daemon refuses an id that is not an opener id, a reused one, and data before accept', () => {
    const sent: Array<[string, string, Record<string, unknown>]> = []
    const relay = createStreamRelay<string>({ send: (l, ev, d) => sent.push([l, ev, d]), log: () => {} })
    relay.open('a', 'r1', 'b', {})
    relay.open('a', '../x', 'b', {})
    expect(sent).toEqual([])
    relay.open('a', 'o1', 'b', { from: 'follower' })
    relay.open('a', 'o1', 'b', {})
    expect(sent[0]).toEqual(['b', 'stream-open', { from: 'follower', sid: 'r1' }])
    expect(sent[1]).toEqual(['a', 'stream-close', { sid: 'o1', error: 'that stream id is already in use' }])
    // The opener may not accept its own stream, nor send before the other side accepted.
    relay.frame('a', 'accept', { sid: 'o1' })
    expect(sent).toHaveLength(2)
    relay.frame('a', 'data', { sid: 'o1', d: 'aGk=' })
    expect(sent.slice(2)).toEqual([
      ['a', 'stream-close', { sid: 'o1', error: 'bad data frame' }],
      ['b', 'stream-close', { sid: 'r1', error: 'bad data frame' }],
    ])
    // A late close for a stream that is gone gets no answer.
    relay.frame('b', 'close', { sid: 'r1' })
    expect(sent).toHaveLength(4)
    expect(relay.count()).toBe(0)
  })

  it('caps the streams on one link', () => {
    const sent: string[] = []
    const relay = createStreamRelay<string>({ send: (_l, ev, d) => sent.push(`${ev}:${String(d.error ?? '')}`), log: () => {} })
    for (let i = 1; i <= 65; i++) relay.open('a', `o${i}`, 'b', {})
    expect(relay.count('a')).toBe(64)
    expect(sent.at(-1)).toBe('stream-close:too many streams on this link')
  })
})
