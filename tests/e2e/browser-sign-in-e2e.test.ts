/**
 * A browser's renewing sign-in on a real primary server (core/browser-sign-in.ts,
 * routes/browser-sign-in.ts, routes/browser-pair.ts).
 *
 * 2026-11-04, the user asked for the way a well-known dashboard keeps a phone
 * signed in: a short-lived access token, a refresh token only the renewal path
 * sees, traded once, a replay signing the browser out, one action signing every
 * browser out; kept to a year of idle time, bound to no address, and every phone
 * signed in before it carried over with no new code. Requests come as a phone
 * through a tunnel does (a proxy header: this server does not trust them).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-browser-sign-in-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createDevice, createDeviceAs, listDeviceRecords, verifyDeviceToken } from '../../src/core/device-auth.js'
import { LOCAL_ACTOR } from '../../src/core/device-actor.js'
import { mintBrowserCode } from '../../src/core/browser-pairing.js'
import { REFRESH_COOKIE_MAX_AGE_S, refreshCookieName } from '../../src/web/middleware/device-cookie.js'
import { _resetBrowserSignInForTesting } from '../../src/core/browser-sign-in.js'
import { _resetAuthRateLimitForTesting } from '../../src/web/middleware/auth-rate-limit.js'
import { wsProtocolsFor } from '../../src/lib/ws-bearer-protocol.js'

const PHONE = { 'X-Forwarded-For': '203.0.113.7', 'Sec-Fetch-Site': 'same-origin' }
let base = ''
/** This server's refresh cookie for an http page and an https one (one per origin: device-cookie.ts refreshCookieName). */
let RC = ''
let RCS = ''
/** The mark beside each, which a page with no token reads before it asks the renewal path. */
let MC = ''
let MCS = ''

beforeAll(async () => {
  const server = await startServer({ port: 0, dev: true })
  const port = (server.address() as AddressInfo).port
  base = `http://127.0.0.1:${port}`
  RC = `walnut_refresh_${port}`
  RCS = `walnut_refresh_s_${port}`
  MC = `walnut_renews_${port}`
  MCS = `walnut_renews_s_${port}`
})

afterAll(async () => {
  await stopServer()
})

/** Each Set-Cookie line of an answer, by cookie name, with its attributes (lower-cased names). */
function cookies(res: Response): Map<string, { value: string; attrs: Map<string, string> }> {
  const out = new Map<string, { value: string; attrs: Map<string, string> }>()
  for (const line of res.headers.getSetCookie()) {
    const [first, ...rest] = line.split(';')
    const eq = first!.indexOf('=')
    const attrs = new Map<string, string>()
    for (const part of rest) {
      const [k, ...v] = part.trim().split('=')
      attrs.set(k!.toLowerCase(), v.join('='))
    }
    out.set(first!.slice(0, eq).trim(), { value: decodeURIComponent(first!.slice(eq + 1)), attrs })
  }
  return out
}

async function pair(query = ''): Promise<{ token: string; name: string; accessUntil: number; accessMs: number; refresh: string; res: Response }> {
  _resetAuthRateLimitForTesting()
  const { code } = mintBrowserCode()
  const res = await fetch(`${base}/api/v1/browser-pair${query}`, { method: 'POST', headers: { ...PHONE, 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })
  expect(res.status).toBe(200)
  const body = await res.json() as { token: string; name: string; accessUntil: number; accessMs: number }
  const refresh = cookies(res).get(query.includes('secure=1') ? RCS : RC)!.value
  return { ...body, refresh, res }
}

function renew(headers: Record<string, string> = {}, query = ''): Promise<Response> {
  return fetch(`${base}/api/auth/browser/refresh${query}`, { method: 'POST', headers: { ...PHONE, ...headers } })
}

function me(token: string): Promise<Response> {
  return fetch(`${base}/api/v1/me`, { headers: { ...PHONE, Authorization: `Bearer ${token}` } })
}

async function editRecord(name: string, change: (d: Record<string, unknown>) => void): Promise<void> {
  const file = path.join(WALNUT_HOME, 'auth.json')
  const raw = JSON.parse(await fs.readFile(file, 'utf-8')) as { devices: Array<Record<string, unknown>> }
  change(raw.devices.find((d) => d.name === name)!)
  await fs.writeFile(file, JSON.stringify(raw))
}

describe('the refresh cookie name', () => {
  it('is one per origin: scheme and port, as the token in localStorage is', () => {
    const name = (host: string, secure: boolean) => refreshCookieName({ headers: { host } }, secure)
    expect(name('walnut.example', false)).toBe('walnut_refresh')
    expect(name('walnut.example', true)).toBe('walnut_refresh_s')
    expect(name('192.168.1.5:3456', false)).toBe('walnut_refresh_3456')
    expect(name('walnut.example:8443', true)).toBe('walnut_refresh_s_8443')
    expect(name('[::1]:3457', false)).toBe('walnut_refresh_3457')
    expect(name('[::1]', false)).toBe('walnut_refresh')
  })
})

describe('signing a browser in', () => {
  it('a code gives an access token that lasts 20 hours and an HttpOnly refresh cookie only the renewal path gets', async () => {
    const t0 = Date.now()
    const { token, name, accessUntil, accessMs, res } = await pair()
    expect(name).toMatch(/^browser-[0-9a-f]{6}$/)
    expect(accessMs).toBe(20 * 3_600_000)
    expect(accessUntil).toBeGreaterThanOrEqual(t0 + accessMs)
    const c = cookies(res).get(RC)!
    expect(c.attrs.get('path')).toBe('/api/auth/browser')
    expect(c.attrs.has('httponly')).toBe(true)
    expect(c.attrs.get('samesite')).toBe('Strict')
    expect(Number(c.attrs.get('max-age'))).toBe(REFRESH_COOKIE_MAX_AGE_S)
    expect(REFRESH_COOKIE_MAX_AGE_S).toBe(365 * 86_400)
    expect(c.attrs.has('secure')).toBe(false)
    // Its mark: readable by the page (no HttpOnly), on every path, no secret in it, as long-lived.
    const m = cookies(res).get(MC)!
    expect(m.value).toBe('1')
    expect(m.attrs.get('path')).toBe('/')
    expect(m.attrs.has('httponly')).toBe(false)
    expect(m.attrs.get('samesite')).toBe('Strict')
    expect(Number(m.attrs.get('max-age'))).toBe(REFRESH_COOKIE_MAX_AGE_S)
    expect((await me(token)).status).toBe(200)
    // An https page (a tunnel ends TLS first) says so, and its cookie is Secure.
    expect(cookies((await pair('?secure=1')).res).get(RCS)!.attrs.has('secure')).toBe(true)
    expect(cookies((await pair('?secure=1')).res).get(MCS)!.attrs.has('secure')).toBe(true)
  })

  it('each browser of one kind is numbered when it signs in, and keeps its number when another is removed', async () => {
    const ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'
    const named = async () => {
      _resetAuthRateLimitForTesting()
      const { code } = mintBrowserCode()
      const res = await fetch(`${base}/api/v1/browser-pair`, { method: 'POST', headers: { ...PHONE, 'User-Agent': ua, 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })
      return await res.json() as { name: string; deviceName: string }
    }
    const a = await named()
    const b = await named()
    const kind = a.deviceName
    expect(b.deviceName).toBe(`${kind} 2`)
    await fetch(`${base}/api/devices/${a.name}`, { method: 'DELETE' })
    const c = await named()
    expect(c.deviceName).toBe(`${kind} 3`)
    const info = new Map((await listDeviceRecords()).map((d) => [d.name, d.info?.deviceName]))
    expect(info.get(b.name)).toBe(`${kind} 2`)
  })

  it('the Walnut extension keeps a token that never expires, and no refresh cookie', async () => {
    _resetAuthRateLimitForTesting()
    const { code } = mintBrowserCode()
    const res = await fetch(`${base}/api/v1/browser-pair`, { method: 'POST', headers: { ...PHONE, 'Content-Type': 'application/json' }, body: JSON.stringify({ code, client: 'extension' }) })
    const body = await res.json() as { token: string; name: string; accessUntil?: number }
    expect(body.name).toMatch(/^extension-/)
    expect(body.accessUntil).toBeUndefined()
    expect([...cookies(res).keys()].some((k) => k.startsWith('walnut_refresh') || k.startsWith('walnut_renews'))).toBe(false)
  })
})

describe('renewing', () => {
  it('the refresh cookie alone renews: a new pair, the old access token stops, the cookie set again', async () => {
    const s = await pair('?secure=1')
    const res = await renew({ Cookie: `${RCS}=${encodeURIComponent(s.refresh)}` }, '?secure=1')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json() as { token: string; name: string; accessUntil: number }
    expect(body.name).toBe(s.name)
    expect(body.token).not.toBe(s.token)
    const next = cookies(res).get(RCS)!
    expect(next.value).not.toBe(s.refresh)
    expect(next.attrs.has('secure')).toBe(true)
    expect(cookies(res).get(MCS)!.value).toBe('1')
    expect((await me(body.token)).status).toBe(200)
    // The token it replaced reads as one that ran out (a request the page sent before it stored the
    // new one renews and goes again), never as signed out.
    const old = await me(s.token)
    expect(old.status).toBe(401)
    expect((await old.json()).code).toBe('token_expired')
    // One renewal later it is nothing this server knows.
    const later = await renew({ Cookie: `${RCS}=${encodeURIComponent(next.value)}` }, '?secure=1')
    expect(later.status).toBe(200)
    expect((await (await me(s.token)).json()).code).toBe('token_refused')
  })

  it('an access token past its time is refused as token_expired (the page renews), and renewing brings it back', async () => {
    const s = await pair()
    await editRecord(s.name, (d) => { (d.browserSignIn as { accessUntil: string }).accessUntil = new Date(Date.now() - 1_000).toISOString() })
    const res = await me(s.token)
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('token_expired')
    // The renewal is public: an expired access token beside it does not stop it.
    const r = await renew({ Cookie: `${RC}=${encodeURIComponent(s.refresh)}`, Authorization: `Bearer ${s.token}` })
    expect(r.status).toBe(200)
    expect((await me((await r.json() as { token: string }).token)).status).toBe(200)
  })

  it('a spent refresh token presented again after its first minute signs the browser out, and clears the cookie', async () => {
    const s = await pair()
    const first = await renew({ Cookie: `${RC}=${encodeURIComponent(s.refresh)}` })
    const { token } = await first.json() as { token: string }
    expect((await me(token)).status).toBe(200)
    _resetBrowserSignInForTesting()
    await editRecord(s.name, (d) => {
      for (const e of (d.browserSignIn as { spent: Array<{ at: string }> }).spent) e.at = new Date(Date.now() - 120_000).toISOString()
    })
    const replay = await renew({ Cookie: `${RC}=${encodeURIComponent(s.refresh)}` })
    expect(replay.status).toBe(401)
    expect((await replay.json()).code).toBe('refresh_reused')
    expect(Number(cookies(replay).get(RC)!.attrs.get('max-age'))).toBe(0)
    expect(Number(cookies(replay).get(MC)!.attrs.get('max-age'))).toBe(0)
    expect((await listDeviceRecords()).some((d) => d.name === s.name)).toBe(false)
    expect((await me(token)).status).toBe(401)
  })

  it('a page that kept its access token but lost its refresh cookie is told it was signed out (never 204, which means "nothing renews here")', async () => {
    const s = await pair()
    const res = await renew({ Authorization: `Bearer ${s.token}` })
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('refresh_missing')
    expect(Number(cookies(res).get(RC)!.attrs.get('max-age'))).toBe(0)
    expect(Number(cookies(res).get(MC)!.attrs.get('max-age'))).toBe(0)
    expect((await me(s.token)).status).toBe(401)
    expect((await listDeviceRecords()).some((d) => d.name === s.name)).toBe(false)
  })

  it('another Walnut on the same host name (another port) keeps its own cookie: neither reads nor clears the other\'s', async () => {
    const s = await pair()
    // A cookie ignores the port: the browser sends both servers' cookies to each.
    const res = await renew({ Cookie: `walnut_refresh_1=from-another-walnut; walnut_renews_1=1; ${RC}=${encodeURIComponent(s.refresh)}` })
    expect(res.status).toBe(200)
    expect([...cookies(res).keys()]).toEqual([RC, MC])
    // Only the other one's: this page's own cookie is gone, so it can never renew.
    const t = await pair()
    const lost = await renew({ Cookie: 'walnut_refresh_1=from-another-walnut; walnut_renews_1=1', Authorization: `Bearer ${t.token}` })
    expect((await lost.json()).code).toBe('refresh_missing')
    expect([...cookies(lost).keys()]).toEqual([RC, MC])
    // With nothing of its own, the other's mark is not cleared either.
    expect((await renew({ Cookie: 'walnut_refresh_1=from-another-walnut; walnut_renews_1=1' })).headers.getSetCookie()).toEqual([])
  })

  // The review of 2026-11-05: a reverse proxy may pass Host on as its upstream (127.0.0.1:3456)
  // while the page is https on the default port; the page names its mark from its own location.
  it('the mark is named from the page\'s Origin, which a proxy leaves as the browser sent it', async () => {
    _resetAuthRateLimitForTesting()
    const res = await renew({ Cookie: `${RCS}=made-up`, Origin: 'https://walnut.example' }, '?secure=1')
    expect(res.status).toBe(401)
    // The page's mark (https, no port) is the one cleared, beside this server's refresh cookie.
    expect([...cookies(res).keys()]).toEqual([RCS, 'walnut_renews_s'])
    const ok = await pair('?secure=1')
    const again = await renew({ Cookie: `${RCS}=${encodeURIComponent(ok.refresh)}`, Origin: 'https://walnut.example' }, '?secure=1')
    expect(again.status).toBe(200)
    expect(cookies(again).get('walnut_renews_s')!.value).toBe('1')
  })

  // A second tab within the first minute getting the same pair: tests/core/browser-sign-in.test.ts.

  it('a refresh token nothing here knows is refused and its cookie cleared; nothing at all is 204', async () => {
    const bad = await renew({ Cookie: `${RC}=made-up` })
    expect(bad.status).toBe(401)
    expect((await bad.json()).code).toBe('refresh_refused')
    expect(Number(cookies(bad).get(RC)!.attrs.get('max-age'))).toBe(0)
    expect(Number(cookies(bad).get(MC)!.attrs.get('max-age'))).toBe(0)
    _resetAuthRateLimitForTesting()
    const none = await renew()
    expect(none.status).toBe(204)
    expect(none.headers.getSetCookie()).toEqual([])
    // A mark with no refresh cookie beside it (one cleared alone) is cleared, so the page stops asking.
    const markOnly = await renew({ Cookie: `${MC}=1` })
    expect(markOnly.status).toBe(204)
    expect(Number(cookies(markOnly).get(MC)!.attrs.get('max-age'))).toBe(0)
    // This computer, with no cookie: nothing to renew, no sign-in screen.
    expect((await fetch(`${base}/api/auth/browser/refresh`, { method: 'POST' })).status).toBe(204)
  })

  it('only the page itself renews (Sec-Fetch-Site)', async () => {
    const s = await pair()
    for (const site of ['cross-site', 'same-site', 'none']) {
      const res = await renew({ 'Sec-Fetch-Site': site, Cookie: `${RC}=${encodeURIComponent(s.refresh)}` })
      expect(res.status, site).toBe(403)
      expect(cookies(res).size).toBe(0)
    }
    // Nothing was spent: the page's own renewal still works.
    expect((await renew({ Cookie: `${RC}=${encodeURIComponent(s.refresh)}` })).status).toBe(200)
  })

  it('wrong refresh tokens count toward the address limit like wrong tokens (429), a right one is never held back', async () => {
    _resetAuthRateLimitForTesting()
    for (let i = 0; i < 10; i++) await renew({ Cookie: `${RC}=guess-${i}` })
    const limited = await renew({ Cookie: `${RC}=guess-x` })
    expect(limited.status).toBe(429)
    _resetAuthRateLimitForTesting()
  })
})

describe('a phone signed in before renewing existed', () => {
  it('its page sends its token once and gets a pair: no new code, the old token stops', async () => {
    const { token } = await createDevice('browser-01d0aa')
    const res = await renew({ Authorization: `Bearer ${token}` })
    expect(res.status).toBe(200)
    const body = await res.json() as { token: string; name: string; accessUntil: number }
    expect(body.name).toBe('browser-01d0aa')
    expect(cookies(res).has(RC)).toBe(true)
    expect((await me(body.token)).status).toBe(200)
    expect((await me(token)).status).toBe(401)
    // Refused here for good (a copy the companion took before renewing existed is removed too).
    const raw = JSON.parse(await fs.readFile(path.join(WALNUT_HOME, 'auth.json'), 'utf-8')) as { revokedHashes?: string[] }
    expect(raw.revokedHashes).toContain(crypto.createHash('sha256').update(token).digest('hex'))
  })

  it('one whose storage Safari cleared starts it from the walnut_signin cookie of the build before, which goes', async () => {
    const { token } = await createDevice('browser-01d0ab')
    const res = await renew({ Cookie: `walnut_signin=${encodeURIComponent(token)}` })
    expect(res.status).toBe(200)
    const c = cookies(res)
    expect(c.has(RC)).toBe(true)
    expect(c.get('walnut_signin')!.attrs.get('path')).toBe('/api')
    expect(Number(c.get('walnut_signin')!.attrs.get('max-age'))).toBe(0)
  })

  it('a page of an older build asking the old cookie route for a renewing sign-in gets 204 and the old cookie cleared', async () => {
    const s = await pair()
    const res = await fetch(`${base}/api/devices/browser-session`, { headers: { ...PHONE, Authorization: `Bearer ${s.token}` } })
    expect(res.status).toBe(204)
    expect(Number(cookies(res).get('walnut_signin')!.attrs.get('max-age'))).toBe(0)
    // One from before renewing still gets its cookie there.
    const { token } = await createDevice('browser-01d0ac')
    const legacy = await fetch(`${base}/api/devices/browser-session`, { headers: { ...PHONE, Authorization: `Bearer ${token}` } })
    expect(legacy.status).toBe(200)
  })

  it('a phone app token renews nothing and keeps working', async () => {
    const { token } = await createDevice('evans-phone-e2e')
    expect((await renew({ Authorization: `Bearer ${token}` })).status).toBe(204)
    expect(await verifyDeviceToken(token)).toEqual({ name: 'evans-phone-e2e' })
  })
})

describe('what a browser sign-in may not do', () => {
  it('pair another device (its token would never expire): 403 browser_cannot_pair, nothing made', async () => {
    const s = await pair()
    const res = await fetch(`${base}/api/devices`, { method: 'POST', headers: { ...PHONE, Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'made-by-a-browser' }) })
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('browser_cannot_pair')
    expect((await listDeviceRecords()).some((d) => d.name === 'made-by-a-browser')).toBe(false)
  })

  it('keep a WebSocket open past its access token: closed with 4419 when it runs out', async () => {
    const s = await pair()
    await editRecord(s.name, (d) => { (d.browserSignIn as { accessUntil: string }).accessUntil = new Date(Date.now() + 1_500).toISOString() })
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, wsProtocolsFor(s.token), { headers: { 'X-Forwarded-For': '203.0.113.7' } })
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
    expect(await closed).toBe(4419)
    // Its token ran out: the upgrade is refused until the page renews.
    const again = new WebSocket(`${base.replace('http', 'ws')}/ws`, wsProtocolsFor(s.token), { headers: { 'X-Forwarded-For': '203.0.113.7' } })
    const status = await new Promise<number>((resolve) => { again.once('unexpected-response', (_req, r) => resolve(r.statusCode ?? 0)); again.once('open', () => resolve(101)) })
    expect(status).toBe(401)
  })
})

describe('signing out', () => {
  it('Sign out all browsers ends every browser signed in with a code, never the extension or a phone app', async () => {
    const a = await pair()
    const b = await pair()
    const { token: legacy } = await createDevice('browser-01d0ad')
    await createDeviceAs('extension-0e0e0e', { by: LOCAL_ACTOR, extension: true })
    const { token: phone } = await createDevice('evans-phone-keep')
    // This computer (no proxy header) may.
    const res = await fetch(`${base}/api/devices/browser-sign-ins/revoke`, { method: 'POST' })
    expect(res.status).toBe(200)
    const out = await res.json() as { revoked: string[]; refused: string[] }
    expect(out.revoked).toEqual(expect.arrayContaining([a.name, b.name, 'browser-01d0ad']))
    expect(out.refused).toEqual([])
    const left = (await listDeviceRecords()).map((d) => d.name)
    expect(left.some((n) => /^browser-/.test(n))).toBe(false)
    expect(left).toEqual(expect.arrayContaining(['extension-0e0e0e', 'evans-phone-keep']))
    for (const t of [a.token, b.token, legacy]) expect((await me(t)).status).toBe(401)
    expect((await renew({ Cookie: `${RC}=${encodeURIComponent(a.refresh)}` })).status).toBe(401)
    expect((await me(phone)).status).toBe(200)
  })

  it('a signed-in browser asking it signs out only itself', async () => {
    const mine = await pair()
    const other = await pair()
    const res = await fetch(`${base}/api/devices/browser-sign-ins/revoke`, { method: 'POST', headers: { ...PHONE, Authorization: `Bearer ${mine.token}` } })
    const out = await res.json() as { revoked: string[]; refused: string[] }
    expect(out.revoked).toEqual([mine.name])
    expect(out.refused).toContain(other.name)
    expect((await me(other.token)).status).toBe(200)
  })

  it('with names (the ones Settings listed), only those are signed out: one signed in after the list stays', async () => {
    const listed = await pair()
    const later = await pair()
    const res = await fetch(`${base}/api/devices/browser-sign-ins/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names: [listed.name, 'evans-phone-keep'] }) })
    const out = await res.json() as { revoked: string[]; refused: string[] }
    // Never a name that is not a browser signed in with a code, whatever the body says.
    expect(out.revoked).toEqual([listed.name])
    expect((await me(listed.token)).status).toBe(401)
    expect((await me(later.token)).status).toBe(200)
  })

  it('a list of names that is not one is refused (never every browser by mistake)', async () => {
    const s = await pair()
    for (const names of [null, 'browser-000000', [1]]) {
      const res = await fetch(`${base}/api/devices/browser-sign-ins/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names }) })
      expect(res.status, JSON.stringify(names)).toBe(400)
    }
    expect((await me(s.token)).status).toBe(200)
  })

  it('a browser that signs itself out keeps no refresh cookie', async () => {
    const s = await pair()
    const res = await fetch(`${base}/api/devices/${s.name}`, { method: 'DELETE', headers: { ...PHONE, Authorization: `Bearer ${s.token}` } })
    expect(res.status).toBe(200)
    expect(Number(cookies(res).get(RC)!.attrs.get('max-age'))).toBe(0)
    expect(Number(cookies(res).get(MC)!.attrs.get('max-age'))).toBe(0)
    // Removing another device from this computer sets no cookie of its own.
    const t = await pair()
    expect(cookies(await fetch(`${base}/api/devices/${t.name}`, { method: 'DELETE' })).size).toBe(0)
  })

  it('a page that comes back after its browser was removed on the computer is told so (device_removed), with no count toward the address limit', async () => {
    const removed: Array<{ token: string; refresh: string }> = []
    for (let i = 0; i < 12; i++) {
      const s = await pair()
      expect((await fetch(`${base}/api/devices/${s.name}`, { method: 'DELETE' })).status).toBe(200)
      removed.push(s)
    }
    _resetAuthRateLimitForTesting()
    // More than the address limit allows of wrong tokens (10 a minute): none is held back.
    for (const s of removed) {
      const res = await renew({ Cookie: `${RC}=${encodeURIComponent(s.refresh)}`, Authorization: `Bearer ${s.token}` })
      expect(res.status).toBe(401)
      expect((await res.json()).code).toBe('device_removed')
      expect(Number(cookies(res).get(RC)!.attrs.get('max-age'))).toBe(0)
      expect(Number(cookies(res).get(MC)!.attrs.get('max-age'))).toBe(0)
    }
    // A sign-in that ended for its own reason (here, its cookie gone) is not "removed on the computer".
    const t = await pair()
    expect((await (await renew({ Authorization: `Bearer ${t.token}` })).json()).code).toBe('refresh_missing')
    expect((await (await renew({ Cookie: `${RC}=${encodeURIComponent(t.refresh)}` })).json()).code).toBe('refresh_refused')
  })

  it('removing a browser closes its open WebSocket at once (4401)', async () => {
    const s = await pair()
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, wsProtocolsFor(s.token), { headers: { 'X-Forwarded-For': '203.0.113.7' } })
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
    const del = await fetch(`${base}/api/devices/${s.name}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(await closed).toBe(4401)
  })
})
