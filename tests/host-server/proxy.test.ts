/**
 * The host server's byte forward (src/host-server/proxy.ts): a request goes to
 * the target as it came over whatever connection the target gives, with the
 * forward headers added, and a read that failed on one target can go to the next.
 */
import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { forwardHttp, forwardUpgrade, type ForwardTarget } from '../../src/host-server/proxy.js'

const servers: http.Server[] = []

async function listen(server: http.Server): Promise<number> {
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return (server.address() as AddressInfo).port
}

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.()
    await new Promise<void>((r) => s.close(() => r()))
  }
})

/** A target that answers with what it got. */
async function echoTarget(): Promise<{ port: number; seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }> }> {
  const seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }> = []
  const port = await listen(http.createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body })
      res.writeHead(200, { 'content-type': 'application/json', connection: 'keep-alive' })
      res.end(JSON.stringify({ ok: true, body }))
    })
  }))
  return { port, seen }
}

const via = (kind: ForwardTarget['kind'], port: number, origin?: string): ForwardTarget => ({
  kind, ...(origin ? { origin } : {}),
  connect: () => new Promise<Duplex>((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => resolve(s))
    s.once('error', reject)
  }),
})

/** A target whose connection is cut as soon as the request reaches it. */
const cutting = (kind: ForwardTarget['kind']): ForwardTarget => ({
  kind,
  connect: () => new Promise<Duplex>((resolve) => {
    const srv = net.createServer((inbound) => {
      srv.close()
      inbound.once('data', () => inbound.destroy())
    })
    srv.listen(0, '127.0.0.1', () => {
      const client = net.connect((srv.address() as AddressInfo).port, '127.0.0.1', () => resolve(client))
    })
  }),
})

describe('forwardHttp', () => {
  it('to the leader: the same Host and Origin, a forward mark, the body as it came', async () => {
    const target = await echoTarget()
    const front = await listen(http.createServer((req, res) => {
      forwardHttp(req, res, via('leader', target.port), (err) => { res.writeHead(599); res.end(err.message) })
    }))
    const res = await fetch(`http://127.0.0.1:${front}/api/tasks?x=1`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://box.example', 'x-forwarded-for': '203.0.113.9' }, body: '{"a":1}',
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-walnut-answered-via')).toBe('leader')
    expect(await res.json()).toEqual({ ok: true, body: '{"a":1}' })
    const got = target.seen[0]!
    expect(got).toMatchObject({ method: 'POST', url: '/api/tasks?x=1', body: '{"a":1}' })
    expect(got.headers.host).toBe(`127.0.0.1:${front}`)
    expect(got.headers.origin).toBe('https://box.example')
    expect(got.headers['x-forwarded-for']).toBe('203.0.113.9, 127.0.0.1')
    expect(got.headers['x-walnut-via']).toBe('host-server')
  })

  it('to the companion: Host and Origin name the companion', async () => {
    const target = await echoTarget()
    const front = await listen(http.createServer((req, res) => {
      forwardHttp(req, res, via('companion', target.port, 'https://cloud.example'), () => { res.writeHead(599); res.end() })
    }))
    const res = await fetch(`http://127.0.0.1:${front}/api/v1/instance`, { headers: { origin: 'https://box.example' } })
    expect(res.headers.get('x-walnut-answered-via')).toBe('companion')
    expect(target.seen[0]!.headers.host).toBe('cloud.example')
    expect(target.seen[0]!.headers.origin).toBe('https://cloud.example')
  })

  it('a read cut on the first target goes to the next and is answered there', async () => {
    const target = await echoTarget()
    const fails: string[] = []
    const front = await listen(http.createServer((req, res) => {
      forwardHttp(req, res, cutting('leader'), (err) => {
        fails.push(err.message)
        forwardHttp(req, res, via('companion', target.port, 'https://cloud.example'), () => { res.writeHead(599); res.end() })
      })
    }))
    const res = await fetch(`http://127.0.0.1:${front}/api/tasks`, { signal: AbortSignal.timeout(10_000) })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-walnut-answered-via')).toBe('companion')
    expect(fails).toHaveLength(1)
    expect(target.seen).toEqual([expect.objectContaining({ method: 'GET', url: '/api/tasks', body: '' })])
  })

  it('a target that cannot be reached is a failure, with nothing sent back yet', async () => {
    const front = await listen(http.createServer((req, res) => {
      forwardHttp(req, res, { kind: 'leader', connect: () => Promise.reject(new Error('no answer from the primary within 4s')) }, (err) => {
        res.writeHead(503, { 'content-type': 'text/plain' }); res.end(err.message)
      })
    }))
    const res = await fetch(`http://127.0.0.1:${front}/`)
    expect(res.status).toBe(503)
    expect(await res.text()).toBe('no answer from the primary within 4s')
  })
})

describe('forwardUpgrade', () => {
  it('passes a refused upgrade on as it came', async () => {
    const target = await listen(http.createServer((_req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}') }))
    const front = await listen(http.createServer())
    servers[servers.length - 1]!.on('upgrade', (req, socket, head) => {
      forwardUpgrade(req, socket, head, via('leader', target), () => socket.destroy())
    })
    const answer = await new Promise<string>((resolve) => {
      const s = net.connect(front, '127.0.0.1', () => {
        s.write('GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n')
      })
      let raw = ''
      s.on('data', (c) => { raw += c.toString() })
      s.on('close', () => resolve(raw))
    })
    expect(answer).toMatch(/^HTTP\/1\.1 401/)
    expect(answer).toContain('{"error":"unauthorized"}')
  })
})
