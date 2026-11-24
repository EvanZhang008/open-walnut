/**
 * What moves with the minute clock in a task list, and only that (2026-11-23, task 9bceb9f2; the
 * clock: web/src/utils/minute-clock.ts):
 *  - clockKey (Home's filter) changes exactly when the clock moves a task in or out: a deferred
 *    task's start arriving, a due time passing for Overdue, a task leaving a relative window;
 *  - timeWindowKey keys only a relative window (an absolute one never moves) and reuses its pass
 *    for an equal window object;
 *  - useNormalizedTaskQuery (the Dashboard and the task views) reads `now` again for a new task
 *    list, so a task updated again inside "the last 24 hours" never drops out (review, 11-24);
 *  - a row's start and due pills move with the clock by themselves, the row never drawing.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act, type ReactNode } from '../../web/node_modules/react/index.js'
import { createRoot, type Root } from '../../web/node_modules/react-dom/client.js'
import type { Task } from '../../src/core/types'
import { matchesTaskQuery, type NormalizedTaskQuery, type TaskQuery } from '../../src/core/task-query'
import { DEFAULT_FILTER_STATE as S0, type FilterState } from '../../web/src/components/tasks/filter-bar-types'
import { clockKey } from '../../web/src/components/tasks/filter-predicate'
import { timeWindowKey } from '../../web/src/components/tasks/task-query-state'

let doc: Document
let hook: typeof import('../../web/src/components/tasks/useNormalizedTaskQuery')
let pills: typeof import('../../web/src/components/tasks/TaskDatePills')
beforeAll(async () => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })
  doc = dom.document as unknown as Document
  hook = await import('../../web/src/components/tasks/useNormalizedTaskQuery')
  pills = await import('../../web/src/components/tasks/TaskDatePills')
})
afterEach(() => { vi.useRealTimers() })

const START = Date.UTC(2026, 10, 23, 10, 0, 30)
const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()

let seq = 0
function mk(over: Partial<Task> = {}): Task {
  seq += 1
  return {
    id: `t${seq}`, title: `Task ${seq}`, status: 'todo', phase: 'TODO', priority: 'none', project: 'Home',
    source: 'local', tags: [], created_at: iso(START - 3_600_000), updated_at: iso(START - 3_600_000), ...over,
  } as unknown as Task
}

function mount(node: ReactNode): { root: Root; host: Element; unmount: () => void } {
  const host = doc.createElement('div')
  doc.body.appendChild(host)
  const root = createRoot(host as unknown as Element)
  act(() => { root.render(node) })
  return { root, host: host as unknown as Element, unmount: () => act(() => root.unmount()) }
}

describe('clockKey: Home\'s filter moves only when the clock moves a task in or out', () => {
  it('a deferred task enters Now when its start time arrives', () => {
    const later = mk({ start_date: iso(START + 2 * MIN) })
    const tasks = [mk(), later]
    const before = clockKey(tasks, S0, START + MIN)
    expect(before).toContain(later.id)
    expect(clockKey(tasks, S0, START + MIN + 10_000)).toBe(before)
    expect(clockKey(tasks, S0, START + 3 * MIN)).not.toContain(later.id)
  })

  it('Overdue takes a task once its due time passes', () => {
    const due = mk({ due_date: iso(START + 2 * MIN) })
    const tasks = [due]
    const state: FilterState = { ...S0, date: 'overdue' }
    expect(clockKey(tasks, state, START + MIN)).toContain(due.id)
    expect(clockKey(tasks, state, START + 3 * MIN)).not.toContain(due.id)
  })

  it('a task leaves a relative window ("the last hour") as the clock passes its edge', () => {
    const recent = mk({ updated_at: iso(START - 30 * MIN) })
    const tasks = [recent]
    const state: FilterState = { ...S0, time: { ...S0.time, preset: '1h' } }
    expect(clockKey(tasks, state, START)).not.toContain(recent.id)
    expect(clockKey(tasks, state, START + 31 * MIN)).toContain(recent.id)
  })
})

describe('timeWindowKey', () => {
  it('keys nothing for an absolute window: it never moves with the clock', () => {
    const tasks = [mk({ updated_at: iso(START - 30 * MIN) })]
    const absolute = { basis: 'updated', from: iso(START - 20 * MIN) } as TaskQuery['time']
    expect(timeWindowKey(tasks, absolute, START)).toBe('')
    expect(timeWindowKey(tasks, absolute, START + 60 * MIN)).toBe('')
  })

  it('reuses its pass for an equal window built anew (callers rebuild it on every call)', () => {
    let reads = 0
    const t = mk()
    const at = t.updated_at
    Object.defineProperty(t, 'updated_at', { get: () => { reads++; return at }, enumerable: true })
    const tasks = [t]
    const window = () => ({ basis: 'updated', last: { value: 24, unit: 'hours' } }) as TaskQuery['time']
    timeWindowKey(tasks, window(), START)
    const first = reads
    expect(first).toBeGreaterThan(0)
    timeWindowKey(tasks, window(), START)
    expect(reads).toBe(first)
  })
})

describe('useNormalizedTaskQuery', () => {
  it('keeps a task updated again inside "the last 24 hours" after the clock ticked', () => {
    vi.useFakeTimers({ now: START })
    const query: TaskQuery = { time: { basis: 'updated', last: { value: 24, unit: 'hours' } } }
    const a = mk({ id: 'a', updated_at: iso(START - 60 * MIN) } as Partial<Task>)
    let seen: NormalizedTaskQuery | null = null
    function Probe({ tasks }: { tasks: Task[] }) {
      seen = hook.useNormalizedTaskQuery(tasks, query)
      return null
    }
    const { root, unmount } = mount(createElement(Probe, { tasks: [a] }))
    // The clock ticks at 10:01:00; an update written at 10:00:50 (or by a server clock behind the
    // browser's) arrives after it. The window still holds the task, so the clock's key is unchanged.
    act(() => { vi.advanceTimersByTime(30_100 + 20_000) })
    const again = { ...a, updated_at: iso(START + 20_000) } as Task
    act(() => { root.render(createElement(Probe, { tasks: [again] })) })
    expect(seen).not.toBeNull()
    expect(matchesTaskQuery(again, seen!, {})).toBe(true)
    unmount()
  })
})

describe('TaskDatePills', () => {
  it('moves the start and due pills with the minute, never drawing the row around them', () => {
    vi.useFakeTimers({ now: START })
    let rowDraws = 0
    function Row() {
      rowDraws++
      return createElement('div', null, createElement(pills.TaskDatePills, { startDate: iso(START + 150_000), dueDate: iso(START + 90_000) }))
    }
    const { host, unmount } = mount(createElement(Row))
    const start = () => host.querySelector('.todo-item-start-pill')?.textContent ?? null
    const due = () => host.querySelector('.todo-item-due-pill:not(.todo-item-start-pill)')
    expect(start()).toBe('3m')
    expect(due()?.textContent).toBe('2m')
    expect(due()?.className).not.toContain('badge-error')
    // 10:01:00: the start is 2m away, the due time 30 s.
    act(() => { vi.advanceTimersByTime(30_100) })
    expect(start()).toBe('2m')
    // 10:03:00: the start has come (no pill), the due time has passed.
    act(() => { vi.advanceTimersByTime(2 * MIN) })
    expect(start()).toBeNull()
    expect(due()?.textContent).toBe('Overdue')
    expect(due()?.className).toContain('badge-error')
    expect(rowDraws).toBe(1)
    unmount()
  })

  it('takes no clock for a task with no dates', () => {
    vi.useFakeTimers({ now: START })
    const { host, unmount } = mount(createElement(pills.TaskDatePills, {}))
    expect(host.textContent).toBe('')
    expect(vi.getTimerCount()).toBe(0)
    unmount()
  })
})
