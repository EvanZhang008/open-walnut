import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFeatureRelay, type FeatureRelaySocket } from '../../src/providers/feature-relay-core.js'

function socket(): FeatureRelaySocket & { frames: Array<Record<string, unknown>> } {
  const frames: Array<Record<string, unknown>> = []
  return { frames, send: (text) => { frames.push(JSON.parse(text)); return true } }
}
afterEach(() => { vi.useRealTimers() })
describe('read-only feature relay', () => {
  it('waits for the exact bridge response instead of acknowledging uplink acceptance', () => {
    const relay = createFeatureRelay('fixture-nonce')
    const caller = socket(), bridge = socket(), imposter = socket()
    relay.request(caller, 1, bridge, 'synthetic-read', () => true)
    expect(caller.frames).toEqual([])
    const requestId = bridge.frames[0].requestId
    expect(relay.result(imposter, requestId, { success: true, payload: 'forged' })).toBe(false)
    expect(relay.result(bridge, requestId, { success: true, payload: 'synthetic' })).toBe(true)
    expect(caller.frames).toEqual([{ id: 1, ok: true, result: { success: true, payload: 'synthetic' } }])
    expect(relay.result(bridge, requestId, { success: true, payload: 'duplicate' })).toBe(false)
    expect(relay.pendingCount).toBe(0)
  })
  it('rejects non-read envelopes, caps pending calls and expires without replay', () => {
    vi.useFakeTimers()
    const relay = createFeatureRelay('fixture-nonce')
    const caller = socket(), bridge = socket()
    relay.request(caller, 1, bridge, { cmd: 'start' }, () => true)
    expect(bridge.frames).toEqual([])
    for (let index = 0; index < 64; index++) relay.request(caller, index + 2, bridge, null, () => true)
    relay.request(caller, 100, bridge, null, () => true)
    expect(caller.frames.at(-1)).toMatchObject({ result: { code: 'busy' } })
    expect(relay.pendingCount).toBe(64)
    vi.advanceTimersByTime(10000)
    expect(relay.pendingCount).toBe(0)
    expect(caller.frames.at(-1)).toMatchObject({ result: { code: 'expired' } })
    expect(relay.result(bridge, bridge.frames[0].requestId, { success: true })).toBe(false)
  })
  it('fails offline on a disconnected bridge and drains disconnected callers', () => {
    const relay = createFeatureRelay('fixture-nonce')
    const caller = socket(), bridge = socket()
    relay.request(caller, 1, bridge, null, () => true)
    relay.disconnect(bridge)
    expect(caller.frames.at(-1)).toMatchObject({ result: { code: 'offline' } })
    relay.request(caller, 2, bridge, null, () => true)
    relay.disconnect(caller)
    expect(relay.pendingCount).toBe(0)
  })
  it('checks source authority again before delivering a result', () => {
    const relay = createFeatureRelay('fixture-nonce')
    const caller = socket(), bridge = socket()
    let authorized = true
    relay.request(caller, 1, bridge, null, () => authorized)
    authorized = false
    expect(relay.result(bridge, bridge.frames[0].requestId, { success: true, payload: 'private' })).toBe(true)
    expect(caller.frames).toEqual([{ id: 1, ok: true, result: { success: false, code: 'denied' } }])
    relay.request(caller, 2, bridge, null, () => authorized)
    expect(bridge.frames).toHaveLength(1)
    expect(relay.pendingCount).toBe(0)
  })
  it('uses injected nonces to separate repeated caller ids across relay instances', () => {
    const caller = socket(), bridge = socket()
    const first = createFeatureRelay('first-nonce'), next = createFeatureRelay('next-nonce')
    first.request(caller, 1, bridge, null, () => true)
    first.disconnect(caller)
    next.request(caller, 1, bridge, null, () => true)
    expect(bridge.frames[0].requestId).not.toBe(bridge.frames[1].requestId)
    expect(next.result(bridge, bridge.frames[0].requestId, { success: true, payload: 'stale' })).toBe(false)
    next.disconnect(caller)
  })
  it('bounds bytes across pending requests and result serialization', () => {
    const relay = createFeatureRelay('fixture-nonce')
    const caller = socket(), bridge = socket()
    for (let index = 0; index < 20; index++) relay.request(caller, index, bridge, 'x'.repeat(65536), () => true)
    expect(bridge.frames.length).toBeLessThanOrEqual(16)
    expect(relay.result(bridge, bridge.frames[0].requestId, 'x'.repeat(65537))).toBe(false)
    relay.disconnect(bridge)
    expect(relay.pendingCount).toBe(0)
  })
})
