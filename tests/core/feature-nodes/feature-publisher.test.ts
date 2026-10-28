import { afterEach, describe, expect, it, vi } from 'vitest'
const created = vi.hoisted(() => [] as Array<{ api: { createClient(): object }; dispose: ReturnType<typeof vi.fn> }>)
vi.mock('../../../src/core/feature-nodes/feature-service.js', () => ({
  createFeatureNodesService: () => {
    let closed = false
    const service = {
      api: { createClient: () => { if (closed) throw new Error('Feature service unavailable'); return {} } },
      dispose: vi.fn(() => { closed = true }),
    }
    created.push(service)
    return service
  },
}))
import { publishFeatureNodes, disposeCoreServices } from '../../../src/core/platform-services.js'
import { getServiceEntry } from '../../../src/core/plugins/service-registry.js'

afterEach(() => { disposeCoreServices(); created.length = 0 })
describe('feature service publisher lifecycle', () => {
  it('withdraws and disposes the exact published generation', () => {
    const handle = publishFeatureNodes()
    const api = getServiceEntry('core:feature-nodes')!.api
    expect(api.createClient()).toEqual({})
    handle.dispose()
    expect(getServiceEntry('core:feature-nodes')).toBeUndefined()
    expect(created[0].dispose).toHaveBeenCalledTimes(1)
    expect(() => api.createClient()).toThrow('unavailable')
  })
  it('an old publication handle never disposes or withdraws its replacement', () => {
    const old = publishFeatureNodes()
    const oldApi = getServiceEntry('core:feature-nodes')!.api
    const latest = publishFeatureNodes()
    const currentApi = getServiceEntry('core:feature-nodes')!.api
    old.dispose()
    expect(getServiceEntry('core:feature-nodes')!.api).toBe(currentApi)
    expect(created[1].dispose).not.toHaveBeenCalled()
    expect(() => oldApi.createClient()).toThrow('unavailable')
    expect(currentApi.createClient()).toEqual({})
    latest.dispose()
    expect(created[1].dispose).toHaveBeenCalledTimes(1)
  })
})
