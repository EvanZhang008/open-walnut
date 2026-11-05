/**
 * The sign-in gate decides, before the console boots, whether this browser gets
 * the console or the sign-in screen (web/src/api/sign-in-gate.ts). 2026-10-13: an
 * unsigned phone mounted the whole console and fired over a hundred refused
 * requests; a scanned code was traded while the console was already asking.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

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
  // `cookie` reads the last line written, as the tests before read it; `cookieWrites` keeps each.
  cookieWrites = []
  vi.stubGlobal('document', { get cookie() { return cookieRead ?? cookieWrites[cookieWrites.length - 1] ?? '' }, set cookie(v: string) { cookieRead = undefined; cookieWrites.push(v) } })
  cookieRead = undefined
  vi.stubGlobal('fetch', fetchMock)
}

let cookieWrites: string[] = []
/** What the page's cookies read as, set by a test (the browser's jar, not the last write). */
let cookieRead: string | undefined

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

// A test that faked the clock never leaves it faked for the next one.
afterEach(() => { vi.useRealTimers() })

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
    answer({ '/api/auth/browser/refresh?secure=1': () => new Response(null, { status: 204 }), '/api/v1/me': () => json(200, { kind: 'human' }) })
    const { resolveSignInGate } = await gate()
    expect(await resolveSignInGate()).toBe('app')
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/auth/browser/refresh?secure=1', '/api/v1/me'])
    // A POST, with no token to send.
    expect(fetchMock.mock.calls[0]![1]?.method).toBe('POST')
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).has('authorization')).toBe(false)
  })

  // 2026-11-04, the user: "if cookie is cleared need another code". Safari removes an
  // unopened site's localStorage after 7 days; the refresh cookie the server set stays.
  it('a page Safari cleared renews from its refresh cookie: the new token stored with its time, then a reload', async () => {
    page('')
    answer({ '/api/auth/browser/refresh?secure=1': () => json(200, { token: 'new-token', name: 'browser-1', accessUntil: 1_900_000_000_000, accessMs: 72_000_000 }) })
    const { resolveSignInGate } = await gate()
    const result = Promise.race([resolveSignInGate(), new Promise((r) => setTimeout(() => r('pending'), 50))])
    expect(await result).toBe('pending')
    expect(store.get('walnut.deviceToken')).toBe('new-token')
    expect(store.get('walnut.deviceTokenUntil')).toBe('1900000000000')
    expect(store.get('walnut.deviceTokenLifetime')).toBe('72000000')
    expect(reload).toHaveBeenCalledTimes(1)
    // The mark is a short cookie, never the address (nothing flashes in the address bar).
    expect(window.location.hash).toBe('')
    expect(cookieWrites).toContain('walnut_restored=1; Max-Age=60; Path=/; SameSite=Strict; Secure')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('storage that refuses the token: this page holds it and boots without a reload loop', async () => {
    page('')
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError') }, removeItem: () => {} })
    answer({ '/api/auth/browser/refresh?secure=1': () => json(200, { token: 'new-token', name: 'browser-1', accessUntil: 1_900_000_000_000, accessMs: 72_000_000 }) })
    const { resolveSignInGate } = await gate()
    expect(await resolveSignInGate()).toBe('app')
    expect(reload).not.toHaveBeenCalled()
    const { getDeviceToken, getDeviceTokenUntil } = await import('../../web/src/api/device-token')
    expect(getDeviceToken()).toBe('new-token')
    expect(getDeviceTokenUntil()).toBe(1_900_000_000_000)
  })

  it('a browser whose renewal is refused (removed, replayed, a year unused) reads This browser was signed out', async () => {
    for (const code of ['refresh_refused', 'refresh_reused', 'refresh_expired']) {
      vi.resetModules()
      page('')
      answer({ '/api/auth/browser/refresh?secure=1': () => json(401, { code }) })
      const { resolveSignInGate, getUnpairedState } = await gate()
      expect(await resolveSignInGate(), code).toBe('sign-in')
      expect(getUnpairedState()).toBe('revoked')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  })

  it('a renewal right after a renewal reload boots instead of reloading again (storage that does not outlive a reload)', async () => {
    page('')
    cookieRead = 'other=1; walnut_restored=1'
    answer({ '/api/auth/browser/refresh?secure=1': () => json(200, { token: 'new-token', name: 'browser-1', accessUntil: 1_900_000_000_000, accessMs: 72_000_000 }) })
    const { resolveSignInGate } = await gate()
    expect(await resolveSignInGate()).toBe('app')
    expect(reload).not.toHaveBeenCalled()
    // Read once: the mark is cleared.
    expect(cookieWrites[0]).toBe('walnut_restored=; Max-Age=0; Path=/; SameSite=Strict; Secure')
  })

  it('a page an older build reloaded with the mark in its address boots too, and the address is cleaned', async () => {
    page('#signed-in-again')
    answer({ '/api/auth/browser/refresh?secure=1': () => json(200, { token: 'new-token', name: 'browser-1', accessUntil: 1_900_000_000_000, accessMs: 72_000_000 }) })
    const { resolveSignInGate } = await gate()
    expect(await resolveSignInGate()).toBe('app')
    expect(reload).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('')
  })

  it('with no token, a rate limit or a server error at the renewal is a failed probe, never a console without one', async () => {
    for (const status of [429, 503]) {
      vi.resetModules()
      page('')
      answer({ '/api/auth/browser/refresh?secure=1': () => json(status, { error: 'busy' }) })
      expect(await (await gate()).resolveSignInGate(), String(status)).toBe('probe-failed')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  })

  it('two tabs at once: a 409 asks again, and the next answer is taken', async () => {
    page('')
    let calls = 0
    answer({ '/api/auth/browser/refresh?secure=1': () => (++calls === 1 ? json(409, { code: 'refresh_raced' }) : json(200, { token: 'new-token', name: 'browser-1', accessUntil: 1_900_000_000_000, accessMs: 72_000_000 })) })
    // Loaded before the clock is faked: a module load waits on real timers.
    const { resolveSignInGate } = await gate()
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const result = resolveSignInGate()
    // The page waits a second before asking again: step the clock until it has.
    for (let i = 0; i < 50 && calls < 2; i++) await vi.advanceTimersByTimeAsync(100)
    vi.useRealTimers()
    void result
    // No token was held: the page reloads with the one it got (the gate's promise never settles).
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(calls).toBe(2)
    expect(store.get('walnut.deviceToken')).toBe('new-token')
  })

  it('an older server without the route falls back to the probe', async () => {
    page('')
    answer({ '/api/auth/browser/refresh?secure=1': () => json(404, { error: 'not found' }), '/api/v1/me': () => json(401, { code: 'not_paired' }) })
    const { resolveSignInGate, getUnpairedState } = await gate()
    expect(await resolveSignInGate()).toBe('sign-in')
    expect(getUnpairedState()).toBe('unpaired')
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/auth/browser/refresh?secure=1', '/api/v1/me'])
  })

  it('a token that ran out renews before the console boots, sending no token of its own', async () => {
    page('')
    store.set('walnut.deviceToken', 'old-access')
    store.set('walnut.deviceTokenUntil', String(Date.now() - 60_000))
    answer({ '/api/auth/browser/refresh?secure=1': () => json(200, { token: 'new-access', name: 'browser-1', accessUntil: Date.now() + 72_000_000, accessMs: 72_000_000 }) })
    const { resolveSignInGate } = await gate()
    expect(await resolveSignInGate()).toBe('app')
    expect(store.get('walnut.deviceToken')).toBe('new-access')
    // It had a token: no reload (its requests renew and go again, client.ts).
    expect(reload).not.toHaveBeenCalled()
  })

  it('a token that ran out, with no answer to its renewal (the Mac away behind a host), boots on it', async () => {
    page('')
    store.set('walnut.deviceToken', 'old-access')
    store.set('walnut.deviceTokenUntil', String(Date.now() - 60_000))
    answer({ '/api/auth/browser/refresh?secure=1': () => json(503, { error: 'needs your Mac' }) })
    expect(await (await gate()).resolveSignInGate()).toBe('app')
    expect(store.get('walnut.deviceToken')).toBe('old-access')
  })

  it('a token not run out (or from before renewing) boots at once; the console renews it', async () => {
    for (const until of [String(Date.now() + 3_600_000), null, 'never']) {
      vi.resetModules()
      page('')
      store.set('walnut.deviceToken', 'tok')
      if (until !== null) store.set('walnut.deviceTokenUntil', until)
      expect(await (await gate()).resolveSignInGate(), String(until)).toBe('app')
      expect(fetchMock).not.toHaveBeenCalled()
    }
  })

  it('a refusal with the primary code gets the sign-in screen alone', async () => {
    page('')
    answer({ '/api/auth/browser/refresh?secure=1': () => new Response(null, { status: 204 }), '/api/v1/me': () => json(401, { code: 'not_paired' }) })
    const { resolveSignInGate, getUnpairedState } = await gate()
    expect(await resolveSignInGate()).toBe('sign-in')
    expect(getUnpairedState()).toBe('unpaired')
  })

  it('a 401 without the code (another server sign-in) boots; an unreachable server is a failed probe (D5)', async () => {
    page('')
    // A companion's auth answers the renewal too, with no code of the route's: not this route speaking.
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
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/v1/browser-pair?secure=1')
    expect(store.get('walnut.deviceToken')).toBe('fresh-token')
    // An older server's answer says no time: that token never renews, and is never asked to.
    expect(store.get('walnut.deviceTokenUntil')).toBe('never')
    expect(cookieWrites.some((c) => c.startsWith('walnut_device=fresh-token'))).toBe(true)
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

  // A reviewer's phone (Claude r4): the trade got no answer for 9 s, a reload then landed on
  // a plain sign-in screen with the link gone from the address.
  it('a #pair code whose trade got no answer is kept for the tab: the reload trades it again', async () => {
    const session = new Map<string, string>()
    const sessionStub = { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => { session.set(k, v) }, removeItem: (k: string) => { session.delete(k) } }
    page('#pair=ABCD-EFGH')
    vi.stubGlobal('sessionStorage', sessionStub)
    fetchMock.mockRejectedValue(new TypeError('Load failed'))
    expect(await (await gate()).resolveSignInGate()).toBe('sign-in')
    expect(window.location.hash).toBe('')
    expect(JSON.parse(session.get('walnut.pendingPairCode')!).code).toBe('ABCD-EFGH')

    // The reload: no code in the address, the kept one is traded.
    vi.resetModules()
    page('')
    vi.stubGlobal('sessionStorage', sessionStub)
    fetchMock.mockResolvedValue(json(200, { token: 'fresh-token', name: 'browser-1', accessUntil: 1_900_000_000_000, accessMs: 72_000_000 }))
    const { resolveSignInGate } = await gate()
    const result = Promise.race([resolveSignInGate(), new Promise((r) => setTimeout(() => r('pending'), 50))])
    expect(await result).toBe('pending')
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).code).toBe('ABCD-EFGH')
    expect(store.get('walnut.deviceToken')).toBe('fresh-token')
    expect(reload).toHaveBeenCalledTimes(1)
    expect(session.has('walnut.pendingPairCode')).toBe(false)
  })

  it('a kept code refused after the reload says the link was used (its first answer was lost), and is dropped', async () => {
    const session = new Map<string, string>([['walnut.pendingPairCode', JSON.stringify({ code: 'ABCD-EFGH', at: Date.now() })]])
    page('')
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => { session.set(k, v) }, removeItem: (k: string) => { session.delete(k) } })
    fetchMock.mockResolvedValue(json(400, { error: { code: 'invalid_code', message: 'That code is wrong, already used or expired.' } }))
    expect(await (await gate()).resolveSignInGate()).toBe('sign-in')
    const { getFragmentPairState, KEPT_CODE_REFUSED } = await import('../../web/src/api/browser-pair')
    expect(getFragmentPairState()).toEqual({ phase: 'failed', code: 'ABCD-EFGH', message: KEPT_CODE_REFUSED })
    expect(session.has('walnut.pendingPairCode')).toBe(false)
  })

  it('a kept code is dropped, never traded, once this browser holds a token (another tab signed in)', async () => {
    const session = new Map<string, string>([['walnut.pendingPairCode', JSON.stringify({ code: 'ABCD-EFGH', at: Date.now() })]])
    page('')
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => { session.set(k, v) }, removeItem: (k: string) => { session.delete(k) } })
    store.set('walnut.deviceToken', 'tok')
    const { hasPendingPairCode } = await import('../../web/src/api/browser-pair')
    expect(hasPendingPairCode()).toBe(false)
    expect(await (await gate()).resolveSignInGate()).toBe('app')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(session.has('walnut.pendingPairCode')).toBe(false)
  })

  it('a kept code older than ten minutes is dropped, never traded', async () => {
    const session = new Map<string, string>([['walnut.pendingPairCode', JSON.stringify({ code: 'ABCD-EFGH', at: Date.now() - 11 * 60_000 })]])
    page('')
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => { session.set(k, v) }, removeItem: (k: string) => { session.delete(k) } })
    answer({ '/api/auth/browser/refresh?secure=1': () => new Response(null, { status: 204 }), '/api/v1/me': () => json(401, { code: 'not_paired' }) })
    expect(await (await gate()).resolveSignInGate()).toBe('sign-in')
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/auth/browser/refresh?secure=1', '/api/v1/me'])
    expect(session.has('walnut.pendingPairCode')).toBe(false)
  })
})
