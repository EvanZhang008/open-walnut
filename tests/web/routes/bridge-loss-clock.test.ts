/**
 * lastBridgeLossAt() — the cloud registry's "how long has this host been gone"
 * clock, driven through the REAL registry (no module mock) so registration and
 * disconnect go through attachBridge / dropBridge exactly as a daemon drives
 * them.
 *
 * Why it exists: the 2026-09-17 report was a laptop asleep with the lid shut
 * (deep sleep with roughly 45-second dark-wake windows, so holes of 8 to 15
 * minutes), and the phone's "no live bridge" error read exactly like a 2-second
 * redial hole. The launch relay turns this timestamp into a duration the user
 * can act on (session-launch-v1-bridge-flap-cloud.test.ts covers the wording).
 *
 * Invariants pinned here: null when this process never had the link (a freshly
 * restarted replica must not invent a duration), null while connected, a stamp
 * on loss, cleared by a reconnect, and the LATEST loss reported after a
 * reconnect rather than the first one ever.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-bridge-loss', { CLOUD_MODE: true }))

import {
  attachBridge, lastBridgeLossAt, bridgeForHost, closeAllBridges,
} from '../../../src/web/ws/bridge-registry.js'

/** Fake bridge socket: attachBridge only uses on/send/close. */
class FakeBridgeWs extends EventEmitter {
  sent: string[] = []
  send(payload: string): void { this.sent.push(payload) }
  close(): void { this.emit('close') }
  inbound(frame: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)))
  }
}

function connectFakeBridge(hostAlias: string, deviceName: string): FakeBridgeWs {
  const ws = new FakeBridgeWs()
  attachBridge(ws as never, deviceName)
  ws.inbound({ ev: 'hello', hostAlias, version: 'test', instanceId: 'i-test', sids: [] })
  return ws
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

afterEach(() => {
  closeAllBridges()
})

describe('lastBridgeLossAt', () => {
  it('is null for a host this process has never seen', () => {
    // A replica that just restarted knows nothing about how long the primary
    // has been down, and a guessed duration would be a confident lie.
    expect(lastBridgeLossAt('__local__')).toBeNull()
    expect(lastBridgeLossAt('marina')).toBeNull()
  })

  it('is null while the bridge is connected', () => {
    connectFakeBridge('__local__', 'bridge-local')
    expect(bridgeForHost('__local__').connected).toBe(true)
    expect(lastBridgeLossAt('__local__')).toBeNull()
  })

  it('stamps the moment the bridge goes away', () => {
    const ws = connectFakeBridge('__local__', 'bridge-local')
    const before = Date.now()
    ws.close()
    const after = Date.now()
    const lost = lastBridgeLossAt('__local__')
    expect(lost).not.toBeNull()
    expect(lost as number).toBeGreaterThanOrEqual(before)
    expect(lost as number).toBeLessThanOrEqual(after)
  })

  it('is cleared by a successful reconnect', () => {
    connectFakeBridge('__local__', 'bridge-local').close()
    expect(lastBridgeLossAt('__local__')).not.toBeNull()
    connectFakeBridge('__local__', 'bridge-local')
    expect(lastBridgeLossAt('__local__')).toBeNull()
  })

  it('reports the LATEST loss, not the first one ever', async () => {
    connectFakeBridge('__local__', 'bridge-local').close()
    const firstLoss = lastBridgeLossAt('__local__') as number
    await sleep(25)
    connectFakeBridge('__local__', 'bridge-local').close()
    const secondLoss = lastBridgeLossAt('__local__') as number
    // Without the clear-on-reconnect the phone would be told the primary has
    // been down since the very first blip of the process's life.
    expect(secondLoss).toBeGreaterThan(firstLoss)
    expect(Date.now() - secondLoss).toBeLessThan(25)
  })

  it('a replacement connection for the same host leaves no outage behind', () => {
    // The daemon's redial replaces the previous socket (close code 4000). That
    // path also runs dropBridge, so the stamp it writes must be cleared by the
    // registration that caused it.
    connectFakeBridge('__local__', 'bridge-local')
    connectFakeBridge('__local__', 'bridge-local')
    expect(bridgeForHost('__local__').connected).toBe(true)
    expect(lastBridgeLossAt('__local__')).toBeNull()
  })

  it('tracks each alias separately', () => {
    connectFakeBridge('marina', 'bridge-marina').close()
    connectFakeBridge('__local__', 'bridge-local')
    expect(lastBridgeLossAt('marina')).not.toBeNull()
    expect(lastBridgeLossAt('__local__')).toBeNull()
  })
})
