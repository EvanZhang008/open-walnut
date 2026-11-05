/**
 * The web client's side of a renewing sign-in (web/src/api/device-token.ts):
 * a request refused as `token_expired` renews and goes again once, a request
 * that was out while another tab renewed goes again with the new token, and
 * renewal is due a quarter of the token's life before it runs out. 2026-11-04,
 * the user asked for a phone that stays signed in the way a well-known dashboard
 * keeps one: short access tokens renewed by the page from a refresh cookie.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type Call = { url: string; method: string; auth: string | null }

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let store: Map<string, string>
let calls: Call[]

function browser(token: string | null, until?: number) {
  store = new Map()
  if (token) store.set('walnut.deviceToken', token)
  if (until !== undefined) store.set('walnut.deviceTokenUntil', String(until))
  calls = []
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })
  vi.stubGlobal('document', { cookie: '', visibilityState: 'visible', addEventListener: () => {} })
  vi.stubGlobal('navigator', {})
}

/** fetch answering `/api/auth/browser/refresh` with `renewal`, every other URL with `route(token)`. */
function server(route: (auth: string | null, url: string) => Response, renewal: () => Response) {
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const auth = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('authorization')
    calls.push({ url, method: String(init?.method ?? 'GET'), auth })
    if (url.startsWith('/api/auth/browser/refresh')) return renewal()
    return route(auth, url)
  })
  return f
}

beforeEach(() => { vi.resetModules() })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('client.ts', () => {
  it('a request refused as token_expired renews, then goes again with the new token', async () => {
    browser('old', Date.now() - 1_000)
    vi.stubGlobal('window', { location: { protocol: 'http:', href: 'http://x.test/' }, addEventListener: () => {} })
    vi.stubGlobal('fetch', server(
      (auth) => (auth === 'Bearer new' ? json(200, { ok: 1 }) : json(401, { code: 'token_expired' })),
      () => json(200, { token: 'new', name: 'browser-1', accessUntil: Date.now() + 72_000_000, accessMs: 72_000_000 }),
    ))
    const { apiGet } = await import('../../web/src/api/client')
    const { getUnpairedState } = await import('../../web/src/api/unpaired')
    expect(await apiGet('/api/tasks')).toEqual({ ok: 1 })
    expect(calls.map((c) => `${c.url} ${c.auth}`)).toEqual(['/api/tasks Bearer old', '/api/auth/browser/refresh Bearer old', '/api/tasks Bearer new'])
    expect(getUnpairedState()).toBe('ok')
  })

  it('a write refused the same way goes again once, with its op id (the first never reached a handler)', async () => {
    browser('old', Date.now() - 1_000)
    vi.stubGlobal('window', { location: { protocol: 'http:', href: 'http://x.test/' }, addEventListener: () => {} })
    const ids: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const h = new Headers(init?.headers)
      if (url.startsWith('/api/auth/browser/refresh')) return json(200, { token: 'new', name: 'b', accessUntil: Date.now() + 72_000_000, accessMs: 72_000_000 })
      ids.push(h.get('x-walnut-op-id') ?? '')
      return h.get('authorization') === 'Bearer new' ? json(200, { ok: 1 }) : json(401, { code: 'token_expired' })
    }))
    const { apiPost } = await import('../../web/src/api/client')
    expect(await apiPost('/api/tasks', { title: 'Acme' })).toEqual({ ok: 1 })
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
  })

  it('a renewal that is refused says the browser is signed out, and the request fails as it did', async () => {
    browser('old', Date.now() - 1_000)
    vi.stubGlobal('window', { location: { protocol: 'http:', href: 'http://x.test/' }, addEventListener: () => {} })
    vi.stubGlobal('fetch', server(() => json(401, { code: 'token_expired' }), () => json(401, { code: 'refresh_reused' })))
    const { apiGet } = await import('../../web/src/api/client')
    const { getUnpairedState } = await import('../../web/src/api/unpaired')
    await expect(apiGet('/api/tasks')).rejects.toMatchObject({ status: 401 })
    expect(getUnpairedState()).toBe('revoked')
    expect(calls).toHaveLength(2)
  })

  it('a renewal answered refresh_missing (its cookie is gone) says signed out too, never retrying until the token runs out', async () => {
    browser('old', Date.now() - 1_000)
    vi.stubGlobal('window', { location: { protocol: 'http:', href: 'http://x.test/' }, addEventListener: () => {} })
    vi.stubGlobal('fetch', server(() => json(401, { code: 'token_expired' }), () => json(401, { code: 'refresh_missing' })))
    const { apiGet } = await import('../../web/src/api/client')
    const { getUnpairedState } = await import('../../web/src/api/unpaired')
    await expect(apiGet('/api/tasks')).rejects.toMatchObject({ status: 401 })
    expect(getUnpairedState()).toBe('revoked')
  })

  it('a renewal with no answer (the Mac away) leaves the browser signed in', async () => {
    browser('old', Date.now() - 1_000)
    vi.stubGlobal('window', { location: { protocol: 'http:', href: 'http://x.test/' }, addEventListener: () => {} })
    vi.stubGlobal('fetch', server(() => json(401, { code: 'token_expired' }), () => json(503, { error: 'needs your Mac' })))
    const { apiGet } = await import('../../web/src/api/client')
    const { getUnpairedState } = await import('../../web/src/api/unpaired')
    await expect(apiGet('/api/tasks')).rejects.toMatchObject({ status: 401 })
    expect(getUnpairedState()).toBe('ok')
  })

  it('a renewal answered by a server that does not renew (404: an older server) is no sign-out either', async () => {
    browser('old', Date.now() - 1_000)
    vi.stubGlobal('window', { location: { protocol: 'http:', href: 'http://x.test/' }, addEventListener: () => {} })
    vi.stubGlobal('fetch', server(() => json(401, { code: 'token_expired' }), () => json(404, { error: 'Not found' })))
    const { apiGet } = await import('../../web/src/api/client')
    const { getUnpairedState } = await import('../../web/src/api/unpaired')
    await expect(apiGet('/api/tasks')).rejects.toMatchObject({ status: 401 })
    expect(getUnpairedState()).toBe('ok')
  })

  it('a refusal heard while a renewal was out (its token was the one replaced) is undone when the renewal lands', async () => {
    browser('old', Date.now() + 60_000)
    vi.stubGlobal('window', { location: { protocol: 'http:', href: 'http://x.test/' }, addEventListener: () => {} })
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { token: 'new', name: 'b', accessUntil: Date.now() + 72_000_000, accessMs: 72_000_000 })))
    const { noteAuthRefusal, getUnpairedState } = await import('../../web/src/api/unpaired')
    const { renewSignIn } = await import('../../web/src/api/device-token')
    noteAuthRefusal({ code: 'token_refused' })
    expect(getUnpairedState()).toBe('revoked')
    expect((await renewSignIn()).kind).toBe('renewed')
    expect(getUnpairedState()).toBe('ok')
  })

  it('a 401 for a token another tab replaced meanwhile goes again with the token held now, and no notice', async () => {
    browser('old')
    vi.stubGlobal('window', { location: { protocol: 'http:', href: 'http://x.test/' }, addEventListener: () => {} })
    vi.stubGlobal('fetch', server((auth) => {
      if (auth === 'Bearer old') { store.set('walnut.deviceToken', 'new'); return json(401, { code: 'token_refused' }) }
      return json(200, { ok: 2 })
    }, () => json(500, {})))
    const { apiGet } = await import('../../web/src/api/client')
    const { getUnpairedState } = await import('../../web/src/api/unpaired')
    expect(await apiGet('/api/x')).toEqual({ ok: 2 })
    expect(calls.map((c) => c.auth)).toEqual(['Bearer old', 'Bearer new'])
    expect(getUnpairedState()).toBe('ok')
  })

  it('a second 401 after going again stands (no loop)', async () => {
    browser('old', Date.now() - 1_000)
    vi.stubGlobal('window', { location: { protocol: 'http:', href: 'http://x.test/' }, addEventListener: () => {} })
    vi.stubGlobal('fetch', server(() => json(401, { code: 'token_expired' }), () => json(200, { token: 'new', name: 'b', accessUntil: Date.now() + 72_000_000, accessMs: 72_000_000 })))
    const { apiGet } = await import('../../web/src/api/client')
    await expect(apiGet('/api/x')).rejects.toMatchObject({ status: 401 })
    expect(calls.filter((c) => c.url === '/api/x')).toHaveLength(2)
  })
})

describe('a refusal with no reason', () => {
  it('a renewing sign-in refused plainly (its device removed, the page reloaded) asks the renewal route once, which says why', async () => {
    browser('old', Date.now() + 60 * 60_000)
    vi.stubGlobal('window', { location: { protocol: 'http:', href: 'http://x.test/' }, addEventListener: () => {} })
    vi.stubGlobal('fetch', server(() => json(401, { code: 'token_refused' }), () => json(401, { code: 'device_removed' })))
    const { startSignInRenewal } = await import('../../web/src/api/device-token')
    const { noteAuthRefusal, getSignedOutReason, getUnpairedState } = await import('../../web/src/api/unpaired')
    startSignInRenewal()
    noteAuthRefusal({ code: 'token_refused' })
    await vi.waitFor(() => expect(getSignedOutReason()).toBe('removed'))
    expect(getUnpairedState()).toBe('revoked')
    noteAuthRefusal({ code: 'token_refused' })
    expect(calls.filter((c) => c.url.startsWith('/api/auth/browser/refresh'))).toHaveLength(1)
  })

  it('a refusal heard by mistake (the sign-in still stands) is undone by that renewal', async () => {
    browser('old', Date.now() + 60 * 60_000)
    vi.stubGlobal('window', { location: { protocol: 'http:', href: 'http://x.test/' }, addEventListener: () => {} })
    vi.stubGlobal('fetch', server(() => json(200, {}), () => json(200, { token: 'new', name: 'b', accessUntil: Date.now() + 72_000_000, accessMs: 72_000_000 })))
    const { startSignInRenewal } = await import('../../web/src/api/device-token')
    const { noteAuthRefusal, getUnpairedState } = await import('../../web/src/api/unpaired')
    startSignInRenewal()
    noteAuthRefusal({ code: 'token_refused' })
    await vi.waitFor(() => expect(getUnpairedState()).toBe('ok'))
  })
})

describe('auth-fetch.ts (loaders that call fetch directly)', () => {
  async function wrapped(route: (auth: string | null, url: string) => Response, renewal: () => Response) {
    const inner = server(route, renewal)
    vi.stubGlobal('window', { location: { protocol: 'http:', href: 'http://x.test/' }, fetch: inner, addEventListener: () => {} })
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => (window as unknown as { fetch: typeof fetch }).fetch(input, init))
    const { installAuthFetch } = await import('../../web/src/api/auth-fetch')
    installAuthFetch()
    return (window as unknown as { fetch: typeof fetch }).fetch
  }

  it('a call refused as token_expired renews and goes again; its caller sees the answer', async () => {
    browser('old', Date.now() - 1_000)
    const f = await wrapped(
      (auth) => (auth === 'Bearer new' ? json(200, { items: [] }) : json(401, { code: 'token_expired' })),
      () => json(200, { token: 'new', name: 'b', accessUntil: Date.now() + 72_000_000, accessMs: 72_000_000 }),
    )
    const res = await f('/api/notifications')
    expect(res.status).toBe(200)
    expect(calls.map((c) => `${c.url} ${c.auth}`)).toEqual(['/api/notifications Bearer old', '/api/auth/browser/refresh Bearer old', '/api/notifications Bearer new'])
  })

  it('a call whose body cannot be sent twice, or that named its own token, is left with its 401', async () => {
    browser('old', Date.now() - 1_000)
    const f = await wrapped(() => json(401, { code: 'token_expired' }), () => json(200, { token: 'new', name: 'b', accessUntil: 1, accessMs: 1 }))
    const stream = new ReadableStream({ start(c) { c.close() } })
    expect((await f('/api/upload', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)).status).toBe(401)
    expect((await f('/api/x', { headers: { Authorization: 'Bearer mine' } })).status).toBe(401)
    expect(calls.some((c) => c.url.startsWith('/api/auth/browser/refresh'))).toBe(false)
  })
})

describe('when renewal is due', () => {
  it('a quarter of the lifetime before it runs out, at most five hours; a token from before renewing at once; never one that never renews', async () => {
    const now = Date.now()
    browser('t', now + 10 * 3_600_000)
    store.set('walnut.deviceTokenLifetime', String(20 * 3_600_000))
    vi.stubGlobal('window', { location: { protocol: 'http:' } })
    let m = await import('../../web/src/api/device-token')
    expect(m.renewalDueAt()).toBe(now + 5 * 3_600_000)
    expect(m.renewalDue(now)).toBe(false)
    expect(m.renewalDue(now + 5 * 3_600_000)).toBe(true)
    store.set('walnut.deviceTokenLifetime', String(60_000))
    expect(m.renewalDueAt()).toBe(now + 10 * 3_600_000 - 15_000)
    store.delete('walnut.deviceTokenUntil')
    expect(m.renewalDueAt()).toBe(0)
    store.set('walnut.deviceTokenUntil', 'never')
    expect(m.renewalDueAt()).toBeNull()
    expect(m.tokenExpired()).toBe(false)
    vi.resetModules()
    browser(null)
    vi.stubGlobal('window', { location: { protocol: 'http:' } })
    m = await import('../../web/src/api/device-token')
    expect(m.renewalDueAt()).toBeNull()
  })

  it('a 204 from the route (a token it never renews) is remembered, so the next open does not ask', async () => {
    browser('app-token')
    vi.stubGlobal('window', { location: { protocol: 'http:' } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    const m = await import('../../web/src/api/device-token')
    expect((await m.renewSignIn()).kind).toBe('unknown')
    expect(store.get('walnut.deviceTokenUntil')).toBe('never')
    expect(m.renewalDue()).toBe(false)
  })

  it('a 401 without the route\'s own code (a companion\'s auth, an older server) is not a sign-out', async () => {
    browser('t')
    vi.stubGlobal('window', { location: { protocol: 'http:' } })
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: 'Authentication required' })))
    const m = await import('../../web/src/api/device-token')
    expect((await m.renewSignIn()).kind).toBe('unknown')
    expect(store.get('walnut.deviceToken')).toBe('t')
  })

  it('a tab that holds the cross-tab lock and never lets go (frozen in the background) is waited for only so long', async () => {
    browser('t')
    vi.stubGlobal('window', { location: { protocol: 'http:' } })
    const request = vi.fn((_name: string, opts: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new DOMException('The request was aborted.', 'AbortError')))
    }))
    vi.stubGlobal('navigator', { locks: { request } })
    const f = vi.fn(async () => json(200, { token: 'n', name: 'b', accessUntil: Date.now() + 72_000_000, accessMs: 72_000_000 }))
    vi.stubGlobal('fetch', f)
    const m = await import('../../web/src/api/device-token')
    expect((await m.renewSignIn(50)).kind).toBe('renewed')
    expect(request).toHaveBeenCalledTimes(1)
    expect(f).toHaveBeenCalledTimes(1)
    expect(store.get('walnut.deviceToken')).toBe('n')
  })

  it('one renewal at a time in a page: two callers share it', async () => {
    browser('t')
    vi.stubGlobal('window', { location: { protocol: 'http:' } })
    const f = vi.fn(async () => json(200, { token: 'n', name: 'b', accessUntil: Date.now() + 72_000_000, accessMs: 72_000_000 }))
    vi.stubGlobal('fetch', f)
    const m = await import('../../web/src/api/device-token')
    const [a, b] = await Promise.all([m.renewSignIn(), m.renewSignIn()])
    expect(a).toEqual(b)
    expect(f).toHaveBeenCalledTimes(1)
  })
})
