/**
 * Every deadline in the page runs on the page's own timers (web/src/utils/deadline-signal.ts),
 * never AbortSignal.timeout (2026-11-22, live in the Mac app's WKWebView: AbortSignal.timeout
 * fired far later than a plain timer. Reads with a 15 s deadline held the page's connections
 * 111 s while the 20 s queue timers of the reads behind them fired on time, so those were
 * rejected: 133 "rejected in the page" in one hour; a 2 s deadline ended after 44 s).
 *
 * The class: every deadline the page sets. A new AbortSignal.timeout anywhere in web/src fails
 * the source check; the behaviour check runs the page's client with an AbortSignal.timeout that
 * never fires (as WebKit's did), and a stuck request must still give up its connection on time.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiGet, getFetchQueueStats, SHARED_FETCH_SLOTS } from '../../web/src/api/client'
import { deadlineSignal } from '../../web/src/utils/deadline-signal'

const WEB_SRC = path.resolve(__dirname, '../../web/src')

/** Code only: line and block comments are blanked out. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('the page sets every deadline with deadlineSignal', () => {
  it('no AbortSignal.timeout in web/src', () => {
    const found: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p) }
        else if (/\.(tsx?|jsx?|mjs)$/.test(e.name) && /AbortSignal\s*\.\s*timeout/.test(code(fs.readFileSync(p, 'utf8')))) found.push(path.relative(WEB_SRC, p))
      }
    }
    walk(WEB_SRC)
    expect(found).toEqual([])
  })
})

describe('deadlineSignal', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('aborts at its time with a TimeoutError reason, as AbortSignal.timeout does', async () => {
    const s = deadlineSignal(1_000)
    await vi.advanceTimersByTimeAsync(999)
    expect(s.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(s.aborted).toBe(true)
    expect((s.reason as DOMException).name).toBe('TimeoutError')
  })
})

describe('a request stuck on the network gives up its connection at its own deadline', () => {
  type Pending = { url: string; resolve: (r: Response) => void }
  let pending: Pending[]
  beforeEach(() => {
    vi.useFakeTimers()
    pending = []
    // WebKit's late AbortSignal.timeout, at its worst: it never fires.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => new AbortController().signal)
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      pending.push({ url, resolve })
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Fetch is aborted', 'AbortError')), { once: true })
    })))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(async () => {
    for (const p of pending.splice(0)) p.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    await vi.advanceTimersByTimeAsync(0)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('every connection held by a read that never answers: the read behind them is sent, never rejected in the queue', async () => {
    const stuck = Array.from({ length: SHARED_FETCH_SLOTS }, (_, i) => apiGet(`/api/stuck${i}`).catch((e: Error) => e.name))
    await vi.advanceTimersByTimeAsync(0)
    const behind = apiGet<{ ok: boolean }>('/api/behind').catch((e: Error) => e.name)
    await vi.advanceTimersByTimeAsync(0)
    expect(getFetchQueueStats().queued).toBe(1)
    // Their 15 s deadline, well before the 20 s the read behind them may wait.
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await Promise.all(stuck)).toEqual(Array(SHARED_FETCH_SLOTS).fill('TimeoutError'))
    const sent = pending.find((p) => p.url === '/api/behind')
    expect(sent, 'the read behind the stuck ones went out').toBeDefined()
    sent!.resolve(new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    expect(await behind).toEqual({ ok: true })
    const rejected = vi.mocked(console.error).mock.calls.filter((c) => String(c[0]).includes('in the connection queue'))
    expect(rejected).toEqual([])
  })
})
