/**
 * The HTTP server closes in bounded time whatever is still open on it
 * (src/web/http-close.ts). 2026-11-10: every deploy's graceful shutdown ran into
 * the 7 s bail, waiting on a long poll still open. One case per kind of open
 * connection: a request still being answered, an idle keep-alive socket, a
 * request whose headers never finished arriving, and an open stream.
 */
import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { closeHttpServer, HTTP_DRAIN_GRACE_MS } from '../../src/web/http-close.js'

const servers: http.Server[] = []
const sockets: net.Socket[] = []
afterEach(() => {
  for (const s of sockets.splice(0)) s.destroy()
  for (const s of servers.splice(0)) { s.closeAllConnections?.(); s.close() }
})

async function serve(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    if (req.url === '/hang') return // a long poll that outlives any shutdown
    if (req.url === '/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(':\n\n'); return }
    if (req.url === '/slow') { setTimeout(() => res.end('late'), 200); return }
    res.end('ok')
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: (server.address() as net.AddressInfo).port }
}

/** Write `text` on a raw socket and wait until it is accepted. */
async function raw(port: number, text: string): Promise<net.Socket> {
  const s = net.connect(port, '127.0.0.1')
  sockets.push(s)
  s.on('error', () => {})
  await new Promise<void>((r) => s.once('connect', () => r()))
  s.write(text)
  return s
}

async function timeClose(server: http.Server, opts?: Parameters<typeof closeHttpServer>[1]): Promise<number> {
  const t0 = Date.now()
  await closeHttpServer(server, opts)
  return Date.now() - t0
}

const BOUND = HTTP_DRAIN_GRACE_MS + 1_500

describe('closeHttpServer', () => {
  it('a request still being answered is cut after the grace', async () => {
    const { server, port } = await serve()
    await raw(port, 'GET /hang HTTP/1.1\r\nHost: x\r\n\r\n')
    await new Promise((r) => setTimeout(r, 100))
    expect(await timeClose(server)).toBeLessThan(BOUND)
  })

  it('an idle keep-alive socket does not hold it', async () => {
    const { server, port } = await serve()
    const s = await raw(port, 'GET / HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n')
    await new Promise<void>((r) => s.once('data', () => r()))
    expect(await timeClose(server)).toBeLessThan(BOUND)
  })

  it('a request whose headers never finished does not hold it', async () => {
    const { server, port } = await serve()
    await raw(port, 'POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: 10\r\n')
    await new Promise((r) => setTimeout(r, 100))
    expect(await timeClose(server)).toBeLessThan(BOUND)
  })

  it('an open stream does not hold it', async () => {
    const { server, port } = await serve()
    const s = await raw(port, 'GET /stream HTTP/1.1\r\nHost: x\r\n\r\n')
    await new Promise<void>((r) => s.once('data', () => r()))
    expect(await timeClose(server)).toBeLessThan(BOUND)
  })

  it('a short request in flight still gets its answer', async () => {
    const { server, port } = await serve()
    const answer = new Promise<string>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/slow', agent: false }, (res) => {
        let body = ''
        res.on('data', (c) => { body += c })
        res.on('end', () => resolve(body))
      }).on('error', reject)
    })
    await new Promise((r) => setTimeout(r, 50))
    const closing = closeHttpServer(server)
    expect(await answer).toBe('late')
    await closing
  })

  it('dropConnections cuts everything at once', async () => {
    const { server, port } = await serve()
    await raw(port, 'GET /hang HTTP/1.1\r\nHost: x\r\n\r\n')
    await new Promise((r) => setTimeout(r, 100))
    expect(await timeClose(server, { dropConnections: true })).toBeLessThan(HTTP_DRAIN_GRACE_MS)
  })
})
