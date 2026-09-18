/**
 * waitForBridge() — the cloud registry's "wait out a reconnect hole" primitive.
 *
 * A routine bridge teardown re-registers within a second or two (the daemon's
 * own redial loop), so a replica request that lands inside that hole should wait
 * for the redial instead of failing hard. The launch relay in
 * routes/session-launch-v1.ts is the caller that turns this into a successful
 * session create (see session-launch-v1-bridge-flap-cloud.test.ts).
 *
 * The REAL registry is used here (no module mock): registration goes through
 * attachBridge + the hello handshake, which is exactly where the wake has to be
 * wired. Invariants pinned: the already-connected fast path, waking during a
 * wait, the timeout verdict, no timer left behind on either settle path, all
 * concurrent waiters woken, and per-alias isolation (a bridge for one host must
 * never satisfy a waiter parked on another).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-bridge-wait', { CLOUD_MODE: true }))

import { attachBridge, waitForBridge, bridgeForHost, closeAllBridges } from '../../../src/web/ws/bridge-registry.js'

/** Fake bridge socket: attachBridge only uses on/send/close. */
class FakeBridgeWs extends EventEmitter {
  sent: string[] = []
  send(payload: string): void { this.sent.push(payload) }
  close(): void { this.emit('close') }
  inbound(frame: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)))
  }
}

/**
 * Register a fake daemon bridge and complete the hello handshake. The device
 * name is the token identity, so it must match the alias: 'bridge-local' owns
 * '__local__', 'bridge-<alias>' owns that alias.
 */
function connectFakeBridge(hostAlias: string, deviceName: string): FakeBridgeWs {
  const ws = new FakeBridgeWs()
  attachBridge(ws as never, deviceName)
  ws.inbound({ ev: 'hello', hostAlias, version: 'test', instanceId: 'i-test', sids: [] })
  return ws
}

afterEach(() => {
  closeAllBridges()
  vi.useRealTimers()
})

describe('waitForBridge', () => {
  it('resolves true immediately when a bridge is already registered', async () => {
    connectFakeBridge('__local__', 'bridge-local')
    expect(bridgeForHost('__local__').connected).toBe(true)
    // A zero budget can only be answered by the already-connected fast path:
    // anything that had to park would have timed out to false.
    await expect(waitForBridge('__local__', 0)).resolves.toBe(true)
  })

  it('resolves true when a bridge registers DURING the wait', async () => {
    expect(bridgeForHost('__local__').connected).toBe(false)
    const started = Date.now()
    const waiting = waitForBridge('__local__', 5_000)
    connectFakeBridge('__local__', 'bridge-local')
    await expect(waiting).resolves.toBe(true)
    // Woken by the registration, not by outliving the budget.
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it('leaves no timer behind when a registration wakes it', async () => {
    vi.useFakeTimers()
    // Connect and drop first, so the registry's silence-sweep interval is
    // already installed and counted: the delta below is the waiter's alone.
    connectFakeBridge('marina', 'bridge-marina').close()
    const before = vi.getTimerCount()
    const waiting = waitForBridge('marina', 60_000)
    expect(vi.getTimerCount()).toBe(before + 1)
    connectFakeBridge('marina', 'bridge-marina')
    await expect(waiting).resolves.toBe(true)
    // attachBridge's hello timer is cleared by the handshake and the sweep
    // interval was already live, so the only delta left would be a leak.
    expect(vi.getTimerCount()).toBe(before)
  })

  it('resolves false on timeout and clears its own timer', async () => {
    vi.useFakeTimers()
    const before = vi.getTimerCount()
    const waiting = waitForBridge('__local__', 8_000)
    expect(vi.getTimerCount()).toBe(before + 1)
    await vi.advanceTimersByTimeAsync(8_000)
    await expect(waiting).resolves.toBe(false)
    expect(vi.getTimerCount()).toBe(before)
  })

  it('wakes EVERY concurrent waiter on the same alias', async () => {
    const waiters = [
      waitForBridge('__local__', 5_000),
      waitForBridge('__local__', 5_000),
      waitForBridge('__local__', 5_000),
    ]
    connectFakeBridge('__local__', 'bridge-local')
    await expect(Promise.all(waiters)).resolves.toEqual([true, true, true])
  })

  it('does NOT wake a waiter for another alias', async () => {
    // 'marina' is what the caller is parked on; the primary reconnecting must
    // not be mistaken for it, or a relay would retry against a host that is
    // still down.
    const waiting = waitForBridge('marina', 120)
    connectFakeBridge('__local__', 'bridge-local')
    await expect(waiting).resolves.toBe(false)
    expect(bridgeForHost('__local__').connected).toBe(true)
    expect(bridgeForHost('marina').connected).toBe(false)
  })

  it('wakes the right alias when several waiters are parked on different hosts', async () => {
    const primary = waitForBridge('__local__', 5_000)
    const other = waitForBridge('acme', 150)
    connectFakeBridge('__local__', 'bridge-local')
    await expect(primary).resolves.toBe(true)
    await expect(other).resolves.toBe(false)
  })
})
