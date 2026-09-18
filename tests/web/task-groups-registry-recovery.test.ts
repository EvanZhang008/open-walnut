/**
 * The task store's folder-name registry (`refetchGroups` in `useTasks`) recovers
 * from a lost answer instead of leaving every folder nameless.
 *
 * The 2026-09-17 report: a hidden tab reloaded onto a new build while the server
 * was stalled; the registry's one fetch was rejected by the connection queue and
 * swallowed, and from then on every folder row rendered as a bare icon + count
 * ("🗂 2") until a manual reload, while the task list, which retries, recovered.
 *
 * Pinned here:
 *  1. a retryable failure is retried on the registry schedule and the names
 *     land without any reload;
 *  2. a later refetch that fails for good keeps the names the page already has
 *     (the map is only ever replaced by a successful answer);
 *  3. a stale answer (older call resolving after a newer one) is discarded;
 *  4. a newer call cancels an older one still waiting to retry;
 *  5. a 4xx is not retried.
 *
 * Same hook-without-a-DOM technique as task-store-mutators.test.ts (React
 * primitives replaced by stand-ins, the REAL hook invoked directly). The hook's
 * mount effect is a no-op here, so the registry fetch is driven through the
 * `task:groups-changed` handler the hook registers, which calls the very same
 * `refetchGroups`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stateSlots: unknown[] = []
let stateIdx = 0

vi.mock('../../web/node_modules/react', () => ({
  useState: <T,>(initial: T) => {
    const slot = stateIdx++
    if (!(slot in stateSlots)) {
      stateSlots[slot] = typeof initial === 'function' ? (initial as () => T)() : initial
    }
    const set = (next: unknown) => {
      stateSlots[slot] = typeof next === 'function'
        ? (next as (prev: unknown) => unknown)(stateSlots[slot])
        : next
    }
    return [stateSlots[slot], set] as const
  },
  useCallback: <T,>(fn: T) => fn,
  useEffect: () => {},
  useRef: <T,>(initial: T) => ({ current: initial }),
  startTransition: (fn: () => void) => fn(),
}))

const eventHandlers = new Map<string, (data?: unknown) => void>()
vi.mock('@/hooks/useWebSocket', () => ({
  useEvent: (name: string, handler: (data?: unknown) => void) => eventHandlers.set(name, handler),
}))

const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('@/utils/log', () => ({ log: logMock }))

const api = {
  fetchTasks: vi.fn(async () => []),
  fetchTaskGroups: vi.fn<() => Promise<unknown[]>>(),
}
vi.mock('@/api/tasks', () => api)

const { useTasks } = await import('@/hooks/useTasks')
const { ApiError } = await import('@/api/client')

function group(id: string, label: string) {
  return { group_id: id, label, hidden: false, member_ids: ['t1'], project: 'Marina' }
}

const timeout = () => new DOMException('Request queued 20000ms without a free connection — pool saturated', 'TimeoutError')

/** First render: registers the WS handlers this test drives. */
function mount() {
  eventHandlers.clear()
  stateSlots.length = 0
  stateIdx = 0
  return useTasks()
}

/** Re-render: the same slots, read back. */
function render() {
  stateIdx = 0
  return useTasks()
}

/** The hook's own registry refresh (what mount, WS connect and groups-changed all call). */
function refetchGroups() {
  const handler = eventHandlers.get('task:groups-changed')
  if (!handler) throw new Error('useTasks did not register task:groups-changed')
  handler()
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  api.fetchTasks.mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('folder-name registry recovery', () => {
  it('retries a lost boot-time answer on the registry schedule; the names land with no reload', async () => {
    api.fetchTaskGroups
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce([group('g1', 'Acme Rearchitecture')])
    mount()
    refetchGroups()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.fetchTaskGroups).toHaveBeenCalledTimes(1)
    expect(render().taskGroups).toEqual({})

    // The old code stopped here forever. First retry is scheduled at 2s.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(api.fetchTaskGroups).toHaveBeenCalledTimes(2)
    expect(render().taskGroups).toEqual({ g1: 'Acme Rearchitecture' })
    expect(render().folderMeta.g1).toMatchObject({ project: 'Marina', memberCount: 1 })
    expect(logMock.warn).toHaveBeenCalledWith(
      'tasks', 'task folder registry fetch failed, retrying in 2000ms', expect.objectContaining({ attempt: 1 }),
    )
  })

  it('a refetch that fails for good keeps the names the page already has', async () => {
    api.fetchTaskGroups.mockResolvedValueOnce([group('g1', 'Session Status Bug')])
    mount()
    refetchGroups()
    await vi.advanceTimersByTimeAsync(0)
    expect(render().taskGroups).toEqual({ g1: 'Session Status Bug' })

    api.fetchTaskGroups.mockRejectedValue(timeout())
    refetchGroups()
    // Spend the whole schedule (2+4+8+16s) and then some.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api.fetchTaskGroups).toHaveBeenCalledTimes(1 + 5)
    expect(render().taskGroups).toEqual({ g1: 'Session Status Bug' })
    expect(logMock.error).toHaveBeenCalledWith(
      'tasks', 'task folder registry fetch failed', expect.objectContaining({ exhausted: true }),
    )
  })

  it('an older call that answers after a newer one is discarded', async () => {
    const first = deferred<unknown[]>()
    const second = deferred<unknown[]>()
    api.fetchTaskGroups.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    mount()
    refetchGroups()
    refetchGroups()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.fetchTaskGroups).toHaveBeenCalledTimes(2)

    second.resolve([group('g2', 'newer answer')])
    await vi.advanceTimersByTimeAsync(0)
    expect(render().taskGroups).toEqual({ g2: 'newer answer' })

    first.resolve([group('g1', 'stale answer')])
    await vi.advanceTimersByTimeAsync(0)
    expect(render().taskGroups).toEqual({ g2: 'newer answer' })
  })

  it('a newer call cancels the wait of an older one still retrying', async () => {
    api.fetchTaskGroups
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce([group('g1', 'from the newer call')])
    mount()
    refetchGroups()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.fetchTaskGroups).toHaveBeenCalledTimes(1)

    // Supersede it 1s into its 2s wait: the older retry must never fire.
    await vi.advanceTimersByTimeAsync(1_000)
    refetchGroups()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.fetchTaskGroups).toHaveBeenCalledTimes(2)
    expect(render().taskGroups).toEqual({ g1: 'from the newer call' })

    await vi.advanceTimersByTimeAsync(60_000)
    expect(api.fetchTaskGroups).toHaveBeenCalledTimes(2)
    // An abort is not a failure.
    expect(logMock.error).not.toHaveBeenCalled()
  })

  it('does not retry a 4xx: the server answered', async () => {
    api.fetchTaskGroups.mockRejectedValue(new ApiError(404, 'Not Found'))
    mount()
    refetchGroups()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api.fetchTaskGroups).toHaveBeenCalledTimes(1)
    expect(render().taskGroups).toEqual({})
    expect(logMock.warn).toHaveBeenCalledWith(
      'tasks', 'task folder registry fetch failed', expect.objectContaining({ retryable: false }),
    )
    expect(logMock.error).not.toHaveBeenCalled()
  })
})
