/**
 * GET /api/devices sharing (web/src/components/settings/sections/cloud/devices-list.ts):
 * concurrent readers share one request, but a read after a pairing or a removal
 * never joins a request that began before it (the new phone went missing when
 * a pairing landed while the pane's first read was still out).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pending: Array<{ resolve: (v: unknown) => void }> = []
vi.mock('@/api/client', () => ({
  apiGet: vi.fn(() => new Promise((resolve) => { pending.push({ resolve }) })),
}))

const events = new Map<string, Set<() => void>>()
vi.mock('@/api/ws', () => ({
  wsClient: {
    onEvent: vi.fn((name: string, cb: () => void) => { if (!events.has(name)) events.set(name, new Set()); events.get(name)!.add(cb) }),
    offEvent: vi.fn((name: string, cb: () => void) => { events.get(name)?.delete(cb) }),
  },
}))

const { apiGet } = await import('@/api/client')
const { fetchDevicesList, devicesListChanged, watchDevicesList, DEVICES_POLL_MS, BROWSER_SIGNED_IN_EVENT } = await import('../../web/src/components/settings/sections/cloud/devices-list.js')

beforeEach(() => {
  vi.mocked(apiGet).mockClear()
})

describe('fetchDevicesList', () => {
  it('shares one request between concurrent readers', async () => {
    const a = fetchDevicesList<{ n: number }>()
    const b = fetchDevicesList<{ n: number }>()
    expect(apiGet).toHaveBeenCalledTimes(1)
    pending.shift()!.resolve({ n: 1 })
    expect(await a).toEqual({ n: 1 })
    expect(await b).toEqual({ n: 1 })
  })

  it('asks again after a change even while an older read is still out', async () => {
    const before = fetchDevicesList<{ n: number }>()
    devicesListChanged()
    const after = fetchDevicesList<{ n: number }>()
    expect(apiGet).toHaveBeenCalledTimes(2)
    // A third reader after the change shares the NEW request, not the old one.
    const alsoAfter = fetchDevicesList<{ n: number }>()
    expect(apiGet).toHaveBeenCalledTimes(2)
    const [older, newer] = [pending.shift()!, pending.shift()!]
    newer.resolve({ n: 2 })
    older.resolve({ n: 1 })
    expect(await before).toEqual({ n: 1 })
    expect(await after).toEqual({ n: 2 })
    expect(await alsoAfter).toEqual({ n: 2 })
  })

  it('caches nothing once a read lands', async () => {
    const first = fetchDevicesList()
    pending.shift()!.resolve({})
    await first
    const second = fetchDevicesList()
    expect(apiGet).toHaveBeenCalledTimes(2)
    pending.shift()!.resolve({})
    await second
  })
})

describe('watchDevicesList (while a pane shows the list)', () => {
  it('a browser signing in, or the clock, tells every reader once; a read still out is not stacked on; the last reader stops it all', async () => {
    vi.useFakeTimers()
    const told: string[] = []
    vi.stubGlobal('document', { visibilityState: 'visible' })
    vi.stubGlobal('window', { dispatchEvent: (e: Event) => { told.push(e.type); return true } })
    try {
      const stopA = watchDevicesList()
      const stopB = watchDevicesList()
      // One listener for both readers.
      expect(events.get(BROWSER_SIGNED_IN_EVENT)?.size).toBe(1)
      for (const cb of events.get(BROWSER_SIGNED_IN_EVENT)!) cb()
      expect(told).toEqual(['walnut:devices-changed'])
      vi.advanceTimersByTime(DEVICES_POLL_MS)
      expect(told).toHaveLength(2)
      // A slow read: the next tick waits for it.
      const slow = fetchDevicesList()
      vi.advanceTimersByTime(DEVICES_POLL_MS)
      expect(told).toHaveLength(2)
      pending.shift()!.resolve({})
      await slow
      vi.advanceTimersByTime(DEVICES_POLL_MS)
      expect(told).toHaveLength(3)
      stopA()
      stopA()
      expect(events.get(BROWSER_SIGNED_IN_EVENT)?.size).toBe(1)
      stopB()
      expect(events.get(BROWSER_SIGNED_IN_EVENT)?.size).toBe(0)
      vi.advanceTimersByTime(DEVICES_POLL_MS * 3)
      expect(told).toHaveLength(3)
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
})
