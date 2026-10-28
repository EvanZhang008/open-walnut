import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
const state = vi.hoisted(() => ({ wsUrl: 'ws://127.0.0.1:1', leader: true, connect: vi.fn() }))
vi.mock('../../../src/core/server-role.js', () => ({ role: () => state.leader ? 'leader' : 'replica' }))
vi.mock('../../../src/providers/local-daemon.js', () => ({ localDaemon: { get wsUrl() { return state.wsUrl } } }))
vi.mock('../../../src/providers/daemon-connection.js', () => ({ getDirectDaemonConnection: state.connect }))
import { createFeatureNodesService } from '../../../src/core/feature-nodes/feature-service.js'

const capability = { id: 'catalog.read', version: 1 }
const contract = { capability, fingerprint: 'catalog-v1', input: z.strictObject({ limit: z.number() }), output: z.strictObject({ items: z.array(z.string()) }) }
const call = { nodeId: 'reader', accountId: 'account', capability, input: { limit: 10 } }

describe('feature node service', () => {
  it('does not start local execution and degrades without a ready primary daemon', async () => {
    state.leader = false
    state.connect.mockClear()
    const service = createFeatureNodesService()
    const client = service.api.createClient()
    client.register(contract)
    expect(await client.read(call)).toEqual({ success: false, code: 'unavailable' })
    expect(state.connect).not.toHaveBeenCalled()
    service.dispose()
    expect(() => service.api.createClient()).toThrow('unavailable')
    state.leader = true
  })

  it('retains disposed client admission through underlying preparation and then allows recovery', async () => {
    vi.useFakeTimers()
    state.leader = true
    let release!: (value: unknown) => void
    state.connect.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const service = createFeatureNodesService()
    const results = []
    for (let index = 0; index < 64; index++) {
      const client = service.api.createClient()
      results.push(client.list())
      client.dispose()
    }
    expect(() => service.api.createClient()).toThrow('limit')
    expect(state.connect).toHaveBeenCalledTimes(1)
    expect(await Promise.all(results)).toEqual(Array.from({ length: 64 }, () => ({ success: false, code: 'cancelled' })))
    release({ connected: true, hasCapability: () => false, send: vi.fn() })
    await vi.advanceTimersByTimeAsync(0)
    const next = service.api.createClient()
    expect(await next.list()).toEqual({ success: false, code: 'unavailable' })
    next.dispose()
    service.dispose()
    vi.useRealTimers()
  })
})
