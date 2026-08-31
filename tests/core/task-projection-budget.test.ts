/**
 * Task projection SELECTION — which rows survive the export byte budget.
 *
 * This projection is not just the cloud replica's seed: the PRIMARY's own
 * GET /api/v1/tasks serves it to the local phone, with no paging, and applies
 * its q/project/tag/status filters over these very rows. So a dropped row is a
 * task the phone can neither list nor find, on both boxes. That is why the
 * budget is sized to NOT bind at real volume (3,079 rows ≈ 1.15MB against a
 * 3.35MB budget) and why, when it does bind, pinned rows are the guaranteed
 * survivors — the board IS the pinned set.
 *
 * The sibling failure this replaces: the payload crossed the 1MB transcript-lane
 * cap, pushProjectionToCloud skipped it (skip, not error), and the replica's
 * task list froze on its last-pushed copy for months.
 *
 * Everything asserts through the REAL buildTaskProjection — only the task store
 * read is mocked, so the ordering, the budget and the warn under test are the
 * shipped ones.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
import { log } from '../../src/logging/index.js'
import type { Task } from '../../src/core/types.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-projection-budget'))

let mockTasks: Task[] = []

vi.mock('../../src/core/task-manager.js', () => ({
  listTasks: async () => mockTasks,
  getCustomTiers: async () => [],
}))

/** A row roughly the shape and size of a real one (~374B), or fat when asked. */
function task(id: string, opts: {
  updatedDaysAgo?: number
  pinned?: boolean
  pinOrder?: number
  status?: string
  fat?: boolean
} = {}): Task {
  const at = new Date(Date.now() - (opts.updatedDaysAgo ?? 0) * 86_400_000).toISOString()
  return {
    id,
    title: `task ${id}`,
    status: opts.status ?? 'todo',
    phase: 'TODO',
    priority: 'medium',
    project: 'Marina',
    created_at: at,
    updated_at: at,
    ...(opts.pinned ? { pinned: true } : {}),
    ...(opts.pinned && opts.pinOrder != null ? { pin_order: opts.pinOrder } : {}),
    ...(opts.fat ? { summary: 's'.repeat(600) } : {}),
  } as Task
}

async function build() {
  const { buildTaskProjection } = await import('../../src/core/task-projection.js')
  return buildTaskProjection()
}

/** Serialized size of the actual bridge frame this projection would ride. */
function pushBytes(projection: unknown): number {
  return Buffer.byteLength(JSON.stringify({ which: 'tasks', data: projection }), 'utf8')
}

describe('task projection budget', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockTasks = []
    warnSpy = vi.spyOn(log.task, 'warn').mockImplementation(() => {})
  })

  it('does NOT truncate at real volume, and the payload now fits one bridge frame', async () => {
    // Today's shape: ~3,079 eligible rows. The whole list must ship (the local
    // phone lists and searches these rows) AND the frame must be sendable.
    for (let i = 0; i < 3_079; i++) {
      mockTasks.push(task(`t-${i}`, { updatedDaysAgo: i * 0.002, pinned: i < 262, pinOrder: i }))
    }
    const projection = await build()
    const { PROJECTION_PUSH_MAX_BYTES } = await import('../../src/core/projection-cache.js')

    expect(projection.tasks.length).toBe(3_079)
    expect(projection.tasks.filter((t) => t.pinned).length).toBe(262)
    expect(pushBytes(projection)).toBeLessThan(PROJECTION_PUSH_MAX_BYTES)
    expect(warnSpy).not.toHaveBeenCalled()
    // Not truncated → absence still means "deleted on the primary", so the
    // replica's importer keeps its delete-reconcile pass armed.
    expect(projection.truncated).toBeUndefined()
  })

  it('keeps the done-retention rule as the visibility rule', async () => {
    mockTasks.push(task('open-old', { updatedDaysAgo: 400 }))
    mockTasks.push(task('done-recent', { status: 'done', updatedDaysAgo: 3 }))
    mockTasks.push(task('done-ancient', { status: 'done', updatedDaysAgo: 90 }))

    const ids = (await build()).tasks.map((t) => t.id)
    expect(ids).toContain('open-old') // open tasks never age out
    expect(ids).toContain('done-recent')
    expect(ids).not.toContain('done-ancient')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('cuts the oldest-updated unpinned rows first and never a pinned one', async () => {
    // Fat rows (600-char summary) overflow the byte budget. The pinned row is
    // deliberately the STALEST row in the set — a plain newest-first fill would
    // drop it, which is exactly the failure mode on the board.
    for (let i = 0; i < 6_000; i++) mockTasks.push(task(`plain-${i}`, { updatedDaysAgo: i * 0.001, fat: true }))
    mockTasks.push(task('pinned-stalest', { updatedDaysAgo: 365, pinned: true, pinOrder: 0, fat: true }))

    const projection = await build()
    const ids = new Set(projection.tasks.map((t) => t.id))

    expect(projection.tasks.length).toBeLessThan(6_001) // budget really bit
    expect(ids.has('pinned-stalest')).toBe(true)
    expect(ids.has('plain-0')).toBe(true) // newest unpinned survives
    expect(ids.has('plain-5999')).toBe(false) // oldest-updated unpinned is what goes
    expect(projection.tasks.filter((t) => t.pinned).length).toBe(1)
  })

  it('keeps the TOP of the board when pinned rows alone overflow the budget', async () => {
    // 6,000 pinned fat rows: the budget bites inside the pinned set, so board
    // order (pin_order) decides, not recency.
    for (let i = 0; i < 6_000; i++) {
      mockTasks.push(task(`pin-${i}`, { pinned: true, pinOrder: i, updatedDaysAgo: 6_000 - i, fat: true }))
    }
    const projection = await build()
    const kept = new Set(projection.tasks.map((t) => t.id))

    expect(projection.tasks.length).toBeLessThan(6_000)
    expect(projection.tasks.every((t) => t.pinned)).toBe(true)
    expect(kept.has('pin-0')).toBe(true) // top of the board
    expect(kept.has('pin-5999')).toBe(false) // bottom of the board
  })

  it('warns exactly once per export when the budget truncates, with the lost counts', async () => {
    for (let i = 0; i < 6_000; i++) mockTasks.push(task(`plain-${i}`, { updatedDaysAgo: i * 0.001, fat: true }))
    mockTasks.push(task('pinned-stalest', { updatedDaysAgo: 365, pinned: true, pinOrder: 0, fat: true }))

    const projection = await build()

    expect(warnSpy).toHaveBeenCalledTimes(1)
    const [message, fields] = warnSpy.mock.calls[0] as [string, Record<string, unknown>]
    expect(message).toBe('task projection truncated by budget')
    expect(fields.eligible).toBe(6_001)
    expect(fields.shipped).toBe(projection.tasks.length)
    expect(fields.dropped).toBe(6_001 - projection.tasks.length)
    expect(fields.droppedPinned).toBe(0)
    expect(fields.boundBy).toBe('bytes')
    expect(fields.retentionDays).toBe(14)
    expect(typeof fields.bytes).toBe('number')
    // The envelope must say so, or the replica's importer would read the dropped
    // rows as primary-side deletes and remove its own copies (tests/core/
    // task-outbox.test.ts pins both halves of that pair).
    expect(projection.truncated).toBe(true)

    // Once PER EXPORT, not once per process.
    warnSpy.mockClear()
    await build()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('bounds the payload under the list-lane frame cap even when truncating', async () => {
    const { PROJECTION_PUSH_MAX_BYTES } = await import('../../src/core/projection-cache.js')
    for (let i = 0; i < 8_000; i++) mockTasks.push(task(`plain-${i}`, { updatedDaysAgo: i * 0.001, fat: true }))
    const projection = await build()
    expect(pushBytes(projection)).toBeLessThan(PROJECTION_PUSH_MAX_BYTES)
  })

  it('emits rows in the store\'s own order — the priority sort must not leak into the contract', async () => {
    // Nothing is truncated here, so the output must be byte-for-byte the order
    // listTasks gave us (consumers do their own sorting; api-v1 sorts only the
    // working_set view).
    mockTasks.push(task('a', { updatedDaysAgo: 1 }))
    mockTasks.push(task('b', { updatedDaysAgo: 30, pinned: true, pinOrder: 5 }))
    mockTasks.push(task('c', { updatedDaysAgo: 0 }))
    mockTasks.push(task('d', { updatedDaysAgo: 10, pinned: true, pinOrder: 1 }))

    const projection = await build()
    expect(projection.tasks.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
