/**
 * The sign-in gate decides, before the console boots, whether this browser gets
 * the console or the sign-in screen (web/src/api/sign-in-gate.ts). 2026-10-13: an
 * unsigned phone mounted the whole console and fired over a hundred refused
 * requests; a scanned code was traded while the console was already asking.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let store: Map<string, string>
let fetchMock: ReturnType<typeof vi.fn<Fetch>>
let reload: ReturnType<typeof vi.fn>

function page(hash: string) {
  store = new Map()
  reload = vi.fn()
  fetchMock = vi.fn<Fetch>()
  vi.stubGlobal('window', { location: { hash, pathname: '/', search: '', protocol: 'https:', reload } })
  vi.stubGlobal('history', { state: null, replaceState: (_s: unknown, _t: string, url: string) => { (window.location as { hash: string }).hash = url.includes('#') ? url.slice(url.indexOf('#')) : '' } })
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })
  vi.stubGlobal('document', { cookie: '' })
  vi.stubGlobal('fetch', fetchMock)
}

/** Answer each URL the gate asks with its own reply; any other URL fails the test. */
function answer(routes: Record<string, () => Response>) {
  fetchMock.mockImplementation(async (url: string) => {
    const reply = routes[url]
    if (!reply) throw new Error(`unexpected fetch ${url}`)
    return reply()
  })
}

async function gate() {
  const { resolveSignInGate } = await import('../../web/src/api/sign-in-gate')
  const { getUnpairedState } = await import('../../web/src/api/unpaired')
  return { resolveSignInGate, getUnpairedState }
}

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('resolveSignInGate', () => {
  it('a browser holding a token boots at once, with no request', async () => {
    page('')
    store.set('walnut.deviceToken', 'tok')
    const { resolveSignInGate } = await gate()
    expect(await resolveSignInGate()).toBe('app')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a browser the server answers without a token (this computer) boots', async () => {
    page('')
    answer({ '/api/devices/browser-session?secure=1': () => new Response(null, { status: 204 }), '/api/v1/me': () => json(200, { kind: 'human' }) })
    const { resolveSignInGate } = await gate()
    expect(await resolveSignInGate()).toBe('app')
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/devices/browser-session?secure=1', '/api/v1/me'])
  })

  // 2026-11-04, the user: "if cookie is cleared need another code". Safari removes an
  // unopened site's localStorage after 7 days; the server's HttpOnly cookie stays.
  it('a page Safari cleared signs back in from the server cookie: stored again, then a reload', async () => {
    page('')
    answer({ '/api/devices/browser-session?secure=1': () => json(200, { token: 'kept-token', name: 'browser-1' }) })
    const { resolveSignInGate } = await gate()
    const result = Promise.race([resolveSignInGate(), new Promise((r) => setTimeout(() => r('pending'), 50))])
    expect(await result).toBe('pending')
    expect(store.get('walnut.deviceToken')).toBe('kept-token')
    expect(reload).toHaveBeenCalledTimes(1)
    expect(window.location.hash).toBe('#signed-in-again')
    // The cookie rides by itself: the call names no token, and nothing else is asked.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).has('authorization')).toBe(false)
  })

  it('storage that refuses the token: this page holds it and boots without a reload loop', async () => {
    page('')
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError') }, removeItem: () => {} })
    answer({ '/api/devices/browser-session?secure=1': () => json(200, { token: 'kept-token', name: 'browser-1' }) })
    const { resolveSignInGate } = await gate()
    expect(await resolveSignInGate()).toBe('app')
    expect(reload).not.toHaveBeenCalled()
    const { getDeviceToken } = await import('../../web/src/api/device-token')
    expect(getDeviceToken()).toBe('kept-token')
  })

  it('a removed phone whose cookie is refused reads This phone was signed out, with no second probe', async () => {
    page('')
    answer({ '/api/devices/browser-session?secure=1': () => json(401, { error: 'Invalid or revoked token', code: 'token_refused' }) })
    const { resolveSignInGate, getUnpairedState } = await gate()
    expect(await resolveSignInGate()).toBe('sign-in')
    expect(getUnpairedState()).toBe('revoked')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(store.has('walnut.deviceToken')).toBe(false)
  })

  it('a restore right after a restore reload boots instead of reloading again (storage that does not outlive a reload)', async () => {
    page('#signed-in-again')
    answer({ '/api/devices/browser-session?secure=1': () => json(200, { token: 'kept-token', name: 'browser-1' }) })
    const { resolveSignInGate } = await gate()
    expect(await resolveSignInGate()).toBe('app')
    expect(reload).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('')
  })

  it('a rate limit or a server error at the restore is a failed probe, never a console without the token', async () => {
    for (const status of [429, 503]) {
      vi.resetModules()
      page('')
      answer({ '/api/devices/browser-session?secure=1': () => json(status, { error: 'busy' }) })
      expect(await (await gate()).resolveSignInGate(), String(status)).toBe('probe-failed')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  })

  it('an older server without the route falls back to the probe', async () => {
    page('')
    answer({ '/api/devices/browser-session?secure=1': () => json(404, { error: 'not found' }), '/api/v1/me': () => json(401, { code: 'not_paired' }) })
    const { resolveSignInGate, getUnpairedState } = await gate()
    expect(await resolveSignInGate()).toBe('sign-in')
    expect(getUnpairedState()).toBe('unpaired')
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/devices/browser-session?secure=1', '/api/v1/me'])
  })

  it('a refusal with the primary code gets the sign-in screen alone', async () => {
    page('')
    fetchMock.mockResolvedValue(json(401, { code: 'not_paired' }))
    const { resolveSignInGate, getUnpairedState } = await gate()
    expect(await resolveSignInGate()).toBe('sign-in')
    expect(getUnpairedState()).toBe('unpaired')
  })

  it('a 401 without the code (another server sign-in) boots; an unreachable server is a failed probe (D5)', async () => {
    page('')
    fetchMock.mockResolvedValue(json(401, { error: 'Authentication required' }))
    expect(await (await gate()).resolveSignInGate()).toBe('app')
    vi.resetModules()
    page('')
    fetchMock.mockRejectedValue(new TypeError('Load failed'))
    expect(await (await gate()).resolveSignInGate()).toBe('probe-failed')
  })

  it('a stored token never probes, so a failed network cannot hold a signed-in browser back (D5)', async () => {
    page('')
    store.set('walnut.deviceToken', 'tok')
    fetchMock.mockRejectedValue(new TypeError('Load failed'))
    expect(await (await gate()).resolveSignInGate()).toBe('app')
  })

  it('a #pair code is traded first, stored with its cookie, and the page reloads', async () => {
    page('#pair=ABCD-EFGH')
    fetchMock.mockResolvedValue(json(200, { token: 'fresh-token', name: 'browser-1' }))
    const { resolveSignInGate } = await gate()
    const result = Promise.race([resolveSignInGate(), new Promise((r) => setTimeout(() => r('pending'), 50))])
    expect(await result).toBe('pending')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/v1/browser-pair')
    expect(store.get('walnut.deviceToken')).toBe('fresh-token')
    expect(document.cookie).toContain('walnut_device=fresh-token')
    expect(reload).toHaveBeenCalledTimes(1)
    expect(window.location.hash).toBe('')
  })

  it('a code that fails shows the sign-in screen, unless an older sign-in still stands', async () => {
    page('#pair=ABCD-EFGH')
    fetchMock.mockResolvedValue(json(400, { error: { message: 'That code is wrong or has expired.' } }))
    const { resolveSignInGate, getUnpairedState } = await gate()
    expect(await resolveSignInGate()).toBe('sign-in')
    expect(getUnpairedState()).toBe('unpaired')
    expect(reload).not.toHaveBeenCalled()

    vi.resetModules()
    page('#pair=ABCD-EFGH')
    store.set('walnut.deviceToken', 'older')
    fetchMock.mockResolvedValue(json(400, { error: { message: 'That code is wrong or has expired.' } }))
    expect(await (await gate()).resolveSignInGate()).toBe('app')
  })
})
