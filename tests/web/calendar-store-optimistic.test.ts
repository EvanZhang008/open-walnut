import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarEvent, CalendarInfo } from '../../web/src/api/calendar.js'

/**
 * Contract tests for the shared calendar events store — the module that made the
 * homepage day agenda and /calendar one truth instead of two private copies.
 *
 * The load-bearing invariants:
 *  1. A write patches EVERY mounted range that carries the event, before the
 *     server answers (that is the whole point: two surfaces, one frame).
 *  2. A failed write restores the exact previous record, not a refetched guess.
 *  3. The same range is fetched ONCE no matter how many surfaces ask for it.
 */

const mocks = vi.hoisted(() => ({
  listCalendarEvents: vi.fn(),
  listCalendarSources: vi.fn(),
  updateCalendarEvent: vi.fn(),
  updateCalendarSource: vi.fn(),
  createCalendarEvent: vi.fn(),
  deleteCalendarEvent: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('@/api/calendar', () => ({
  listCalendarEvents: mocks.listCalendarEvents,
  listCalendarSources: mocks.listCalendarSources,
  updateCalendarEvent: mocks.updateCalendarEvent,
  updateCalendarSource: mocks.updateCalendarSource,
  createCalendarEvent: mocks.createCalendarEvent,
  deleteCalendarEvent: mocks.deleteCalendarEvent,
}))
vi.mock('@/utils/log', () => ({ log: { warn: mocks.warn, info: vi.fn() } }))

import {
  __resetCalendarEventsStore,
  calendarRangeKey,
  createCalendarEventOptimistic,
  ensureCalendarRange,
  getCalendarRange,
  loadCalendarRange,
  moveCalendarEvent,
  removeCalendarEvent,
  setCalendarHidden,
  subscribeCalendarRange,
} from '../../web/src/stores/calendar-events-store.js'

const DAY = '2026-09-03'
const WEEK_FROM = '2026-08-31'
const WEEK_TO = '2026-09-06'
const DAY_KEY = calendarRangeKey(DAY, DAY)
const WEEK_KEY = calendarRangeKey(WEEK_FROM, WEEK_TO)

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'ev-1',
    source: 'eventkit',
    calendarId: 'cal-work',
    calendarName: 'Work',
    accountName: 'Cloud',
    title: 'Standup',
    start: `${DAY}T09:00:00`,
    end: `${DAY}T09:30:00`,
    allDay: false,
    color: '#4285f4',
    ...over,
  }
}

function calendar(over: Partial<CalendarInfo> = {}): CalendarInfo {
  return { id: 'cal-work', title: 'Work', account: 'Cloud', color: '#4285f4', readonly: false, hidden: false, ...over }
}

/** Mount both surfaces on their own ranges and let their first fetch settle. */
async function mountBothRanges(events: CalendarEvent[]): Promise<() => void> {
  mocks.listCalendarEvents.mockResolvedValue({ events, sources: [{ id: 'eventkit', available: true, enabled: true }] })
  const offDay = subscribeCalendarRange(DAY_KEY, () => {})
  const offWeek = subscribeCalendarRange(WEEK_KEY, () => {})
  ensureCalendarRange(DAY, DAY)
  ensureCalendarRange(WEEK_FROM, WEEK_TO)
  await Promise.all([loadCalendarRange(DAY_KEY), loadCalendarRange(WEEK_KEY)])
  return () => { offDay(); offWeek() }
}

describe('calendar events store', () => {
  beforeEach(() => {
    __resetCalendarEventsStore()
    for (const fn of Object.values(mocks)) fn.mockReset()
  })

  it('fetches one range ONCE however many surfaces ask for it', async () => {
    const held = deferred<{ events: CalendarEvent[]; sources: [] }>()
    mocks.listCalendarEvents.mockReturnValue(held.promise)

    const offA = subscribeCalendarRange(DAY_KEY, () => {})
    const offB = subscribeCalendarRange(DAY_KEY, () => {})
    ensureCalendarRange(DAY, DAY)
    ensureCalendarRange(DAY, DAY)
    expect(mocks.listCalendarEvents).toHaveBeenCalledTimes(1)

    held.resolve({ events: [event()], sources: [] })
    await loadCalendarRange(DAY_KEY)
    expect(getCalendarRange(DAY_KEY).events).toHaveLength(1)
    expect(mocks.listCalendarEvents).toHaveBeenCalledTimes(1)
    offA(); offB()
  })

  it('a move patches every mounted range before the PATCH answers', async () => {
    const off = await mountBothRanges([event()])
    const held = deferred<{ event: CalendarEvent }>()
    mocks.updateCalendarEvent.mockReturnValue(held.promise)

    moveCalendarEvent('ev-1', { start: `${DAY}T13:00:00`, end: `${DAY}T13:30:00`, title: 'Renamed' })

    // Server has not answered — both surfaces already moved.
    for (const key of [DAY_KEY, WEEK_KEY]) {
      const moved = getCalendarRange(key).events[0]
      expect(moved.start).toBe(`${DAY}T13:00:00`)
      expect(moved.title).toBe('Renamed')
    }

    held.resolve({ event: event({ id: 'ev-1-detached', start: `${DAY}T13:00:00`, end: `${DAY}T13:30:00`, title: 'Renamed' }) })
    await held.promise
    await Promise.resolve()
    // A recurring edit can hand back a new id — the canonical record wins.
    expect(getCalendarRange(DAY_KEY).events[0].id).toBe('ev-1-detached')
    off()
  })

  it('a failed move restores the exact previous record on every range', async () => {
    const off = await mountBothRanges([event()])
    mocks.updateCalendarEvent.mockRejectedValue(new Error('calendar is read-only'))

    moveCalendarEvent('ev-1', { start: `${DAY}T20:00:00`, end: `${DAY}T20:30:00`, title: 'Moved' })
    await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalled())

    for (const key of [DAY_KEY, WEEK_KEY]) {
      const back = getCalendarRange(key).events[0]
      expect(back.start).toBe(`${DAY}T09:00:00`)
      expect(back.end).toBe(`${DAY}T09:30:00`)
      expect(back.title).toBe('Standup')
    }
    off()
  })

  it('a create shows a provisional chip in every covering range, then the server record', async () => {
    const off = await mountBothRanges([])
    const held = deferred<{ event: CalendarEvent }>()
    mocks.createCalendarEvent.mockReturnValue(held.promise)

    const pending = createCalendarEventOptimistic({
      calendarId: 'cal-work', title: 'New meeting', start: `${DAY}T15:00:00`, end: `${DAY}T16:00:00`,
    })

    expect(getCalendarRange(DAY_KEY).events).toHaveLength(1)
    expect(getCalendarRange(WEEK_KEY).events[0].title).toBe('New meeting')
    expect(getCalendarRange(DAY_KEY).events[0].id).toMatch(/^pending-/)

    held.resolve({ event: event({ id: 'ev-real', title: 'New meeting', start: `${DAY}T15:00:00`, end: `${DAY}T16:00:00` }) })
    await pending
    expect(getCalendarRange(DAY_KEY).events[0].id).toBe('ev-real')
    off()
  })

  it('a failed create removes the provisional chip and rethrows', async () => {
    const off = await mountBothRanges([])
    mocks.createCalendarEvent.mockRejectedValue(new Error('no writable calendar'))

    await expect(createCalendarEventOptimistic({
      calendarId: 'cal-work', title: 'Doomed', start: `${DAY}T15:00:00`, end: `${DAY}T16:00:00`,
    })).rejects.toThrow('no writable calendar')

    expect(getCalendarRange(DAY_KEY).events).toHaveLength(0)
    expect(getCalendarRange(WEEK_KEY).events).toHaveLength(0)
    off()
  })

  it('a failed delete puts the chip back', async () => {
    const off = await mountBothRanges([event()])
    mocks.deleteCalendarEvent.mockRejectedValue(new Error('gone'))

    removeCalendarEvent('ev-1')
    expect(getCalendarRange(DAY_KEY).events).toHaveLength(0)

    await vi.waitFor(() => expect(getCalendarRange(DAY_KEY).events).toHaveLength(1))
    expect(getCalendarRange(WEEK_KEY).events[0].title).toBe('Standup')
    off()
  })

  it('hiding a calendar drops its chips at once; a failed PUT brings them back', async () => {
    const off = await mountBothRanges([event(), event({ id: 'ev-2', calendarId: 'cal-personal', title: 'Errand' })])
    mocks.listCalendarSources.mockResolvedValue({
      sources: [{ id: 'eventkit', available: true, enabled: true }],
      calendars: [calendar(), calendar({ id: 'cal-personal', title: 'Personal' })],
    })
    mocks.updateCalendarSource.mockRejectedValue(new Error('write failed'))

    const done = setCalendarHidden('cal-personal', true)
    // Instant, without waiting for the calendars list or the PUT.
    expect(getCalendarRange(DAY_KEY).events.map((e) => e.id)).toEqual(['ev-1'])

    await done
    expect(getCalendarRange(DAY_KEY).events.map((e) => e.id).sort()).toEqual(['ev-1', 'ev-2'])
    off()
  })
})
