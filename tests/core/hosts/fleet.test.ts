/**
 * The fleet view's gathering (core/hosts/fleet.ts): which hosts it lists, that
 * it asks only connected daemons with the capability, the deadline and the
 * stale fallback, the reuse window, one background probe per daemon, and the
 * spend by host, and that the placement fields are session placement's own view.
 *
 * Real: host profiles on a temp WALNUT_HOME, the host status frames, placement's
 * judgeHost. Fake: the config, the daemon connections, the cost report, the load
 * each host reports to placement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('host-fleet'))

const config = {
  hosts: {
    devbox: { hostname: 'devbox.example.internal', label: 'Dev box' },
    slowbox: { hostname: 'slow.example.internal' },
    oldbox: { hostname: 'old.example.internal' },
    offbox: { hostname: 'off.example.internal', enabled: false },
  },
}
vi.mock('../../../src/core/config-manager.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/config-manager.js')>()),
  getConfig: async () => config,
}))
const costCalls: Array<{ start?: string }> = []
const cost = { fail: false }
vi.mock('../../../src/core/usage/cost-report.js', () => ({
  buildCostReport: async (_view: string, range: { start?: string }) => {
    costCalls.push(range)
    if (cost.fail) throw new Error('rollup locked')
    return { groups: [{ id: 'host', heading: 'By host', lines: [{ key: '__local__', costUsd: 2345.6 }, { key: 'devbox', costUsd: 1234.2 }] }] }
  },
}))
vi.mock('../../../src/core/usage/collection.js', () => ({
  responseUsageStore: () => ({ rollup: {}, database: {}, timezone: 'America/Los_Angeles' }),
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { __setFleetConnectionsForTesting, __setFleetLoadsForTesting, getFleetHost, listFleet } from '../../../src/core/hosts/fleet.js'
import { judgeHost, type HostLoadView } from '../../../src/core/hosts/placement.js'
import { readHostProfile } from '../../../src/core/hosts/host-profile.js'

const NOW = Date.now()
function vitalsReply(running: number) {
  return {
    ok: true,
    stats: { sampledAt: NOW, cpus: 8, cpuUtil: 0.5, load: [1, 1, 1], memTotalBytes: 16, memAvailBytes: 8, uptimeSec: 100, bootedAt: NOW - 100_000, daemonStartedAt: NOW - 50_000, linked: true, running },
    history: { coverageFrom: NOW - 3600_000, bucketMinutes: 1440, buckets: [], windows: [{ days: 7, minutes: 60, up: 60, linked: 60, online: 1, linkedShare: 1, drops: 0, downs: 0 }], outages: [], boots: [], daemonStarts: 1 },
    ledger: { lastWriteAt: NOW, writeErrors: 0, lastError: null },
  }
}

interface Fake { sends: Array<{ cmd: string; params: Record<string, unknown> }>; conn: Record<string, unknown> }
function fake(caps: string[], answer: (cmd: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>, instance = 'i-1'): Fake {
  const sends: Fake['sends'] = []
  return {
    sends,
    conn: {
      connected: true, roundTripMs: 40, daemonVersion: '0.6.20', daemonStartedAt: NOW - 50_000, daemonStartup: 'service', daemonInstanceId: instance, remoteRuntime: 'bun',
      hasCapability: (c: string) => caps.includes(c),
      send: (cmd: string, params: Record<string, unknown>) => { sends.push({ cmd, params }); return answer(cmd, params) },
    },
  }
}

const facts = { ok: true, os: { platform: 'linux', release: '5.10', prettyName: 'Ubuntu 24.04' }, arch: 'x64', cpus: 8, memBytes: 16, home: '/home/dev', proxyEnv: {}, cloud: null, internet: null, tools: {}, uptimeSec: 100, probedAt: new Date(NOW).toISOString() }

const GB = 1024 ** 3
const loadAsks: string[][] = []
/** What each host reports to placement: devbox is idle, the Mac is over the load cap, the others are unknown. */
function views(hosts: string[]): HostLoadView[] {
  loadAsks.push(hosts)
  return hosts.map((h) => {
    if (h === 'devbox') return { ...judgeHost(h, 'Dev box', { cpus: 8, load: [1, 1, 1], cpuBusy: 0.25, memTotalBytes: 16 * GB, memAvailBytes: 8 * GB, diskFreeBytes: 100 * GB, at: new Date(NOW).toISOString() } as never, 2, 10), weight: 50 }
    if (h === '__local__') return { ...judgeHost(h, 'this Mac', { cpus: 10, load: [40, 40, 40], cpuBusy: 0.5, memTotalBytes: 32 * GB, memAvailBytes: 8 * GB, diskFreeBytes: 100 * GB, at: new Date(NOW).toISOString() } as never, 4, 10), weight: 50 }
    return { ...judgeHost(h, h, undefined, 0, 10, undefined, 'not connected'), weight: 50 }
  })
}

let local: Fake, dev: Fake, slow: Fake, old: Fake
beforeEach(async () => {
  loadAsks.length = 0
  __setFleetLoadsForTesting(async (hosts) => views(hosts))
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  local = fake(['host-vitals-v1', 'host-facts-v1'], async (cmd) => cmd === 'host.vitals' ? vitalsReply(4) : facts)
  dev = fake(['host-vitals-v1', 'host-facts-v1'], async (cmd) => cmd === 'host.vitals' ? vitalsReply(19) : facts)
  slow = fake(['host-vitals-v1'], () => new Promise(() => {})) // never answers
  old = fake([], async () => ({ ok: false, error: 'unknown command' })) // predates the capability
  __setFleetConnectionsForTesting(() => new Map([
    ['__local__', [local.conn]], ['devbox', [dev.conn]], ['slowbox', [slow.conn]], ['oldbox', [old.conn]],
  ]) as never)
})
afterEach(() => { __setFleetConnectionsForTesting(null); __setFleetLoadsForTesting(null) })

describe('listFleet', () => {
  it('lists the Mac first, then every enabled host, and asks only daemons that can answer', async () => {
    const started = Date.now()
    const hosts = await listFleet()
    expect(Date.now() - started).toBeLessThan(6_000) // the slow host's 3 s deadline, not forever
    expect(hosts.map((h) => h.host)).toEqual(['__local__', 'devbox', 'slowbox', 'oldbox'])
    const [mac, devbox, slowbox, oldbox] = hosts
    expect(mac).toMatchObject({ label: 'This computer', local: true, connection: { kind: 'local', connected: true }, sessions: { running: 4 } })
    expect(devbox).toMatchObject({ label: 'Dev box', connection: { kind: 'ssh-tunnel' }, sessions: { running: 19 }, daemon: { version: '0.6.20', startup: 'service', vitals: true } })
    expect(devbox.now).toMatchObject({ cpuUtil: 0.5, stale: false })
    expect(devbox.spend).toMatchObject({ last30dUsd: 1234.2, basis: 'list-price' })
    expect(mac.spend?.last30dUsd).toBe(2345.6)
    expect(slowbox).toMatchObject({ now: null, history: null, spend: { last30dUsd: 0 } })
    expect(oldbox).toMatchObject({ now: null, history: null, daemon: { vitals: false } })
    expect(old.sends.filter((s) => s.cmd === 'host.vitals')).toHaveLength(0)
    expect(dev.sends.find((s) => s.cmd === 'host.vitals')?.params).toEqual({ days: 30 })
    expect(costCalls).toHaveLength(1)
  }, 15_000)

  it('reuses an answer for 15 s, and a host that stops answering keeps its last reading as stale', async () => {
    await listFleet()
    const again = Date.now()
    await listFleet()
    // The hung host's ask already outlived its deadline: not waited for twice.
    expect(Date.now() - again).toBeLessThan(1_000)
    expect(dev.sends.filter((s) => s.cmd === 'host.vitals')).toHaveLength(1)
    expect(slow.sends.filter((s) => s.cmd === 'host.vitals')).toHaveLength(1)
    // The link drops: the card keeps what it knew, marked stale, and counts no sessions.
    ;(dev.conn as { connected: boolean }).connected = false
    const devbox = (await listFleet()).find((h) => h.host === 'devbox')!
    expect(devbox.now).toMatchObject({ cpuUtil: 0.5, stale: true })
    expect(devbox.sessions.running).toBeNull()
    expect(dev.sends.filter((s) => s.cmd === 'host.vitals')).toHaveLength(1)
  }, 20_000)

  it('probes a host with no profile once per daemon instance, in the background', async () => {
    await listFleet()
    await vi.waitFor(async () => expect((await readHostProfile('devbox')).probed?.os.prettyName).toBe('Ubuntu 24.04'))
    await listFleet()
    expect(dev.sends.filter((s) => s.cmd === 'host.facts')).toHaveLength(1)
    expect(old.sends.filter((s) => s.cmd === 'host.facts')).toHaveLength(0) // no capability, no probe
    const card = (await listFleet()).find((h) => h.host === 'devbox')!
    expect(card.system).toMatchObject({ os: 'Ubuntu 24.04', cpus: 8 })
    expect(card.line).toContain('Ubuntu 24.04')
  }, 20_000)
})

describe('placement', () => {
  it('each card carries the room session placement judges the host by, never a second score', async () => {
    const hosts = await listFleet()
    expect(loadAsks).toEqual([['__local__', 'devbox', 'slowbox', 'oldbox']])
    const byHost = new Map(hosts.map((h) => [h.host, h]))
    const dev = byHost.get('devbox')!
    const judged = views(['devbox'])[0]
    expect(dev.placement).toMatchObject({ score: judged.score, busy: false, reasons: [], weight: 50 })
    expect(dev.placement.score).toBeGreaterThan(0)
    const mac = byHost.get('__local__')!
    expect(mac.placement).toMatchObject({ score: 0, busy: true, weight: 50 })
    expect(mac.placement.reasons[0]).toMatch(/^load 40 on 10 CPUs/)
    expect(mac.line).toContain('too busy for new sessions: load 40 on 10 CPUs')
    // A host placement cannot read is unknown, not "busy".
    expect(byHost.get('oldbox')!.placement).toMatchObject({ score: null, busy: null, reasons: [] })
  }, 15_000)

  it('placement that does not answer in time leaves the fields unknown and the page on time', async () => {
    __setFleetLoadsForTesting(() => new Promise(() => {}))
    const started = Date.now()
    const card = await getFleetHost('devbox')
    expect(Date.now() - started).toBeLessThan(7_000)
    expect(card?.placement).toMatchObject({ score: null, busy: null, reasons: [], weight: null })
    expect(card?.now).toMatchObject({ cpuUtil: 0.5 }) // the rest of the card is there
  }, 15_000)
})

describe('the spend', () => {
  it('a failing cost report reads as unknown, and is not asked again on every read', async () => {
    cost.fail = true
    try {
      costCalls.length = 0
      const first = await listFleet()
      expect(first.every((h) => h.spend === null)).toBe(true)
      const again = Date.now()
      await listFleet()
      expect(Date.now() - again).toBeLessThan(1_000)
      expect(costCalls).toHaveLength(1)
    } finally { cost.fail = false }
  }, 20_000)
})

describe('getFleetHost', () => {
  it('asks the host at the resolution named, and knows only configured hosts', async () => {
    const card = await getFleetHost('devbox', { days: 1, bucketMinutes: 60 })
    expect(card?.host).toBe('devbox')
    expect(dev.sends.find((s) => s.cmd === 'host.vitals')?.params).toEqual({ days: 1, bucketMinutes: 60 })
    expect(await getFleetHost('offbox')).toBeNull() // disabled
    expect(await getFleetHost('nosuch')).toBeNull()
  }, 15_000)
})
