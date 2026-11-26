/**
 * A bridge.configure push that was refused or failed is tried again soon (bridge-push-retry.ts),
 * not only at the 5-minute re-push tick. 2026-11-26 drill: a new leader's first push to each host
 * came before it held the write permission ("no machine token minted", the config read threw),
 * and the other dev box's bridge stood up only 280 s later.
 *
 * Real layer: a real DaemonConnection over a real WebSocket to MockDaemon; only the bridge-config
 * derivation (cloud remote + token mint) is mocked. The backoff is shortened for the test.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { MockDaemon } from '../helpers/mock-daemon.js'
import { DaemonConnection, setPooledConnectionForTest } from '../../src/providers/daemon-connection.js'
import { _setBridgeRetryDelaysForTesting } from '../../src/providers/bridge-push-retry.js'
import { holdOwnBridge } from '../../src/core/leader/own-bridge-hold.js'
import { setRevokedHosts } from '../../src/core/session-channel/revoked-hosts.js'
import {
  _forgetDoorsOpenedListenersForTesting, notifyOutwardDoorsOpened, setOutwardDoorChecker,
} from '../../src/core/leader/switch/doors.js'

const bridgeConfigMock = vi.hoisted(() => ({
  payload: { enabled: true, url: 'wss://cloud.example.invalid/bridge', token: 'fixture', hostAlias: 'h' } as Record<string, unknown>,
  /** How many of the next config reads throw (the permit-less leader's missing machine token). */
  failures: 0,
  reads: 0,
}))
vi.mock('../../src/integrations/cloud-bridge-config.js', () => ({
  getBridgeConfigForHost: vi.fn(async () => {
    bridgeConfigMock.reads++
    if (bridgeConfigMock.failures > 0) {
      bridgeConfigMock.failures--
      throw new Error('Bridge credential unavailable; existing daemon configuration was not changed')
    }
    return bridgeConfigMock.payload
  }),
  revalidateBridgeToken: vi.fn(async () => false),
}))

const TARGET = { hostname: '127.0.0.1', user: undefined, port: undefined }

type Inner = { bridgePushInFlight: boolean; bridgeRetry: { pending: boolean }; pushBridgeConfig(): void }
const inner = (c: DaemonConnection) => c as unknown as Inner

describe('DaemonConnection bridge push retry', () => {
  let daemon: MockDaemon
  let conn: DaemonConnection | null = null
  const configures = () => daemon.getCommandHistory().filter((c) => c.cmd === 'bridge.configure').length

  beforeEach(async () => {
    bridgeConfigMock.failures = 0
    bridgeConfigMock.reads = 0
    _setBridgeRetryDelaysForTesting([50, 100, 150, 200])
    daemon = new MockDaemon()
    await daemon.start()
    daemon.setBridgeConnected(true)
  })

  afterEach(async () => {
    try { conn?.disconnect() } catch { /* best effort */ }
    conn = null
    _setBridgeRetryDelaysForTesting(null)
    await daemon.stop()
    vi.restoreAllMocks()
  })

  it('a first push that threw (no machine token yet) is pushed again within the backoff, then waits for the tick', async () => {
    bridgeConfigMock.failures = 1
    conn = new DaemonConnection('bridge-retry-thrown', TARGET)
    await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)
    await vi.waitFor(() => expect(configures()).toBe(1), { timeout: 5000 })
    await vi.waitFor(() => expect(inner(conn!).bridgePushInFlight).toBe(false))
    expect(bridgeConfigMock.reads).toBe(2)
    expect(conn.lastBridgeConnected).toBe(true)
    // Went through: no retry waits, the 5-minute tick is all that is left.
    expect(inner(conn).bridgeRetry.pending).toBe(false)
  })

  it('a first push the daemon refused is pushed again within the backoff, then waits for the tick', async () => {
    daemon.refuseNextCommand('bridge.configure', 'bridge.configure: not now')
    conn = new DaemonConnection('bridge-retry-refused', TARGET)
    await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)
    await vi.waitFor(() => expect(configures()).toBe(2), { timeout: 5000 })
    await vi.waitFor(() => expect(conn!.lastBridgeConnected).toBe(true))
    expect(inner(conn).bridgeRetry.pending).toBe(false)
  })

  it('a push that keeps failing is tried once per delay, then left to the tick', async () => {
    bridgeConfigMock.failures = 1000
    conn = new DaemonConnection('bridge-retry-spent', TARGET)
    await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)
    // The connect push and four retries, then none waits.
    await vi.waitFor(() => {
      expect(bridgeConfigMock.reads).toBe(5)
      expect(inner(conn!).bridgePushInFlight).toBe(false)
      expect(inner(conn!).bridgeRetry.pending).toBe(false)
    }, { timeout: 5000 })
    expect(configures()).toBe(0)
  })

  it('a closed connection drops the waiting retry', async () => {
    _setBridgeRetryDelaysForTesting([60_000])
    bridgeConfigMock.failures = 1
    conn = new DaemonConnection('bridge-retry-closed', TARGET)
    await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)
    await vi.waitFor(() => expect(inner(conn!).bridgeRetry.pending).toBe(true))
    conn.disconnect()
    expect(inner(conn).bridgeRetry.pending).toBe(false)
  })

  it('a deliberate skip (the leader switch\'s hold of this machine\'s own bridge) schedules nothing', async () => {
    try {
      holdOwnBridge(true)
      conn = new DaemonConnection('__local__', TARGET)
      await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)
      // The connect push returned before it started anything.
      inner(conn).pushBridgeConfig()
      expect(inner(conn).bridgePushInFlight).toBe(false)
      expect(inner(conn).bridgeRetry.pending).toBe(false)
      expect(bridgeConfigMock.reads).toBe(0)
    } finally { holdOwnBridge(false) }
  })

  it('a revoked host\'s refused turn-off is not retried', async () => {
    try {
      setRevokedHosts([{ hostKey: 'bridge-retry-revoked', machineId: 'm-revoked' }])
      daemon.refuseNextCommand('bridge.configure', 'bridge.configure: not now')
      conn = new DaemonConnection('bridge-retry-revoked', TARGET)
      await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)
      await vi.waitFor(() => {
        expect(configures()).toBe(1)
        expect(inner(conn!).bridgePushInFlight).toBe(false)
      }, { timeout: 5000 })
      expect(daemon.getCommandHistory().find((c) => c.cmd === 'bridge.configure')!.payload.enabled).toBe(false)
      expect(inner(conn).bridgeRetry.pending).toBe(false)
    } finally { setRevokedHosts([]) }
  })

  it('a push that failed behind closed doors goes again the moment this server gets the write permission', async () => {
    _setBridgeRetryDelaysForTesting([60_000]) // only the doors opening can push within the test
    const host = 'bridge-retry-doors'
    setOutwardDoorChecker(() => {
      const err = new Error('not the holder')
      err.name = 'PermitNotHeld'
      throw err
    }, () => false)
    try {
      bridgeConfigMock.failures = 1
      conn = new DaemonConnection(host, TARGET)
      setPooledConnectionForTest(host, conn)
      await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)
      await vi.waitFor(() => expect(inner(conn!).bridgeRetry.pending).toBe(true))
      expect(configures()).toBe(0)
      setOutwardDoorChecker(() => {}, () => true)
      notifyOutwardDoorsOpened()
      await vi.waitFor(() => expect(configures()).toBe(1), { timeout: 5000 })
      await vi.waitFor(() => expect(inner(conn!).bridgeRetry.pending).toBe(false))
    } finally {
      setOutwardDoorChecker(null)
      _forgetDoorsOpenedListenersForTesting()
      setPooledConnectionForTest(host, null)
    }
  })
})
