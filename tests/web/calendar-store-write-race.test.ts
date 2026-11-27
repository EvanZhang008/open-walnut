import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarEvent } from '../../web/src/api/calendar.js'

/**
 * 2026-11-21, Evan: "why sometimes the calendar is not loaded and when i create it doesn't show
 * up events". His Mac's logs: every create answered 201 and the events are in his calendar, and
 * three loads in two days answered 503 while the server restarted, leaving the grid empty with
 * nothing that said so or asked again. Two rules of the shared calendar store:
 *  1. An answer to a fetch that left before a write landed never takes the written event off the
 *     grid: it is asked again once the writes settle.
 *  2. A failed load says so on its range and is tried again by itself while someone watches it.
 */

const mocks = vi.hoisted(() => ({
  listCalendarEvents: vi.fn(),
  listCalendarSources: vi.fn(),
  updateCalendarEvent: vi.fn(),
  updateCalendarSource: vi.fn(),
  createCalendarEvent: vi.fn(),
  deleteCalendarEvent: vi.fn(),
  setCalendarEventVisibility: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('@/api/calendar', () => ({
  listCalendarEvents: mocks.listCalendarEvents,
  listCalendarSources: mocks.listCalendarSources,
  updateCalendarEvent: mocks.updateCalendarEvent,
  updateCalendarSource: mocks.updateCalendarSource,
  createCalendarEvent: mocks.createCalendarEvent,
  deleteCalendarEvent: mocks.deleteCalendarEvent,
  setCalendarEventVisibility: mocks.setCalendarEventVisibility,
}))
vi.mock('@/utils/log', () => ({ log: { warn: mocks.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() } }))

import {
  __resetCalendarEventsStore,
  calendarRangeKey,
  createCalendarEventOptimistic,
  ensureCalendarRange,
  getCalendarRange,
  loadCalendarRange,
  moveCalendarEvent,
  subscribeCalendarRange,
} from '../../web/src/stores/calendar-events-store.js'

const DAY = '2026-11-21'
const KEY = calendarRangeKey(DAY, DAY)
const SOURCES = [{ id: 'eventkit', available: true, enabled: true }]

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function ev(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'ev-1', source: 'eventkit', calendarId: 'cal-event', calendarName: 'Event', accountName: 'Google',
    title: 'Practice', start: `${DAY}T13:00:00`, end: `${DAY}T14:00:00`, allDay: false, color: '#9D00FF', ...over,
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
const ids = () => getCalendarRange(KEY).events.map((e) => e.id).sort()

describe('a fetch answered across a write', () => {
  beforeEach(() => {
    __resetCalendarEventsStore()
    for (const fn of Object.values(mocks)) fn.mockReset()
  })

  async function mounted(events: CalendarEvent[]) {
    mocks.listCalendarEvents.mockResolvedValue({ events, sources: SOURCES })
    const off = subscribeCalendarRange(KEY, () => {})
    ensureCalendarRange(DAY, DAY)
    await loadCalendarRange(KEY)
    return off
  }

  it('a create stays on the grid when an older fetch answers after it', async () => {
    const off = await mounted([ev({ id: 'other', title: 'Eat' })])
    // A fetch leaves (a page mount, a socket reconnect), then the person creates.
    const stale = deferred<{ events: CalendarEvent[]; sources: typeof SOURCES }>()
    mocks.listCalendarEvents.mockReturnValueOnce(stale.promise)
    const refetch = loadCalendarRange(KEY, true)
    const write = deferred<{ event: CalendarEvent }>()
    mocks.createCalendarEvent.mockReturnValueOnce(write.promise)
    const created = createCalendarEventOptimistic({ calendarId: 'cal-event', title: 'Practice', start: `${DAY}T13:00:00`, end: `${DAY}T14:00:00` })
    expect(ids()).toEqual(['other', 'pending-1'])
    write.resolve({ event: ev() })
    await created
    expect(ids()).toEqual(['ev-1', 'other'])
    // The fetch that left before the write answers now, without the new event.
    mocks.listCalendarEvents.mockResolvedValue({ events: [ev({ id: 'other', title: 'Eat' }), ev()], sources: SOURCES })
    stale.resolve({ events: [ev({ id: 'other', title: 'Eat' })], sources: SOURCES })
    await refetch
    await flush()
    expect(ids()).toEqual(['ev-1', 'other'])
    // It asked again, and that answer holds the event.
    expect(mocks.listCalendarEvents.mock.calls.length).toBeGreaterThanOrEqual(3)
    off()
  })

  it('an answer that lands while a write is still on its way waits for it, then asks again', async () => {
    const off = await mounted([ev()])
    const write = deferred<{ event: CalendarEvent }>()
    mocks.updateCalendarEvent.mockReturnValueOnce(write.promise)
    const moved = moveCalendarEvent('ev-1', { start: `${DAY}T15:00:00`, end: `${DAY}T16:00:00` })
    expect(getCalendarRange(KEY).events[0]!.start).toBe(`${DAY}T15:00:00`)
    // A fetch answers with the old time while the move is still unconfirmed.
    mocks.listCalendarEvents.mockResolvedValueOnce({ events: [ev()], sources: SOURCES })
    await loadCalendarRange(KEY, true)
    expect(getCalendarRange(KEY).events[0]!.start).toBe(`${DAY}T15:00:00`)
    mocks.listCalendarEvents.mockResolvedValue({ events: [ev({ start: `${DAY}T15:00:00`, end: `${DAY}T16:00:00` })], sources: SOURCES })
    write.resolve({ event: ev({ start: `${DAY}T15:00:00`, end: `${DAY}T16:00:00` }) })
    await moved
    await flush()
    await flush()
    expect(getCalendarRange(KEY).events[0]!.start).toBe(`${DAY}T15:00:00`)
    off()
  })

  it('a move the Mac must confirm holds no answers back while it waits (up to minutes)', async () => {
    const off = await mounted([ev()])
    const write = deferred<{ event: CalendarEvent }>()
    mocks.updateCalendarEvent.mockReturnValueOnce(write.promise)
    const moved = moveCalendarEvent('ev-1', { start: `${DAY}T15:00:00`, end: `${DAY}T16:00:00`, human_confirm: true })
    // An agent's new event arrives while the confirmation is still open: it shows.
    mocks.listCalendarEvents.mockResolvedValueOnce({ events: [ev(), ev({ id: 'agent', title: 'Lunch' })], sources: SOURCES })
    await loadCalendarRange(KEY, true)
    expect(ids()).toEqual(['agent', 'ev-1'])
    // An answer asked before the confirmed move lands is set aside and asked again.
    const stale = deferred<{ events: CalendarEvent[]; sources: typeof SOURCES }>()
    mocks.listCalendarEvents.mockReturnValueOnce(stale.promise)
    const refetch = loadCalendarRange(KEY, true)
    const after = ev({ start: `${DAY}T15:00:00`, end: `${DAY}T16:00:00` })
    mocks.listCalendarEvents.mockResolvedValue({ events: [after, ev({ id: 'agent', title: 'Lunch' })], sources: SOURCES })
    write.resolve({ event: after })
    await moved
    stale.resolve({ events: [ev(), ev({ id: 'agent', title: 'Lunch' })], sources: SOURCES })
    await refetch
    expect(getCalendarRange(KEY).events.find((e) => e.id === 'ev-1')!.start).toBe(`${DAY}T15:00:00`)
    off()
  })

  it('an event created before the first load answers stays when that answer is set aside', async () => {
    const off = subscribeCalendarRange(KEY, () => {})
    const first = deferred<{ events: CalendarEvent[]; sources: typeof SOURCES }>()
    mocks.listCalendarEvents.mockReturnValueOnce(first.promise)
    ensureCalendarRange(DAY, DAY)
    const load = loadCalendarRange(KEY)
    mocks.createCalendarEvent.mockResolvedValueOnce({ event: ev() })
    await createCalendarEventOptimistic({ calendarId: 'cal-event', title: 'Practice', start: `${DAY}T13:00:00`, end: `${DAY}T14:00:00` })
    // The re-ask after the set-aside answer is slow too: until it comes, the new event stays.
    const again = deferred<{ events: CalendarEvent[]; sources: typeof SOURCES }>()
    mocks.listCalendarEvents.mockReturnValueOnce(again.promise)
    first.resolve({ events: [ev({ id: 'other', title: 'Eat' })], sources: SOURCES })
    await flush()
    expect(ids()).toEqual(['ev-1', 'other'])
    again.resolve({ events: [ev({ id: 'other', title: 'Eat' }), ev()], sources: SOURCES })
    await load
    expect(ids()).toEqual(['ev-1', 'other'])
    off()
  })
})

describe('a failed load', () => {
  beforeEach(() => {
    __resetCalendarEventsStore()
    for (const fn of Object.values(mocks)) fn.mockReset()
    vi.useFakeTimers()
  })
  afterEach(() => { vi.useRealTimers() })

  it('says so on its range and is tried again by itself until it loads', async () => {
    const off = subscribeCalendarRange(KEY, () => {})
    mocks.listCalendarEvents.mockRejectedValueOnce(new Error('plugin_starting'))
    mocks.listCalendarEvents.mockRejectedValueOnce(new Error('plugin_starting'))
    mocks.listCalendarEvents.mockResolvedValue({ events: [ev()], sources: SOURCES })
    ensureCalendarRange(DAY, DAY)
    await vi.advanceTimersByTimeAsync(0)
    expect(getCalendarRange(KEY)).toMatchObject({ loading: false, error: 'plugin_starting', events: [] })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(mocks.listCalendarEvents).toHaveBeenCalledTimes(2)
    expect(getCalendarRange(KEY).error).toBe('plugin_starting')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mocks.listCalendarEvents).toHaveBeenCalledTimes(3)
    expect(getCalendarRange(KEY).error).toBeUndefined()
    expect(ids()).toEqual(['ev-1'])
    off()
  })

  it('one lost refresh of a loaded range is retried quietly; a second in a row is said', async () => {
    const off = subscribeCalendarRange(KEY, () => {})
    mocks.listCalendarEvents.mockResolvedValueOnce({ events: [ev()], sources: SOURCES })
    ensureCalendarRange(DAY, DAY)
    await vi.advanceTimersByTimeAsync(0)
    mocks.listCalendarEvents.mockRejectedValue(new Error('plugin_starting'))
    await loadCalendarRange(KEY, true)
    expect(getCalendarRange(KEY)).toMatchObject({ events: [expect.objectContaining({ id: 'ev-1' })] })
    expect(getCalendarRange(KEY).error).toBeUndefined()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(getCalendarRange(KEY).error).toBe('plugin_starting')
    expect(ids()).toEqual(['ev-1'])
    off()
  })

  it('a range left with a failed load loads again when it is watched again, however recent', async () => {
    let off = subscribeCalendarRange(KEY, () => {})
    mocks.listCalendarEvents.mockResolvedValueOnce({ events: [ev()], sources: SOURCES })
    ensureCalendarRange(DAY, DAY)
    await vi.advanceTimersByTimeAsync(0)
    mocks.listCalendarEvents.mockRejectedValueOnce(new Error('down'))
    mocks.listCalendarEvents.mockRejectedValueOnce(new Error('down'))
    await loadCalendarRange(KEY, true)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(getCalendarRange(KEY).error).toBe('down')
    off()
    await vi.advanceTimersByTimeAsync(1_000)
    const calls = mocks.listCalendarEvents.mock.calls.length
    mocks.listCalendarEvents.mockResolvedValue({ events: [ev()], sources: SOURCES })
    off = subscribeCalendarRange(KEY, () => {})
    ensureCalendarRange(DAY, DAY)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.listCalendarEvents).toHaveBeenCalledTimes(calls + 1)
    expect(getCalendarRange(KEY).error).toBeUndefined()
    off()
  })

  it('stops trying once nobody watches the range', async () => {
    const off = subscribeCalendarRange(KEY, () => {})
    mocks.listCalendarEvents.mockRejectedValue(new Error('down'))
    ensureCalendarRange(DAY, DAY)
    await vi.advanceTimersByTimeAsync(0)
    off()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(mocks.listCalendarEvents).toHaveBeenCalledTimes(1)
  })
})
