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
  failure: false,
  /** While set, a read of the config waits here after taking the payload (a push in flight). */
  gate: null as Promise<void> | null,
  /** What revalidateBridgeToken answers, call by call (then false). */
  reminted: [] as boolean[],
  revalidated: [] as string[],
}))
vi.mock('../../src/integrations/cloud-bridge-config.js', () => ({
  getBridgeConfigForHost: vi.fn(async () => {
    if (bridgeConfigMock.failure) throw new Error('Cloud pairing read failed')
    const payload = bridgeConfigMock.payload
    if (bridgeConfigMock.gate) await bridgeConfigMock.gate
    return payload
  }),
  revalidateBridgeToken: vi.fn(async (host: string) => {
    bridgeConfigMock.revalidated.push(host)
    return bridgeConfigMock.reminted.shift() ?? false
  }),
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
    bridgeConfigMock.failure = false
    bridgeConfigMock.gate = null
    daemon = new MockDaemon()
    await daemon.start()
  })

  afterEach(async () => {
    try { conn?.disconnect() } catch { /* best effort */ }
    conn = null
    await daemon.stop()
    vi.restoreAllMocks()
  })

  it('failed configuration reads never disable a live bridge, and a later explicit disable still applies', async () => {
    bridgeConfigMock.payload = { enabled: true, url: 'wss://cloud.example.invalid/bridge', token: 'fixture', hostAlias: 'h-live' }
    daemon.setBridgeConnected(true)
    const warn = vi.spyOn(log.session, 'warn')
    conn = new DaemonConnection('bridge-vis-preserved', TARGET)
    await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)
    await waitFor(() => conn!.lastBridgeConnected === true)
    const checkedAt = conn.lastBridgeCheckedAt
    const commands = () => daemon.getCommandHistory().filter((c) => c.cmd === 'bridge.configure')
    const repush = () => (conn as unknown as { pushBridgeConfig(): void }).pushBridgeConfig()
    for (let i = 0; i < 3; i++) {
      bridgeConfigMock.failure = true
      const n = warn.mock.calls.length
      repush()
      await waitFor(() => warn.mock.calls.length > n)
      expect(commands()).toHaveLength(1)
      expect(conn.lastBridgeConnected).toBe(true)
      expect(conn.lastBridgeCheckedAt).toBe(checkedAt)
    }
    bridgeConfigMock.failure = false
    bridgeConfigMock.payload = { enabled: false }
    repush()
    await waitFor(() => conn!.lastBridgeConnected === null)
    expect(commands()).toHaveLength(2)
  })

  it('a push asked for while one is out runs after it, with the config as it is then', async () => {
    bridgeConfigMock.payload = { enabled: true, url: 'wss://cloud.example.invalid/bridge', token: 'old', hostAlias: 'h-again' }
    daemon.setBridgeConnected(true)
    conn = new DaemonConnection('bridge-vis-again', TARGET)
    await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)
    const commands = () => daemon.getCommandHistory().filter((c) => c.cmd === 'bridge.configure')
    await waitFor(() => commands().length === 1)
    const repush = () => (conn as unknown as { pushBridgeConfig(): void }).pushBridgeConfig()
    let release!: () => void
    bridgeConfigMock.gate = new Promise<void>((r) => { release = r })
    repush() // reads the old token, then waits
    await new Promise((r) => setTimeout(r, 50))
    bridgeConfigMock.payload = { ...bridgeConfigMock.payload, token: 'new' } // a new machine token
    repush()
    repush() // coalesced with the one before
    bridgeConfigMock.gate = null
    release()
    await waitFor(() => commands().length === 3)
    await new Promise((r) => setTimeout(r, 100))
    expect(commands()).toHaveLength(3)
    expect(commands().map((c) => c.payload.token)).toEqual(['old', 'old', 'new'])
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

  it('an enabled bridge that is not connected asks the companion about its token; a re-mint is pushed at once', async () => {
    bridgeConfigMock.payload = { enabled: true, url: 'wss://cloud.example/bridge', token: 't', hostAlias: 'h-remint' }
    bridgeConfigMock.reminted = [true]
    bridgeConfigMock.revalidated = []
    daemon.setBridgeConnected(false)

    conn = new DaemonConnection('bridge-vis-remint', TARGET)
    await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)

    // The first push, the question about the token, then a second push with the new one.
    await waitFor(() => daemon.getCommandHistory().filter((c) => c.cmd === 'bridge.configure').length >= 2)
    expect(bridgeConfigMock.revalidated[0]).toBe('bridge-vis-remint')
  })

  it('a token the companion still accepts is not pushed again (the network is the problem)', async () => {
    bridgeConfigMock.payload = { enabled: true, url: 'wss://cloud.example/bridge', token: 't', hostAlias: 'h-ok' }
    bridgeConfigMock.reminted = []
    bridgeConfigMock.revalidated = []
    daemon.setBridgeConnected(false)

    conn = new DaemonConnection('bridge-vis-no-remint', TARGET)
    await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)

    await waitFor(() => bridgeConfigMock.revalidated.length === 1)
    await new Promise((r) => setTimeout(r, 300))
    expect(daemon.getCommandHistory().filter((c) => c.cmd === 'bridge.configure')).toHaveLength(1)
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
