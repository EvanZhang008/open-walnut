/**
 * Which machine answers at a tunnel's address (src/core/expose/probe.ts), over real
 * HTTP: each listener a tunnel points at answers the probe path with its own token,
 * so a check through the address tells this run from another Walnut, from a sign-in
 * page in front (unverified), and from the service's error page or nothing (down).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { TUNNEL_PROBE_PATH, answerTunnelProbe, httpProbe, probeAnswer } from '../../src/core/expose/probe.js'

/** Stands in for a tunnel service in front of one listener: `/t/<name>` goes to `answer`. */
let behind: (req: IncomingMessage, res: ServerResponse) => void = () => {}
let seen: string[] = []
let server: http.Server
let base = ''

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    if (!(req.url ?? '').startsWith('/t/demo')) { res.writeHead(404); res.end('no such tunnel'); return }
    req.url = (req.url ?? '').slice('/t/demo'.length) || '/'
    behind(req, res)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/t/demo`
})
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())) })

const app = (status: number, headers: Record<string, string> = {}) => (req: IncomingMessage, res: ServerResponse) => {
  if (answerTunnelProbe(req, res, 'token-of-this-run')) return
  res.writeHead(status, headers)
  res.end('the app')
}

describe('answerTunnelProbe', () => {
  it('answers GET and HEAD on its path only, with its token, before the app', async () => {
    behind = app(401)
    seen = []
    const res = await fetch(`${base}${TUNNEL_PROBE_PATH}?x=1`)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-walnut-tunnel')).toBe('token-of-this-run')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect((await fetch(`${base}${TUNNEL_PROBE_PATH}`, { method: 'HEAD' })).headers.get('x-walnut-tunnel')).toBe('token-of-this-run')
    // Anything else is the app's (which wants a sign-in here).
    expect((await fetch(`${base}${TUNNEL_PROBE_PATH}`, { method: 'POST' })).status).toBe(401)
    expect((await fetch(`${base}${TUNNEL_PROBE_PATH}/more`)).status).toBe(401)
    expect((await fetch(`${base}/`)).status).toBe(401)
  })
})

describe('httpProbe', () => {
  it('mine: this run\'s listener answers; other: another Walnut does', async () => {
    behind = app(200)
    seen = []
    expect(await httpProbe(base, 5_000, 'token-of-this-run')).toBe('mine')
    expect(await httpProbe(`${base}/`, 5_000, 'token-of-another-run')).toBe('other')
    // It asks the probe path under the address (a trailing slash or a query never matters).
    expect(seen).toEqual([`GET /t/demo${TUNNEL_PROBE_PATH}`, `GET /t/demo${TUNNEL_PROBE_PATH}`])
    expect(await httpProbe(`${base}?from=link`, 5_000, 'token-of-this-run')).toBe('mine')
  })

  it('unverified: a sign-in page in front answers without a token (a redirect, 401, 403)', async () => {
    for (const status of [200, 302, 401, 403]) {
      behind = (_req, res) => { res.writeHead(status, status === 302 ? { location: 'https://sign-in.example.test/' } : {}); res.end('sign in') }
      expect(await httpProbe(base, 5_000, 'token-of-this-run'), String(status)).toBe('unverified')
    }
  })

  it('down: the service\'s error page (an older connection it no longer routes to), nothing listening, or no answer in time', async () => {
    for (const status of [404, 410, 502, 503, 504, 530]) {
      behind = (_req, res) => { res.writeHead(status); res.end('no connection for this name') }
      expect(await httpProbe(base, 5_000, 'token-of-this-run'), String(status)).toBe('down')
    }
    expect(await httpProbe('http://127.0.0.1:9/t/demo', 2_000, 'token-of-this-run')).toBe('down')
    expect(await httpProbe('not a url', 2_000, 'token-of-this-run')).toBe('down')
    behind = () => { /* never answers */ }
    const t0 = Date.now()
    expect(await httpProbe(base, 300, 'token-of-this-run')).toBe('down')
    expect(Date.now() - t0).toBeLessThan(3_000)
  })

  it('a boolean from an older fake reads as unverified or down', () => {
    expect(probeAnswer(true)).toBe('unverified')
    expect(probeAnswer(false)).toBe('down')
    expect(probeAnswer('other')).toBe('other')
  })
})
