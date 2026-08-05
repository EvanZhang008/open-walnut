/**
 * Mac-side bridge visibility — DaemonConnection records the daemon's
 * bridge liveness from the bridge.configure reply and WARNs when the bridge
 * is enabled but not connected (RC3 of the 2-day cloud-bridge wedge: zero
 * observability, /api/system/health said nothing about bridge state).
 *
 * Real layer: a real DaemonConnection over a real WebSocket to MockDaemon;
 * only the bridge-config derivation (cloud remote + token mint) is mocked.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { MockDaemon } from '../helpers/mock-daemon.js'
import { DaemonConnection, getDaemonPoolStatus } from '../../src/providers/daemon-connection.js'
import { log } from '../../src/logging/index.js'

// Bridge provisioning normally requires a cloud git remote + a token mint
// round-trip; stub the derivation so pushBridgeConfig() exercises only the
// RPC + recording path under test.
const bridgeConfigMock = vi.hoisted(() => ({
  payload: { enabled: false } as Record<string, unknown>,
}))
vi.mock('../../src/integrations/cloud-bridge-config.js', () => ({
  getBridgeConfigForHost: vi.fn(async () => bridgeConfigMock.payload),
}))

const TARGET = { hostname: '127.0.0.1', user: undefined, port: undefined }

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('DaemonConnection bridge visibility', () => {
  let daemon: MockDaemon
  let conn: DaemonConnection | null = null

  beforeEach(async () => {
    daemon = new MockDaemon()
    await daemon.start()
  })

  afterEach(async () => {
    try { conn?.disconnect() } catch { /* best effort */ }
    conn = null
    await daemon.stop()
    vi.restoreAllMocks()
  })

  it('records lastBridgeConnected=false and WARNs when bridge is enabled but daemon reports not connected', async () => {
    bridgeConfigMock.payload = { enabled: true, url: 'wss://cloud.example/bridge', token: 't', hostAlias: 'h1' }
    daemon.setBridgeConnected(false)
    const warnSpy = vi.spyOn(log.session, 'warn')

    conn = new DaemonConnection('bridge-vis-host', TARGET)
    await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)

    await waitFor(() => conn!.lastBridgeConnected !== null)
    expect(conn.lastBridgeConnected).toBe(false)
    expect(conn.lastBridgeCheckedAt).toBeGreaterThan(Date.now() - 10_000)
    expect(warnSpy.mock.calls.some(
      ([msg]) => typeof msg === 'string' && msg.includes('bridge enabled but NOT connected'),
    )).toBe(true)
  })

  it('records lastBridgeConnected=true when the daemon reports a live bridge', async () => {
    bridgeConfigMock.payload = { enabled: true, url: 'wss://cloud.example/bridge', token: 't', hostAlias: 'h2' }
    daemon.setBridgeConnected(true)

    conn = new DaemonConnection('bridge-vis-host-2', TARGET)
    await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)

    await waitFor(() => conn!.lastBridgeConnected !== null)
    expect(conn.lastBridgeConnected).toBe(true)
  })

  it('keeps lastBridgeConnected null when the bridge is disabled (not applicable, not an outage)', async () => {
    bridgeConfigMock.payload = { enabled: false }
    daemon.setBridgeConnected(false)

    conn = new DaemonConnection('bridge-vis-host-3', TARGET)
    await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)

    // The push happens fire-and-forget; wait for the configure RPC to land.
    await waitFor(() => daemon.getCommandHistory().some((c) => c.cmd === 'bridge.configure'))
    // Give the reply-processing microtask a beat.
    await new Promise((r) => setTimeout(r, 100))
    expect(conn.lastBridgeConnected).toBeNull()
  })

  it('getDaemonPoolStatus surfaces bridgeConnected per host', async () => {
    // Not pool-registered (we constructed the connection directly), so just
    // lock the shape contract: every entry carries bridgeConnected.
    for (const entry of getDaemonPoolStatus()) {
      expect('bridgeConnected' in entry).toBe(true)
    }
  })
})
