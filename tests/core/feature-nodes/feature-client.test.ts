import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { FeatureNodeClient, type FeatureRelayConnection } from '../../../src/core/feature-nodes/feature-client.js'

const capability = { id: 'catalog.read', version: 1 }
const contract = { capability, fingerprint: 'catalog-v1', input: z.strictObject({ limit: z.number().int().min(1).max(100) }), output: z.strictObject({ items: z.array(z.string()).max(100) }) }
const node = { authority: { nodeId: 'reader', accountId: 'account', permissionVersion: 1, grants: [{ capability, fingerprint: contract.fingerprint }] }, generation: 'generation:1', capabilities: [capability] }
const call = { nodeId: 'reader', accountId: 'account', capability, input: { limit: 10 } }
function fixture() {
  const send = vi.fn(async (_command: string, params: Record<string, unknown>) => {
    if (params.frame === null) return { result: { success: true, payload: { items: [node], nextCursor: null } } }
    const frame = JSON.parse(params.frame as string)
    if (frame.type === 'lookup') return { result: { success: true, payload: node } }
    return { result: { protocolVersion: 1, type: 'result', generation: frame.generation, correlationId: frame.correlationId, success: true, payload: { items: ['entry'] } } }
  })
  const connection: FeatureRelayConnection = { hasCapability: () => true, send }
  const client = new FeatureNodeClient(() => connection)
  const unregister = client.register(contract)
  return { client, connection, send, unregister }
}

describe('FeatureNodeClient', () => {
  it('pages all 32 nodes at maximum grants and capabilities without aggregate frame overflow', async () => {
    const { client, send } = fixture()
    const nodes = Array.from({ length: 32 }, (_, index) => ({
      ...node, authority: { ...node.authority, nodeId: `reader-${String(index).padStart(2, '0')}`,
        grants: Array.from({ length: 64 }, (_, grant) => ({ capability: { id: `catalog-${grant}`, version: 1 }, fingerprint: `catalog-${grant}` })) },
      capabilities: Array.from({ length: 64 }, (_, cap) => ({ id: `catalog-${cap}`, version: 1 })),
    }))
    send.mockImplementation(async (_command, params) => {
      const after = params.frame === null ? null : JSON.parse(params.frame as string).after
      const index = after === null ? 0 : nodes.findIndex((value) => value.authority.nodeId === after) + 1
      return { result: { success: true, payload: { items: [nodes[index]], nextCursor: index < 31 ? nodes[index].authority.nodeId : null } } } as never
    })
    expect(await client.list()).toEqual({ success: true, payload: nodes })
    expect(send).toHaveBeenCalledTimes(32)
    client.dispose()
  })

  it('keeps typed relay failure codes for discovery and reads', async () => {
    const { client, send } = fixture()
    send.mockResolvedValue({ result: { success: false, code: 'busy' } } as never)
    expect(await client.list()).toEqual({ success: false, code: 'busy' })
    expect(await client.read(call)).toEqual({ success: false, code: 'busy' })
    client.dispose()
  })

  it('starts deadline and admission before asynchronous connection preparation', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const prepare = vi.fn(() => waiting)
    const { connection, send } = fixture()
    const client = new FeatureNodeClient(() => connection, prepare)
    client.register(contract)
    const requests = Array.from({ length: 4 }, () => client.read({ ...call, timeoutMs: 50 }))
    expect(await client.read(call)).toEqual({ success: false, code: 'busy' })
    expect(prepare).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(50)
    expect(await Promise.all(requests)).toEqual(Array.from({ length: 4 }, () => ({ success: false, code: 'expired' })))
    expect(send).not.toHaveBeenCalled()
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(send).not.toHaveBeenCalled()
    expect(client.resources).toEqual({ calls: 0, bytes: 0 })
    client.dispose()
    vi.useRealTimers()
  })

  it('reads repeatedly through a trusted installed contract', async () => {
    const { client, send } = fixture()
    for (let index = 0; index < 3; index++) expect(await client.read(call)).toEqual({ success: true, payload: { items: ['entry'] } })
    expect(send).toHaveBeenCalledTimes(6)
    expect(client.resources).toEqual({ calls: 0, bytes: 0 })
    client.dispose()
  })

  it('degrades an old daemon without sending an unknown command', async () => {
    const { client, connection, send } = fixture()
    connection.hasCapability = () => false
    expect(await client.read(call)).toEqual({ success: false, code: 'unavailable' })
    expect(send).not.toHaveBeenCalled()
    client.dispose()
  })

  it('rejects input, account mismatch, unsupported capabilities and malformed list data', async () => {
    const { client, send } = fixture()
    expect(await client.read({ ...call, input: { limit: 101 } })).toEqual({ success: false, code: 'invalid_input' })
    expect(send).not.toHaveBeenCalled()
    expect(await client.read({ ...call, accountId: 'other' })).toEqual({ success: false, code: 'denied' })
    send.mockResolvedValueOnce({ result: { success: true, payload: [{ ...node, capabilities: [{ id: 'bad id', version: 1 }] }] } } as never)
    expect(await client.list()).toEqual({ success: false, code: 'invalid_output' })
    send.mockResolvedValueOnce({ result: { success: true, payload: { ...node, capabilities: [] } } } as never)
    expect(await client.read(call)).toEqual({ success: false, code: 'unavailable' })
    client.dispose()
  })

  it('bounds targeted lookup admission before waiting', async () => {
    const { client, send } = fixture()
    const releases: Array<(value: Record<string, unknown>) => void> = []
    send.mockImplementation(() => new Promise((resolve) => { releases.push(resolve) }))
    const controller = new AbortController()
    const requests = Array.from({ length: 4 }, () => client.read({ ...call, signal: controller.signal }))
    expect(await client.read(call)).toEqual({ success: false, code: 'busy' })
    await expect.poll(() => send.mock.calls.length).toBe(4)
    controller.abort()
    expect(await Promise.all(requests)).toEqual(Array.from({ length: 4 }, () => ({ success: false, code: 'cancelled' })))
    expect(client.resources.calls).toBe(4)
    for (const release of releases) release({ result: { success: true, payload: node } })
    await expect.poll(() => client.resources.calls).toBe(0)
    expect(client.resources.bytes).toBe(0)
    client.dispose()
  })

  it('keeps expired underlying reads admitted until transport settlement', async () => {
    vi.useFakeTimers()
    const { client, send } = fixture()
    let release!: (value: Record<string, unknown>) => void
    send.mockImplementationOnce(async () => ({ result: { success: true, payload: node } } as never))
    send.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const request = client.read({ ...call, timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    expect(await request).toEqual({ success: false, code: 'expired' })
    expect(client.resources.calls).toBe(1)
    release({ result: {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(client.resources).toEqual({ calls: 0, bytes: 0 })
    client.dispose()
    vi.useRealTimers()
  })

  it('rejects a wrong correlation, output and replaced transport', async () => {
    const { client, connection, send } = fixture()
    const original = send.getMockImplementation()!
    send.mockImplementation(async (command, params) => {
      const result = await original(command, params)
      if (params.frame !== null && JSON.parse(params.frame as string).type === 'read') (result.result as Record<string, unknown>).correlationId = 'other'
      return result
    })
    expect(await client.read(call)).toEqual({ success: false, code: 'invalid_output' })
    send.mockImplementation(async (command, params) => {
      const result = await original(command, params)
      if (params.frame !== null && JSON.parse(params.frame as string).type === 'read') (result.result as Record<string, unknown>).payload = { items: [42] }
      return result
    })
    expect(await client.read(call)).toEqual({ success: false, code: 'invalid_output' })
    let current: FeatureRelayConnection = connection
    const switched = new FeatureNodeClient(() => current)
    switched.register(contract)
    send.mockImplementation(async (command, params) => {
      const result = await original(command, params)
      if (params.frame !== null && JSON.parse(params.frame as string).type === 'read') current = { ...connection }
      return result
    })
    expect(await switched.read(call)).toEqual({ success: false, code: 'offline' })
    switched.dispose()
    client.dispose()
  })

  it('rejects a contract withdrawn while listing and cancels on dispose', async () => {
    const { client, send, unregister } = fixture()
    send.mockImplementationOnce(async () => { unregister(); return { result: { success: true, payload: node } } as never })
    expect(await client.read(call)).toEqual({ success: false, code: 'unavailable' })
    expect(send).toHaveBeenCalledTimes(1)
    client.register(contract)
    let release!: (value: Record<string, unknown>) => void
    send.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const pending = client.read(call)
    await expect.poll(() => send.mock.calls.length).toBe(2)
    client.dispose()
    expect(await pending).toEqual({ success: false, code: 'cancelled' })
    expect(await client.read(call)).toEqual({ success: false, code: 'unavailable' })
    release({ result: { success: true, payload: node } })
    await expect.poll(() => client.resources.calls).toBe(0)
  })
})
