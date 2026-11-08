/**
 * The facts table of a host's Details in Settings > Remote Hosts
 * (web/src/components/settings/sections/host-fleet-model.ts): each reading in plain words, a
 * missing one saying why, and the day cells' tones. Each fact once on the page (2026-11-04
 * review): the system, sessions, spend and Walnut on the host are said elsewhere in Details, so
 * the table has none of them, and the helper row says no build tool or service manager.
 */
import { describe, expect, it } from 'vitest'
import { dayTitle, dayTone, fleetRows, gb, pct, span, statusKind } from '../../web/src/components/settings/sections/host-fleet-model'
import type { FleetHost } from '../../web/src/api/hosts-fleet'

const NOW = Date.UTC(2026, 9, 30, 12)
const GB = 1024 ** 3

function host(over: Partial<FleetHost> = {}): FleetHost {
  return {
    host: 'devbox', label: 'Dev box', local: false, line: '', checkedAt: NOW,
    connection: { kind: 'ssh-tunnel', connected: true, phase: 'connected', phaseLabel: 'Connected', since: NOW - 20 * 60_000, rttMs: 38, error: null },
    system: { os: 'Debian 12', arch: 'x64', cpus: 32, memBytes: 128 * GB, diskFreeBytes: 2.3e12, kind: 'private-cloud-vm', probedAt: null },
    now: { cpus: 32, cpuUtil: 0.254, load: [6.16, 8, 14], memTotalBytes: 128 * GB, memAvailBytes: 96 * GB, uptimeSec: 13 * 86400, bootedAt: 0, linked: true, at: NOW, stale: false },
    history: { coverageFrom: 0, bucketMinutes: 1440, buckets: [], windows: [{ days: 7, minutes: 7 * 1440, up: 10000, linked: 9000, online: 0.9921, linkedShare: 0.89, drops: 41, downs: 1, daemonStarts: 15, boots: 0 }], outages: [], boots: [], daemonStarts: 15 },
    sessions: { running: 19 },
    spend: { last30dUsd: 1234.4, from: '2026-10-01', basis: 'list-price' },
    server: { enabled: true, program: 'replica', phase: 'running', phaseLabel: 'running', build: '0.6.20-abc1234', phone: 'connected', message: null },
    daemon: { version: 'walnut-daemon-0123456789ab', startedAt: 0, startup: 'on-demand', startsAfterReboot: false, runtime: 'bun', vitals: true },
    placement: { score: 1, busy: false, reasons: [], weight: 50, longRunning: { ok: false, reasons: [] } },
    ...over,
  }
}

const value = (h: FleetHost, key: string) => fleetRows(h, NOW).find((r) => r.key === key)

describe('formatting', () => {
  it('sizes, shares and spans', () => {
    expect(gb(128 * GB)).toBe('128 GB')
    expect(gb(1.5 * GB)).toBe('1.5 GB')
    expect(gb(0)).toBeNull()
    expect(pct(0.9921, 1)).toBe('99.2%')
    expect(pct(null)).toBeNull()
    expect(span(13 * 86_400_000)).toBe('13 d')
    expect(span(20 * 60_000)).toBe('20 min')
    expect(span(5 * 3600_000)).toBe('5 h')
    expect(span(30_000)).toBe('30 s')
  })
})

describe('a full card', () => {
  it('reads each row in plain words, each fact once', () => {
    const h = host()
    expect(fleetRows(h, NOW).map((r) => r.key)).toEqual(['now', 'online', 'connection', 'daemon'])
    expect(value(h, 'now')?.value).toBe('13 d, load 6.16')
    expect(value(h, 'online')).toMatchObject({ value: '99.2% of the last 7 days, 1 down, 41 link drops, session helper started 15 times', tone: 'good' })
    expect(value(h, 'connection')?.value).toBe('SSH tunnel: connected 20 min, 38 ms')
    // The reboot problem is said once, as a problem: the helper row only gives the version.
    expect(value(h, 'daemon')).toMatchObject({ label: 'Session helper', value: 'Build 0123456789ab' })
    for (const gone of ['system', 'sessions', 'spend', 'server']) expect(value(h, gone)).toBeUndefined()
    expect(statusKind(h)).toBe('connected')
  })
})

describe('missing readings say why', () => {
  it('an older helper, a host never read, nothing counted yet', () => {
    const h = host({ system: null, now: null, history: null, spend: null, sessions: { running: null }, daemon: { version: null, startedAt: null, startup: 'on-demand', startsAfterReboot: false, runtime: null, vitals: false } })
    expect(value(h, 'now')?.value).toBe('Its session helper is older than this view (it updates on the next connect)')
    expect(value(h, 'online')?.value).toBe('No record yet')
    expect(value(h, 'daemon')?.value).toBe('Build not reported yet')
  })

  it('a host that went away keeps its last reading, marked', () => {
    const h = host({
      connection: { kind: 'ssh-tunnel', connected: false, phase: 'failed', phaseLabel: 'Could not reach Dev box', since: null, rttMs: null, error: 'ssh: connection refused' },
      now: { ...host().now!, stale: true, at: NOW - 5 * 60_000 },
    })
    expect(value(h, 'now')?.value).toMatch(/\(last reading, 5 min ago\)$/)
    expect(value(h, 'connection')).toMatchObject({ value: 'SSH tunnel: Could not reach Dev box (ssh: connection refused)', tone: 'bad' })
    expect(statusKind(h)).toBe('failed')
  })

  it('a ledger younger than a week names the time it covers; the Mac has no reboot line', () => {
    const h = host({ local: true, server: null, history: { ...host().history!, windows: [{ days: 7, minutes: 180, up: 170, linked: 170, online: 170 / 180, linkedShare: 1, drops: 0, downs: 1 }], daemonStarts: 1 } })
    expect(value(h, 'online')).toMatchObject({ value: '94.4% of the 3 hours recorded, 1 down', tone: 'warn' })
    expect(value(h, 'daemon')?.value).toBe('Build 0123456789ab')
  })
})

describe('day cells', () => {
  it('green, amber, red by the share of covered minutes up; grey before the ledger', () => {
    const b = (minutes: number, up: number) => ({ start: NOW, minutes, up, linked: up, cpu: null, mem: null, sessionsMax: 0 })
    expect(dayTone(b(1440, 1440))).toBe('good')
    expect(dayTone(b(1440, 1400))).toBe('warn')
    expect(dayTone(b(1440, 1000))).toBe('bad')
    expect(dayTone(b(0, 0))).toBe('none')
    expect(dayTitle(b(1440, 1440), 1440)).toMatch(/^24 h to .*: up 100%, linked 100%$/)
    expect(dayTitle(b(0, 0), 1440)).toMatch(/: no record yet$/)
  })
})

describe('words, never codes, on the card', () => {
  it('a week recorded for less than an hour counts minutes, never "0 hours"', () => {
    const w = { days: 7, minutes: 10, up: 10, linked: 10, online: 1, linkedShare: 1, drops: 0, downs: 0 }
    const h = host({ history: { coverageFrom: NOW - 600_000, bucketMinutes: 1440, buckets: [], windows: [w], outages: [], boots: [], daemonStarts: 1 } })
    expect(value(h, 'online')?.value).toBe('100% of the 10 minutes recorded')
    const one = host({ history: { coverageFrom: NOW - 60_000, bucketMinutes: 1440, buckets: [], windows: [{ ...w, minutes: 1, up: 1, linked: 1 }], outages: [], boots: [], daemonStarts: 1 } })
    expect(value(one, 'online')?.value).toBe('100% of the 1 minute recorded')
  })

  it('the helper row follows the server\'s reboot verdict, in plain words; how it starts is on hover', () => {
    const cloud = host({ connection: { kind: 'bridge', connected: true, phase: 'connected', phaseLabel: 'Connected', since: null, rttMs: 100, error: null }, daemon: { version: 'walnut-daemon-0123456789ab', startedAt: 0, startup: 'on-demand', startsAfterReboot: true, runtime: 'bun', vitals: true } })
    expect(value(cloud, 'daemon')?.value).toBe('Build 0123456789ab, starts by itself after a reboot')
    expect(value(cloud, 'connection')?.value).toBe('It connects in to this Mac: connected, 100 ms')
    const d = { version: 'walnut-daemon-0123456789ab', startedAt: 0, startup: 'on-demand', runtime: 'binary', vitals: true }
    const bs = { mode: 'boot' as const, backend: 'systemd-user', reason: null, checkedAt: NOW, setupRunning: false, setupError: null }
    const svc = host({ daemon: { ...d, startsAfterReboot: true, bootStart: bs, reboot: 'starts by itself after a reboot as a systemd user service' } })
    const row = value(svc, 'daemon')!
    expect(row.value).toBe('Build 0123456789ab, starts by itself after a reboot')
    expect(row.value).not.toMatch(/systemd|bun|binary|daemon/)
    expect(row.title).toContain('as a systemd user service')
  })
})

describe('the Can do row', () => {
  const caps = (over: Partial<NonNullable<FleetHost['capabilities']>> = {}): NonNullable<FleetHost['capabilities']> => ({
    tags: ['macos', 'local', 'ios', 'browser', 'mcp:playwright'], alwaysOn: false, placement: 'local', os: 'macos',
    ios: { xcode: 'Xcode 26.1', runtimes: ['iOS 26.1'] }, browsers: [{ name: 'chrome', relay: true }, { name: 'brave', relay: false }],
    mcp: [{ name: 'playwright' }, { name: 'docs-mcp', plugin: 'ToolsPlugin' }], clis: ['git', 'node'], declared: ['gpu'], unknown: [], ...over,
  })
  it('says what a task can use the host for, with the tags and MCP names on hover', () => {
    const row = value(host({ capabilities: caps() }), 'can')!
    expect(row.value).toBe('iOS (Xcode 26.1, iOS 26.1), your browser (chrome), 2 MCP servers, gpu')
    expect(row.title).toContain('tags: macos, local, ios, browser, mcp:playwright')
    expect(row.title).toContain('MCP: playwright, docs-mcp (ToolsPlugin)')
    expect(row.title).toContain('Tools: git, node')
  })
  it('names a server offered to other hosts as such', () => {
    const row = value(host({ capabilities: caps({ mcp: [{ name: 'wiki-search', offered: true, capability: 'wiki' }] }) }), 'can')!
    expect(row.title).toContain('MCP: wiki-search (offered to other hosts)')
  })
  it('a daemon that has not reported yet reads so, never as "none"', () => {
    const row = value(host({ capabilities: caps({ tags: ['linux'], ios: null, browsers: [], mcp: [], declared: [], unknown: ['browser', 'mcp', 'system'] }) }), 'can')!
    expect(row.value).toBe('browser: not reported yet, MCP servers: not reported yet')
    expect(row.tone).toBe('muted')
  })
  it('each unknown names its capability first, after what the host can do', () => {
    const row = value(host({ capabilities: caps({ tags: ['linux', 'docker'], ios: null, browsers: [], mcp: [{ name: 'docs-mcp' }], clis: ['docker'], declared: [], unknown: ['always-on'] }) }), 'can')!
    expect(row.value).toBe('docker, 1 MCP server, always on: known after a day of uptime records')
  })
  it('a server older than capabilities shows no row at all', () => {
    expect(value(host(), 'can')).toBeUndefined()
  })
})

describe('a host whose link keeps dropping', () => {
  it('wears the warn dot and an "unstable" problem on its card, while connected', async () => {
    const { problemsOf } = await import('../../web/src/components/settings/sections/host-fleet-dashboard-model')
    const h = host()
    const flapping = host({ connection: { ...h.connection, unstable: { drops: 5, windowMin: 30 } } })
    expect(statusKind(h)).toBe('connected')
    expect(statusKind(flapping)).toBe('warn')
    const p = problemsOf(flapping, NOW).find((x) => x.key === 'unstable')
    expect(p).toMatchObject({ text: 'Link unstable: dropped 5 times in 30 min', tone: 'warn' })
    expect(problemsOf(h, NOW).some((x) => x.key === 'unstable')).toBe(false)
  })
})
