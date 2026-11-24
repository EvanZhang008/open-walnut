/**
 * The main-thread tracer's lag sampler must tell a blocked thread from WebKit's
 * timer alignment, and say what happened in a block nothing traced explains.
 *
 * On the Mac app (WKWebView) a visually idle page gets its nested timers aligned to
 * 1s on one fixed phase per page load (WebKit's `alignedFireTime`: k * 1s plus one
 * random offset per process). 2026-11-23: 143 "main-thread block" reports in a day,
 * most while nobody used the window; the first ticks of each aligned run (a 250-650ms
 * one, then a ~900ms one, on the same phase mod 1000ms) were reported, because the
 * old filter absorbed only inside 700-1100ms and only from the 3rd in a row.
 *
 * Pinned here:
 *  1. the sampler re-arms from a message task (nesting level 0, so WebKit does not
 *     align it), and from the timer directly while hidden (browsers keep throttling);
 *  2. aligned wakeups are counted in "timers throttled", never reported: the first
 *     two ticks of a run (held one tick, then paired), a later single tick on the
 *     learned phase (any lateness), and a held timer released early;
 *  3. a block with a traced callback, a phase, or user input is reported even on the
 *     phase; a quiet block off the phase is reported one tick later, once;
 *  4. a block nothing traced explains carries draws, DOM mutations, focus, last input;
 *  5. a quiet wakeup later than one interval is never alignment; the phase outlives its
 *     run only while the window is unfocused and idle (plain timers, alignment expected);
 *     that idle mode drops the hop (battery), focus or input brings it back;
 *  6. a held block is reported and sent when the page goes away.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

const slow = vi.hoisted(() => ({ callbacks: [] as string[], beaconAt: [] as number[] }))
vi.mock('../../web/src/utils/browser-logger', () => ({
  beaconFlush: () => { slow.beaconAt.push(warnCount()) },
}))
vi.mock('../../web/src/utils/trace-dispatchers', () => ({
  installCallbackTracing: () => {},
  slowCallbacksSince: () => slow.callbacks,
}))

import { endPhase, initMainThreadTracer, startPhase } from '../../web/src/utils/main-thread-tracer'
import { countRender } from '../../web/src/utils/render-count'

const PHASE = 634 // the tab's alignment phase, ms mod 1000

// performance.now() only moves when a test says so. Monotonic across tests, so
// phases or input from an earlier test never fall inside a later block window.
let clock = 50_000
let warn: MockInstance<typeof console.warn>
function warnCount(): number { return warn.mock.calls.length }
let winListeners: Array<[string, () => void]>
let doc: { visibilityState: string; focused: boolean }
let mutationCallback: ((records: unknown[]) => void) | null

/** Let the next 100ms sample fire `lateBy` ms after it was due. */
function wake(lateBy: number): void {
  clock += 100 + lateBy
  vi.advanceTimersByTime(100)
}
/** Let the next sample fire at performance.now() === t. */
function wakeAt(t: number): void {
  expect(t).toBeGreaterThanOrEqual(clock + 100)
  clock = t
  vi.advanceTimersByTime(100)
}
/** On-time samples (each under 250ms late) until performance.now() === t. */
function onTimeUntil(t: number): void {
  while (clock + 100 + 200 < t) wake(200)
  wake(t - clock - 100)
}
/** The first time on PHASE at least `ms` from now. */
function phasePointAfter(ms: number): number {
  const t = clock + ms
  return t + ((((PHASE - t) % 1000) + 1000) % 1000)
}
/** An aligned run: the first tick `firstLate` ms late, the rest a second apart. */
function alignedRun(firstLate: number, ticks: number, jitter: number[] = []): number {
  const t0 = phasePointAfter(2000)
  onTimeUntil(t0 - 100 - firstLate)
  for (let i = 0; i < ticks; i++) wakeAt(t0 + i * 1000 + (jitter[i] ?? 0))
  return t0
}

const lines = () => warn.mock.calls.map((call) => String(call[0]))
const blocks = () => warn.mock.calls.filter((call) => call[0] === '[perf] main-thread block').map((call) => call[1] as Record<string, unknown>)
const dataOf = (line: string) => warn.mock.calls.filter((call) => call[0] === line).map((call) => call[1] as Record<string, unknown>)

function stubPage(extraWindow: Record<string, unknown> = {}): void {
  winListeners = []
  doc = { visibilityState: 'visible', focused: true }
  mutationCallback = null
  vi.stubGlobal('window', {
    location: { pathname: '/org' },
    addEventListener: (type: string, fn: () => void) => { winListeners.push([type, fn]) },
    ...extraWindow,
  })
  vi.stubGlobal('document', {
    get visibilityState() { return doc.visibilityState },
    addEventListener: () => {},
    hasFocus: () => doc.focused,
    documentElement: {},
  })
  vi.stubGlobal('MutationObserver', class {
    constructor(cb: (records: unknown[]) => void) { mutationCallback = cb }
    observe() {}
  })
}

beforeEach(() => {
  clock += 10_000
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  slow.callbacks = []
  slow.beaconAt = []
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const fire = (type: string) => winListeners.filter(([t]) => t === type).forEach(([, fn]) => fn())

/** A MessageChannel whose messages the test delivers by hand. */
function fakeChannel(posted: Array<() => void>) {
  return class {
    port1: { onmessage: (() => void) | null } = { onmessage: null }
    port2 = { postMessage: () => { posted.push(() => this.port1.onmessage?.()) } }
  }
}

describe('main-thread tracer: the sampler is armed outside timer nesting', () => {
  it('re-arms from a message task while visible, and from the timer while hidden', () => {
    const posted: Array<() => void> = []
    stubPage({ MessageChannel: fakeChannel(posted) })
    initMainThreadTracer()

    // No timer is armed from the init or a timer callback: only the message arms it.
    expect(vi.getTimerCount()).toBe(0)
    posted.shift()!()
    expect(vi.getTimerCount()).toBe(1)
    wake(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(posted).toHaveLength(1)

    // A block that delays the hop itself still counts: lateness runs from the post.
    clock += 400
    posted.shift()!()
    wake(0)
    expect(blocks()).toHaveLength(0) // quiet: held one tick
    posted.shift()!()
    wake(0)
    expect(blocks().map((b) => b.blockedMs)).toEqual([400])

    doc.visibilityState = 'hidden'
    posted.shift()!()
    wake(0)
    expect(posted).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('an unfocused window with no input for 30s gets plain timers; focus or input brings the hop back', () => {
    const posted: Array<() => void> = []
    stubPage({ MessageChannel: fakeChannel(posted) })
    initMainThreadTracer()
    fire('keydown')
    const step = () => { if (posted.length) posted.shift()!(); wake(0) }
    doc.focused = false
    for (let i = 0; i < 100; i++) step() // 10s since the input: still the hop
    expect(posted).toHaveLength(1)
    for (let i = 0; i < 250; i++) step() // 35s
    expect(posted).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(1)

    doc.focused = true
    step()
    expect(posted).toHaveLength(1)
    doc.focused = false
    step()
    expect(posted).toHaveLength(0) // still idle: no input for 35s
    fire('pointerdown')
    step()
    expect(posted).toHaveLength(1)
  })
})

describe('main-thread tracer: WebKit timer alignment is not a block', () => {
  beforeEach(() => { stubPage(); initMainThreadTracer() })

  it('absorbs the first ticks of every aligned run on the tab phase (300 then 900, a single 400, a single 900)', () => {
    // An unfocused, idle window: plain timers, alignment expected, the phase outlives a run.
    doc.focused = false
    onTimeUntil(clock + 31_000)
    // First run of the page, no phase known yet: the 300ms tick is held, the 900ms one pairs it.
    alignedRun(300, 2)
    wake(0)
    expect(blocks()).toEqual([])
    expect(dataOf('[perf] timers throttled (page idle)')).toEqual([
      expect.objectContaining({ count: 2, totalMs: 1200, phaseMs: PHASE }),
    ])
    expect(dataOf('[perf] timers throttled ended')).toEqual([{ count: 2, totalMs: 1200 }])

    // A minute later the phase is known: one tick on it is alignment at any lateness.
    alignedRun(400, 1)
    wake(0)
    alignedRun(900, 1)
    wake(0)
    // A long run with a few ms of dispatch jitter.
    alignedRun(650, 8, [3, 1, 4, 1, 5, 9, 2, 6])
    wake(0)
    expect(blocks()).toEqual([])
    expect(dataOf('[perf] timers throttled ended').map((d) => d.count)).toEqual([2, 1, 1, 8])
  })

  it('absorbs a held timer released early when alignment switches off', () => {
    const t0 = alignedRun(300, 2)
    wakeAt(t0 + 1000 + 705) // due at the next aligned point, fired 605ms late
    wake(0)
    expect(blocks()).toEqual([])
    expect(dataOf('[perf] timers throttled ended')).toEqual([{ count: 3, totalMs: 300 + 900 + 605 }])
  })

  it('reports a block on the phase that carries a traced callback, a phase, or user input', () => {
    alignedRun(300, 2)
    wake(0)
    expect(blocks()).toEqual([])

    slow.callbacks = ['port:onmessage performWork (380ms)']
    alignedRun(400, 1)
    slow.callbacks = []
    startPhase('board-render')
    alignedRun(500, 1)
    endPhase('board-render')
    const t = phasePointAfter(2000)
    onTimeUntil(t - 100 - 400 - 500)
    winListeners.find(([type]) => type === 'keydown')![1]()
    onTimeUntil(t - 500)
    wakeAt(t)

    expect(blocks().map((b) => b.blockedMs)).toEqual([400, 500, 400])
    expect(blocks()[0].slowCallbacks).toEqual(['port:onmessage performWork (380ms)'])
    expect(blocks()[1].activePhases).toEqual([expect.stringMatching(/^board-render\(/)])
    expect(blocks()[2].sinceInputMs).toBe(1000)
  })

  it('reports a quiet block off the phase once, one tick later, with its own lateness', () => {
    alignedRun(300, 2)
    wake(0)
    const t = phasePointAfter(2000) + 300 // 300ms off the phase
    onTimeUntil(t - 500)
    wakeAt(t)
    expect(blocks()).toEqual([])
    wake(0)
    expect(blocks()).toEqual([expect.objectContaining({ blockedMs: 400, sincePageLoadMs: t })])
    wake(0)
    expect(blocks()).toHaveLength(1)
  })

  it('never absorbs a quiet wakeup later than one interval, on the phase or paired', () => {
    doc.focused = false
    onTimeUntil(clock + 31_000)
    alignedRun(300, 2) // learns the phase
    wake(0)
    alignedRun(5000, 1) // a 5s block that ends on the phase
    wake(0)
    expect(blocks().map((b) => b.blockedMs)).toEqual([5000])

    // A 1500ms one followed one interval later by a 900ms one: no pair.
    onTimeUntil(clock + 2000)
    wake(1500)
    wake(900)
    wake(0)
    expect(blocks().map((b) => b.blockedMs)).toEqual([5000, 1500, 900])
  })

  it('forgets the phase when a run ends while the window is in use', () => {
    alignedRun(300, 2)
    wake(0)
    expect(blocks()).toEqual([])
    alignedRun(400, 1) // on the old phase, but that run ended: held, then reported
    wake(0)
    expect(blocks().map((b) => b.blockedMs)).toEqual([400])
  })

  it('reports a held block and sends it when the page goes away', () => {
    wake(0)
    wake(400)
    expect(blocks()).toEqual([])
    fire('pagehide')
    expect(blocks().map((b) => b.blockedMs)).toEqual([400])
    expect(slow.beaconAt).toEqual([warnCount()]) // the send came after the report
  })

  it('reports quiet blocks that are neither on a learned phase nor paired one second apart', () => {
    wake(900) // in the old 700-1100 band, but alone and no phase is known yet
    wake(0)
    wake(1800)
    wake(400) // 500ms after the 1800 one: not one interval
    wake(0)
    expect(blocks().map((b) => b.blockedMs)).toEqual([900, 1800, 400])
    // Two quiet wakes exactly one second apart are alignment by shape.
    wake(900)
    wake(900)
    wake(0)
    expect(blocks()).toHaveLength(3)
  })

  it('a traced block during a run ends it and is reported at once', () => {
    alignedRun(300, 5)
    const before = lines().length
    slow.callbacks = ['ws:onmessage onMessage (910ms)']
    wake(960)
    slow.callbacks = []
    expect(lines().slice(before)).toEqual(['[perf] timers throttled ended', '[perf] main-thread block'])
    expect(dataOf('[perf] timers throttled ended')[0]).toEqual({ count: 5, totalMs: 300 + 4 * 900 })
    expect(blocks().at(-1)).toMatchObject({ blockedMs: 960, slowCallbacks: ['ws:onmessage onMessage (910ms)'] })
    expect(blocks().at(-1)).not.toHaveProperty('draws')
  })
})

describe('main-thread tracer: what an untraced block carries', () => {
  beforeEach(() => { stubPage(); initMainThreadTracer() })

  it('names the components that drew, the DOM mutations and the focus of its window only', () => {
    wake(0)
    countRender('MainPage') // before the block's window: not counted for it
    mutationCallback!(Array(5))
    wake(0)

    countRender('SessionChatHistory')
    countRender('TodoPanel')
    countRender('SessionChatHistory')
    countRender('SessionPanelBody')
    countRender('SessionChatHistory')
    countRender('SessionPanelBody')
    countRender('DraftSessionPanel')
    mutationCallback!(Array(42))
    doc.focused = false
    wake(430)
    wake(0)

    expect(blocks()).toEqual([expect.objectContaining({
      blockedMs: 430,
      draws: 'SessionChatHistory:3 SessionPanelBody:2 TodoPanel:1',
      domMutations: 42,
      focused: false,
      url: '/org',
    })])
    // Small: only a handful of fields carry a value.
    expect(Object.values(blocks()[0]).filter((v) => v !== undefined).length).toBeLessThanOrEqual(7)
  })

  it('says how long since the last input, and nothing about draws when none came', () => {
    wake(0)
    winListeners.find(([type]) => type === 'pointerdown')![1]()
    onTimeUntil(clock + 3000) // input long before the window: the block is still quiet
    wake(300)
    wake(0)
    expect(blocks()).toEqual([expect.objectContaining({ blockedMs: 300, draws: undefined, domMutations: 0, focused: true })])
    expect(blocks()[0].sinceInputMs).toBeGreaterThan(3000)
  })
})
