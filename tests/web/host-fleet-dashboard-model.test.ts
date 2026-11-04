/**
 * The fleet dashboard's rules (web/src/components/settings/sections/host-fleet-dashboard-model.ts):
 * the summary, the one problem line and its button, the 12 hour timeline from the
 * ledger's outages, gauges, disk, chips and the diagram's layout.
 */
import { describe, expect, it } from 'vitest'
import {
  capabilityChips, clip, readingWhy, sessionsTitle, sessionsUnknown, spendUnknown, diskFree, fleetSummary, gauges, isLive, linkLabel, problemsOf, roleChips, sparkPaths, sparks, timeline, topologyLayout, TIMELINE_MS, TOPO,
} from '../../web/src/components/settings/sections/host-fleet-dashboard-model'
import type { FleetHost } from '../../web/src/api/hosts-fleet'

const NOW = Date.UTC(2026, 9, 30, 12)
const GB = 1024 ** 3
const H = 3_600_000

function host(over: Partial<FleetHost> = {}): FleetHost {
  return {
    host: 'devbox', label: 'Dev box', local: false, line: '', checkedAt: NOW,
    connection: { kind: 'ssh-tunnel', connected: true, phase: 'connected', phaseLabel: 'Connected', since: NOW - 20 * 60_000, rttMs: 38, error: null },
    system: { os: 'Debian 12', arch: 'x64', cpus: 32, memBytes: 128 * GB, diskFreeBytes: 400 * GB, kind: 'private-cloud-vm', probedAt: null },
    now: { cpus: 32, cpuUtil: 0.25, load: [6, 8, 14], memTotalBytes: 128 * GB, memAvailBytes: 32 * GB, uptimeSec: 86400, bootedAt: 0, linked: true, at: NOW, stale: false },
    history: { coverageFrom: NOW - 30 * 24 * H, bucketMinutes: 1440, buckets: [], windows: [{ days: 7, minutes: 7 * 1440, up: 10000, linked: 10000, online: 0.999, linkedShare: 0.99, drops: 0, downs: 0 }], outages: [], boots: [], daemonStarts: 1 },
    sessions: { running: 4 },
    spend: { last30dUsd: 100, from: '2026-10-01', basis: 'list-price' },
    server: null,
    daemon: { version: 'walnut-daemon-0123456789ab', startedAt: 0, startup: 'service', startsAfterReboot: true, runtime: 'bun', vitals: true },
    placement: { score: 1, busy: false, reasons: [], weight: 50, longRunning: { ok: true, reasons: [] } },
    ...over,
  }
}

const offline = (over: Partial<FleetHost> = {}) => host({
  host: 'gone', label: 'Gone', now: null, sessions: { running: null }, spend: null,
  connection: { kind: 'ssh-tunnel', connected: false, phase: 'failed', phaseLabel: 'Could not connect', since: null, rttMs: null, error: 'Connection refused' },
  ...over,
})

const noBoot = (bootStart: NonNullable<FleetHost['daemon']>['bootStart'], reboot = 'does not start by itself after a reboot') =>
  host({ daemon: { version: 'walnut-daemon-0123456789ab', startedAt: 0, startup: 'on-demand', startsAfterReboot: false, runtime: 'bun', vitals: true, bootStart, reboot } })

describe('summary', () => {
  it('counts live hosts, sums what is known, and counts offline hosts as problems', () => {
    const list = [host({ host: '__local__', local: true }), host(), offline(), host({ host: 'disk', system: { ...host().system!, diskFreeBytes: 5 * GB } })]
    const s = fleetSummary(list, NOW)
    expect(s).toEqual({ online: 3, total: 4, sessions: 12, spendUsd: 300, problems: 2 })
    // A grey note (a laptop) is not counted.
    const laptop = host({ host: '__local__', local: true, system: { ...host().system!, kind: 'laptop' }, placement: { ...host().placement, longRunning: { ok: false, reasons: ['It is a laptop.'] } } })
    expect(problemsOf(laptop, NOW).map((p) => p.tone)).toEqual(['muted'])
    expect(fleetSummary([laptop], NOW).problems).toBe(0)
    expect(fleetSummary([offline()], NOW)).toMatchObject({ sessions: null, spendUsd: null })
  })
  it('this computer is live even with no link of its own', () => {
    expect(isLive(host({ local: true, connection: { ...host().connection, connected: false } }))).toBe(true)
  })
})

describe('problem line', () => {
  it('a healthy host has none', () => {
    expect(problemsOf(host(), NOW)).toEqual([])
  })
  it('offers Set up when the host says a setup is due', () => {
    const [p] = problemsOf(noBoot({ mode: 'none', backend: null, reason: 'nothing on it starts the daemon at boot', checkedAt: NOW, setupRunning: false, setupError: null, next: 'install' }), NOW)
    expect(p).toMatchObject({ key: 'reboot', text: 'Daemon does not come back after a reboot', action: { kind: 'boot-start', label: 'Set up' } })
  })
  it('offers Check again when only a change on the host can fix it', () => {
    const [p] = problemsOf(noBoot({ mode: 'login', backend: 'systemd-user', reason: 'linger is off', checkedAt: NOW, setupRunning: false, setupError: null, next: 'recheck' }), NOW)
    expect(p.action?.label).toBe('Check again')
  })
  it('offers no button when a check from here can change nothing, or an older server does not say, and keeps the whole sentence', () => {
    for (const next of [null, undefined]) {
      const reboot = 'does not start by itself after a reboot: this Walnut has no daemon binary for the host'
      const [p] = problemsOf(noBoot({ mode: 'none', backend: null, reason: null, checkedAt: NOW, setupRunning: false, setupError: 'this Walnut has no daemon binary for the host', ...(next === null ? { next } : {}) }, reboot), NOW)
      expect(p.action, String(next)).toBeUndefined()
      expect(p.detail).toBe(reboot)
    }
    // A host Walnut is not connected to now: nothing to ask.
    const away = noBoot({ mode: 'none', backend: null, reason: null, checkedAt: NOW, setupRunning: false, setupError: null, next: 'install' })
    away.connection = { ...away.connection, connected: false }
    expect(problemsOf(away, NOW)[0].action).toBeUndefined()
  })
  it('says it is setting up while it is', () => {
    const [p] = problemsOf(noBoot({ mode: 'none', backend: null, reason: null, checkedAt: NOW, setupRunning: true, setupError: null }), NOW)
    expect(p).toMatchObject({ text: 'Setting up start after a reboot', tone: 'muted' })
    expect(p.action).toBeUndefined()
  })
  it('the cloud box and this computer get no Set up', () => {
    const cloud = noBoot({ mode: 'none', backend: null, reason: null, checkedAt: NOW, setupRunning: false, setupError: null, next: 'install' })
    cloud.connection = { ...cloud.connection, kind: 'bridge' }
    expect(problemsOf(cloud, NOW)[0].action).toBeUndefined()
    expect(problemsOf({ ...noBoot(null), local: true }, NOW)).toEqual([])
  })
  it('ranks a stopped server first, then the reboot, then a full disk', () => {
    const h = noBoot(null)
    h.server = { enabled: true, program: 'replica', phase: 'failed', phaseLabel: 'failed', build: null, phone: null, message: 'port in use' }
    h.system = { ...h.system!, diskFreeBytes: 3 * GB }
    expect(problemsOf(h, NOW).map((p) => p.key)).toEqual(['server', 'reboot', 'disk'])
    expect(problemsOf(h, NOW)[0].detail).toBe('Its Walnut server is failed: port in use')
  })
  it('a day of record at least before uptime is a problem', () => {
    const h = host({ history: { ...host().history!, windows: [{ days: 7, minutes: 60, up: 45, linked: 45, online: 0.75, linkedShare: 0.75, drops: 0, downs: 1 }] } })
    expect(problemsOf(h, NOW)).toEqual([])
  })
  it('names a stale reading, low uptime and a laptop', () => {
    const h = host({
      now: { ...host().now!, stale: true, at: NOW - 10 * 60_000 },
      history: { ...host().history!, windows: [{ days: 7, minutes: 7 * 1440, up: 9000, linked: 9000, online: 0.9, linkedShare: 0.9, drops: 0, downs: 6 }] },
      system: { ...host().system!, kind: 'laptop' },
      placement: { ...host().placement, longRunning: { ok: false, reasons: ['It is a laptop: a job here stops while it sleeps.'] } },
    })
    expect(problemsOf(h, NOW).map((p) => [p.key, p.text])).toEqual([
      ['stale', 'Last reading 10 min ago'],
      ['uptime', 'Up 90% of the last 7 days'],
      ['long-running', 'Laptop: not for jobs that must keep running'],
    ])
  })
  it('the long-running verdict never repeats the reboot reason', () => {
    const h = noBoot(null)
    h.placement = { ...h.placement, longRunning: { ok: false, reasons: ['Its daemon does not start by itself after a reboot (run it).'] } }
    expect(problemsOf(h, NOW).map((p) => p.key)).toEqual(['reboot'])
  })
})

describe('12 hour timeline', () => {
  const at = (ms: number) => (ms - (NOW - TIMELINE_MS)) / TIMELINE_MS
  it('is one good run when nothing went wrong', () => {
    expect(timeline(host(), NOW).map((s) => [s.from, s.to, s.tone])).toEqual([[0, 1, 'good']])
  })
  it('places each outage where it was, down in red and unlinked in amber', () => {
    const h = host({ history: { ...host().history!, outages: [
      { from: NOW - 2 * H, to: NOW - H, minutes: 60, kind: 'unlinked' },
      { from: NOW - 8 * H, to: NOW - 7 * H, minutes: 60, kind: 'down' },
      { from: NOW - 40 * H, to: NOW - 39 * H, minutes: 60, kind: 'down' },
    ] } })
    expect(timeline(h, NOW).map((s) => [s.from, s.to, s.tone])).toEqual([
      [0, at(NOW - 8 * H), 'good'],
      [at(NOW - 8 * H), at(NOW - 7 * H), 'bad'],
      [at(NOW - 7 * H), at(NOW - 2 * H), 'good'],
      [at(NOW - 2 * H), at(NOW - H), 'warn'],
      [at(NOW - H), 1, 'good'],
    ])
  })
  it('with 20 outages listed, the time before the oldest is unknown, never green', () => {
    const outages = Array.from({ length: 20 }, (_, i) => ({ from: NOW - (i + 1) * 20 * 60_000, to: NOW - (i + 1) * 20 * 60_000 + 60_000, minutes: 1, kind: 'unlinked' as const }))
    const segs = timeline(host({ history: { ...host().history!, outages } }), NOW)
    expect(segs[0]).toMatchObject({ from: 0, to: at(NOW - 400 * 60_000), tone: 'none', title: expect.stringMatching(/^Too many drops to show before /) })
  })
  it('clips an outage that started before the window, and overlapping outages never run backwards', () => {
    const h = host({ history: { ...host().history!, outages: [
      { from: NOW - 20 * H, to: NOW - 10 * H, minutes: 600, kind: 'down' },
      { from: NOW - 11 * H, to: NOW - 9 * H, minutes: 120, kind: 'unlinked' },
    ] } })
    const segs = timeline(h, NOW)
    expect(segs[0]).toMatchObject({ from: 0, tone: 'bad' })
    for (const s of segs) expect(s.to).toBeGreaterThan(s.from)
    for (let i = 1; i < segs.length; i++) expect(segs[i].from).toBeCloseTo(segs[i - 1].to)
  })
  it('shows no record before the ledger began, and none at all without one', () => {
    const h = host({ history: { ...host().history!, coverageFrom: NOW - 3 * H } })
    expect(timeline(h, NOW).map((s) => s.tone)).toEqual(['none', 'good'])
    expect(timeline(host({ history: null }), NOW)).toEqual([expect.objectContaining({ from: 0, to: 1, tone: 'none' })])
  })
})

describe('gauges, disk and chips', () => {
  it('CPU, memory and disk shares with their tones; GPU only on a host that has one', () => {
    const [cpu, mem, disk] = gauges(host())
    expect(cpu).toMatchObject({ key: 'cpu', share: 0.25, tone: 'good' })
    expect(mem).toMatchObject({ key: 'mem', share: 0.75, tone: 'warn' })
    // An older daemon reports no disk size: the ring has no share, its label says what is free.
    expect(disk).toMatchObject({ key: 'disk', share: null, text: '400 GB', sub: 'free', subLow: false })
    expect(gauges(host()).map((g) => g.key)).toEqual(['cpu', 'mem', 'disk'])
    expect(gauges(host({ now: null })).map((g) => g.share)).toEqual([null, null, null])
    const gpu = host({ now: { ...host().now!, gpuUtil: 0.62, disk: { totalBytes: 1000 * GB, freeBytes: 250 * GB } } })
    expect(gauges(gpu).map((g) => [g.key, g.share])).toEqual([['cpu', 0.25], ['mem', 0.75], ['gpu', 0.62], ['disk', 0.75]])
  })
  it('the disk ring is the share in use, red by what is left', () => {
    const low = host({ now: { ...host().now!, disk: { totalBytes: 100 * GB, freeBytes: 12 * GB } } })
    expect(gauges(low).find((g) => g.key === 'disk')).toMatchObject({ share: 0.88, tone: 'bad', sub: '12 GB free', subLow: true })
    const big = host({ now: { ...host().now!, disk: { totalBytes: 4096 * GB, freeBytes: 300 * GB } } })
    expect(gauges(big).find((g) => g.key === 'disk')).toMatchObject({ tone: 'warn', sub: '300 GB free', subLow: false })
    expect(diskFree(low)).toEqual({ text: '12 GB', low: true }) // the daemon's reading wins over the profile
    // A full disk the daemon read is the loudest case, never a quiet one.
    const full = host({ now: { ...host().now!, disk: { totalBytes: 100 * GB, freeBytes: 0 } } })
    expect(problemsOf(full, NOW)[0]).toMatchObject({ key: 'disk', text: 'Disk almost full: 0 GB free', tone: 'bad' })
    expect(fleetSummary([full], NOW).problems).toBe(1)
    // A profile that says 0 only means it was not probed.
    expect(problemsOf(host({ system: { ...host().system!, diskFreeBytes: 0 } }), NOW)).toEqual([])
  })
  it('disk free in GB or TB, red under 20 GB', () => {
    expect(diskFree(host())).toEqual({ text: '400 GB', low: false })
    expect(diskFree(host({ system: { ...host().system!, diskFreeBytes: 2300 * GB } }))?.text).toBe('2.2 TB')
    expect(diskFree(host({ system: { ...host().system!, diskFreeBytes: 12 * GB } }))).toEqual({ text: '12 GB', low: true })
    expect(diskFree(host({ system: null }))).toBeNull()
  })
  it('role chips: Primary, Cloud, Always on, Replica', () => {
    const h = host({ local: true, server: { enabled: true, program: 'replica', phase: 'running', phaseLabel: 'running', build: null, phone: null, message: null } })
    h.capabilities = { tags: [], alwaysOn: true, placement: null, os: null, ios: null, browsers: [], mcp: [], clis: [], declared: [], unknown: [] }
    expect(roleChips(h).map((c) => c.text)).toEqual(['Primary', 'Always on', 'Replica'])
  })
  it('capability chips name what a task can use', () => {
    const h = host()
    h.capabilities = {
      tags: ['docker'], alwaysOn: null, placement: null, os: 'linux',
      ios: { xcode: 'Xcode 26.1', runtimes: ['iOS 26.1'] }, browsers: [{ name: 'chrome', relay: true }],
      mcp: [{ name: 'a' }, { name: 'b', plugin: 'P' }], clis: [], declared: ['gpu', 'cloud'], unknown: ['mcp', 'system'],
    }
    expect(capabilityChips(h).map((c) => c.text)).toEqual(['iOS simulator', 'Browser', 'Docker', '2 MCP servers', 'gpu', 'MCP?'])
  })
})

describe('a number slot with no number says why', () => {
  it('sessions: the host\'s count, Walnut\'s records, or why there is none', () => {
    expect(sessionsUnknown(host())).toBeNull()
    expect(sessionsTitle(host({ sessions: { running: 4, source: 'host', why: null } }), NOW)).toBe('Counted by the host itself')
    const kept = host({ sessions: { running: 4, source: 'host', why: null, at: NOW - 19 * 60_000 }, now: { ...host().now!, at: NOW - 19 * 60_000, stale: true } })
    expect(sessionsTitle(kept, NOW)).toBe('Counted by the host 19 min ago (its last reading)')
    const fromRecords = host({ sessions: { running: 4, source: 'records', why: null }, now: { ...host().now!, at: NOW - 19 * 60_000, stale: true } })
    expect(sessionsTitle(fromRecords, NOW)).toBe("From Walnut's session records (its own reading is 19 min old)")
    expect(sessionsUnknown(host({ sessions: { running: null, why: 'Walnut is not connected to it' } }))?.why).toBe('Walnut is not connected to it')
    // An older server sends no why: the card names one itself.
    expect(sessionsUnknown(offline({ sessions: { running: null } }))?.why).toBe('not connected')
  })
  it('spend and rings', () => {
    expect(spendUnknown(host())).toBeNull()
    expect(spendUnknown(host({ spend: null }))?.why).toBe('not counted yet')
    for (const h of [host({ now: null }), offline(), host({ daemon: { ...host().daemon!, vitals: false }, now: null })]) {
      for (const g of gauges(h)) expect(g.share !== null || !!g.text || !!g.why, `${h.host} ${g.key}`).toBe(true)
    }
    expect(readingWhy(offline())).toBe('not connected')
    expect(readingWhy(host({ now: null, daemon: { ...host().daemon!, vitals: false } }))).toBe('older daemon')
    expect(readingWhy(host({ now: null }))).toBe('not read yet')
    expect(sessionsUnknown(host({ sessions: { running: null }, now: { ...host().now!, stale: true } }))?.why).toBe('its reading is old')
    // A disk whose size an older daemon does not report: the ring says the free space instead.
    expect(gauges(host()).find((g) => g.key === 'disk')).toMatchObject({ share: null, text: '400 GB', sub: 'free' })
  })
})

describe('small charts of the last 12 hours', () => {
  const recent = (over: Record<string, unknown> = {}) => ({
    from: NOW - 12 * H, stepMinutes: 15, up: Array(48).fill(15), cpu: Array(48).fill(0.2), mem: Array(48).fill(0.5), gpu: null, disk: Array(48).fill(0.4), sessions: Array(48).fill(3), ...over,
  })
  it('CPU, memory and sessions; GPU only when the host reported one', () => {
    const h = host({ history: { ...host().history!, recent: recent() as never } })
    expect(sparks(h).map((s) => [s.key, s.value])).toEqual([['cpu', 'max 20%'], ['mem', 'max 50%'], ['sessions', 'max 3']])
    const g = host({ history: { ...host().history!, recent: recent({ gpu: [...Array(47).fill(null), 0.4] }) as never } })
    expect(sparks(g).map((s) => s.key)).toEqual(['cpu', 'mem', 'gpu', 'sessions'])
    expect(sparks(host())).toEqual([]) // an older daemon sends no recent series
  })
  it('a chart\'s number is the most of its 12 hours, and sessions break where the host was down', () => {
    const cpu = [...Array(46).fill(0.2), 0.7, null]
    const up = [...Array(46).fill(15), 15, 0]
    const h = host({ history: { ...host().history!, recent: recent({ cpu, up, sessions: [...Array(46).fill(1), 9, 0] }) as never } })
    const [c, , s] = sparks(h)
    expect(c.value).toBe('max 70%')
    expect(s.values[47]).toBeNull()
    expect(s).toMatchObject({ max: 9, value: 'max 9' })
  })
  it('a path breaks at each gap, and a lone point still draws', () => {
    const { line, area } = sparkPaths([0, 1, null, 0.5, null, null], 1, 20)
    expect(line.split('M').filter(Boolean)).toHaveLength(2)
    expect(area.split('Z').filter((x) => x.trim())).toHaveLength(2)
    expect(line).toContain('M8.33 19 L25 1') // the first run: 0 at the bottom, 1 at the top
    expect(sparkPaths([null, null], 1)).toEqual({ line: '', area: '' })
  })
})

describe('diagram', () => {
  it('puts the primary in the centre and splits the rest left and right in order', () => {
    const list = [host({ host: '__local__', local: true }), host({ host: 'a' }), host({ host: 'b' }), offline({ host: 'c' }), host({ host: 'd' })]
    const { centre, nodes, height } = topologyLayout(list)
    expect(centre).toMatchObject({ host: '__local__', x: TOPO.width / 2, y: height / 2 })
    expect(nodes.map((n) => [n.host, n.side, n.live])).toEqual([['a', 'left', true], ['c', 'left', false], ['b', 'right', true], ['d', 'right', true]])
    for (const n of nodes) {
      expect(n.y - TOPO.nodeH / 2).toBeGreaterThanOrEqual(0)
      expect(n.y + TOPO.nodeH / 2).toBeLessThanOrEqual(height)
    }
  })
  it('grows with the fleet so no two nodes overlap', () => {
    const list = [host({ host: '__local__', local: true }), ...Array.from({ length: 11 }, (_, i) => host({ host: `h${i}` }))]
    const { nodes } = topologyLayout(list)
    const left = nodes.filter((n) => n.side === 'left').map((n) => n.y)
    for (let i = 1; i < left.length; i++) expect(left[i] - left[i - 1]).toBeGreaterThanOrEqual(TOPO.nodeH)
  })
  it('labels each link with its kind and latency', () => {
    expect(linkLabel(host())).toBe('SSH tunnel, 38 ms')
    expect(linkLabel(offline())).toBe('Not connected')
    // A machine that joined with a link has no SSH at all.
    const joined = host()
    expect(linkLabel({ ...joined, connection: { ...joined.connection, kind: 'host-network' } })).toBe('Host network, 38 ms')
    expect(clip('Spare box with a rather long label', 17)).toBe('Spare box with...')
  })
})
