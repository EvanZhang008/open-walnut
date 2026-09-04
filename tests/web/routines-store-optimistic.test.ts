import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Routine, CreateRoutineInput } from '../../web/src/api/routines.js'

/**
 * Contract tests for the shared routines store.
 *
 * Before it existed, `toggle`/`create`/`remove` were bare API pass-throughs: the
 * switch did not move until the round-trip AND the `cron:job-*` broadcast came
 * back, and each of the two mounted surfaces refetched the whole list on every
 * cron tick. The invariants worth pinning:
 *  1. The list changes before the server answers, and rolls back if it refuses.
 *  2. A cron event that arrives WHILE a write is in flight must not clobber the
 *     optimistic row — it waits for the write to settle.
 *  3. One fetch serves every subscriber.
 */

const mocks = vi.hoisted(() => ({
  fetchRoutines: vi.fn(),
  createRoutine: vi.fn(),
  updateRoutine: vi.fn(),
  deleteRoutine: vi.fn(),
  toggleRoutine: vi.fn(),
  runRoutine: vi.fn(),
  fetchExecutors: vi.fn(),
  draftRoutine: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('@/api/routines', () => ({
  fetchRoutines: mocks.fetchRoutines,
  createRoutine: mocks.createRoutine,
  updateRoutine: mocks.updateRoutine,
  deleteRoutine: mocks.deleteRoutine,
  toggleRoutine: mocks.toggleRoutine,
  runRoutine: mocks.runRoutine,
  fetchExecutors: mocks.fetchExecutors,
  draftRoutine: mocks.draftRoutine,
}))
vi.mock('@/utils/log', () => ({ log: { warn: mocks.warn, info: vi.fn() } }))

import {
  __resetRoutinesStore,
  createRoutine,
  getRoutinesSnapshot,
  loadRoutines,
  onRoutinesChanged,
  removeRoutine,
  subscribeRoutines,
  toggleRoutine,
} from '../../web/src/stores/routines-store.js'

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function routine(over: Partial<Routine> = {}): Routine {
  return {
    id: 'r-1',
    name: 'Morning digest',
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: 'every', everyMs: 60_000 },
    wakeMode: 'now',
    executor: { type: 'walnut-agent', config: { instructions: 'summarize' } },
    state: {},
    ...over,
  }
}

const CREATE_INPUT: CreateRoutineInput = {
  name: 'Evening wrap',
  schedule: { kind: 'every', everyMs: 300_000 },
  executor: { type: 'walnut-agent', config: { instructions: 'wrap up' } },
}

function ids(): string[] {
  return getRoutinesSnapshot().routines.map((r) => r.id)
}

describe('routines store', () => {
  beforeEach(() => {
    __resetRoutinesStore()
    for (const fn of Object.values(mocks)) fn.mockReset()
  })

  it('one fetch serves every subscriber', async () => {
    const held = deferred<Routine[]>()
    mocks.fetchRoutines.mockReturnValue(held.promise)
    void loadRoutines()
    void loadRoutines()
    expect(mocks.fetchRoutines).toHaveBeenCalledTimes(1)
    held.resolve([routine()])
    await loadRoutines()
    expect(getRoutinesSnapshot().loading).toBe(false)
    expect(ids()).toEqual(['r-1'])
    expect(mocks.fetchRoutines).toHaveBeenCalledTimes(1)
  })

  it('toggle flips the switch before the POST answers, then takes the server row', async () => {
    mocks.fetchRoutines.mockResolvedValue([routine()])
    await loadRoutines()
    const held = deferred<Routine>()
    mocks.toggleRoutine.mockReturnValue(held.promise)

    let notified = 0
    const unsub = subscribeRoutines(() => notified++)
    const done = toggleRoutine('r-1')
    expect(getRoutinesSnapshot().routines[0].enabled).toBe(false)
    expect(notified).toBeGreaterThan(0)

    held.resolve(routine({ enabled: false, updatedAtMs: 2 }))
    await done
    expect(getRoutinesSnapshot().routines[0].updatedAtMs).toBe(2)
    unsub()
  })

  it('a refused toggle rolls the switch back', async () => {
    mocks.fetchRoutines.mockResolvedValue([routine()])
    await loadRoutines()
    mocks.toggleRoutine.mockRejectedValue(new Error('routine is locked'))

    await expect(toggleRoutine('r-1')).rejects.toThrow('routine is locked')
    expect(getRoutinesSnapshot().routines[0].enabled).toBe(true)
    expect(mocks.warn).toHaveBeenCalled()
  })

  it('create shows a provisional row, then swaps in the real one', async () => {
    mocks.fetchRoutines.mockResolvedValue([routine()])
    await loadRoutines()
    const held = deferred<Routine>()
    mocks.createRoutine.mockReturnValue(held.promise)

    const done = createRoutine(CREATE_INPUT)
    expect(getRoutinesSnapshot().routines).toHaveLength(2)
    expect(getRoutinesSnapshot().routines[1].id).toMatch(/^pending-/)
    expect(getRoutinesSnapshot().routines[1].name).toBe('Evening wrap')

    held.resolve(routine({ id: 'r-2', name: 'Evening wrap' }))
    await done
    expect(ids()).toEqual(['r-1', 'r-2'])
  })

  it('a refused create removes the provisional row', async () => {
    mocks.fetchRoutines.mockResolvedValue([routine()])
    await loadRoutines()
    mocks.createRoutine.mockRejectedValue(new Error('bad schedule'))

    await expect(createRoutine(CREATE_INPUT)).rejects.toThrow('bad schedule')
    expect(ids()).toEqual(['r-1'])
  })

  it('a refused delete puts the row back where it was', async () => {
    mocks.fetchRoutines.mockResolvedValue([routine({ id: 'r-a' }), routine({ id: 'r-b' }), routine({ id: 'r-c' })])
    await loadRoutines()
    mocks.deleteRoutine.mockRejectedValue(new Error('busy'))

    const failing = removeRoutine('r-b')
    expect(ids()).toEqual(['r-a', 'r-c'])
    await expect(failing).rejects.toThrow('busy')
    expect(ids()).toEqual(['r-a', 'r-b', 'r-c'])
  })

  it('a cron event during a write waits for the write instead of clobbering it', async () => {
    mocks.fetchRoutines.mockResolvedValue([routine()])
    await loadRoutines()
    const held = deferred<Routine>()
    mocks.toggleRoutine.mockReturnValue(held.promise)
    mocks.fetchRoutines.mockClear()

    const done = toggleRoutine('r-1')
    // The engine's own echo lands mid-write and would re-assert enabled: true.
    onRoutinesChanged()
    expect(mocks.fetchRoutines).not.toHaveBeenCalled()
    expect(getRoutinesSnapshot().routines[0].enabled).toBe(false)

    mocks.fetchRoutines.mockResolvedValue([routine({ enabled: false })])
    held.resolve(routine({ enabled: false }))
    await done
    await vi.waitFor(() => expect(mocks.fetchRoutines).toHaveBeenCalledTimes(1))
    expect(getRoutinesSnapshot().routines[0].enabled).toBe(false)
  })
})
