/**
 * The alone page retires on a host replica (docs/plan/walnut-replica-servers-impl.md,
 * WP7): with the Mac away, a page a browser opens on the replica is the console
 * itself, served by the replica's own app from its copies (marked
 * `x-walnut-offline`), never the host server's alone page. A dispatcher given an
 * `answerAlone` (the plain host server's shape) still answers the alone page.
 *
 * The real dispatcher on a real HTTP server; the "app" behind it is a stand-in
 * that says what it served.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type net from 'node:net'
import { createDispatcher, OFFLINE_HEADER, type DispatchDeps } from '../../src/replica/dispatch.js'

const AS_OF = 1_750_000_000_000
const servers: http.Server[] = []

async function serve(answerAlone?: DispatchDeps['answerAlone']): Promise<number> {
  const deps: DispatchDeps = {
    route: () => ({ kind: 'alone', why: 'mac-away' }),
    asOf: () => AS_OF,
    connect: async () => { throw new Error('the Mac is asleep') },
    suspect: () => {},
    ownUpgrade: (_req, socket) => { socket.end('HTTP/1.1 418 I am the replica\r\n\r\n') },
    log: () => {},
    ...(answerAlone ? { answerAlone } : {}),
  }
  const dispatcher = createDispatcher(deps)
  const server = http.createServer((req, res) => dispatcher.middleware(req, res, () => {
    // The replica's own app: the SPA for a page, JSON for the API.
    const page = !(req.url ?? '').startsWith('/api/')
    res.writeHead(200, { 'content-type': page ? 'text/html' : 'application/json' })
    res.end(page ? `<div id="root" data-offline="${String(res.getHeader(OFFLINE_HEADER) ?? '')}">console</div>` : '{"from":"copies"}')
  }))
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return (server.address() as net.AddressInfo).port
}

function get(port: number, p: string, accept: string): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', agent: false, headers: { accept } }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

let replica = 0
let hostServer = 0
beforeAll(async () => {
  replica = await serve()
  hostServer = await serve((_req, res, why) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<p data-why="${why}">alone</p>`) })
})
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))))
})

describe('a page while the Mac is away', () => {
  it('on the replica: the console from its copies, marked offline, for every page path', async () => {
    for (const p of ['/', '/sessions', '/tasks?project=Acme', '/notes/Projects/Release.md']) {
      const r = await get(replica, p, 'text/html,application/xhtml+xml')
      expect(r.status).toBe(200)
      expect(r.text).toBe(`<div id="root" data-offline="${AS_OF}">console</div>`)
      expect(r.headers['x-walnut-answered-via']).toBe('replica')
    }
    // The API under it reads the copies as before.
    const api = await get(replica, '/api/tasks', 'application/json')
    expect(api.text).toBe('{"from":"copies"}')
    expect(api.headers[OFFLINE_HEADER]).toBe(String(AS_OF))
  })

  it('on the plain host server: the alone page stays', async () => {
    const r = await get(hostServer, '/sessions', 'text/html')
    expect(r.text).toBe('<p data-why="mac-away">alone</p>')
  })
})
