/**
 * GETs that several modules fire during one page load share ONE request.
 *
 * A cold load sent GET /api/config five times (each hook module kept its own
 * cache) and the system health and git-sync status three times each (every
 * useSystemHealth consumer fetched on its own), 2026-09-29. Pinned here:
 *  1. concurrent and closely following callers get one request, each with its
 *     own copy of the answer;
 *  2. the answer is not reused once the short memo has passed, after a failure,
 *     after a config write (started before or during it), or after the WS event
 *     that announces a change, which drops it before any named listener runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ apiGet: vi.fn(), apiPut: vi.fn(), apiPost: vi.fn() }))
vi.mock('@/api/client', () => api)
const socket = vi.hoisted(() => ({ wildcard: null as null | ((name: string, data: unknown) => void) }))
vi.mock('@/api/ws', () => ({
  wsClient: { subscribeAll: (cb: (name: string, data: unknown) => void) => { socket.wildcard = cb; return () => {} } },
}))

import { _resetServerFactsForTest, fetchConfig, fetchInstallDir, updateConfig } from '../../web/src/api/config'
import { resetSharedGetsForTest, sharedGet } from '../../web/src/api/shared-get'

const answer = () => ({ config: { ui: { show_priority: true } }, envTokenHint: 'env', installDir: '/src/walnut' })
const flush = () => new Promise((r) => setTimeout(r, 0))

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  // No shared answer, a fresh clock, request mocks with no recorded calls.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-29T12:00:00.000Z'))
  resetSharedGetsForTest()
  _resetServerFactsForTest()
  api.apiGet.mockReset()
  api.apiPut.mockReset()
  api.apiGet.mockImplementation(async () => answer())
  api.apiPut.mockResolvedValue({ ok: true })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GET /api/config is shared', () => {
  it('five mounts and the page-lifetime helpers send ONE request, each caller owning its copy', async () => {
    const pending = deferred<ReturnType<typeof answer>>()
    api.apiGet.mockImplementationOnce(() => pending.promise)
    const reads = [fetchConfig(), fetchConfig(), fetchConfig(), fetchConfig(), fetchConfig()]
    const installDir = fetchInstallDir()
    pending.resolve(answer())
    const configs = await Promise.all(reads)

    expect(api.apiGet).toHaveBeenCalledTimes(1)
    expect(api.apiGet).toHaveBeenCalledWith('/api/config')
    expect(await installDir).toBe('/src/walnut')
    expect(configs[0]).toEqual({ ui: { show_priority: true }, _envTokenHint: 'env' })
    configs[0].ui!.show_priority = false
    expect(configs[1].ui?.show_priority).toBe(true)
    expect(configs[0]).not.toBe(configs[1])
  })

  it('a mount shortly after the answer reuses it; one after the memo sends a new request', async () => {
    await fetchConfig()
    vi.setSystemTime(Date.now() + 2_500)
    await fetchConfig()
    expect(api.apiGet).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + 600)
    await fetchConfig()
    expect(api.apiGet).toHaveBeenCalledTimes(2)
  })

  it('a failed request is not reused', async () => {
    api.apiGet.mockRejectedValueOnce(new Error('offline'))
    await expect(fetchConfig()).rejects.toThrow('offline')
    await fetchConfig()
    expect(api.apiGet).toHaveBeenCalledTimes(2)
  })

  it('a config write drops the answer, including a read that started during the write', async () => {
    await fetchConfig()
    const put = deferred<{ ok: boolean }>()
    api.apiPut.mockImplementationOnce(() => put.promise)
    const write = updateConfig({ ui: { show_priority: false } } as never)
    // A read racing the write: it may be answered before the server applies it.
    const racing = fetchConfig()
    expect(api.apiGet).toHaveBeenCalledTimes(2)
    put.resolve({ ok: true })
    await write
    await racing
    await fetchConfig()
    expect(api.apiGet).toHaveBeenCalledTimes(3)
  })

  it('config:changed drops the answer before a component hears the event', async () => {
    await fetchConfig()
    expect(socket.wildcard).toBeTypeOf('function')
    socket.wildcard!('config:changed', { key: 'ui' })
    await fetchConfig()
    expect(api.apiGet).toHaveBeenCalledTimes(2)
    // An unrelated event leaves it alone.
    socket.wildcard!('task:updated', {})
    await fetchConfig()
    expect(api.apiGet).toHaveBeenCalledTimes(2)
  })
})

describe('raw-fetch GETs (system health) share one request too', () => {
  it('three consumers mounting at once send one request; its WS event drops the answer', async () => {
    let requests = 0
    const load = async () => { requests++; return { claudeCliAvailable: true } }
    const answers = await Promise.all([1, 2, 3].map(() => sharedGet('/api/system/health', load, { invalidateOn: ['system:health'] })))
    expect(requests).toBe(1)
    expect(answers).toEqual([{ claudeCliAvailable: true }, { claudeCliAvailable: true }, { claudeCliAvailable: true }])

    socket.wildcard!('system:health', { claudeCliAvailable: false })
    await sharedGet('/api/system/health', load, { invalidateOn: ['system:health'] })
    expect(requests).toBe(2)
    await flush()
  })
})
