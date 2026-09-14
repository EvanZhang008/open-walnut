import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createPluginUpdatesController,
  PASSIVE_DEBOUNCE_MS,
  PASSIVE_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  POLL_MAX,
  RETRY_DELAY_MS,
  TRANSIENT_RECHECK_MS,
  type PluginUpdatesController,
  type WindowLike,
  type WsClientLike,
} from '../../web/src/hooks/pluginUpdatesController'
import type { PluginUpdatesResponse } from '../../web/src/components/settings/plugin-update-types'

// ---- fakes ---------------------------------------------------------------------------

function emitter() {
  const map = new Map<string, Set<() => void>>()
  return {
    addEventListener(type: string, cb: () => void) { (map.get(type) ?? map.set(type, new Set()).get(type)!).add(cb) },
    removeEventListener(type: string, cb: () => void) { map.get(type)?.delete(cb) },
    dispatch(type: string) { for (const cb of map.get(type) ?? []) cb() },
    count(type: string) { return map.get(type)?.size ?? 0 },
  }
}

function fakeWindow(onLine = true) {
  const win = emitter()
  const doc = emitter()
  return {
    ...win,
    document: { ...doc, visibilityState: 'visible' as string },
    navigator: { onLine },
  } as WindowLike & ReturnType<typeof emitter> & { document: ReturnType<typeof emitter> & { visibilityState: string }; navigator: { onLine: boolean } }
}

function fakeWs(): WsClientLike & { emit(state: string): void } {
  const cbs = new Set<(s: string) => void>()
  return {
    onConnectionChange: (cb) => { cbs.add(cb) },
    offConnectionChange: (cb) => { cbs.delete(cb) },
    emit: (s) => { for (const cb of cbs) cb(s) },
  }
}

type Reply = { status?: number; body?: unknown; delayMs?: number } | 'hang'
type Call = { url: string; method: string }

/** A counting fetch. Each reply is consumed in order; `hang` rejects only on abort. */
function fakeFetch(replies: Reply[] | ((call: Call, n: number) => Reply)) {
  const calls: Call[] = []
  const impl = ((input: string, init?: { signal?: AbortSignal; method?: string }) => {
    const call = { url: String(input), method: init?.method ?? 'GET' }
    calls.push(call)
    const reply = typeof replies === 'function' ? replies(call, calls.length) : (replies[calls.length - 1] ?? replies[replies.length - 1])
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      init?.signal?.addEventListener('abort', onAbort)
      if (reply === 'hang') return
      const send = () => {
        const status = reply.status ?? 200
        resolve({ status, ok: status >= 200 && status < 300, json: async () => reply.body ?? {} })
      }
      if (reply.delayMs) setTimeout(send, reply.delayMs)
      else send()
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const T0 = Date.parse('2026-09-13T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const MIN_INTERVAL = 10 * 60_000

function body(over: Partial<PluginUpdatesResponse> = {}): PluginUpdatesResponse {
  return {
    checkedAt: iso(T0 - 60_000),
    minIntervalMs: MIN_INTERVAL,
    refreshing: false,
    rows: {
      'linked:abc': { state: { kind: 'available', behind: 3 }, checkedAt: iso(T0 - 60_000) },
      'source:acme': { state: { kind: 'current' }, checkedAt: iso(T0 - 120_000) },
    },
    rowKeyOf: { 'acme-tracker': 'linked:abc', 'acme-notes': 'linked:abc', 'acme-mail': 'source:acme' },
    ...over,
  }
}

let ctl: PluginUpdatesController | null = null

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  // The controller logs through @/utils/log (console under the hood); keep the run quiet.
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  ctl?.stop()
  ctl = null
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms)

describe('passive GET: deadline, one silent retry, then error with rows kept (C61)', () => {
  it('a hung GET aborts at 10 s, retries once after 3 s, and only then sets error', async () => {
    const f = fakeFetch(['hang'])
    ctl = createPluginUpdatesController({ fetchImpl: f.impl, window: fakeWindow() })
    ctl.start()
    expect(f.calls.length).toBe(1)
    expect(f.calls[0].url).toBe('/api/plugin-updates')
    await tick(PASSIVE_TIMEOUT_MS)
    expect(ctl.getSnapshot().error).toBe(false)
    await tick(RETRY_DELAY_MS)
    expect(f.calls.length).toBe(2)
    expect(ctl.getSnapshot().error).toBe(false)
    await tick(PASSIVE_TIMEOUT_MS)
    expect(ctl.getSnapshot().error).toBe(true)
    expect(f.calls.length).toBe(2)
  })

  it('a 4 s response is not an error', async () => {
    const f = fakeFetch([{ body: body(), delayMs: 4000 }])
    ctl = createPluginUpdatesController({ fetchImpl: f.impl, window: fakeWindow() })
    ctl.start()
    await tick(4000)
    const s = ctl.getSnapshot()
    expect(s.loaded).toBe(true)
    expect(s.error).toBe(false)
    expect(Object.keys(s.rows)).toEqual(['linked:abc', 'source:acme'])
    expect(s.checkedAt).toBe(iso(T0 - 60_000))
    await tick(PASSIVE_TIMEOUT_MS + RETRY_DELAY_MS)
    expect(f.calls.length).toBe(1)
  })

  it('an HTTP 500 after a good load keeps the rows and flags error; retry() clears it', async () => {
    const f = fakeFetch([{ body: body() }, { status: 500 }, { body: body() }])
    ctl = createPluginUpdatesController({ fetchImpl: f.impl, window: fakeWindow() })
    ctl.start()
    await tick(0)
    ctl.retry()
    await tick(0)
    await tick(RETRY_DELAY_MS)
    expect(ctl.getSnapshot().error).toBe(true)
    expect(Object.keys(ctl.getSnapshot().rows).length).toBe(2)
    ctl.retry()
    await tick(0)
    expect(ctl.getSnapshot().error).toBe(false)
  })
})

describe('refreshing: poll every 2 s, at most 15 times, swap rows in place (C43)', () => {
  it('stops polling the moment the server says refreshing:false and installs the new rows', async () => {
    const stale = body({ refreshing: true })
    const fresh = body({ refreshing: false, checkedAt: iso(T0), rows: { 'linked:abc': { state: { kind: 'current' }, checkedAt: iso(T0) } } })
    const f = fakeFetch([{ body: stale }, { body: stale }, { body: fresh }])
    ctl = createPluginUpdatesController({ fetchImpl: f.impl, window: fakeWindow() })
    ctl.start()
    await tick(0)
    expect(ctl.getSnapshot().refreshing).toBe(true)
    expect(ctl.getSnapshot().rows['linked:abc'].state.kind).toBe('available')
    await tick(POLL_INTERVAL_MS)
    expect(f.calls.length).toBe(2)
    await tick(POLL_INTERVAL_MS)
    expect(f.calls.length).toBe(3)
    const s = ctl.getSnapshot()
    expect(s.refreshing).toBe(false)
    expect(s.rows['linked:abc'].state.kind).toBe('current')
    expect(s.checkedAt).toBe(iso(T0))
    await tick(POLL_INTERVAL_MS * 3)
    expect(f.calls.length).toBe(3)
  })

  it('after 15 polls still refreshing it gives up: error true, rows kept', async () => {
    const f = fakeFetch([{ body: body({ refreshing: true }) }])
    ctl = createPluginUpdatesController({ fetchImpl: f.impl, window: fakeWindow() })
    ctl.start()
    await tick(0)
    await tick(POLL_INTERVAL_MS * POLL_MAX)
    expect(f.calls.length).toBe(1 + POLL_MAX)
    await tick(POLL_INTERVAL_MS)
    expect(f.calls.length).toBe(1 + POLL_MAX)
    const s = ctl.getSnapshot()
    expect(s.error).toBe(true)
    expect(s.refreshing).toBe(false)
    expect(Object.keys(s.rows).length).toBe(2)
  })

  it('checkAll: every row busy checking, GET ?refresh=1, a 202 polls, busy clears when the batch ends', async () => {
    const done = body({ checkedAt: iso(T0) })
    const f = fakeFetch((call, n) => {
      if (n === 1) return { body: body() }
      if (call.url.includes('refresh=1')) return { status: 202, body: { refreshing: true, checkedAt: null } }
      return { body: done }
    })
    ctl = createPluginUpdatesController({ fetchImpl: f.impl, window: fakeWindow() })
    ctl.start()
    await tick(0)
    void ctl.checkAll()
    expect(ctl.getSnapshot().busy).toEqual({ 'linked:abc': 'checking', 'source:acme': 'checking' })
    expect(ctl.getSnapshot().refreshing).toBe(true)
    await tick(0)
    expect(f.calls[1].url).toBe('/api/plugin-updates?refresh=1')
    await tick(POLL_INTERVAL_MS)
    expect(f.calls.length).toBe(3)
    expect(f.calls[2].url).toBe('/api/plugin-updates')
    expect(ctl.getSnapshot().refreshing).toBe(false)
    expect(ctl.getSnapshot().busy).toEqual({})
    expect(ctl.getSnapshot().checkedAt).toBe(iso(T0))
  })

  it('two answers watching the same batch arm ONE poll; a settled batch leaves no trailing GET', async () => {
    // reload() (a source was just added) and a Check now 1 s later both hear `refreshing:
    // true`. Two poll timers used to fire two GETs, the second one AFTER the first had seen
    // the batch finish, so a read the user never asked for landed 2 s later.
    const inProgress = body({ refreshing: true })
    const done = body({ checkedAt: iso(T0), refreshing: false })
    let settled = false
    const f = fakeFetch((call) => {
      if (call.url.includes('refresh=1')) return { status: 202, body: { refreshing: true, checkedAt: null } }
      return { body: settled ? done : inProgress }
    })
    ctl = createPluginUpdatesController({ fetchImpl: f.impl, window: fakeWindow() })
    ctl.start()
    await tick(0)
    expect(f.calls.length).toBe(1)
    await tick(1_000)
    void ctl.checkAll()
    await tick(0)
    expect(f.calls.length).toBe(2)
    settled = true
    // The first poll (2 s after the checkAll answer) sees the batch finished.
    await tick(POLL_INTERVAL_MS)
    expect(f.calls.length).toBe(3)
    expect(ctl.getSnapshot().refreshing).toBe(false)
    // No second poll from the reload's timer: nothing else is requested for a long while.
    await tick(POLL_INTERVAL_MS * 3)
    expect(f.calls.length).toBe(3)
    expect(ctl.getSnapshot().busy).toEqual({})
  })
})

describe('offline and re-check triggers (C49, C60)', () => {
  it('offline: no request, offline:true; the online event sends exactly one GET', async () => {
    const win = fakeWindow(false)
    const f = fakeFetch([{ body: body() }])
    ctl = createPluginUpdatesController({ fetchImpl: f.impl, window: win })
    ctl.start()
    await tick(PASSIVE_TIMEOUT_MS)
    expect(f.calls.length).toBe(0)
    expect(ctl.getSnapshot().offline).toBe(true)
    win.navigator.onLine = true
    win.dispatch('online')
    await tick(0)
    expect(f.calls.length).toBe(1)
    expect(ctl.getSnapshot().offline).toBe(false)
    expect(ctl.getSnapshot().loaded).toBe(true)
  })

  it('checkAll does nothing while offline', async () => {
    const win = fakeWindow(false)
    const f = fakeFetch([{ body: body() }])
    ctl = createPluginUpdatesController({ fetchImpl: f.impl, window: win })
    ctl.start()
    await ctl.checkAll()
    expect(f.calls.length).toBe(0)
    expect(ctl.getSnapshot().busy).toEqual({})
  })

  it('visibilitychange, focus and WS reconnect re-GET only when the last check is older than minInterval (C60)', async () => {
    const win = fakeWindow()
    const ws = fakeWs()
    // The newest check is one minute old: well inside the 10-minute interval.
    const f = fakeFetch(() => ({ body: body() }))
    ctl = createPluginUpdatesController({ fetchImpl: f.impl, window: win, wsClient: ws })
    ctl.start()
    await tick(0)
    expect(f.calls.length).toBe(1)

    // Fresh: none of the three events asks again, however far apart they land.
    await tick(PASSIVE_DEBOUNCE_MS)
    win.document.dispatch('visibilitychange')
    await tick(PASSIVE_DEBOUNCE_MS)
    win.dispatch('focus')
    await tick(PASSIVE_DEBOUNCE_MS)
    ws.emit('disconnected')
    ws.emit('connected')
    await tick(0)
    expect(f.calls.length).toBe(1)

    // Older than the interval: each event is one GET, and focus + visibilitychange landing
    // together (a window switch) collapse into one.
    vi.setSystemTime(T0 + MIN_INTERVAL + 60_000)
    win.document.dispatch('visibilitychange')
    win.dispatch('focus')
    await tick(0)
    expect(f.calls.length).toBe(2)
    // The reply is the same one-minute-old body, so the check is STILL stale afterwards.
    await tick(PASSIVE_DEBOUNCE_MS)
    win.dispatch('focus')
    await tick(0)
    expect(f.calls.length).toBe(3)
    await tick(PASSIVE_DEBOUNCE_MS)
    ws.emit('disconnected')
    ws.emit('connected')
    await tick(0)
    expect(f.calls.length).toBe(4)
    // Staying connected is not a reconnect.
    await tick(PASSIVE_DEBOUNCE_MS)
    ws.emit('connected')
    await tick(0)
    expect(f.calls.length).toBe(4)

    // A hidden tab never fires, however old the check is.
    await tick(PASSIVE_DEBOUNCE_MS)
    win.document.visibilityState = 'hidden'
    win.document.dispatch('visibilitychange')
    await tick(0)
    expect(f.calls.length).toBe(4)
    win.document.visibilityState = 'visible'
    win.document.dispatch('visibilitychange')
    await tick(0)
    expect(f.calls.length).toBe(5)
    for (const call of f.calls) expect(call.url).toBe('/api/plugin-updates')
  })

  it('a fresh answer ends the re-GETs: once the server says "checked just now", focus stays silent for the interval (C60)', async () => {
    const win = fakeWindow()
    const stale = body({ checkedAt: iso(T0 - MIN_INTERVAL - 60_000), rows: { 'linked:abc': { state: { kind: 'current' }, checkedAt: iso(T0 - MIN_INTERVAL - 60_000) } } })
    const fresh = body({ checkedAt: iso(T0), rows: { 'linked:abc': { state: { kind: 'current' }, checkedAt: iso(T0) } } })
    const f = fakeFetch((_call, n) => ({ body: n === 1 ? stale : fresh }))
    ctl = createPluginUpdatesController({ fetchImpl: f.impl, window: win })
    ctl.start()
    await tick(0)
    expect(f.calls.length).toBe(1)
    await tick(PASSIVE_DEBOUNCE_MS)
    win.dispatch('focus')
    await tick(0)
    expect(f.calls.length).toBe(2)
    expect(ctl.getSnapshot().checkedAt).toBe(iso(T0))
    await tick(PASSIVE_DEBOUNCE_MS)
    win.dispatch('focus')
    win.document.dispatch('visibilitychange')
    await tick(0)
    expect(f.calls.length).toBe(2)
  })

  it('online always sends one GET, and a WS reconnect seconds later rides the same debounce (C49)', async () => {
    const win = fakeWindow(false)
    const ws = fakeWs()
    const f = fakeFetch(() => ({ body: body() }))
    ctl = createPluginUpdatesController({ fetchImpl: f.impl, window: win, wsClient: ws })
    ctl.start()
    expect(f.calls.length).toBe(0)
    win.navigator.onLine = true
    win.dispatch('online')
    await tick(0)
    expect(f.calls.length).toBe(1)
    // The socket comes back 2.5 s after the network: not a second GET.
    await tick(2_500)
    ws.emit('disconnected')
    ws.emit('connected')
    await tick(0)
    expect(f.calls.length).toBe(1)
    // A fresh check gates focus, but a second offline/online cycle still asks once.
    await tick(PASSIVE_DEBOUNCE_MS)
    win.dispatch('focus')
    await tick(0)
    expect(f.calls.length).toBe(1)
    win.dispatch('offline')
    expect(ctl.getSnapshot().offline).toBe(true)
    win.dispatch('online')
    await tick(0)
    expect(f.calls.length).toBe(2)
  })

  it('a doubled online event and a focus right after it produce ONE GET (N18)', async () => {
    const win = fakeWindow()
    const f = fakeFetch(() => ({ body: body() }))
    ctl = createPluginUpdatesController({ fetchImpl: f.impl, window: win })
    ctl.start()
    await tick(0)
    expect(f.calls.length).toBe(1)
    await tick(PASSIVE_DEBOUNCE_MS)
    win.dispatch('online')
    win.dispatch('online')
    win.dispatch('focus')
    await tick(8)
    win.dispatch('online')
    await tick(0)
    expect(f.calls.length).toBe(2)
    expect(ctl.getSnapshot().offline).toBe(false)
  })

  it('reload() sends one passive GET now and polls while the server is still checking the new row (N4)', async () => {
    const win = fakeWindow()
    const settled = body({ rows: { ...body().rows, 'source:new': { state: { kind: 'current' }, checkedAt: iso(T0) } } })
    const f = fakeFetch((_call, n) => {
      if (n === 1) return { body: body() }
      if (n === 2) return { body: { ...settled, refreshing: true, rows: { ...settled.rows, 'source:new': { state: { kind: 'unchecked' }, checkedAt: null } } } }
      return { body: settled }
    })
    ctl = createPluginUpdatesController({ fetchImpl: f.impl, window: win })
    ctl.start()
    await tick(0)
    expect(f.calls.length).toBe(1)
    ctl.reload()
    await tick(0)
    expect(f.calls.length).toBe(2)
    expect(ctl.getSnapshot().refreshing).toBe(true)
    expect(ctl.getSnapshot().rows['source:new']!.state.kind).toBe('unchecked')
    await tick(POLL_INTERVAL_MS)
    expect(f.calls.length).toBe(3)
    expect(ctl.getSnapshot().refreshing).toBe(false)
    expect(ctl.getSnapshot().rows['source:new']!.state.kind).toBe('current')
    // Not started (no consumer mounted): nothing is sent.
    ctl.stop()
    ctl.reload()
    await tick(0)
    expect(f.calls.length).toBe(3)
  })

  it('stop() removes every listener and cancels timers', async () => {
    const win = fakeWindow()
    const ws = fakeWs()
    const f = fakeFetch(['hang'])
    ctl = createPluginUpdatesController({ fetchImpl: f.impl, window: win, wsClient: ws })
    ctl.start()
    expect(win.count('focus')).toBe(1)
    expect(win.document.count('visibilitychange')).toBe(1)
    ctl.stop()
    expect(win.count('focus')).toBe(0)
    expect(win.count('online')).toBe(0)
    expect(win.document.count('visibilitychange')).toBe(0)
    await tick(PASSIVE_TIMEOUT_MS + RETRY_DELAY_MS)
    expect(f.calls.length).toBe(1)
    expect(ctl.getSnapshot().error).toBe(false)
  })
})

describe('busy record and single-row checks (C27, C57)', () => {
  it('busy is independent per rowKey', () => {
    ctl = createPluginUpdatesController({ fetchImpl: fakeFetch([{ body: body() }]).impl, window: fakeWindow() })
    ctl.setBusy('linked:abc', 'updating')
    ctl.setBusy('source:acme', 'checking')
    expect(ctl.getSnapshot().busy).toEqual({ 'linked:abc': 'updating', 'source:acme': 'checking' })
    ctl.setBusy('source:acme', null)
    expect(ctl.getSnapshot().busy).toEqual({ 'linked:abc': 'updating' })
    ctl.setBusy('linked:abc', null)
    expect(ctl.getSnapshot().busy).toEqual({})
  })

  it('checkRow POSTs the right route, merges state and bumps the header checkedAt', async () => {
    const T1 = iso(T0 + 5_000)
    const f = fakeFetch((call) => {
      if (call.method === 'POST') return { body: { behind: 0, ahead: 0, dirty: false, state: { kind: 'current' }, checkedAt: T1 } }
      return { body: body() }
    })
    ctl = createPluginUpdatesController({ fetchImpl: f.impl, window: fakeWindow() })
    ctl.start()
    await tick(0)
    const p = ctl.checkRow('linked:abc', { kind: 'linked', pluginId: 'acme-tracker' })
    expect(ctl.getSnapshot().busy).toEqual({ 'linked:abc': 'checking' })
    await p
    expect(f.calls[1]).toEqual({ url: '/api/plugin-runtime/acme-tracker/linked/check', method: 'POST' })
    const s = ctl.getSnapshot()
    expect(s.rows['linked:abc'].state).toEqual({ kind: 'current' })
    expect(s.rows['linked:abc'].checkedAt).toBe(T1)
    expect(s.rows['source:acme'].state.kind).toBe('current')
    expect(s.checkedAt).toBe(T1)
    expect(s.busy).toEqual({})

    await ctl.checkRow('source:acme', { kind: 'source', slug: 'acme' })
    expect(f.calls[2]).toEqual({ url: '/api/plugin-sources/acme/check', method: 'POST' })
    expect(f.calls.length).toBe(3)
  })

  it('a failed single-row check keeps the previous row and clears busy', async () => {
    const f = fakeFetch((call) => (call.method === 'POST' ? { status: 500, body: { error: 'boom' } } : { body: body() }))
    ctl = createPluginUpdatesController({ fetchImpl: f.impl, window: fakeWindow() })
    ctl.start()
    await tick(0)
    await ctl.checkRow('linked:abc', { kind: 'linked', pluginId: 'acme-tracker' })
    expect(ctl.getSnapshot().rows['linked:abc'].state).toEqual({ kind: 'available', behind: 3 })
    expect(ctl.getSnapshot().busy).toEqual({})
    expect(ctl.getSnapshot().error).toBe(false)
  })

  it('a failed single-row check keeps the last successful checkedAt for "Last checked", never stamping now (N17)', async () => {
    const f = fakeFetch((call) => (call.method === 'POST'
      ? { body: { state: { kind: 'unreachable', cause: 'network', lastKnown: 'available', reason: 'x', behind: 3 }, checkedAt: null } }
      : { body: body() }))
    ctl = createPluginUpdatesController({ fetchImpl: f.impl, window: fakeWindow() })
    ctl.start()
    await tick(0)
    const before = ctl.getSnapshot().rows['linked:abc'].checkedAt
    vi.setSystemTime(T0 + 5 * 60_000)
    await ctl.checkRow('linked:abc', { kind: 'linked', pluginId: 'acme-tracker' })
    const row = ctl.getSnapshot().rows['linked:abc']
    expect(row.state).toMatchObject({ kind: 'unreachable', behind: 3 })
    expect(row.checkedAt).toBe(before)
    expect(ctl.getSnapshot().checkedAt).toBe(before)
  })

  it('a second checkRow on a busy row is ignored (no second POST)', async () => {
    const f = fakeFetch((call) => (call.method === 'POST' ? 'hang' : { body: body() }))
    ctl = createPluginUpdatesController({ fetchImpl: f.impl, window: fakeWindow() })
    ctl.start()
    await tick(0)
    void ctl.checkRow('linked:abc', { kind: 'linked', pluginId: 'acme-tracker' })
    void ctl.checkRow('linked:abc', { kind: 'linked', pluginId: 'acme-notes' })
    await tick(0)
    expect(f.calls.filter((c) => c.method === 'POST').length).toBe(1)
  })

  it('a transient lock schedules exactly one automatic re-check 30 s later', async () => {
    let posts = 0
    const f = fakeFetch((call) => {
      if (call.method !== 'POST') return { body: body() }
      posts += 1
      return posts === 1
        ? { body: { state: { kind: 'available', behind: 3 }, checkedAt: iso(T0 - 60_000), transient: true } }
        : { body: { state: { kind: 'current' }, checkedAt: iso(T0 + TRANSIENT_RECHECK_MS) } }
    })
    ctl = createPluginUpdatesController({ fetchImpl: f.impl, window: fakeWindow() })
    ctl.start()
    await tick(0)
    await ctl.checkRow('linked:abc', { kind: 'linked', pluginId: 'acme-tracker' })
    expect(ctl.getSnapshot().rows['linked:abc'].transient).toBe(true)
    await tick(TRANSIENT_RECHECK_MS - 1)
    expect(posts).toBe(1)
    await tick(1)
    expect(posts).toBe(2)
    expect(ctl.getSnapshot().rows['linked:abc'].state.kind).toBe('current')
    expect(ctl.getSnapshot().rows['linked:abc'].transient).toBe(false)
    await tick(TRANSIENT_RECHECK_MS * 2)
    expect(posts).toBe(2)
  })

  it('applyRow replaces one row and moves the header time forward, never back', () => {
    ctl = createPluginUpdatesController({ fetchImpl: fakeFetch([{ body: body() }]).impl, window: fakeWindow() })
    ctl.applyRow('linked:abc', { state: { kind: 'current' }, checkedAt: iso(T0) })
    expect(ctl.getSnapshot().checkedAt).toBe(iso(T0))
    ctl.applyRow('source:acme', { state: { kind: 'current' }, checkedAt: iso(T0 - 60_000) })
    expect(ctl.getSnapshot().checkedAt).toBe(iso(T0))
    expect(Object.keys(ctl.getSnapshot().rows)).toEqual(['linked:abc', 'source:acme'])
  })
})
