/**
 * The main-thread tracer's lag sampler must tell a blocked thread from WebKit's
 * timer alignment.
 *
 * On the Mac app (WKWebView) a visually idle page gets its timers aligned to 1s,
 * so the 100ms sampler wakes ~900ms late with nothing running. The log showed
 * ~49 "main-thread block" lines a minute for hours, all in that band, while the
 * reports that carried a slow callback were genuine (2026-09-29).
 *
 * Pinned here:
 *  1. genuine blocks (a slow callback, an active phase, a lateness outside the
 *     band) are reported exactly as before;
 *  2. three idle-aligned wakeups in a row enter a "timers throttled" state with
 *     ONE line, and further aligned wakeups are counted, not reported;
 *  3. a real block inside that state is reported and ends it, and an on-time
 *     wakeup ends it too; each end logs one summary with count and total ms.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

const slow = vi.hoisted(() => ({ callbacks: [] as string[] }))
vi.mock('../../web/src/utils/trace-dispatchers', () => ({
  installCallbackTracing: () => {},
  slowCallbacksSince: () => slow.callbacks,
}))

import { endPhase, initMainThreadTracer, startPhase } from '../../web/src/utils/main-thread-tracer'

// performance.now() only moves when a test says so. Monotonic across tests, so
// phases ended in an earlier test never fall inside a later block window.
let clock = 50_000
let warn: MockInstance<typeof console.warn>

/** Let the next 100ms sample fire `lateBy` ms after it was due. */
function wake(lateBy: number): void {
  clock += 100 + lateBy
  vi.advanceTimersByTime(100)
}

const lines = () => warn.mock.calls.map((call) => String(call[0]))
const dataOf = (line: string) => warn.mock.calls.filter((call) => call[0] === line).map((call) => call[1] as Record<string, unknown>)

beforeEach(() => {
  // A fresh visible page, no slow callbacks, no phases, no lines yet.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  vi.stubGlobal('window', { location: { pathname: '/' } })
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => {} })
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  slow.callbacks = []
  initMainThreadTracer()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('main-thread tracer: genuine blocks', () => {
  it('reports a late wakeup that carries a slow callback, an active phase, or an out-of-band delay', () => {
    slow.callbacks = ['timeout(0) heavyParse (870ms)']
    wake(900)
    slow.callbacks = []
    startPhase('react-mount')
    wake(950)
    endPhase('react-mount')
    // An idle wakeup far outside the 1s alignment band is not alignment.
    wake(1800)
    wake(400)

    expect(lines()).toEqual(Array(4).fill('[perf] main-thread block'))
    const reports = dataOf('[perf] main-thread block')
    expect(reports.map((r) => r.blockedMs)).toEqual([900, 950, 1800, 400])
    expect(reports[0].slowCallbacks).toEqual(['timeout(0) heavyParse (870ms)'])
    expect(reports[1].activePhases).toEqual([expect.stringMatching(/^react-mount\(/)])
  })

  it('reports aligned-looking wakeups that are not three in a row', () => {
    wake(900)
    wake(900)
    wake(0) // on time: the run is broken
    wake(900)
    wake(900)
    expect(lines()).toEqual(Array(4).fill('[perf] main-thread block'))
  })
})

describe('main-thread tracer: throttled timers on an idle page', () => {
  it('three idle-aligned wakeups enter the throttled state with ONE line; later ones are counted', () => {
    wake(900)
    wake(880)
    wake(920)
    expect(lines()).toEqual([
      '[perf] main-thread block',
      '[perf] main-thread block',
      '[perf] timers throttled (page idle)',
    ])
    expect(dataOf('[perf] timers throttled (page idle)')[0]).toMatchObject({ count: 3, totalMs: 2700 })

    // A minute of idle alignment: nothing more is logged.
    for (let i = 0; i < 60; i++) wake(i % 2 ? 750 : 1050)
    expect(lines()).toHaveLength(3)

    // An on-time wakeup ends it with one summary.
    wake(10)
    expect(lines()).toHaveLength(4)
    expect(lines()[3]).toBe('[perf] timers throttled ended')
    expect(dataOf('[perf] timers throttled ended')[0]).toEqual({ count: 63, totalMs: 2700 + 30 * 750 + 30 * 1050 })
  })

  it('a real block inside the throttled state is reported and ends the state', () => {
    wake(900)
    wake(900)
    wake(900)
    wake(900)
    wake(900)
    expect(lines().filter((l) => l === '[perf] timers throttled (page idle)')).toHaveLength(1)
    const before = lines().length

    slow.callbacks = ['ws:onmessage onMessage (910ms)']
    wake(960)
    slow.callbacks = []

    expect(lines().slice(before)).toEqual(['[perf] timers throttled ended', '[perf] main-thread block'])
    expect(dataOf('[perf] timers throttled ended')[0]).toEqual({ count: 5, totalMs: 4500 })
    expect(dataOf('[perf] main-thread block').at(-1)).toMatchObject({
      blockedMs: 960, slowCallbacks: ['ws:onmessage onMessage (910ms)'],
    })

    // The state was left: aligned wakeups report again until three in a row.
    wake(900)
    wake(900)
    expect(lines().slice(before + 2)).toEqual(['[perf] main-thread block', '[perf] main-thread block'])
    wake(900)
    expect(lines().at(-1)).toBe('[perf] timers throttled (page idle)')
  })

  it('an active phase during the throttled state also ends it and is reported', () => {
    wake(900)
    wake(900)
    wake(900)
    const before = lines().length
    startPhase('board-render')
    wake(1000)
    endPhase('board-render')
    expect(lines().slice(before)).toEqual(['[perf] timers throttled ended', '[perf] main-thread block'])
    expect(dataOf('[perf] main-thread block').at(-1)?.activePhases).toEqual([expect.stringMatching(/^board-render\(/)])
  })
})
