/**
 * Identical reads take turns (web/src/api/same-read-turn.ts, wired in web/src/api/client.ts):
 * the page never has the same GET in flight twice, so one URL never holds more than one of its
 * connections (2026-11-22, live: four copies of one session's permission-decisions held the
 * page's connections 60 to 137 s and every other request was rejected in the queue; the day
 * before, a lead's Threads read 2 to 4 at a time). This is the class guard for every caller,
 * present and future: it goes through apiGet, the one way the page reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiGet, apiPost, getFetchQueueStats, SHARED_FETCH_SLOTS } from '../../web/src/api/client'
import { sameReadLines } from '../../web/src/api/same-read-turn'

type Pending = { url: string; method: string; resolve: (r: Response) => void; reject: (e: unknown) => void }
let pending: Pending[]
let inFlightByUrl: Map<string, number>
let maxByUrl: Map<string, number>

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const settle = () => vi.advanceTimersByTimeAsync(0)
async function answer(url: string, body: unknown = { ok: url }) {
  const i = pending.findIndex((p) => p.url === url)
  expect(i, `a request to ${url} is out`).toBeGreaterThanOrEqual(0)
  pending.splice(i, 1)[0].resolve(json(body))
  await settle()
}

beforeEach(() => {
  vi.useFakeTimers()
  pending = []
  inFlightByUrl = new Map()
  maxByUrl = new Map()
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const n = (inFlightByUrl.get(url) ?? 0) + 1
    inFlightByUrl.set(url, n)
    maxByUrl.set(url, Math.max(maxByUrl.get(url) ?? 0, n))
    const done = () => inFlightByUrl.set(url, (inFlightByUrl.get(url) ?? 1) - 1)
    const entry: Pending = { url, method: init?.method ?? 'GET', resolve: (r) => { done(); resolve(r) }, reject: (e) => { done(); reject(e) } }
    pending.push(entry)
    init?.signal?.addEventListener('abort', () => {
      const at = pending.findIndex((p) => p.reject === entry.reject)
      if (at >= 0) pending.splice(at, 1)
      done(); reject(init.signal!.reason ?? new DOMException('aborted', 'AbortError'))
    }, { once: true })
  })))
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(async () => {
  for (const p of pending.splice(0)) p.resolve(json({}))
  await settle()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('identical GETs take turns', () => {
  it('copies of one read in flight become one read after it; another URL is not held up', async () => {
    const url = '/api/sessions/s-1/permission-decisions'
    const reads = [apiGet<{ n: number }>(url).then((r) => r.n, (e) => e)]
    const other = apiGet('/api/other')
    await settle()
    // Asked again and again while the first is on the wire.
    for (let i = 0; i < 3; i++) reads.push(apiGet<{ n: number }>(url).then((r) => r.n, (e) => e))
    await settle()
    expect(pending.map((p) => p.url).sort()).toEqual(['/api/other', url])
    await answer('/api/other')
    await expect(other).resolves.toEqual({ ok: '/api/other' })
    // The first went; the second waits for it and the other two join the second (it starts after the first ended).
    expect(sameReadLines()[url]).toBe(2)
    await answer(url, { n: 1 })
    expect(pending.filter((p) => p.url === url)).toHaveLength(1)
    await answer(url, { n: 2 })
    expect(await Promise.all(reads)).toEqual([1, 2, 2, 2])
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(maxByUrl.get(url)).toBe(1)
    expect(sameReadLines()[url]).toBeUndefined()
    expect(getFetchQueueStats()).toEqual({ inFlight: 0, queued: 0 })
  })

  it('callers asking in the same moment share one request', async () => {
    const url = '/api/tasks/groups'
    const reads = Array.from({ length: 3 }, () => apiGet<{ n: number }>(url))
    await settle()
    await answer(url, { n: 7 })
    expect((await Promise.all(reads)).map((r) => r.n)).toEqual([7, 7, 7])
    expect(vi.mocked(fetch).mock.calls.filter((c) => c[0] === url)).toHaveLength(1)
  })

  it('a read still waiting for a connection is joined: one request, each caller its own copy', async () => {
    const blockers = Array.from({ length: SHARED_FETCH_SLOTS }, (_, i) => apiGet(`/api/block${i}`))
    const url = '/api/config'
    const sent: string[] = []
    const a = apiGet<{ list: number[] }>(url, undefined, { onDispatch: () => sent.push('a') })
    const b = apiGet<{ list: number[] }>(url, undefined, { onDispatch: () => sent.push('b') })
    await settle()
    expect(pending.filter((p) => p.url === url)).toHaveLength(0)
    expect(sent).toEqual([])
    await answer('/api/block0')
    // The one who joined hears that the shared read left the queue, as with its own (shared-read.ts markSent).
    expect(sent).toEqual(['a', 'b'])
    await answer(url, { list: [1] })
    const [ra, rb] = await Promise.all([a, b])
    expect(ra).toEqual({ list: [1] })
    expect(rb).toEqual({ list: [1] })
    expect(ra).not.toBe(rb)
    expect(vi.mocked(fetch).mock.calls.filter((c) => c[0] === url)).toHaveLength(1)
    for (let i = 1; i < SHARED_FETCH_SLOTS; i++) await answer(`/api/block${i}`)
    await Promise.all(blockers)
  })

  it('a read of a higher lane never waits behind a lower one', async () => {
    const url = '/api/sessions/s-5/history'
    const low = apiGet(url, undefined, { priority: 'low' })
    const now = apiGet(url, undefined, { priority: 'interactive' })
    await settle()
    expect(pending.filter((p) => p.url === url)).toHaveLength(2)
    await answer(url); await answer(url)
    await Promise.all([low, now])
  })

  it('a read claiming the kept connection never joins or waits behind a normal one', async () => {
    const url = '/api/sessions/s-7'
    const normal = apiGet(url)
    const claim = apiGet(url, undefined, { lane: { interactive: true } })
    await settle()
    expect(pending.filter((p) => p.url === url)).toHaveLength(2)
    await answer(url); await answer(url)
    await Promise.all([normal, claim])
  })

  it('copies behind a cancellable waiter still join one read, not a line', async () => {
    const url = '/api/sessions/s-8/record'
    const first = apiGet<{ n: number }>(url)
    await settle()
    const ctrl = new AbortController()
    const cancellable = apiGet<{ n: number }>(url, undefined, { signal: ctrl.signal })
    const copies = [apiGet<{ n: number }>(url), apiGet<{ n: number }>(url)]
    await settle()
    await answer(url, { n: 1 })
    await answer(url, { n: 2 })
    await expect(first).resolves.toEqual({ n: 1 })
    await expect(cancellable).resolves.toEqual({ n: 2 })
    // The copies wait as ONE next read after it: one request for both, never one by one.
    expect(pending.filter((p) => p.url === url)).toHaveLength(1)
    await answer(url, { n: 3 })
    expect((await Promise.all(copies)).map((r) => r.n)).toEqual([3, 3])
    expect(vi.mocked(fetch).mock.calls.filter((c) => c[0] === url)).toHaveLength(3)
  })

  it('a resend for an empty body stays in its turn: no deadlock, the read behind it goes after', async () => {
    const url = '/api/sessions/s-6'
    const first = apiGet<{ n: number }>(url)
    await settle()
    const second = apiGet<{ n: number }>(url)
    await settle()
    const i = pending.findIndex((p) => p.url === url)
    pending.splice(i, 1)[0].resolve(new Response('', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    await settle()
    // The cache-bypass resend of the first, alone on the wire.
    expect(pending.filter((p) => p.url === url)).toHaveLength(1)
    await answer(url, { n: 1 })
    await expect(first).resolves.toEqual({ n: 1 })
    await answer(url, { n: 2 })
    await expect(second).resolves.toEqual({ n: 2 })
    expect(maxByUrl.get(url)).toBe(1)
  })

  it('a read that fails or times out hands the turn on', async () => {
    const url = '/api/v1/tasks/lead/threads'
    const first = apiGet(url, undefined, { timeoutMs: 5_000 }).catch((e: DOMException) => e.name)
    await settle()
    const second = apiGet(url).catch((e: DOMException) => e.name)
    await settle()
    expect(pending).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await first).toBe('TimeoutError')
    expect(pending.filter((p) => p.url === url)).toHaveLength(1)
    await answer(url)
    await expect(second).resolves.toEqual({ ok: url })
  })

  it('a read waiting behind a stuck one gives up at its own queue deadline, logged with what holds the connections', async () => {
    const url = '/api/sessions/s-2/supervision'
    const warns = vi.mocked(console.warn)
    const errors = vi.mocked(console.error)
    const stuck = apiGet(url, undefined, { timeoutMs: 120_000 }).catch((e: DOMException) => e.name)
    await settle()
    const behind = apiGet(url).catch((e: DOMException) => e.name)
    await settle()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await behind).toBe('TimeoutError')
    // A warning, never a page error: the read on its way answers, or reports its own failure.
    expect(errors.mock.calls.some((c) => String(c[0]).includes(url))).toBe(false)
    const line = warns.mock.calls.find((c) => String(c[0]).includes('waiting for the same read in flight'))
    expect(String(line?.[0])).toBe(`[api] GET ${url} gave up after 20000ms waiting for the same read in flight`)
    expect((line?.[1] as { holding: string[] }).holding[0]).toMatch(new RegExp(`^GET ${url} 2000\\dms$`))
    // The one that gave up never took a turn: the stuck one still holds it, and the next read waits for it.
    expect(sameReadLines()[url]).toBe(1)
    await answer(url)
    await expect(stuck).resolves.toEqual({ ok: url })
    expect(sameReadLines()[url]).toBeUndefined()
  })

  it('a waiting read the caller aborts leaves the line without a trace', async () => {
    const url = '/api/sessions/s-3/slash-commands'
    const first = apiGet(url)
    await settle()
    const ctrl = new AbortController()
    const second = apiGet(url, undefined, { signal: ctrl.signal }).catch((e: DOMException) => e.name)
    const third = apiGet(url)
    await settle()
    ctrl.abort()
    expect(await second).toBe('AbortError')
    await answer(url, { n: 1 })
    await expect(first).resolves.toEqual({ n: 1 })
    await answer(url, { n: 3 })
    await expect(third).resolves.toEqual({ n: 3 })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('a long poll or a stream is never held behind another', async () => {
    for (const url of ['/api/v1/jobs/j-1?wait_ms=30000', '/api/sessions/s-4/events']) {
      const a = apiGet(url, undefined, { timeoutMs: 60_000 })
      const b = apiGet(url, undefined, { timeoutMs: 60_000 })
      await settle()
      expect(pending.filter((p) => p.url === url)).toHaveLength(2)
      await answer(url); await answer(url)
      await Promise.all([a, b])
    }
  })

  it('writes are never held behind each other', async () => {
    const a = apiPost('/api/same', { a: 1 })
    const b = apiPost('/api/same', { b: 2 })
    await settle()
    expect(pending.filter((p) => p.url === '/api/same')).toHaveLength(2)
    pending.splice(0).forEach((p) => p.resolve(json({})))
    await Promise.all([a, b])
  })
})
