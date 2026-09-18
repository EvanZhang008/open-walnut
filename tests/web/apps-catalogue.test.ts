import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginApp } from '../../web/src/api/apps.js'

const mocks = vi.hoisted(() => ({
  fetchApps: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

// A stand-in for the WS singleton: the module-scope `_ws:reconnected`
// registration is captured so the test can be the socket coming back.
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

vi.mock('@/api/apps', () => ({ fetchApps: mocks.fetchApps }))
vi.mock('@/api/ws', () => ({ wsClient: ws.wsClient }))
vi.mock('@/utils/log', () => ({ log: { warn: mocks.warn, error: mocks.error, info: vi.fn(), debug: vi.fn() } }))

import {
  __resetAppsCache,
  __subscribeAppsForTests,
  refreshAppsCatalogue,
} from '../../web/src/hooks/useApps.js'

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function app(id: string): PluginApp {
  return {
    id,
    pluginId: id,
    title: id,
    icon: null,
    url: `/plugin-apps/${id}/app/index.html`,
  }
}

describe('Plugin App catalogue', () => {
  beforeEach(() => {
    __resetAppsCache()
    mocks.fetchApps.mockReset()
    mocks.warn.mockReset()
  })

  it('queues a forced refresh behind an in-flight response', async () => {
    const first = deferred<PluginApp[]>()
    mocks.fetchApps
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([app('after-change')])

    const initial = refreshAppsCatalogue()
    const forced = refreshAppsCatalogue()
    expect(mocks.fetchApps).toHaveBeenCalledTimes(1)

    first.resolve([app('before-change')])
    await Promise.all([initial, forced])

    expect(mocks.fetchApps).toHaveBeenCalledTimes(2)
  })

  // A boot-time answer lost to a stalled server (2026-09-17: the connection
  // queue rejected it) used to leave the sidebar with no apps until a reload,
  // because the empty fallback list counted as "loaded".
  describe('a lost answer is not a verdict', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    const timeout = () => new DOMException('pool saturated', 'TimeoutError')

    it('retries a retryable failure on the registry schedule and settles on the recovered list', async () => {
      mocks.fetchApps
        .mockRejectedValueOnce(timeout())
        .mockResolvedValueOnce([app('recovered')])
      const load = refreshAppsCatalogue()
      await vi.advanceTimersByTimeAsync(2_000)
      await load
      expect(mocks.fetchApps).toHaveBeenCalledTimes(2)
      expect(mocks.error).not.toHaveBeenCalled()
    })

    it('publishes the empty catalogue on the FIRST failure so the app page stops spinning, while retries go on', async () => {
      // The app host page renders a spinner until the first notify; a fetch that
      // is retried for 30s must not hold that spinner for 30s.
      const notified: number[] = []
      const unsubscribe = __subscribeAppsForTests(() => { notified.push(mocks.fetchApps.mock.calls.length) })
      mocks.fetchApps
        .mockRejectedValueOnce(timeout())
        .mockResolvedValueOnce([app('late')])
      const load = refreshAppsCatalogue()
      await vi.advanceTimersByTimeAsync(0)
      // Notified once, right after the first failure, with the retry still pending.
      expect(notified).toEqual([1])
      expect(mocks.fetchApps).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(2_000)
      await load
      // Second notify carries the recovered list.
      expect(notified).toEqual([1, 2])
      unsubscribe()
    })

    it('after the schedule is spent, falls back to an empty list and asks again when the socket comes back', async () => {
      mocks.fetchApps.mockRejectedValue(timeout())
      const load = refreshAppsCatalogue()
      await vi.advanceTimersByTimeAsync(60_000)
      await load
      expect(mocks.fetchApps).toHaveBeenCalledTimes(5)
      expect(mocks.error).toHaveBeenCalledWith('apps', 'plugin app catalogue fetch failed', expect.objectContaining({ exhausted: true }))

      mocks.fetchApps.mockReset()
      mocks.fetchApps.mockResolvedValue([app('back')])
      ws.emit('_ws:reconnected')
      await vi.advanceTimersByTimeAsync(0)
      expect(mocks.fetchApps).toHaveBeenCalledTimes(1)
    })

    it('a reconnect after a GOOD answer does not refetch (the list was never wrong)', async () => {
      mocks.fetchApps.mockResolvedValue([app('fine')])
      await refreshAppsCatalogue()
      mocks.fetchApps.mockClear()
      ws.emit('_ws:reconnected')
      await vi.advanceTimersByTimeAsync(0)
      expect(mocks.fetchApps).not.toHaveBeenCalled()
    })
  })
})
