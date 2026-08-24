import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginApp } from '../../web/src/api/apps.js'

const mocks = vi.hoisted(() => ({
  fetchApps: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('@/api/apps', () => ({ fetchApps: mocks.fetchApps }))
vi.mock('@/utils/log', () => ({ log: { warn: mocks.warn } }))

import {
  __resetAppsCache,
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
})
