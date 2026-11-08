/**
 * Every same-origin /api fetch carries the device token (web/src/api/auth-fetch.ts).
 * 2026-10-13: a signed-in phone got 401 from every loader that calls fetch()
 * directly (notifications, quiet mode, status items), so those parts stayed empty.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { heldOffWhileSignedOut, initWithDeviceToken } from '../../web/src/api/auth-fetch'
import { deviceCookieLine } from '../../web/src/api/device-token'

const PAGE = 'https://walnut.example.test/settings'

function auth(init: RequestInit | null): string | null {
  return init ? new Headers(init.headers).get('Authorization') : null
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('raw fetch reads during navigation', () => {
  async function setup() {
    vi.resetModules()
    const frames: FrameRequestCallback[] = []
    const original = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}'))
    const win = Object.assign(new EventTarget(), {
      location: { href: PAGE }, fetch: original,
      requestAnimationFrame: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length },
    })
    vi.stubGlobal('window', win)
    vi.stubGlobal('localStorage', { getItem: () => null })
    const { installAuthFetch } = await import('../../web/src/api/auth-fetch')
    installAuthFetch()
    return { frames, original, win }
  }

  it('holds relative, absolute, URL, Request and HEAD API reads until a cancelled navigation renders again', async () => {
    const { frames, original, win } = await setup()
    win.dispatchEvent(new Event('beforeunload'))
    const reads = [
      win.fetch('/api/quiet'), win.fetch('https://walnut.example.test/api/notifications'),
      win.fetch(new URL('https://walnut.example.test/api/config')),
      win.fetch(new Request('https://walnut.example.test/api/system/health')),
      win.fetch('/api/metadata', { method: 'HEAD' }),
    ]
    await Promise.resolve()
    expect(original).not.toHaveBeenCalled()
    frames.shift()!(0)
    expect((await Promise.all(reads)).map(response => response.status)).toEqual([200, 200, 200, 200, 200])
    expect(original).toHaveBeenCalledTimes(5)
  })

  it('leaves writes, other origins and assets alone while API reads are held', async () => {
    const { frames, original, win } = await setup()
    win.dispatchEvent(new Event('beforeunload'))
    await Promise.all([
      win.fetch('/api/config', { method: 'PUT', body: '{}' }),
      win.fetch('https://elsewhere.example.test/api/config'), win.fetch('/assets/app.js'),
    ])
    expect(original).toHaveBeenCalledTimes(3)
    expect(original.mock.calls[0][1]).toMatchObject({ method: 'PUT', body: '{}' })
    frames.shift()!(0)
  })

  it('retains the caller signal while suspended and sends nothing after it aborts', async () => {
    const { original, win } = await setup()
    win.dispatchEvent(new Event('beforeunload'))
    const controller = new AbortController()
    const read = win.fetch('/api/config', { signal: controller.signal })
    const rejected = expect(read).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    expect(original).not.toHaveBeenCalled()
  })

  it('honors an explicit null signal instead of inheriting an aborted Request signal', async () => {
    const { frames, original, win } = await setup()
    const controller = new AbortController()
    const request = new Request('https://walnut.example.test/api/config', { signal: controller.signal })
    controller.abort()
    win.dispatchEvent(new Event('beforeunload'))
    const read = win.fetch(request, { signal: null })
    await Promise.resolve()
    expect(original).not.toHaveBeenCalled()
    frames.shift()!(0)
    expect((await read).status).toBe(200)
    expect(original.mock.calls[0][1]).toMatchObject({ signal: null })
  })

  it('expires held raw reads without opening the connection', async () => {
    vi.useFakeTimers()
    const { original, win } = await setup()
    win.dispatchEvent(new Event('beforeunload'))
    const read = win.fetch('/api/config')
    const rejected = expect(read).rejects.toMatchObject({ name: 'TimeoutError' })
    await vi.advanceTimersByTimeAsync(20_000)
    await rejected
    expect(original).not.toHaveBeenCalled()
  })
})

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

// 2026-11-04, a reviewer's log: a signed-out phone kept asking a plugin's summary and the
// renewal route every 15 to 30 s, each answered 401.
describe('heldOffWhileSignedOut', () => {
  it('holds back every same-origin /api call once the page knows why it was signed out', () => {
    expect(heldOffWhileSignedOut('/api/plugins/slack/summary', PAGE, 'removed')).toBe(true)
    expect(heldOffWhileSignedOut(new URL('https://walnut.example.test/api/notifications'), PAGE, 'cookie_gone')).toBe(true)
  })
  it('never signing in again, the check whether it is signed in, another origin, or a page signed in', () => {
    for (const path of ['/api/v1/browser-pair', '/api/auth/browser/refresh?secure=1', '/api/v1/me']) {
      expect(heldOffWhileSignedOut(path, PAGE, 'removed'), path).toBe(false)
    }
    expect(heldOffWhileSignedOut('https://elsewhere.example.test/api/x', PAGE, 'removed')).toBe(false)
    expect(heldOffWhileSignedOut('/assets/app.js', PAGE, 'removed')).toBe(false)
    expect(heldOffWhileSignedOut('/api/notifications', PAGE, null)).toBe(false)
  })
})
