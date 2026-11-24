/**
 * The shared minute clock (web/src/utils/minute-clock.ts) and structural sharing
 * (web/src/utils/keep-equal.ts), the two pieces that keep a minute and a task update from
 * drawing whole pages (2026-11-23, task 9bceb9f2; browser guard:
 * tests/e2e/browser/org-home-redraw-budget.spec.ts).
 *
 *  - the clock fires on the wall minute, runs only while subscribed, and sleeps while hidden;
 *  - useMinuteValue draws its component only when what it reads changes: a label whose words
 *    stay the same over a minute draws nothing, and the component around it never draws;
 *  - keepEqual hands back the old object for every part that reads the same.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act, type ReactNode } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import { keepEqual } from '../../web/src/utils/keep-equal'

let clock: typeof import('../../web/src/utils/minute-clock')
let doc: Document
beforeAll(async () => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })
  doc = dom.document as unknown as Document
  clock = await import('../../web/src/utils/minute-clock')
})
afterEach(() => { vi.useRealTimers() })

const START = Date.UTC(2026, 10, 23, 10, 0, 30)

function mount(node: ReactNode): { unmount: () => void } {
  const host = doc.createElement('div')
  doc.body.appendChild(host)
  const root = createRoot(host as unknown as Element)
  act(() => { root.render(node) })
  return { unmount: () => act(() => root.unmount()) }
}

describe('the minute clock', () => {
  it('ticks on the wall minute while subscribed, and stops with its last subscriber', () => {
    vi.useFakeTimers({ now: START })
    const seen: number[] = []
    const off = clock.subscribeMinute(() => seen.push(clock.minuteNow()))
    vi.advanceTimersByTime(29_000)
    expect(seen).toEqual([])
    vi.advanceTimersByTime(1_100)
    expect(seen).toHaveLength(1)
    expect(seen[0]! % clock.MINUTE_MS).toBeLessThan(100)
    vi.advanceTimersByTime(clock.MINUTE_MS)
    expect(seen).toHaveLength(2)
    off()
    vi.advanceTimersByTime(5 * clock.MINUTE_MS)
    expect(seen).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reads stable between ticks, and fresh once a minute old with no subscriber', () => {
    vi.useFakeTimers({ now: START })
    const a = clock.minuteNow()
    vi.advanceTimersByTime(10_000)
    expect(clock.minuteNow()).toBe(a)
    vi.advanceTimersByTime(clock.MINUTE_MS)
    expect(clock.minuteNow()).toBe(Date.now())
  })

  it('gives a first subscriber this wall minute, never the one before (read 0.6 s apart across it)', () => {
    // Read once an hour earlier, then just before the minute, so the reading is 10:00:59.9.
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 23, 9, 0, 0) })
    clock.minuteNow()
    vi.setSystemTime(Date.UTC(2026, 10, 23, 10, 0, 59, 900))
    clock.minuteNow()
    vi.setSystemTime(Date.UTC(2026, 10, 23, 10, 1, 0, 500))
    const off = clock.subscribeMinute(() => {})
    try {
      expect(Math.floor(clock.minuteNow() / clock.MINUTE_MS)).toBe(Math.floor(Date.now() / clock.MINUTE_MS))
    } finally { off() }
  })

  it('sleeps while the tab is hidden and ticks once when it is shown again', () => {
    vi.useFakeTimers({ now: START })
    const seen: number[] = []
    const off = clock.subscribeMinute(() => seen.push(clock.minuteNow()))
    const show = (state: 'hidden' | 'visible') => {
      Object.defineProperty(doc, 'visibilityState', { value: state, configurable: true })
      const ev = doc.createEvent('Event')
      ev.initEvent('visibilitychange', false, false)
      doc.dispatchEvent(ev)
    }
    try {
      show('hidden')
      vi.advanceTimersByTime(3 * clock.MINUTE_MS)
      expect(seen).toEqual([])
      vi.setSystemTime(Date.now() + 10_000)
      show('visible')
      expect(seen).toHaveLength(1)
      expect(seen[0]).toBe(Date.now())
      // Shown again with nothing missed: no extra tick; the wall minute goes on as before.
      show('hidden'); show('visible')
      expect(seen).toHaveLength(1)
      vi.advanceTimersByTime(clock.MINUTE_MS)
      expect(seen).toHaveLength(2)
    } finally {
      Object.defineProperty(doc, 'visibilityState', { value: 'visible', configurable: true })
      off()
    }
  })

  it('draws a label only when its words change, and never the component around it', () => {
    vi.useFakeTimers({ now: START })
    const draws = { page: 0, label: 0 }
    const at = START - 30 * 60_000
    // "30m ago" style words for the first hour, then hours: words that change each minute.
    function Label({ hours }: { hours: boolean }) {
      draws.label++
      const words = clock.useMinuteValue((now) => hours ? `${Math.floor((now - at) / 3_600_000)}h` : `${Math.floor((now - at) / 60_000)}m`)
      return createElement('span', null, words)
    }
    function Page({ hours }: { hours: boolean }) {
      draws.page++
      return createElement('div', null, createElement(Label, { hours }))
    }
    const minutes = mount(createElement(Page, { hours: false }))
    expect(draws).toEqual({ page: 1, label: 1 })
    // The first tick (on the wall minute, 30 s in) still reads "30m"; the next one "31m".
    act(() => { vi.advanceTimersByTime(30_100) })
    expect(draws).toEqual({ page: 1, label: 1 })
    act(() => { vi.advanceTimersByTime(clock.MINUTE_MS) })
    expect(draws).toEqual({ page: 1, label: 2 })
    minutes.unmount()

    draws.page = 0; draws.label = 0
    const hours = mount(createElement(Page, { hours: true }))
    act(() => { vi.advanceTimersByTime(3 * clock.MINUTE_MS) })
    // "0h" for three minutes: nothing drew after the mount.
    expect(draws).toEqual({ page: 1, label: 1 })
    hours.unmount()
  })
})

describe('keepEqual', () => {
  it('keeps every part that reads the same, and only those', () => {
    const prev = { rows: [{ key: 'a', n: 1, tags: ['x'] }, { key: 'b', n: 2, tags: ['y'] }], set: new Set(['a']), map: new Map([['a', { v: 1 }]]) }
    const next = { rows: [{ key: 'a', n: 1, tags: ['x'] }, { key: 'b', n: 3, tags: ['y'] }], set: new Set(['a']), map: new Map([['a', { v: 1 }]]) }
    const kept = keepEqual(prev, next)
    expect(kept).not.toBe(prev)
    expect(kept.rows[0]).toBe(prev.rows[0])
    expect(kept.rows[1]).not.toBe(prev.rows[1])
    expect(kept.rows[1]!.tags).toBe(prev.rows[1]!.tags)
    expect(kept.rows[1]!.n).toBe(3)
    expect(kept.set).toBe(prev.set)
    expect(kept.map).toBe(prev.map)
    const same = { rows: next.rows.map((r) => ({ ...r, n: r.key === 'b' ? 3 : r.n })), set: new Set(['a']), map: new Map([['a', { v: 1 }]]) }
    expect(keepEqual(kept, same)).toBe(kept)
  })

  it('keeps a row that only moved in a list re-sorted around another row\'s change', () => {
    const prev = [{ key: 'a', at: 1 }, { key: 'b', at: 2 }, { key: 'c', at: 3 }]
    const next = [{ key: 'c', at: 9 }, { key: 'a', at: 1 }, { key: 'b', at: 2 }]
    const kept = keepEqual(prev, next)
    expect(kept).not.toBe(prev)
    expect(kept[1]).toBe(prev[0])
    expect(kept[2]).toBe(prev[1])
    expect(kept[0]).not.toBe(prev[2])
    expect(kept.map((r) => r.key)).toEqual(['c', 'a', 'b'])
  })

  it('sees an added or dropped field, entry or member', () => {
    expect(keepEqual({ a: 1 } as Record<string, number>, { a: 1, b: 2 })).toEqual({ a: 1, b: 2 })
    const p = { a: 1, b: 2 } as Record<string, number>
    expect(keepEqual(p, { a: 1 })).not.toBe(p)
    const s = new Set(['a'])
    expect(keepEqual(s, new Set(['b']))).not.toBe(s)
    const fn = () => 1
    expect(keepEqual({ fn }, { fn: () => 1 }).fn).not.toBe(fn)
  })
})
