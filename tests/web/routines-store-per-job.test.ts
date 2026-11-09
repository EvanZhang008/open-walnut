import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { Routine } from '../../web/src/api/routines.js'

/**
 * A `cron:job-*` push reads the one job it names, never the whole list (2026-11-09: every quiet
 * trigger check sends one, and the page refetched the 1.2 MB list of 182 routines on each, 12 to
 * 30 times a minute: about 95% of the JSON the Mac app's page parsed, and the floor and most of the
 * swing of its 2 GB page process). Part one pins the store; part two walks web/src so a new
 * subscriber of those pushes cannot go back to refetching the list.
 */

const mocks = vi.hoisted(() => ({
  fetchRoutines: vi.fn(),
  fetchRoutine: vi.fn(),
  toggleRoutine: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('@/api/routines', () => ({
  fetchRoutines: mocks.fetchRoutines,
  fetchRoutine: mocks.fetchRoutine,
  toggleRoutine: mocks.toggleRoutine,
}))
vi.mock('@/utils/log', () => ({ log: { warn: mocks.warn, info: vi.fn() } }))

import {
  __resetRoutinesStore,
  getRoutinesSnapshot,
  loadRoutines,
  onRoutinesChanged,
  onRoutinesStale,
  subscribeRoutines,
  toggleRoutine,
} from '../../web/src/stores/routines-store.js'

function routine(id: string, over: Partial<Routine> = {}): Routine {
  return {
    id,
    name: `Routine ${id}`,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: 'every', everyMs: 60_000 },
    wakeMode: 'now',
    executor: { type: 'walnut-agent', config: { instructions: 'x' } },
    state: {},
    ...over,
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

const LIST = Array.from({ length: 30 }, (_, i) => routine(`r-${i}`))

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(500)
}

describe('routines store: a push reads its own job', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    __resetRoutinesStore()
    for (const fn of Object.values(mocks)) fn.mockReset()
    mocks.fetchRoutines.mockResolvedValue(LIST.map((r) => ({ ...r })))
    await loadRoutines()
    mocks.fetchRoutines.mockClear()
  })
  afterEach(() => { vi.useRealTimers() })

  it('a minute of quiet trigger checks fetches no list', async () => {
    mocks.fetchRoutine.mockImplementation(async (id: string) => routine(id, { state: { lastRunAtMs: 5 } }))
    for (let i = 0; i < 30; i++) {
      onRoutinesChanged({ action: 'updated', jobId: `r-${i % 3}` })
      await settle()
    }
    expect(mocks.fetchRoutines).not.toHaveBeenCalled()
    expect(mocks.fetchRoutine).toHaveBeenCalledTimes(30)
    expect(getRoutinesSnapshot().routines.find((r) => r.id === 'r-1')?.state.lastRunAtMs).toBe(5)
    expect(getRoutinesSnapshot().routines).toHaveLength(30)
  })

  it('a burst of pushes for one job is one read', async () => {
    mocks.fetchRoutine.mockImplementation(async (id: string) => routine(id))
    onRoutinesChanged({ action: 'started', jobId: 'r-2' })
    onRoutinesChanged({ action: 'updated', jobId: 'r-2' })
    onRoutinesChanged({ action: 'finished', jobId: 'r-2' })
    await settle()
    expect(mocks.fetchRoutine).toHaveBeenCalledTimes(1)
  })

  it('an unchanged job keeps its object and wakes no subscriber', async () => {
    const before = getRoutinesSnapshot()
    let woken = 0
    const unsub = subscribeRoutines(() => woken++)
    mocks.fetchRoutine.mockImplementation(async (id: string) => routine(id))
    onRoutinesChanged({ action: 'updated', jobId: 'r-4' })
    await settle()
    expect(woken).toBe(0)
    expect(getRoutinesSnapshot()).toBe(before)
    unsub()
  })

  it('a changed job is replaced in place; the others keep their objects', async () => {
    const other = getRoutinesSnapshot().routines[0]
    mocks.fetchRoutine.mockResolvedValue(routine('r-7', { enabled: false }))
    onRoutinesChanged({ action: 'updated', jobId: 'r-7' })
    await settle()
    const rows = getRoutinesSnapshot().routines
    expect(rows.findIndex((r) => r.id === 'r-7')).toBe(7)
    expect(rows[7].enabled).toBe(false)
    expect(rows[0]).toBe(other)
  })

  it('an added job is appended, a removed one dropped without a read', async () => {
    mocks.fetchRoutine.mockResolvedValue(routine('r-new'))
    onRoutinesChanged({ action: 'added', jobId: 'r-new' })
    onRoutinesChanged({ action: 'removed', jobId: 'r-3' })
    await settle()
    const ids = getRoutinesSnapshot().routines.map((r) => r.id)
    expect(ids).toContain('r-new')
    expect(ids).not.toContain('r-3')
    expect(mocks.fetchRoutine).toHaveBeenCalledTimes(1)
  })

  it('a job the server no longer has is dropped', async () => {
    mocks.fetchRoutine.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }))
    onRoutinesChanged({ action: 'updated', jobId: 'r-5' })
    await settle()
    expect(getRoutinesSnapshot().routines.map((r) => r.id)).not.toContain('r-5')
    expect(mocks.fetchRoutines).not.toHaveBeenCalled()
  })

  it('an older answer that lands after a newer one is dropped', async () => {
    const first = deferred<Routine>()
    const second = deferred<Routine>()
    mocks.fetchRoutine.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    onRoutinesChanged({ action: 'updated', jobId: 'r-6' })
    await settle()
    onRoutinesChanged({ action: 'updated', jobId: 'r-6' })
    await settle()
    second.resolve(routine('r-6', { name: 'newer' }))
    await settle()
    first.resolve(routine('r-6', { name: 'older' }))
    await settle()
    expect(getRoutinesSnapshot().routines.find((r) => r.id === 'r-6')?.name).toBe('newer')
  })

  it('a push with no job, a failed read, or a burst over the limit refetches the list', async () => {
    onRoutinesChanged({ action: 'updated' })
    await settle()
    expect(mocks.fetchRoutines).toHaveBeenCalledTimes(1)

    mocks.fetchRoutine.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }))
    onRoutinesChanged({ action: 'updated', jobId: 'r-1' })
    await settle()
    expect(mocks.fetchRoutines).toHaveBeenCalledTimes(2)

    mocks.fetchRoutine.mockReset()
    for (let i = 0; i < 25; i++) onRoutinesChanged({ action: 'updated', jobId: `r-${i}` })
    await settle()
    expect(mocks.fetchRoutine).not.toHaveBeenCalled()
    expect(mocks.fetchRoutines).toHaveBeenCalledTimes(3)
  })

  it('a list whose load failed is fetched whole again, never filled one row at a time', async () => {
    __resetRoutinesStore()
    mocks.fetchRoutines.mockRejectedValueOnce(new Error('server restarting'))
    await loadRoutines(true)
    expect(getRoutinesSnapshot().error).toBeTruthy()
    mocks.fetchRoutines.mockResolvedValue(LIST.map((r) => ({ ...r })))
    mocks.fetchRoutine.mockImplementation(async (id: string) => routine(id))
    onRoutinesChanged({ action: 'updated', jobId: 'r-1' })
    await settle()
    expect(mocks.fetchRoutine).not.toHaveBeenCalled()
    expect(getRoutinesSnapshot()).toMatchObject({ error: null })
    expect(getRoutinesSnapshot().routines).toHaveLength(30)
  })

  it('a reconnect fetches the whole list once (pushes sent while it was down are not replayed)', async () => {
    onRoutinesStale()
    onRoutinesChanged({ action: 'updated', jobId: 'r-1' })
    await settle()
    expect(mocks.fetchRoutines).toHaveBeenCalledTimes(1)
    expect(mocks.fetchRoutine).not.toHaveBeenCalled()
  })

  it('a just-added job the server does not have yet fetches the list instead of losing it', async () => {
    mocks.fetchRoutine.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }))
    onRoutinesChanged({ action: 'added', jobId: 'r-late' })
    await settle()
    expect(mocks.fetchRoutines).toHaveBeenCalledTimes(1)
  })

  it('a push during a write waits for it, then reads the job', async () => {
    const held = deferred<Routine>()
    mocks.toggleRoutine.mockReturnValue(held.promise)
    mocks.fetchRoutine.mockImplementation(async (id: string) => routine(id, { enabled: false }))
    const done = toggleRoutine('r-0')
    onRoutinesChanged({ action: 'updated', jobId: 'r-0' })
    await settle()
    expect(mocks.fetchRoutine).not.toHaveBeenCalled()
    held.resolve(routine('r-0', { enabled: false }))
    await done
    await settle()
    expect(mocks.fetchRoutine).toHaveBeenCalledWith('r-0')
    expect(mocks.fetchRoutines).not.toHaveBeenCalled()
  })
})

describe('subscribers of cron:job-* pushes', () => {
  const WEB = path.resolve(__dirname, '../../web/src')
  function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name)
      return e.isDirectory() ? files(full) : /\.(ts|tsx)$/.test(e.name) ? [full] : []
    })
  }

  it('hand the push to onRoutinesChanged, so it can read the job it names', () => {
    const subscribers = files(WEB).filter((f) => {
      const text = fs.readFileSync(f, 'utf8')
      return /['"`]cron:job-/.test(text) && /\b(?:useEvent|onEvent)\(/.test(text)
    })
    expect(subscribers.map((f) => path.relative(WEB, f)).sort()).toEqual(['hooks/useRoutines.ts', 'hooks/useTaskTriggers.ts'].map((p) => p.split('/').join(path.sep)))
    for (const f of subscribers) {
      const text = fs.readFileSync(f, 'utf8')
      expect(text, `${path.relative(WEB, f)} listens to cron:job-* pushes: pass each push to onRoutinesChanged(data)`)
        .toMatch(/onRoutinesChanged\(\s*data\b/)
      expect(text, `${path.relative(WEB, f)}: refetch the list when the socket reconnects (onRoutinesStale)`).toMatch(/_ws:reconnected[\s\S]{0,200}onRoutinesStale|onRoutinesStale[\s\S]{0,200}_ws:reconnected/)
      expect(text, `${path.relative(WEB, f)}: a push must never refetch the whole list`).not.toMatch(/onRoutinesChanged\(\s*\)|fetchRoutines\(/)
    }
  })

  it('only the store fetches the whole list', () => {
    const callers = files(WEB)
      .filter((f) => /\bfetchRoutines\(/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(WEB, f).split(path.sep).join('/'))
      .sort()
    expect(callers).toEqual(['api/routines.ts', 'stores/routines-store.ts'])
  })
})
