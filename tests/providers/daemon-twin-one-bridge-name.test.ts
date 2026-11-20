/**
 * One daemon, two names, one bridge name. A real DaemonConnection per alias over a real WebSocket
 * to ONE MockDaemon (both hellos name the same process). 2026-11-20: each link pushed its own
 * alias, the daemon's bridge took the name of the link that pushed last (`newdev`, found in
 * ~/.ssh/config), and with the Mac asleep the phone found `clouddev` unreachable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockDaemon } from '../helpers/mock-daemon.js'

vi.mock('../../src/integrations/cloud-bridge-config.js', () => ({
  getBridgeConfigForHost: vi.fn(async (host: string) => ({ enabled: true, url: 'wss://cloud.example.invalid/bridge', token: `token-${host}`, hostAlias: host })),
  revalidateBridgeToken: vi.fn(async () => false),
}))
vi.mock('../../src/core/hosts/same-daemon-record.js', () => ({
  recordedSameDaemon: async () => [],
  rememberSameDaemon: async () => {},
  forgetSameDaemon: async () => {},
}))
const hosts = vi.hoisted(() => ({
  zbox: { hostname: 'zbox.example.invalid', label: 'Big box', enabled: true },
  abox: { hostname: 'box.example.invalid', discovered: true, enabled: true },
}))
vi.mock('../../src/core/config-manager.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/config-manager.js')>()),
  getConfig: async () => ({ version: 1, hosts }),
}))

import { DaemonConnection, setPooledConnectionForTest } from '../../src/providers/daemon-connection.js'
import { daemonKeeperAlias } from '../../src/core/hosts/daemon-twins.js'

const TARGET = { hostname: '127.0.0.1', user: undefined, port: undefined }
async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) { if (Date.now() > end) throw new Error('waitFor timed out'); await new Promise((r) => setTimeout(r, 25)) }
}

describe('daemonKeeperAlias', () => {
  it('picks this machine, else the row the person added and named, in any order', () => {
    expect(daemonKeeperAlias(['abox', 'zbox'], hosts)).toBe('zbox')
    expect(daemonKeeperAlias(['zbox', 'abox'], hosts)).toBe('zbox')
    expect(daemonKeeperAlias(['abox', '__local__'], hosts)).toBe('__local__')
    expect(daemonKeeperAlias(['solo'], {})).toBe('solo')
    // Not the first by name: the row the person added wins over a found one sorted before it.
    expect(daemonKeeperAlias(['abox-found', 'zbox'], { zbox: { label: 'Z box', enabled: true }, 'abox-found': { discovered: true, enabled: true } })).toBe('zbox')
  })
})

describe('two links to one daemon', () => {
  let daemon: MockDaemon
  const conns: DaemonConnection[] = []
  beforeEach(async () => { daemon = new MockDaemon(); daemon.setBridgeConnected(true); await daemon.start() })
  afterEach(async () => {
    for (const c of conns.splice(0)) { try { c.disconnect() } catch { /* best effort */ } }
    for (const h of ['zbox', 'abox']) setPooledConnectionForTest(h, null)
    await daemon.stop()
  })

  async function link(host: 'zbox' | 'abox'): Promise<DaemonConnection> {
    const c = new DaemonConnection(host, TARGET)
    conns.push(c)
    setPooledConnectionForTest(host, c)
    await c.connectDirect(`ws://127.0.0.1:${daemon.port}`)
    return c
  }
  // The pushes that name a bridge. A dynamic import here now and then reaches the real config
  // module (walnut-testing skill, "spy on it, don't vi.mock"): it answers this test box's own
  // config, `{enabled: false}` with no name, which names nobody and so cannot take the bridge.
  const named = () => daemon.getCommandHistory()
    .filter((c) => c.cmd === 'bridge.configure' && typeof (c.payload as { hostAlias?: unknown }).hostAlias === 'string')
    .map((c) => (c.payload as { hostAlias: string }).hostAlias)
  const repush = (c: DaemonConnection): void => { (c as unknown as { pushBridgeConfig(): void }).pushBridgeConfig() }

  for (const order of [['zbox', 'abox'], ['abox', 'zbox']] as const) {
    it(`every push names the person's alias once both are up (${order.join(' then ')})`, async () => {
      const first = await link(order[0])
      await waitFor(() => named().length >= 1)
      const second = await link(order[1])
      // From here both names are known: the periodic re-push from each link, as every 5 minutes.
      const from = named().length
      for (let round = 0; round < 4 && named().length < from + 3; round++) {
        repush(first)
        repush(second)
        await new Promise((r) => setTimeout(r, 300))
      }
      await waitFor(() => named().length >= from + 2)
      const afterBoth = named().slice(from)
      expect(afterBoth.every((n) => n === 'zbox'), JSON.stringify(named())).toBe(true)
    })
  }
})
