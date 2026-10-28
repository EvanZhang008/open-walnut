import { afterEach, describe, expect, it } from 'vitest'
import { FeatureNodeHub } from '../../../src/web/ws/feature-node-hub.js'
import type { Authority } from '../../../src/core/feature-nodes/contracts.js'
import { FakeClock, FakeTransport, authority, capability, deferred, flush, readFrame, reply } from './fakes.js'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
function setup(verify?: () => Promise<Authority | undefined>) {
  const clock = new FakeClock()
  const hub = new FeatureNodeHub(clock)
  const transport = new FakeTransport()
  let current: Authority | undefined = authority()
  const attached = hub.attach({ authority: current, verify: verify ?? (async () => current) }, transport)
  if (!attached.success) throw new Error('Synthetic hub attach failed')
  transport.deliver({ protocolVersion: 1, type: 'manifest', capabilities: [capability] })
  const frame = readFrame('call:1', { generation: attached.payload.generation, expiresAt: 5100 })
  cleanups.push(() => hub.close())
  return { clock, hub, transport, frame, identity: { authority: attached.payload.authority, verify: async () => current },
    revoke: () => { current = undefined }, revise: () => { current = { ...authority(), permissionVersion: 2 } } }
}

describe('feature node hub stays outside execution bridge routing', () => {
  it('lists only verified exact identities and relays a bounded correlated read', async () => {
    const f = setup()
    expect(await f.hub.list()).toEqual([{ authority: authority(), generation: f.frame.generation, capabilities: [capability] }])
    const pending = f.hub.read(JSON.stringify(f.frame))
    await expect.poll(() => f.transport.reads.length).toBe(1)
    reply(f.transport, f.transport.reads[0], { items: ['synthetic'] })
    expect(await pending).toMatchObject({ success: true, payload: { items: ['synthetic'] } })
    expect(f.hub.resources).toMatchObject({ calls: 0, bytes: 0 })
  })

  it('rejects execution, gateway, status, forged schemas and peer-granted identities', async () => {
    const f = setup()
    for (const input of [{ ev: 'gateway-request' }, { cmd: 'start' }, { ...f.frame, type: 'write' },
      { ...f.frame, accountId: 'other-account' }, { ...f.frame, fingerprint: 'peer-schema' },
      { ...f.frame, permissionVersion: 2 }]) {
      expect(await f.hub.read(JSON.stringify(input))).toMatchObject({ success: false })
    }
    expect(f.transport.reads).toHaveLength(0)
    f.transport.deliver({ protocolVersion: 1, type: 'manifest', capabilities: [capability], readonly: true })
    expect(f.hub.size).toBe(0)
  })

  it('limits four pending reads and releases resources after deadlines', async () => {
    const f = setup()
    const calls = Array.from({ length: 4 }, (_, index) => f.hub.read(JSON.stringify({ ...f.frame, correlationId: `call:${index}` })))
    await flush()
    expect(f.hub.resources.calls).toBe(4)
    expect(await f.hub.read(JSON.stringify({ ...f.frame, correlationId: 'excess' }))).toMatchObject({ success: false, code: 'busy' })
    f.clock.advance(5000)
    expect(await Promise.all(calls)).toEqual(expect.arrayContaining([expect.objectContaining({ success: false, code: 'expired' })]))
    expect(f.hub.resources).toMatchObject({ calls: 0, bytes: 0 })
    expect(f.transport.sent.filter((frame) => frame.type === 'cancel')).toHaveLength(4)
  })

  it('does not dispatch a new read using a verification started before revocation', async () => {
    const held = deferred<Authority | undefined>()
    let checks = 0
    let revoked = false
    const f = setup(() => {
      checks++
      return checks === 1 ? held.promise : Promise.resolve(revoked ? undefined : authority())
    })
    const checking = f.hub.check(f.frame.nodeId, f.frame.generation)
    await expect.poll(() => checks).toBe(1)
    revoked = true
    const call = f.hub.read(JSON.stringify(f.frame))
    held.resolve(authority())
    await checking
    expect(await call).toMatchObject({ success: false, code: 'denied' })
    expect(f.transport.reads).toHaveLength(0)
    expect(checks).toBe(2)
  })

  it('does not authorize a result using a verification started before revocation', async () => {
    const held = deferred<Authority | undefined>()
    let checks = 0
    let revoked = false
    const f = setup(() => {
      checks++
      if (checks === 2) return held.promise
      return Promise.resolve(revoked ? undefined : authority())
    })
    const call = f.hub.read(JSON.stringify(f.frame))
    await expect.poll(() => f.transport.reads.length).toBe(1)
    const checking = f.hub.check(f.frame.nodeId, f.frame.generation)
    await expect.poll(() => checks).toBe(2)
    revoked = true
    reply(f.transport, f.transport.reads[0], 'synthetic-private-data')
    held.resolve(authority())
    await checking
    expect(await call).toMatchObject({ success: false, code: 'denied' })
    expect(checks).toBe(3)
    expect(f.hub.size).toBe(0)
  })

  it('drops a revoked connection and never accepts its otherwise successful result', async () => {
    const f = setup()
    const call = f.hub.read(JSON.stringify(f.frame))
    await expect.poll(() => f.transport.reads.length).toBe(1)
    f.revoke()
    reply(f.transport, f.transport.reads[0], 'synthetic-private-data')
    expect(await call).toMatchObject({ success: false, code: 'denied' })
    expect(await f.hub.list()).toEqual([])
    expect(f.transport.listenerCount).toBe(0)
    expect(f.hub.resources.calls).toBe(0)
  })

  it('isolates reconnect generations and stale results without freeing the new read', async () => {
    const f = setup()
    const old = f.hub.read(JSON.stringify(f.frame))
    await flush()
    const replacement = new FakeTransport()
    const attached = f.hub.attach(f.identity, replacement)
    expect(await old).toMatchObject({ success: false, code: 'offline' })
    if (!attached.success) throw new Error('Synthetic reattach failed')
    replacement.deliver({ protocolVersion: 1, type: 'manifest', capabilities: [capability] })
    const frame = { ...f.frame, generation: attached.payload.generation }
    const call = f.hub.read(JSON.stringify(frame))
    await expect.poll(() => replacement.reads.length).toBe(1)
    reply(replacement, f.frame, 'stale')
    expect(f.hub.resources.calls).toBe(1)
    reply(replacement, replacement.reads[0], 'current')
    expect(await call).toMatchObject({ success: true, payload: 'current' })
  })

  it('bounds a hung credential check and accepts no read after its expiry', async () => {
    const held = deferred<Authority | undefined>()
    const f = setup(() => held.promise)
    const call = f.hub.read(JSON.stringify(f.frame))
    await flush()
    f.clock.advance(1000)
    expect(await call).toMatchObject({ success: false, code: 'denied' })
    expect(f.transport.reads).toHaveLength(0)
    held.resolve(authority())
    await flush()
    expect(f.hub.size).toBe(0)
  })

  it('does not reuse upstream correlations after a caller reuses an expired id', async () => {
    const f = setup()
    const first = f.hub.read(JSON.stringify(f.frame))
    await expect.poll(() => f.transport.reads.length).toBe(1)
    const old = f.transport.reads[0]
    f.clock.advance(5000)
    expect(await first).toMatchObject({ success: false, code: 'expired' })
    const next = f.hub.read(JSON.stringify({ ...f.frame, expiresAt: 10100 }))
    await expect.poll(() => f.transport.reads.length).toBe(2)
    expect(f.transport.reads[1].correlationId).not.toBe(old.correlationId)
    reply(f.transport, old, 'stale')
    expect(f.hub.resources.calls).toBe(1)
    reply(f.transport, f.transport.reads[1], 'current')
    expect(await next).toMatchObject({ success: true, payload: 'current' })
  })

  it('coalesces hung verification across listing and admitted reads before applying budget', async () => {
    const held = deferred<Authority | undefined>()
    let checks = 0
    const f = setup(() => { checks++; return held.promise })
    const listings = Array.from({ length: 100 }, () => f.hub.list())
    expect(new Set(listings).size).toBe(1)
    const calls = Array.from({ length: 4 }, (_, index) => f.hub.read(JSON.stringify({ ...f.frame, correlationId: `call:${index}` })))
    await flush()
    expect(checks).toBe(1)
    expect(await f.hub.read(JSON.stringify({ ...f.frame, correlationId: 'excess' }))).toMatchObject({ code: 'busy' })
    f.clock.advance(1000)
    expect(await Promise.all(calls)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'denied' })]))
    expect(await listings[0]).toEqual([])
    expect(f.hub.resources.verification).toBe(1)
    held.resolve(authority())
    await flush()
    expect(f.hub.resources.verification).toBe(0)
  })

  it('uses current grants even when a store reports the same version', async () => {
    const f = setup(async () => ({ ...authority(), grants: [] }))
    expect(await f.hub.read(JSON.stringify(f.frame))).toMatchObject({ success: false, code: 'denied' })
    expect(f.transport.reads).toHaveLength(0)
  })

  it('disposes a subscription that closes synchronously during registration', () => {
    const clock = new FakeClock()
    const hub = new FeatureNodeHub(clock)
    const transport = new FakeTransport()
    const original = transport.onClose.bind(transport)
    transport.onClose = (listener) => { const dispose = original(listener); listener(); return dispose }
    expect(hub.attach({ authority: authority(), verify: async () => authority() }, transport)).toMatchObject({ success: false })
    expect(transport.listenerCount).toBe(0)
    hub.close()
  })

  it('cleans pending calls when timer setup or transport send fails', async () => {
    const f = setup()
    f.transport.sendHook = () => false
    const call = f.hub.read(JSON.stringify(f.frame))
    expect(await call).toMatchObject({ success: false, code: 'offline' })
    expect(f.hub.resources).toMatchObject({ calls: 0, bytes: 0 })
    const next = setup()
    next.clock.throwSet = true
    expect(await next.hub.read(JSON.stringify(next.frame))).toMatchObject({ success: false })
    expect(next.hub.resources).toMatchObject({ calls: 0, bytes: 0 })
  })
})
