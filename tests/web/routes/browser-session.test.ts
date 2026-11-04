/**
 * Every server a phone's address can reach answers GET /api/devices/browser-session
 * itself (routes/browser-session.ts): the route trusts only the device its role's
 * auth middleware named; a host replica keeps it local; the plain host server
 * answers it from its device copy while it shows the alone page. 2026-11-04, the
 * user: "if cookie is cleared need another code" (Safari's 7-day rules).
 */
import http from 'node:http'
import vm from 'node:vm'
import type { AddressInfo } from 'node:net'
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { browserSessionHandler } from '../../../src/web/routes/browser-session.js'
import { classify } from '../../../src/replica/route-table.js'
import { answerBrowserSession, isBrowserSessionRequest } from '../../../src/host-server/browser-session.js'
import { pageIsSecure } from '../../../src/web/middleware/device-cookie.js'
import { alonePage } from '../../../src/host-server/alone-page.js'

/** A role's auth middleware, reduced to what the route reads: the device it named, if any. */
function app(named: string | undefined) {
  return express()
    .use((req: Request, _res: Response, next: NextFunction) => {
      ;(req as Request & { deviceName?: string }).deviceName = named
      next()
    })
    .get('/api/devices/browser-session', browserSessionHandler)
}

describe('the route behind any role\'s auth middleware', () => {
  it('a named device gets its own token back and the cookie, never another', async () => {
    const res = await request(app('browser-1')).get('/api/devices/browser-session').set('Authorization', 'Bearer tok-1')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ token: 'tok-1', name: 'browser-1' })
    expect(res.headers['set-cookie']).toEqual([expect.stringMatching(/^walnut_signin=tok-1; Path=\/api; HttpOnly; SameSite=Strict; Max-Age=34560000$/)])
  })

  it('the cookie alone counts on a GET', async () => {
    const res = await request(app('browser-1')).get('/api/devices/browser-session').set('Cookie', 'other=1; walnut_signin=tok%2B2')
    expect(res.body).toEqual({ token: 'tok+2', name: 'browser-1' })
    expect(res.headers['set-cookie'][0]).toMatch(/^walnut_signin=tok%2B2;/)
  })

  it('only the page\'s own same-origin call gets it (Sec-Fetch-Site)', async () => {
    const ask = (site: string) => request(app('browser-1')).get('/api/devices/browser-session').set('Cookie', 'walnut_signin=tok-1').set('Sec-Fetch-Site', site)
    expect((await ask('same-origin')).status).toBe(200)
    for (const site of ['cross-site', 'same-site', 'none']) {
      const res = await ask(site)
      expect(res.status, site).toBe(204)
      expect(res.headers['set-cookie']).toBeUndefined()
    }
  })

  it('no device named (an API key, an unknown token, this computer) is 204 with no cookie', async () => {
    for (const named of [undefined, '']) {
      const res = await request(app(named)).get('/api/devices/browser-session').set('Authorization', 'Bearer api-key')
      expect(res.status).toBe(204)
      expect(res.headers['set-cookie']).toBeUndefined()
    }
    const none = await request(app('browser-1')).get('/api/devices/browser-session')
    expect(none.status).toBe(204)
  })

  it('Secure follows the page: ?secure=1, the proxy\'s X-Forwarded-Proto, else none', () => {
    expect(pageIsSecure({ headers: {}, query: { secure: '1' } })).toBe(true)
    expect(pageIsSecure({ headers: { 'x-forwarded-proto': 'https, http' } })).toBe(true)
    expect(pageIsSecure({ headers: { 'x-forwarded-proto': 'http' } })).toBe(false)
    expect(pageIsSecure({ headers: {}, query: {} })).toBe(false)
  })
})

describe('a host replica', () => {
  it('answers it here, the Mac answering or not', () => {
    expect(classify('GET', '/api/devices/browser-session').cls).toBe('local')
  })
})

describe('the plain host server on its alone page', () => {
  let server: http.Server | null = null
  afterEach(() => { server?.close(); server = null })

  async function serve(devices: { held: () => boolean; verify: (t: string) => string | null }) {
    server = http.createServer((req, res) => {
      if (isBrowserSessionRequest(req)) return answerBrowserSession(req, res, devices)
      res.writeHead(404).end()
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  }

  it('a cookie its device copy knows gets the token back and the cookie renewed', async () => {
    const base = await serve({ held: () => true, verify: (t) => (t === 'tok-1' ? 'browser-1' : null) })
    const res = await fetch(`${base}/api/devices/browser-session?secure=1`, { headers: { Cookie: 'walnut_signin=tok-1' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ token: 'tok-1', name: 'browser-1' })
    expect(res.headers.get('set-cookie')).toBe('walnut_signin=tok-1; Path=/api; HttpOnly; SameSite=Strict; Secure; Max-Age=34560000')
    const elsewhere = await fetch(`${base}/api/devices/browser-session`, { headers: { Cookie: 'walnut_signin=tok-1', 'Sec-Fetch-Site': 'cross-site' } })
    expect(elsewhere.status).toBe(204)
  })

  it('an unknown token, no copy yet, or no cookie: 204, nothing set', async () => {
    const known = await serve({ held: () => true, verify: () => null })
    for (const headers of [{ Cookie: 'walnut_signin=nope' }, {}]) {
      const res = await fetch(`${known}/api/devices/browser-session`, { headers })
      expect(res.status).toBe(204)
      expect(res.headers.get('set-cookie')).toBeNull()
    }
    server!.close()
    const empty = await serve({ held: () => false, verify: () => 'browser-1' })
    const res = await fetch(`${empty}/api/devices/browser-session`, { headers: { Cookie: 'walnut_signin=tok-1' } })
    expect(res.status).toBe(204)
  })

  it('only the GET of that path is this answer', () => {
    const req = (method: string, url: string) => ({ method, url }) as http.IncomingMessage
    expect(isBrowserSessionRequest(req('GET', '/api/devices/browser-session?secure=1'))).toBe(true)
    expect(isBrowserSessionRequest(req('POST', '/api/devices/browser-session'))).toBe(false)
    expect(isBrowserSessionRequest(req('GET', '/api/devices/browser-session/x'))).toBe(false)
  })
})

describe('the alone page\'s own script', () => {
  /** Run the page as a browser runs it, with `session` answering the cookie route. */
  async function open(session: { status: number; body?: unknown }) {
    const html = alonePage('marina', 'mac-away', 'n0nce')
    const script = /<script nonce="n0nce">([\s\S]*?)<\/script>/.exec(html)![1]!
    const els = new Map<string, Record<string, unknown>>()
    const el = (id: string) => {
      if (!els.has(id)) els.set(id, { id, hidden: true, textContent: '', value: '', className: '', appendChild: () => {} })
      return els.get(id)!
    }
    const stored = new Map<string, string>()
    const asked: Array<{ url: string; auth: string | null }> = []
    vm.runInNewContext(script, {
      localStorage: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, v) } },
      document: { getElementById: el, createElement: () => el(`n${els.size}`), body: { scrollHeight: 0 } },
      location: { reload: () => {}, hash: '', protocol: 'https:' },
      window: { addEventListener: () => {}, innerHeight: 0, scrollY: 0, scrollTo: () => {} },
      fetch: async (url: string, o: RequestInit = {}) => {
        asked.push({ url, auth: new Headers(o.headers).get('authorization') })
        if (url.startsWith('/api/devices/browser-session')) {
          return new Response(session.body === undefined ? null : JSON.stringify(session.body), { status: session.status })
        }
        return new Response(JSON.stringify({ sessions: [] }), { status: 200 })
      },
      setInterval: () => 0,
    })
    await new Promise((r) => setTimeout(r, 20))
    return { stored, asked, el }
  }

  it('with its storage cleared, it takes the token its cookie holds, keeps it, and lists the sessions with it', async () => {
    const page = await open({ status: 200, body: { token: 'tok-1', name: 'browser-1' } })
    expect(page.asked[0]).toEqual({ url: '/api/devices/browser-session?secure=1', auth: null })
    expect(page.stored.get('walnut.deviceToken')).toBe('tok-1')
    expect(page.asked).toContainEqual({ url: '/_alone/sessions', auth: 'Bearer tok-1' })
    expect(page.el('signed-out').hidden).toBe(true)
  })

  it('with no cookie the server accepts, it says it is signed out and asks nothing more', async () => {
    const page = await open({ status: 204 })
    expect(page.el('signed-out').hidden).toBe(false)
    expect(page.stored.size).toBe(0)
    expect(page.asked.map((a) => a.url)).toEqual(['/api/devices/browser-session?secure=1'])
  })
})
