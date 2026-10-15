/**
 * Every same-origin /api fetch carries the device token (web/src/api/auth-fetch.ts).
 * 2026-10-13: a signed-in phone got 401 from every loader that calls fetch()
 * directly (notifications, quiet mode, status items), so those parts stayed empty.
 */
import { describe, it, expect } from 'vitest'
import { initWithDeviceToken } from '../../web/src/api/auth-fetch'
import { deviceCookieLine } from '../../web/src/api/device-token'

const PAGE = 'https://walnut.example.test/settings'

function auth(init: RequestInit | null): string | null {
  return init ? new Headers(init.headers).get('Authorization') : null
}

describe('initWithDeviceToken', () => {
  it('adds the token to a relative and an absolute same-origin /api call', () => {
    expect(auth(initWithDeviceToken('/api/quiet', undefined, PAGE, 'tok'))).toBe('Bearer tok')
    expect(auth(initWithDeviceToken(new URL('https://walnut.example.test/api/plugin-status-items'), undefined, PAGE, 'tok'))).toBe('Bearer tok')
    expect(auth(initWithDeviceToken(new Request('https://walnut.example.test/api/files/list?path=%2F'), undefined, PAGE, 'tok'))).toBe('Bearer tok')
  })

  it('keeps the caller init: method, body, other headers', () => {
    const next = initWithDeviceToken('/api/x', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }, PAGE, 'tok')
    expect(next).toMatchObject({ method: 'POST', body: '{}' })
    expect(new Headers(next!.headers).get('Content-Type')).toBe('application/json')
    expect(auth(next)).toBe('Bearer tok')
  })

  it('keeps a Request object headers when no init is given', () => {
    const req = new Request('https://walnut.example.test/api/x', { headers: { 'X-Trace': '1' } })
    const next = initWithDeviceToken(req, undefined, PAGE, 'tok')
    expect(new Headers(next!.headers).get('X-Trace')).toBe('1')
  })

  it('leaves the call alone without a token, off /api, on another origin, or with its own Authorization', () => {
    expect(initWithDeviceToken('/api/quiet', undefined, PAGE, null)).toBeNull()
    expect(initWithDeviceToken('/assets/index.js', undefined, PAGE, 'tok')).toBeNull()
    expect(initWithDeviceToken('/apiary', undefined, PAGE, 'tok')).toBeNull()
    expect(initWithDeviceToken('https://other.example.test/api/quiet', undefined, PAGE, 'tok')).toBeNull()
    expect(initWithDeviceToken('/api/x', { headers: { Authorization: 'Bearer mine' } }, PAGE, 'tok')).toBeNull()
  })

  it('never sends a token to the sign-in exchange', () => {
    expect(initWithDeviceToken('/api/v1/browser-pair', { method: 'POST' }, PAGE, 'stale')).toBeNull()
  })
})

describe('deviceCookieLine', () => {
  it('scopes the cookie to /api, SameSite=Strict, Secure on https, and encodes the token', () => {
    const line = deviceCookieLine('a b;c', true)
    expect(line.startsWith('walnut_device=a%20b%3Bc; ')).toBe(true)
    expect(line).toContain('Path=/api')
    expect(line).toContain('SameSite=Strict')
    expect(line).toContain('Secure')
    expect(deviceCookieLine('t', false)).not.toContain('Secure')
  })

  it('expires it on sign-out', () => {
    expect(deviceCookieLine(null, true)).toMatch(/^walnut_device=; .*Max-Age=0$/)
  })
})
