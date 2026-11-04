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
    // A machine that joined with a link: the host network, never an SSH tunnel.
    oldbox: { hostname: 'oldbox.walnut-net.invalid', transport: 'net', endpoint: 'e'.repeat(64) },
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

const bootConn = { conn: null as null | { checkBootStart: () => Promise<void> } }
vi.mock('../../../src/providers/daemon-connection.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/providers/daemon-connection.js')>()),
  getConnectedDaemonConnection: (host: string) => (host === 'devbox' ? bootConn.conn : null),
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { __setFleetConnectionsForTesting, __setFleetLoadsForTesting, BootStartCheckError, checkHostBootStart, getFleetHost, listFleet } from '../../../src/core/hosts/fleet.js'
import { judgeHost, type HostLoadView } from '../../../src/core/hosts/placement.js'
import { readHostProfile } from '../../../src/core/hosts/host-profile.js'
import { cachedFleet, fleetRefreshIdle, startFleetRefresh } from '../../../src/core/hosts/fleet-refresh.js'
import { flushFleetCacheNow } from '../../../src/core/hosts/fleet-cache.js'

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
    expect(oldbox).toMatchObject({ now: null, history: null, daemon: { vitals: false }, connection: { kind: 'host-network' } })
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
    // The link drops: the card keeps what it knew, its session count included, marked stale.
    ;(dev.conn as { connected: boolean }).connected = false
    const devbox = (await listFleet()).find((h) => h.host === 'devbox')!
    expect(devbox.now).toMatchObject({ cpuUtil: 0.5, stale: true })
    expect(devbox.sessions).toMatchObject({ running: expect.any(Number), source: 'host', at: expect.any(Number) }) // never "?"
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

  it('a fresh profile probed before host-caps-v1 is probed again once the daemon can say what it can do', async () => {
    const { recordProbedFacts } = await import('../../../src/core/hosts/host-profile.js')
    const { ok: _ok, ...oldFacts } = facts
    await recordProbedFacts('devbox', oldFacts as never) // fresh, but without ios/browsers/mcp
    config.hosts.devbox = { ...config.hosts.devbox, capabilities: ['GPU'] } as never
    ;(config as { local_capabilities?: string[] }).local_capabilities = ['Studio-Display']
    try {
      const withCaps = { ...facts, ios: null, browsers: [], mcp: [{ name: 'docs-mcp' }] }
      dev = fake(['host-vitals-v1', 'host-facts-v1', 'host-caps-v1'], async (cmd) => cmd === 'host.vitals' ? vitalsReply(19) : withCaps, 'i-caps')
      __setFleetConnectionsForTesting(() => new Map([['__local__', [local.conn]], ['devbox', [dev.conn]]]) as never)
      const before = (await listFleet()).find((h) => h.host === 'devbox')!
      expect(before.capabilities.unknown).toContain('mcp')
      expect(before.capabilities.tags).toContain('gpu')
      await vi.waitFor(async () => expect((await readHostProfile('devbox')).probed?.mcp).toEqual([{ name: 'docs-mcp' }]))
      const after = (await listFleet()).find((h) => h.host === 'devbox')!
      expect(after.capabilities.tags).toEqual(expect.arrayContaining(['linux', 'gpu', 'mcp:docs-mcp']))
      expect(after.capabilities.unknown).not.toContain('mcp')
      expect(dev.sends.filter((s) => s.cmd === 'host.facts')).toHaveLength(1)
      // This machine has no hosts entry: its own tags come from local_capabilities.
      expect((await listFleet()).find((h) => h.host === '__local__')!.capabilities.declared).toEqual(['studio-display'])
    } finally {
      delete (config.hosts.devbox as { capabilities?: string[] }).capabilities
      delete (config as { local_capabilities?: string[] }).local_capabilities
    }
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

describe('checkHostBootStart (the Overview\'s Set up)', () => {
  const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof BootStartCheckError ? e.code : String(e)))
  it('refuses a host it does not know, this Mac, and a host it has no link to now', async () => {
    bootConn.conn = null
    expect(await code(checkHostBootStart('nosuch'))).toBe('unknown_host')
    expect(await code(checkHostBootStart('offbox'))).toBe('unknown_host')
    expect(await code(checkHostBootStart('__local__'))).toBe('not_remote')
    expect(await code(checkHostBootStart('devbox'))).toBe('not_connected')
  })
  it('asks the host\'s keeper once and answers the card after it', async () => {
    let checks = 0
    bootConn.conn = { checkBootStart: async () => { checks++ } }
    const card = await checkHostBootStart('devbox')
    expect(checks).toBe(1)
    expect(card.host).toBe('devbox')
    bootConn.conn = { checkBootStart: async () => { throw new Error('ssh: connection reset') } }
    const err = await checkHostBootStart('devbox').catch((e) => e)
    expect(err).toBeInstanceOf(BootStartCheckError)
    expect(err).toMatchObject({ code: 'check_failed', message: 'Walnut could not check Dev box: ssh: connection reset' })
    bootConn.conn = null
  }, 15_000)
})

describe('a reading kept until the next one comes (2026-11-04: "cache should cache for long tie until the real data come")', () => {
  it('hours later, with the host gone and the server restarted, every value stays on the card, marked stale', async () => {
    await startFleetRefresh(['__local__', 'devbox'])
    await fleetRefreshIdle()
    await flushFleetCacheNow()
    const fresh = (await cachedFleet()).hosts.find((h) => h.host === 'devbox')!
    expect(fresh.sessions).toMatchObject({ running: 19, source: 'host' })
    expect(fresh.spend?.last30dUsd).toBeCloseTo(1234.2)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 3 * 3_600_000)
      ;(dev.conn as { connected: boolean }).connected = false
      cost.fail = true
      // A restart: the server's memory is gone, only the file is left.
      __setFleetConnectionsForTesting(() => new Map([['__local__', [local.conn]], ['devbox', [dev.conn]]]) as never)
      const later = (await cachedFleet()).hosts.find((h) => h.host === 'devbox')!
      expect(later.now).toMatchObject({ cpuUtil: 0.5, stale: true })
      expect(later.sessions).toMatchObject({ running: 19, source: 'host', at: fresh.now!.at })
      expect(later.history?.windows.length).toBeGreaterThan(0)
      expect(later.spend?.last30dUsd).toBeCloseTo(1234.2)
      expect(later.readAt).toBe(fresh.readAt)
      // A cost report that fails now keeps the spend it read before.
      await listFleet()
      expect((await cachedFleet()).hosts.find((h) => h.host === 'devbox')!.spend?.last30dUsd).toBeCloseTo(1234.2)
    } finally {
      vi.useRealTimers()
      cost.fail = false
    }
  }, 20_000)
})

describe('a machine in config twice (found in ~/.ssh/config, then joined)', () => {
  it('is listed and read once, as the joined machine', async () => {
    // oldbox joined the host network; its own address is the found row's HostName.
    const hosts = config.hosts as Record<string, unknown>
    hosts['oldbox-ssh'] = { hostname: '10.20.30.40', discovered: true }
    ;(config as { net?: unknown }).net = { enabled: true, where: { ['e'.repeat(64)]: { addrs: ['10.20.30.40:5000'], self: ['10.20.30.40:5000'] } } }
    const found = fake(['host-vitals-v1', 'host-facts-v1'], async (cmd) => cmd === 'host.vitals' ? vitalsReply(2) : facts, 'i-found')
    __setFleetConnectionsForTesting(() => new Map([
      ['__local__', [local.conn]], ['devbox', [dev.conn]], ['oldbox', [old.conn]], ['oldbox-ssh', [found.conn]],
    ]) as never)
    try {
      const listed = (await listFleet()).map((h) => h.host)
      expect(listed).toContain('oldbox')
      expect(listed).not.toContain('oldbox-ssh')
      expect(loadAsks.flat()).not.toContain('oldbox-ssh')
      const { started } = await startFleetRefresh()
      expect(started).toContain('oldbox')
      expect(started).not.toContain('oldbox-ssh')
      await fleetRefreshIdle()
      expect((await cachedFleet()).hosts.map((h) => h.host)).not.toContain('oldbox-ssh')
      expect(found.sends).toHaveLength(0) // no list asked it anything
      // Asked for by its own alias (host_get from a session still on it, Set up), it is still found.
      expect((await getFleetHost('oldbox-ssh'))?.host).toBe('oldbox-ssh')
      bootConn.conn = null
      await expect(checkHostBootStart('oldbox-ssh')).rejects.toMatchObject({ code: 'not_connected' })
    } finally {
      delete hosts['oldbox-ssh']
      delete (config as { net?: unknown }).net
    }
  }, 20_000)
})
