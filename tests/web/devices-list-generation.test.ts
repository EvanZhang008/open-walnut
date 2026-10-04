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

const { apiGet } = await import('@/api/client')
const { fetchDevicesList, devicesListChanged } = await import('../../web/src/components/settings/sections/cloud/devices-list.js')

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
