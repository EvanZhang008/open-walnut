/**
 * The project registry store (web/src/hooks/useProjectRegistry.ts) recovers a
 * boot-time load that was lost, instead of leaving every surface on task-derived
 * names (no source badges, every project "new") until a consumer remounts.
 *
 *  1. a retryable failure is retried on the registry schedule; `loaded` flips
 *     and the rows land with no reload;
 *  2. a 4xx is not retried and the store stays honest (`loaded: false`);
 *  3. `_ws:reconnected` re-pulls (pre-existing behaviour, pinned so it stays);
 *  4. a `fresh` load (a confirmed write, a reconnect) starts NOW and supersedes a
 *     boot load still retrying, instead of queueing behind its ~30s schedule;
 *  5. a superseded load's late answer cannot overwrite the newer one.
 *
 * The hook is read through a `useSyncExternalStore` stand-in that subscribes
 * and returns the snapshot, the same hook-without-a-DOM technique as
 * task-store-mutators.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../web/node_modules/react', () => ({
  useSyncExternalStore: <T,>(subscribe: (cb: () => void) => () => void, getSnapshot: () => T): T => {
    subscribe(() => {})
    return getSnapshot()
  },
  useMemo: <T,>(fn: () => T) => fn(),
  useCallback: <T,>(fn: T) => fn,
}))

const ws = vi.hoisted(() => {
  const handlers = new Map<string, Set<(data: unknown) => void>>()
  return {
    wsClient: {
      onEvent(name: string, cb: (data: unknown) => void) {
        let set = handlers.get(name)
        if (!set) { set = new Set(); handlers.set(name, set) }
        set.add(cb)
      },
      offEvent(name: string, cb: (data: unknown) => void) { handlers.get(name)?.delete(cb) },
    },
    emit(name: string) { for (const cb of handlers.get(name) ?? []) cb({}) },
  }
})
vi.mock('@/api/ws', () => ({ wsClient: ws.wsClient }))

const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('@/utils/log', () => ({ log: logMock }))

const projectsApi = vi.hoisted(() => ({ fetchProjects: vi.fn<() => Promise<unknown>>() }))
vi.mock('@/api/projects', () => projectsApi)

const { useProjectRegistry, resetProjectRegistryForTests, refreshProjectRegistry } = await import('@/hooks/useProjectRegistry')
const { ApiError } = await import('@/api/client')

const timeout = () => new DOMException('pool saturated', 'TimeoutError')
const answer = (...names: string[]) => ({
  projects: names.map((name) => ({ name, source: 'local', favorite: false, task_count: 0 })),
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  resetProjectRegistryForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('project registry recovery', () => {
  it('retries a lost boot-time load on the registry schedule and then reports loaded', async () => {
    projectsApi.fetchProjects
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce(answer('Marina', 'Acme'))

    // The first consumer's subscribe is the load trigger.
    expect(useProjectRegistry().loaded).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(projectsApi.fetchProjects).toHaveBeenCalledTimes(1)
    expect(useProjectRegistry().loaded).toBe(false)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(projectsApi.fetchProjects).toHaveBeenCalledTimes(2)
    const snap = useProjectRegistry()
    expect(snap.loaded).toBe(true)
    expect(snap.projectNames).toEqual(['Acme', 'Marina'])
    expect(snap.isKnownProject('marina')).toBe(true)
    expect(logMock.warn).toHaveBeenCalledWith(
      'tasks', 'project registry fetch failed, retrying in 2000ms', expect.objectContaining({ attempt: 1 }),
    )
  })

  it('does not retry a 4xx and stays honest about not having loaded', async () => {
    projectsApi.fetchProjects.mockRejectedValue(new ApiError(404, 'Not Found'))
    useProjectRegistry()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(projectsApi.fetchProjects).toHaveBeenCalledTimes(1)
    expect(useProjectRegistry().loaded).toBe(false)
  })

  it('a fresh load supersedes a boot load that is still retrying, and starts at once', async () => {
    projectsApi.fetchProjects
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce(answer('Marina'))
    useProjectRegistry()
    await vi.advanceTimersByTimeAsync(0)
    expect(projectsApi.fetchProjects).toHaveBeenCalledTimes(1)

    // 1s into the boot chain's 2s wait: a confirmed write asks for fresh rows.
    await vi.advanceTimersByTimeAsync(1_000)
    refreshProjectRegistry()
    await vi.advanceTimersByTimeAsync(0)
    expect(projectsApi.fetchProjects).toHaveBeenCalledTimes(2)
    expect(useProjectRegistry().loaded).toBe(true)
    expect(useProjectRegistry().projectNames).toEqual(['Marina'])

    // The superseded chain's retry never fires.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(projectsApi.fetchProjects).toHaveBeenCalledTimes(2)
  })

  it('a superseded load answering late cannot overwrite the newer rows', async () => {
    let resolveOld!: (v: unknown) => void
    projectsApi.fetchProjects
      .mockImplementationOnce(() => new Promise((res) => { resolveOld = res }))
      .mockResolvedValueOnce(answer('Marina', 'Acme'))
    useProjectRegistry()
    await vi.advanceTimersByTimeAsync(0)
    refreshProjectRegistry()
    await vi.advanceTimersByTimeAsync(0)
    expect(useProjectRegistry().projectNames).toEqual(['Acme', 'Marina'])

    resolveOld(answer('Stale'))
    await vi.advanceTimersByTimeAsync(0)
    expect(useProjectRegistry().projectNames).toEqual(['Acme', 'Marina'])
  })

  it('the socket coming back re-pulls the registry', async () => {
    projectsApi.fetchProjects.mockResolvedValue(answer('Marina'))
    useProjectRegistry()
    await vi.advanceTimersByTimeAsync(0)
    expect(projectsApi.fetchProjects).toHaveBeenCalledTimes(1)

    projectsApi.fetchProjects.mockResolvedValue(answer('Marina', 'Acme'))
    ws.emit('_ws:reconnected')
    await vi.advanceTimersByTimeAsync(0)
    expect(projectsApi.fetchProjects).toHaveBeenCalledTimes(2)
    expect(useProjectRegistry().projectNames).toEqual(['Acme', 'Marina'])
  })
})
