/**
 * The recent-completed window (src/core/task-recent-completed.ts): which
 * completed rows the home list leaves on the server, and which it never may.
 */
import { describe, it, expect } from 'vitest'
import { recentCompletedWindow, parseCompletedWithinDays } from '../../src/core/task-recent-completed.js'

const NOW = Date.parse('2026-09-29T12:00:00.000Z')
const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString()

describe('recentCompletedWindow', () => {
  it('keeps open tasks and recent completions, drops old completions and counts them', () => {
    const tasks = [
      { id: 'open', status: 'todo', phase: 'TODO', updated_at: daysAgo(400) },
      { id: 'recent', status: 'done', phase: 'COMPLETE', completed_at: daysAgo(3) },
      { id: 'old', status: 'done', phase: 'COMPLETE', completed_at: daysAgo(30) },
      { id: 'older', status: 'done', phase: 'COMPLETE', completed_at: daysAgo(365) },
    ]
    const { tasks: kept, completedHidden } = recentCompletedWindow(tasks, 7, NOW)
    expect(kept.map((t) => t.id)).toEqual(['open', 'recent'])
    expect(completedHidden).toBe(2)
  })

  it('a completion inside the window by minutes stays; one just outside goes', () => {
    const edge = 7 * 24 * 60 * 60 * 1000
    const tasks = [
      { id: 'in', status: 'done', completed_at: new Date(NOW - edge + 60_000).toISOString() },
      { id: 'out', status: 'done', completed_at: new Date(NOW - edge - 60_000).toISOString() },
    ]
    const { tasks: kept, completedHidden } = recentCompletedWindow(tasks, 7, NOW)
    expect(kept.map((t) => t.id)).toEqual(['in'])
    expect(completedHidden).toBe(1)
  })

  it('falls back to updated_at when completed_at is missing, and keeps a task with neither', () => {
    const tasks = [
      { id: 'by-updated-old', status: 'done', updated_at: daysAgo(20) },
      { id: 'by-updated-new', status: 'done', updated_at: daysAgo(1) },
      { id: 'no-timestamp', status: 'done' },
      { id: 'garbage', status: 'done', completed_at: 'not a date' },
    ]
    const { tasks: kept, completedHidden } = recentCompletedWindow(tasks, 7, NOW)
    expect(kept.map((t) => t.id)).toEqual(['by-updated-new', 'no-timestamp', 'garbage'])
    expect(completedHidden).toBe(1)
  })

  it('never drops a pinned or tiered task, however old its completion', () => {
    const tasks = [
      { id: 'pinned', status: 'done', completed_at: daysAgo(300), pinned: true },
      { id: 'tiered', status: 'done', completed_at: daysAgo(300), focus_tier: 'backlog' },
      { id: 'plain', status: 'done', completed_at: daysAgo(300) },
    ]
    const { tasks: kept, completedHidden } = recentCompletedWindow(tasks, 7, NOW)
    expect(kept.map((t) => t.id)).toEqual(['pinned', 'tiered'])
    expect(completedHidden).toBe(1)
  })

  it('reads completion from either vocabulary: legacy status or phase', () => {
    const tasks = [
      { id: 'phase-only', phase: 'COMPLETE', completed_at: daysAgo(30) },
      { id: 'status-only', status: 'done', completed_at: daysAgo(30) },
      { id: 'need-action', phase: 'NEED_ACTION', status: 'in_progress', updated_at: daysAgo(30) },
    ]
    const { tasks: kept, completedHidden } = recentCompletedWindow(tasks, 7, NOW)
    expect(kept.map((t) => t.id)).toEqual(['need-action'])
    expect(completedHidden).toBe(2)
  })

  it('a zero-day window keeps only completions from this instant on; order is preserved', () => {
    const tasks = [
      { id: 'a', status: 'todo' },
      { id: 'b', status: 'done', completed_at: daysAgo(0.001) },
      { id: 'c', status: 'todo' },
      { id: 'd', status: 'done', completed_at: new Date(NOW).toISOString() },
    ]
    const { tasks: kept, completedHidden } = recentCompletedWindow(tasks, 0, NOW)
    expect(kept.map((t) => t.id)).toEqual(['a', 'c', 'd'])
    expect(completedHidden).toBe(1)
  })

  it('an empty list is an empty answer', () => {
    expect(recentCompletedWindow([], 7, NOW)).toEqual({ tasks: [], completedHidden: 0 })
  })
})

describe('parseCompletedWithinDays', () => {
  it('absent means no window', () => {
    expect(parseCompletedWithinDays(undefined)).toBeUndefined()
    expect(parseCompletedWithinDays('')).toBeUndefined()
    expect(parseCompletedWithinDays(null)).toBeUndefined()
  })

  it('accepts a number of days as a string or number, fractions included', () => {
    expect(parseCompletedWithinDays('7')).toBe(7)
    expect(parseCompletedWithinDays(14)).toBe(14)
    expect(parseCompletedWithinDays('0.5')).toBe(0.5)
    expect(parseCompletedWithinDays('0')).toBe(0)
  })

  it('refuses garbage and negative values', () => {
    expect(() => parseCompletedWithinDays('soon')).toThrow(RangeError)
    expect(() => parseCompletedWithinDays('-1')).toThrow(RangeError)
    expect(() => parseCompletedWithinDays('Infinity')).toThrow(RangeError)
  })
})
