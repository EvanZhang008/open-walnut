/**
 * A request the page's own exit cut (a reload, a navigation) is not an error:
 * 2026-10-30, every reload in a browser test logged "[api] GET … JSON parse
 * failed … TypeError: Failed to fetch" for a body the browser cancelled. The same
 * failure while the page stays is still logged as one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

let win: EventTarget
let errors: unknown[][]

async function loadClient() {
  vi.resetModules()
  return import('../../web/src/api/client')
}

beforeEach(() => {
  win = new EventTarget()
  vi.stubGlobal('window', win)
  errors = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args) })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

/** A 200 whose body read fails the way a cancelled load does. */
function cutBody(): Response {
  const res = new Response('{}', { status: 200 })
  Object.defineProperty(res, 'text', { value: () => Promise.reject(new TypeError('Failed to fetch')) })
  return res
}

describe('requests cut by the page leaving', () => {
  it('a body read the reload cut rejects without an error log', async () => {
    const { apiGet } = await loadClient()
    vi.stubGlobal('fetch', vi.fn(async () => cutBody()))
    win.dispatchEvent(new Event('pagehide'))
    await expect(apiGet('/api/sessions/s1/supervision')).rejects.toBeInstanceOf(TypeError)
    expect(errors).toEqual([])
  })

  it('a fetch the reload cut rejects without an error log', async () => {
    const { apiGet } = await loadClient()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    win.dispatchEvent(new Event('pagehide'))
    await expect(apiGet('/api/tasks')).rejects.toBeInstanceOf(TypeError)
    expect(errors).toEqual([])
  })

  it('the same failures while the page stays are logged, and a back-forward restore counts as staying', async () => {
    const { apiGet } = await loadClient()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(apiGet('/api/tasks')).rejects.toBeInstanceOf(TypeError)
    win.dispatchEvent(new Event('pagehide'))
    win.dispatchEvent(new Event('pageshow'))
    vi.stubGlobal('fetch', vi.fn(async () => cutBody()))
    await expect(apiGet('/api/sessions/s1/supervision')).rejects.toBeDefined()
    expect(errors.map((e) => String(e[0]))).toEqual([
      expect.stringContaining('GET /api/tasks FAILED'),
      expect.stringContaining('JSON parse failed'),
      expect.stringContaining('JSON parse failed'),
    ])
  })
})

/**
 * A write made as the page goes outlives it (2026-11-01: a reload cut the visit batch its own
 * hide edge sent; WebKit logs that as "cannot load /api/page-visits due to access control
 * checks"). It is sent with keepalive and at once, never left in the connection queue, which
 * the page stops before draining.
 */
describe('writes made as the page goes', () => {
  let doc: EventTarget & { visibilityState: string }
  let calls: { url: string; init: RequestInit }[]
  let held: (() => void)[]

  beforeEach(() => {
    doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    vi.stubGlobal('document', doc)
    calls = []
    held = []
  })

  /** Every fetch answers at once, except GETs held open when `hold` is on. */
  let hold = false
  function stubFetch(holdGets = false) {
    hold = holdGets
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (hold && (init.method ?? 'GET') === 'GET') {
        return new Promise<Response>((resolve) => { held.push(() => resolve(new Response('{}', { status: 200 }))) })
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    }))
  }
  const hide = () => { doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange')) }

  it('a write at the hide edge goes with keepalive and ahead of a full connection queue', async () => {
    const { apiGet, apiPut, getFetchQueueStats } = await loadClient()
    stubFetch(true)
    const gets = Array.from({ length: 8 }, (_, i) => apiGet(`/api/slow/${i}`))
    expect(getFetchQueueStats().queued).toBeGreaterThan(0)
    hide()
    const put = apiPut('/api/config', { a: 1 })
    await Promise.resolve()
    const sent = calls.find((c) => c.url === '/api/config')
    expect(sent?.init.keepalive).toBe(true)
    await put
    hold = false
    held.forEach((r) => r())
    await Promise.all(gets)
  })

  // 2026-11-06, CI: the visit batch its timer sent behind a full pool sat in the queue when the
  // page reloaded, and JS stopped before the queue drained, so it never reached the server.
  for (const edge of ['pagehide', 'hide'] as const) {
    it(`a write already waiting in the queue goes at once with keepalive at the ${edge} edge; a waiting GET stays`, async () => {
      const { apiGet, apiPost, getFetchQueueStats } = await loadClient()
      stubFetch(true)
      const gets = Array.from({ length: 8 }, (_, i) => apiGet(`/api/slow/${i}`))
      const visits = apiPost('/api/page-visits', { keys: ['page:org'] }, { background: true, priority: 'low', keepalive: true })
      const save = apiPost('/api/config', { a: 1 })
      // A background POST that only reads: it may wait, and must not burst past the cap.
      const listing = apiPost('/api/files/list-many', { paths: [] }, { background: true })
      await Promise.resolve()
      expect(calls.map((c) => c.url)).not.toContain('/api/page-visits')
      expect(calls.map((c) => c.url)).not.toContain('/api/config')
      if (edge === 'pagehide') win.dispatchEvent(new Event('pagehide'))
      else hide()
      for (let i = 0; i < 5; i++) await Promise.resolve()
      expect(calls.find((c) => c.url === '/api/page-visits')?.init.keepalive).toBe(true)
      expect(calls.find((c) => c.url === '/api/config')?.init.keepalive).toBe(true)
      // The GETs past the six slots still wait their turn.
      expect(calls.filter((c) => c.url.startsWith('/api/slow/'))).toHaveLength(6)
      expect(calls.map((c) => c.url)).not.toContain('/api/files/list-many')
      expect(getFetchQueueStats().queued).toBe(3)
      await Promise.all([visits, save])
      hold = false
      held.forEach((r) => r())
      await Promise.all([...gets, listing])
      // Every slot taken past the cap was given back.
      expect(getFetchQueueStats()).toEqual({ inFlight: 0, queued: 0 })
    })
  }

  it('a write on pagehide goes with keepalive; a GET there does not', async () => {
    const { apiGet, apiPost } = await loadClient()
    stubFetch()
    win.dispatchEvent(new Event('pagehide'))
    await apiPost('/api/page-visits', { keys: ['page:org'] })
    await apiGet('/api/tasks')
    expect(calls.map((c) => [c.url, c.init.keepalive ?? false])).toEqual([['/api/page-visits', true], ['/api/tasks', false]])
  })

  it('a write while the page shows is plain unless it asks for keepalive', async () => {
    const { apiPost } = await loadClient()
    stubFetch()
    await apiPost('/api/a', { x: 1 })
    await apiPost('/api/b', { x: 1 }, { keepalive: true })
    expect(calls.map((c) => c.init.keepalive ?? false)).toEqual([false, true])
  })

  it('the exit edge ends when the page shows again, even with its timer still waiting', async () => {
    const { apiGet, apiPut, getFetchQueueStats } = await loadClient()
    stubFetch(true)
    const gets = Array.from({ length: 8 }, (_, i) => apiGet(`/api/slow/${i}`))
    hide()
    doc.visibilityState = 'visible'
    doc.dispatchEvent(new Event('visibilitychange'))
    // Visible and past the edge: the write waits its turn in the queue like any other.
    const put = apiPut('/api/config', { a: 1 })
    await Promise.resolve()
    expect(calls.find((c) => c.url === '/api/config')).toBeUndefined()
    expect(getFetchQueueStats().queued).toBeGreaterThan(0)
    hold = false
    held.forEach((r) => r())
    await Promise.all([put, ...gets])
    expect(calls.find((c) => c.url === '/api/config')?.init.keepalive ?? false).toBe(false)
  })

  it('the keepalive limit counts bytes: a body of CJK text under 60,000 characters but over 60 KB goes plain', async () => {
    const { apiPost } = await loadClient()
    stubFetch()
    hide()
    await apiPost('/api/cjk', { text: '\u6587'.repeat(25_000) })
    await apiPost('/api/cjk-small', { text: '\u6587'.repeat(1_000) })
    expect(calls.map((c) => c.init.keepalive ?? false)).toEqual([false, true])
  })

  it('a body over the keepalive limit goes plain, and a refused keepalive is sent again plainly', async () => {
    const { apiPost } = await loadClient()
    stubFetch()
    hide()
    await apiPost('/api/big', { text: 'x'.repeat(70_000) })
    expect(calls[0].init.keepalive ?? false).toBe(false)
    calls = []
    let first = true
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (first) { first = false; return Promise.reject(new TypeError('keepalive budget')) }
      return Promise.resolve(new Response('{}', { status: 200 }))
    }))
    await apiPost('/api/small', { x: 1 })
    expect(calls.map((c) => c.init.keepalive)).toEqual([true, false])
  })
})
