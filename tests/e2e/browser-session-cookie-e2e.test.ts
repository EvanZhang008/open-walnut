/**
 * GET /api/devices/browser-session on a real primary server (routes/browser-session.ts).
 *
 * 2026-11-04, the user: "if cookie is cleared need another code"; "how long will
 * cookie usually last". Safari removes an unopened site's localStorage after 7
 * days and keeps a script-written cookie 7 days at most, so a phone left alone a
 * week was signed out. The server now keeps the token in its own HttpOnly cookie
 * for 400 days, renewed at every open, and a page with empty storage gets its
 * token back from it. These requests come as a phone through a tunnel does (a
 * proxy header: this server does not trust them).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-browser-session-cookie-e2e'))

import { startServer, stopServer } from '../../src/web/server.js'
import { createDevice, revokeDevice } from '../../src/core/device-auth.js'
import { DEVICE_COOKIE_MAX_AGE_S } from '../../src/web/middleware/device-cookie.js'

const PHONE = { 'X-Forwarded-For': '203.0.113.7' }
let base = ''

beforeAll(async () => {
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await stopServer()
})

function session(headers: Record<string, string>, query = '') {
  return fetch(`${base}/api/devices/browser-session${query}`, { headers })
}

/** Each attribute of the Set-Cookie line, lower-cased names. */
function attrs(line: string | null): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of (line ?? '').split(';').slice(1)) {
    const [k, ...v] = part.trim().split('=')
    out.set(k!.toLowerCase(), v.join('='))
  }
  return out
}

describe('the sign-in cookie a phone keeps', () => {
  it('an open with the token sets it HttpOnly for 400 days on /api, Strict, Secure only for an https page', async () => {
    const { token, name } = await createDevice('browser-c00c1e')
    const res = await session({ ...PHONE, Authorization: `Bearer ${token}` })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ token, name })
    expect(res.headers.get('cache-control')).toBe('no-store')
    const line = res.headers.get('set-cookie')
    // Its own name beside the page's walnut_device: a page cannot write over an HttpOnly cookie.
    expect(line!.startsWith(`walnut_signin=${encodeURIComponent(token)};`)).toBe(true)
    const a = attrs(line)
    expect(a.has('httponly')).toBe(true)
    expect(a.get('samesite')).toBe('Strict')
    expect(a.get('path')).toBe('/api')
    expect(Number(a.get('max-age'))).toBe(DEVICE_COOKIE_MAX_AGE_S)
    expect(DEVICE_COOKIE_MAX_AGE_S).toBe(400 * 86_400)
    expect(a.has('secure')).toBe(false)
    // The page says it is https (a tunnel ends TLS before this server), or the proxy does.
    expect(attrs((await session({ ...PHONE, Authorization: `Bearer ${token}` }, '?secure=1')).headers.get('set-cookie')).has('secure')).toBe(true)
    expect(attrs((await session({ ...PHONE, 'X-Forwarded-Proto': 'https', Authorization: `Bearer ${token}` })).headers.get('set-cookie')).has('secure')).toBe(true)
  })

  it('a page whose storage was cleared gets its token back from the cookie alone, renewed', async () => {
    const { token, name } = await createDevice('browser-c00c1f')
    const res = await session({ ...PHONE, Cookie: `walnut_signin=${encodeURIComponent(token)}` })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ token, name })
    expect(Number(attrs(res.headers.get('set-cookie')).get('max-age'))).toBe(DEVICE_COOKIE_MAX_AGE_S)
    // The restored token then works for writes too, as a header.
    const self = await fetch(`${base}/api/v1/me`, { headers: { ...PHONE, Authorization: `Bearer ${token}` } })
    expect(self.status).toBe(200)
  })

  it('a removed phone is never signed back in by its cookie', async () => {
    const { token } = await createDevice('browser-c00c20')
    expect(await revokeDevice('browser-c00c20')).toBe(true)
    const res = await session({ ...PHONE, Cookie: `walnut_signin=${encodeURIComponent(token)}` })
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('token_refused')
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('no cookie through a tunnel is the usual sign-in refusal; this computer itself gets 204 and no cookie', async () => {
    const phone = await session(PHONE)
    expect(phone.status).toBe(401)
    expect((await phone.json()).code).toBe('not_paired')
    const here = await session({})
    expect(here.status).toBe(204)
    expect(here.headers.get('set-cookie')).toBeNull()
  })

  it('the token that was checked is the one answered: the header over a cookie, the page\'s cookie over the server\'s', async () => {
    const a = await createDevice('browser-c00c21')
    const b = await createDevice('browser-c00c22')
    const viaHeader = await session({ ...PHONE, Authorization: `Bearer ${a.token}`, Cookie: `walnut_signin=${encodeURIComponent(b.token)}` })
    expect(await viaHeader.json()).toEqual({ token: a.token, name: a.name })
    const viaCookies = await session({ ...PHONE, Cookie: `walnut_signin=${encodeURIComponent(b.token)}; walnut_device=${encodeURIComponent(a.token)}` })
    expect(await viaCookies.json()).toEqual({ token: a.token, name: a.name })
    // An image or a download reads the server's cookie when the page's is gone.
    const media = await fetch(`${base}/api/v1/me`, { headers: { ...PHONE, Cookie: `walnut_signin=${encodeURIComponent(b.token)}` } })
    expect(media.status).toBe(200)
  })

  it('a call that is not the page\'s own (another site, an address typed in) gets no token back', async () => {
    const { token } = await createDevice('browser-c00c23')
    for (const site of ['cross-site', 'same-site', 'none']) {
      const res = await session({ ...PHONE, 'Sec-Fetch-Site': site, Cookie: `walnut_signin=${encodeURIComponent(token)}` })
      expect(res.status, site).toBe(204)
      expect(res.headers.get('set-cookie')).toBeNull()
    }
    expect((await session({ ...PHONE, 'Sec-Fetch-Site': 'same-origin', Cookie: `walnut_signin=${encodeURIComponent(token)}` })).status).toBe(200)
  })

  it('a made-up cookie on this computer is not echoed or set', async () => {
    const res = await session({ Cookie: 'walnut_signin=not-a-real-token' })
    expect(res.status).toBe(204)
    expect(res.headers.get('set-cookie')).toBeNull()
  })
})
