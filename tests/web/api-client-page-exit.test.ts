/**
 * A request the page's own exit cut (a reload, a navigation) is not an error:
 * 2026-10-30, every reload in a browser test logged "[api] GET … JSON parse
 * failed … TypeError: Failed to fetch" for a body the browser cancelled. The same
 * failure while the page stays is still logged as one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

let win: EventTarget
let frames: FrameRequestCallback[]
let errors: unknown[][]

async function loadClient() {
  vi.resetModules()
  return import('../../web/src/api/client')
}

beforeEach(() => {
  frames = []
  win = Object.assign(new EventTarget(), { requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => frames.push(callback)) })
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
    let rejectBody!: (error: Error) => void
    let bodyStarted!: () => void
    const started = new Promise<void>(resolve => { bodyStarted = resolve })
    const response = new Response('{}', { status: 200 })
    Object.defineProperty(response, 'text', { value: () => {
      bodyStarted()
      return new Promise<string>((_resolve, reject) => { rejectBody = reject })
    } })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const read = readOutcome(apiGet('/api/sessions/s1/supervision'))
    await started
    win.dispatchEvent(new Event('pagehide'))
    rejectBody(new TypeError('Failed to fetch'))
    const result = await read
    expect(result.kind).toBe('rejected')
    expect(result.kind === 'rejected' && result.error).toBeInstanceOf(TypeError)
    expect(errors).toEqual([])
  })

  it('a fetch the reload cut rejects without an error log', async () => {
    const { apiGet } = await loadClient()
    let rejectFetch!: (error: Error) => void
    let fetchStarted!: () => void
    const started = new Promise<void>(resolve => { fetchStarted = resolve })
    vi.stubGlobal('fetch', vi.fn(() => {
      fetchStarted()
      return new Promise<Response>((_resolve, reject) => { rejectFetch = reject })
    }))
    const read = readOutcome(apiGet('/api/tasks'))
    await started
    win.dispatchEvent(new Event('pagehide'))
    rejectFetch(new TypeError('Failed to fetch'))
    const result = await read
    expect(result.kind).toBe('rejected')
    expect(result.kind === 'rejected' && result.error).toBeInstanceOf(TypeError)
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

/** Attach rejection handlers immediately: a red assertion must never create an unhandled rejection. */
function readOutcome<T>(promise: Promise<T>) {
  return promise.then(
    value => ({ kind: 'resolved' as const, value }),
    error => ({ kind: 'rejected' as const, error }),
  )
}

function outcomeView(result: Awaited<ReturnType<typeof readOutcome>>) {
  return result.kind === 'resolved'
    ? { kind: result.kind }
    : { kind: result.kind, name: (result.error as Error)?.name, message: (result.error as Error)?.message }
}

async function drainMicrotasks() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

function showPage() {
  const event = new Event('pageshow')
  Object.defineProperty(event, 'persisted', { value: true })
  win.dispatchEvent(event)
}

describe('cancelled navigation read admission', () => {
  it('restores the original normal, low and text promises once after a full pool drains', async () => {
    const { apiGet, apiGetText, getFetchQueueStats, getLowFetchQueueStats } = await loadClient()
    const held: Array<() => void> = []
    const fetch = vi.fn((url: string) => url.startsWith('/api/active/')
      ? new Promise<Response>(resolve => { held.push(() => resolve(new Response('{}'))) })
      : Promise.resolve(new Response(url === '/api/text' ? 'Restored report' : '{"restored":true}')))
    vi.stubGlobal('fetch', fetch)
    const active = Array.from({ length: 6 }, (_, i) => readOutcome(apiGet(`/api/active/${i}`)))
    await drainMicrotasks()
    const onDispatch = vi.fn()
    const reads = [readOutcome(apiGet('/api/normal', undefined, { onDispatch })),
      readOutcome(apiGet('/api/low', undefined, { priority: 'low', onDispatch })), readOutcome(apiGetText('/api/text'))]
    win.dispatchEvent(new Event('beforeunload'))
    held.forEach(release => release())
    await Promise.all(active)
    expect(fetch).toHaveBeenCalledTimes(6)
    expect(onDispatch).not.toHaveBeenCalled()
    expect(getFetchQueueStats()).toEqual({ inFlight: 0, queued: 3 })
    expect(getLowFetchQueueStats()).toEqual({ inFlight: 0, queued: 1 })
    frames[0](0)
    expect(await Promise.all(reads)).toEqual([{ kind: 'resolved', value: { restored: true } },
      { kind: 'resolved', value: { restored: true } }, { kind: 'resolved', value: 'Restored report' }])
    expect(fetch.mock.calls.slice(6).map(call => call[0])).toEqual(['/api/normal', '/api/text', '/api/low'])
    expect(onDispatch).toHaveBeenCalledTimes(2)
    showPage()
    await drainMicrotasks()
    expect(fetch).toHaveBeenCalledTimes(9)
    expect(getFetchQueueStats()).toEqual({ inFlight: 0, queued: 0 })
    expect(getLowFetchQueueStats()).toEqual({ inFlight: 0, queued: 0 })
  })

  for (const edge of ['beforeunload', 'pagehide']) {
    it(`holds background read POSTs across ${edge} after active connections drain`, async () => {
      const { apiGet, apiPost, getFetchQueueStats } = await loadClient()
      const held: Array<() => void> = []
      const fetch = vi.fn((url: string, _init?: RequestInit) => url.startsWith('/api/active/')
        ? new Promise<Response>(resolve => held.push(() => resolve(new Response('{}'))))
        : Promise.resolve(new Response('{}')))
      vi.stubGlobal('fetch', fetch)
      const active = Array.from({ length: 6 }, (_, i) => readOutcome(apiGet(`/api/active/${i}`)))
      await drainMicrotasks()
      const read = readOutcome(apiPost('/api/files/list-many', { paths: [] }, { background: true, readOnly: true }))
      win.dispatchEvent(new Event(edge))
      held.forEach(release => release())
      await Promise.all(active)
      expect(fetch).toHaveBeenCalledTimes(6)
      const lateRead = readOutcome(apiPost('/api/files/exists', { paths: [] }, { background: true, readOnly: true }))
      const save = apiPost('/api/page-visits', { keys: ['page:home'] }, { background: true, keepalive: true })
      await save
      expect(fetch.mock.calls.map(call => call[0])).toEqual([...Array.from({ length: 6 }, (_, i) => `/api/active/${i}`), '/api/page-visits'])
      expect(fetch.mock.calls.at(-1)?.[1]?.keepalive).toBe(true)
      expect(getFetchQueueStats()).toEqual({ inFlight: 0, queued: 2 })
      if (edge === 'beforeunload') frames[0](0)
      else showPage()
      expect((await Promise.all([read, lateRead])).map(outcome => outcome.kind)).toEqual(['resolved', 'resolved'])
      expect(fetch.mock.calls.slice(7).map(call => call[0])).toEqual(['/api/files/list-many', '/api/files/exists'])
      expect(fetch.mock.calls.slice(7).every(call => !call[1]?.keepalive)).toBe(true)
      expect(getFetchQueueStats()).toEqual({ inFlight: 0, queued: 0 })
    })
  }

  it('preserves background writes at navigation even without an explicit keepalive option', async () => {
    const { apiPost } = await loadClient()
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}'))
    vi.stubGlobal('fetch', fetch)
    win.dispatchEvent(new Event('beforeunload'))
    await apiPost('/api/v1/org/nodes/example/brief-refresh', {}, { background: true })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][1]?.keepalive).toBe(true)
    frames[0](0)
  })

  it('holds reads between beforeunload and pagehide but sends each exit save once with keepalive', async () => {
    const { apiGet, apiPut, apiPost, getFetchQueueStats } = await loadClient()
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}'))
    vi.stubGlobal('fetch', fetch)
    win.dispatchEvent(new Event('beforeunload'))
    const read = readOutcome(apiGet('/api/paused'))
    await drainMicrotasks()
    expect(fetch).not.toHaveBeenCalled()
    expect(getFetchQueueStats()).toEqual({ inFlight: 0, queued: 1 })
    await Promise.all([apiPut('/api/save', { saved: true }), apiPost('/api/visits', { visited: true })])
    win.dispatchEvent(new Event('pagehide'))
    frames[0](0)
    await drainMicrotasks()
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/save', '/api/visits'])
    expect(fetch.mock.calls.map(call => (call[1] as RequestInit).keepalive)).toEqual([true, true])
    showPage()
    expect((await read).kind).toBe('resolved')
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/save', '/api/visits', '/api/paused'])
    expect(getFetchQueueStats()).toEqual({ inFlight: 0, queued: 0 })
  })

  it('rechecks the exit when onDispatch synchronously starts navigation', async () => {
    const { apiGet, getFetchQueueStats } = await loadClient()
    const fetch = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetch)
    const onDispatch = vi.fn().mockImplementationOnce(() => win.dispatchEvent(new Event('beforeunload')))
    const read = readOutcome(apiGet('/api/dispatch-race', undefined, { onDispatch }))
    await drainMicrotasks()
    expect(onDispatch).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
    expect(getFetchQueueStats()).toEqual({ inFlight: 0, queued: 1 })
    frames[0](0)
    expect((await read).kind).toBe('resolved')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(getFetchQueueStats()).toEqual({ inFlight: 0, queued: 0 })
  })

  it('keeps the original absolute queue deadline across two navigation grant races', async () => {
    const { apiGet, getFetchQueueStats } = await loadClient()
    vi.useFakeTimers()
    try {
      const fetch = vi.fn(async () => new Response('{}'))
      vi.stubGlobal('fetch', fetch)
      const read = readOutcome(apiGet('/api/deadline'))
      win.dispatchEvent(new Event('beforeunload'))
      await drainMicrotasks()
      await vi.advanceTimersByTimeAsync(8_000)
      frames[0](0)
      win.dispatchEvent(new Event('beforeunload'))
      await drainMicrotasks()
      await vi.advanceTimersByTimeAsync(11_999)
      expect(getFetchQueueStats()).toEqual({ inFlight: 0, queued: 1 })
      await vi.advanceTimersByTimeAsync(1)
      expect(outcomeView(await read)).toEqual({ kind: 'rejected', name: 'TimeoutError',
        message: 'Request queued 20000ms while the page was suspended' })
      showPage()
      frames[1](0)
      await drainMicrotasks()
      expect(fetch).not.toHaveBeenCalled()
      expect(getFetchQueueStats()).toEqual({ inFlight: 0, queued: 0 })
    } finally { vi.useRealTimers() }
  })

  it('removes caller-aborted reads from both lanes without dispatching them on resume', async () => {
    const { apiGet, getFetchQueueStats, getLowFetchQueueStats } = await loadClient()
    const fetch = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetch)
    win.dispatchEvent(new Event('beforeunload'))
    const controllers = [new AbortController(), new AbortController()]
    const reads = controllers.map((controller, i) => readOutcome(apiGet(`/api/cancel/${i}`, undefined,
      { signal: controller.signal, ...(i ? { priority: 'low' as const } : {}) })))
    expect(getFetchQueueStats()).toEqual({ inFlight: 0, queued: 2 })
    controllers.forEach(controller => controller.abort())
    expect((await Promise.all(reads)).map(outcomeView)).toEqual([0, 1].map(() =>
      ({ kind: 'rejected', name: 'AbortError', message: 'The operation was aborted.' })))
    frames[0](0)
    showPage()
    await drainMicrotasks()
    expect(fetch).not.toHaveBeenCalled()
    expect(getFetchQueueStats()).toEqual({ inFlight: 0, queued: 0 })
    expect(getLowFetchQueueStats()).toEqual({ inFlight: 0, queued: 0 })
  })
})
describe('GETs resume after document restore', () => {
  for (const failure of ['AbortError', 'TypeError'] as const) {
    it(`holds both GET lanes when active reads reject with ${failure}`, async () => {
      const { apiGet, getFetchQueueStats } = await loadClient()
      const calls: string[] = []
      const rejects: Array<(error: Error) => void> = []
      vi.stubGlobal('fetch', vi.fn((url: string) => {
        calls.push(url)
        if (url.startsWith('/api/active/')) return new Promise<Response>((_resolve, reject) => { rejects.push(reject) })
        return Promise.resolve(new Response('{}', { status: 200 }))
      }))
      const active = Array.from({ length: 6 }, (_, i) => readOutcome(apiGet(`/api/active/${i}`)))
      await drainMicrotasks()
      const queued = [
        readOutcome(apiGet('/api/queued/normal')),
        readOutcome(apiGet('/api/queued/low', undefined, { priority: 'low' })),
      ]
      win.dispatchEvent(new Event('pagehide'))
      rejects.forEach(reject => reject(failure === 'AbortError'
        ? new DOMException('The document left.', 'AbortError') : new TypeError('Load failed')))
      await Promise.all(active)
      expect(calls).toHaveLength(6)
      expect(getFetchQueueStats()).toEqual({ inFlight: 0, queued: 2 })
      showPage()
      expect((await Promise.all(queued)).map(result => result.kind)).toEqual(['resolved', 'resolved'])
      expect(calls.slice(6)).toEqual(['/api/queued/normal', '/api/queued/low'])
      expect(getFetchQueueStats()).toEqual({ inFlight: 0, queued: 0 })
    })
  }

  it('returns an immediate grant before suspending and dispatches once on restore', async () => {
    const { apiGet, getFetchQueueStats } = await loadClient()
    const fetch = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetch)
    const onDispatch = vi.fn()
    const read = readOutcome(apiGet('/api/immediate', undefined, { onDispatch }))
    win.dispatchEvent(new Event('pagehide'))
    await drainMicrotasks()
    expect(fetch).not.toHaveBeenCalled()
    expect(onDispatch).not.toHaveBeenCalled()
    expect(getFetchQueueStats()).toEqual({ inFlight: 0, queued: 1 })
    showPage()
    expect((await read).kind).toBe('resolved')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(onDispatch).toHaveBeenCalledTimes(1)
    expect(getFetchQueueStats()).toEqual({ inFlight: 0, queued: 0 })
  })

  it('does not miss pageshow before the granted-slot continuation', async () => {
    const { apiGet } = await loadClient()
    const fetch = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetch)
    const read = readOutcome(apiGet('/api/early-restore'))
    win.dispatchEvent(new Event('pagehide'))
    showPage()
    expect((await read).kind).toBe('resolved')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps a new GET pending until pageshow without a caller retry', async () => {
    const { apiGet, getFetchQueueStats } = await loadClient()
    const fetch = vi.fn(async () => new Response('{"restored":true}'))
    vi.stubGlobal('fetch', fetch)
    win.dispatchEvent(new Event('pagehide'))
    const read = readOutcome(apiGet('/api/new-while-away'))
    await drainMicrotasks()
    expect(fetch).not.toHaveBeenCalled()
    expect(getFetchQueueStats()).toEqual({ inFlight: 0, queued: 1 })
    showPage()
    expect(await read).toEqual({ kind: 'resolved', value: { restored: true } })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('resumes the one-shot Tracking reader for the same note path', async () => {
    await loadClient()
    const { fetchNoteContent } = await import('../../web/src/api/notes-v2')
    const fetch = vi.fn(async () => new Response('{"content":"Tracking restored","updatedAt":"now","contentHash":"hash"}'))
    vi.stubGlobal('fetch', fetch)
    win.dispatchEvent(new Event('pagehide'))
    const notePath = 'Projects/Example/Tracking.md'
    const read = readOutcome(fetchNoteContent(notePath))
    await drainMicrotasks()
    expect(fetch).not.toHaveBeenCalled()
    showPage()
    expect(await read).toEqual({ kind: 'resolved', value: { content: 'Tracking restored', updatedAt: 'now', contentHash: 'hash' } })
    expect(fetch.mock.calls).toHaveLength(1)
    expect(fetch.mock.calls[0][0]).toBe(`/api/notes-v2/content/${notePath}`)
  })

  it('resumes the original text GET after its granted-slot race', async () => {
    const { apiGetText, getFetchQueueStats } = await loadClient()
    const fetch = vi.fn(async () => new Response('report'))
    vi.stubGlobal('fetch', fetch)
    const read = readOutcome(apiGetText('/api/bug-report'))
    win.dispatchEvent(new Event('pagehide'))
    await drainMicrotasks()
    expect(fetch).not.toHaveBeenCalled()
    expect(getFetchQueueStats()).toEqual({ inFlight: 0, queued: 1 })
    showPage()
    expect(await read).toEqual({ kind: 'resolved', value: 'report' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(getFetchQueueStats()).toEqual({ inFlight: 0, queued: 0 })
  })

  it('keeps a hidden document readable and sends writes with keepalive', async () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    vi.stubGlobal('document', doc)
    const { apiGet, apiPut } = await loadClient()
    const calls: Array<{ url: string; keepalive: boolean }> = []
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
      calls.push({ url, keepalive: init.keepalive ?? false })
      return Promise.resolve(new Response('{}'))
    }))
    doc.visibilityState = 'hidden'
    doc.dispatchEvent(new Event('visibilitychange'))
    expect((await Promise.all([
      readOutcome(apiGet('/api/hidden-read')),
      readOutcome(apiPut('/api/hidden-write', { saved: true })),
    ])).every(result => result.kind === 'resolved')).toBe(true)
    expect(calls).toEqual([{ url: '/api/hidden-write', keepalive: true }, { url: '/api/hidden-read', keepalive: false }])
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
    const gets = Array.from({ length: 8 }, (_, i) => readOutcome(apiGet(`/api/slow/${i}`)))
    expect(getFetchQueueStats().queued).toBeGreaterThan(0)
    hide()
    const put = apiPut('/api/config', { a: 1 })
    await Promise.resolve()
    const sent = calls.find((c) => c.url === '/api/config')
    expect(sent?.init.keepalive).toBe(true)
    await put
    hold = false
    held.forEach((r) => r())
    expect((await Promise.all(gets)).every(result => result.kind === 'resolved')).toBe(true)
  })

  // 2026-11-06, CI: the visit batch its timer sent behind a full pool sat in the queue when the
  // page reloaded, and JS stopped before the queue drained, so it never reached the server.
  for (const edge of ['pagehide', 'hide'] as const) {
    it(`flushes queued writes with keepalive at ${edge} while GETs wait`, async () => {
      const { apiGet, apiPost, getFetchQueueStats } = await loadClient()
      stubFetch(true)
      const gets = Array.from({ length: 8 }, (_, i) => readOutcome(apiGet(`/api/slow/${i}`)))
      const visits = readOutcome(apiPost('/api/page-visits', { keys: ['page:org'] }, { background: true, priority: 'low', keepalive: true }))
      const save = readOutcome(apiPost('/api/config', { a: 1 }))
      // A background POST that only reads keeps its queue contract.
      const listing = readOutcome(apiPost('/api/files/list-many', { paths: [] }, { background: true, readOnly: true }))
      await Promise.resolve()
      expect(calls.map((c) => c.url)).not.toContain('/api/page-visits')
      expect(calls.map((c) => c.url)).not.toContain('/api/config')
      if (edge === 'pagehide') win.dispatchEvent(new Event('pagehide'))
      else hide()
      for (let i = 0; i < 5; i++) await Promise.resolve()
      expect(calls.find((c) => c.url === '/api/page-visits')?.init.keepalive).toBe(true)
      expect(calls.find((c) => c.url === '/api/config')?.init.keepalive).toBe(true)
      expect(calls.filter((c) => c.url.startsWith('/api/slow/'))).toHaveLength(6)
      expect(calls.map((c) => c.url)).not.toContain('/api/files/list-many')
      expect(getFetchQueueStats().queued).toBe(3)
      if (edge === 'pagehide') showPage()
      expect((await Promise.all([visits, save])).map(result => result.kind)).toEqual(['resolved', 'resolved'])
      hold = false
      held.forEach((r) => r())
      const outcomes = await Promise.all([...gets, listing])
      expect(outcomes.every(result => result.kind === 'resolved')).toBe(true)
      expect(calls.filter((c) => c.url.startsWith('/api/slow/'))).toHaveLength(8)
      expect(getFetchQueueStats()).toEqual({ inFlight: 0, queued: 0 })
    })
  }

  it('sends pagehide writes with keepalive and resumes new GETs on pageshow', async () => {
    const { apiGet, apiPost } = await loadClient()
    stubFetch()
    win.dispatchEvent(new Event('pagehide'))
    await apiPost('/api/page-visits', { keys: ['page:org'] })
    const read = readOutcome(apiGet('/api/tasks'))
    await drainMicrotasks()
    expect(calls.map((c) => [c.url, c.init.keepalive ?? false])).toEqual([['/api/page-visits', true]])
    showPage()
    expect((await read).kind).toBe('resolved')
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
    const gets = Array.from({ length: 8 }, (_, i) => readOutcome(apiGet(`/api/slow/${i}`)))
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
    await put
    expect((await Promise.all(gets)).every(result => result.kind === 'resolved')).toBe(true)
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
