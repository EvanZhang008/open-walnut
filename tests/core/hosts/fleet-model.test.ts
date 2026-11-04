/**
 * The fleet card's pure rules (core/hosts/fleet-model.ts): the free-capacity
 * score, the long-running verdict and its reasons, and how the inputs become
 * one card and one line for an agent.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  type FleetBootStart,
  buildFleetHost, longRunningReasons, recordedSpan, withPlacement, SERVER_PHASE_WORDS, type FleetHost, type FleetInputs,
} from '../../../src/core/hosts/fleet-model.js'
import type { HostVitals } from '../../../src/providers/host-vitals-core.js'
import type { HostProfile } from '../../../src/core/hosts/host-profile.js'

const NOW = Date.UTC(2026, 9, 30, 12)
const GB = 1024 ** 3

function vitals(over: Partial<HostVitals['stats']> = {}, week = { online: 0.99, minutes: 7 * 1440 }): HostVitals {
  return {
    stats: { sampledAt: NOW, cpus: 32, cpuUtil: 0.25, load: [6.2, 8.1, 14.7], memTotalBytes: 128 * GB, memAvailBytes: 96 * GB, uptimeSec: 13 * 86400, bootedAt: NOW - 13 * 86_400_000, daemonStartedAt: NOW - 3600_000, linked: true, running: 19, ...over },
    history: {
      coverageFrom: NOW - 7 * 86_400_000, bucketMinutes: 1440, buckets: [],
      windows: [{ days: 7, minutes: week.minutes, up: Math.round(week.online * week.minutes), linked: 0, online: week.online, linkedShare: 0.9, drops: 41, downs: 2 }],
      outages: [], boots: [], daemonStarts: 15,
    },
    ledger: { lastWriteAt: NOW, writeErrors: 0, lastError: null },
  }
}

const profile = (kind: HostProfile['kind'] = 'private-cloud-vm'): HostProfile => ({
  host: 'devbox', kind, kindReasons: [], observed: { repoPaths: {}, reaches: {} }, updatedAt: '',
  probed: { os: { platform: 'linux', release: '5.10', prettyName: 'Debian 12' }, arch: 'x64', cpus: 32, memBytes: 128 * GB, home: '/home/dev', proxyEnv: {}, cloud: null, internet: null, tools: {}, uptimeSec: 1, diskFreeBytes: 50 * GB, probedAt: '2026-10-30T00:00:00.000Z' },
})

function inputs(over: Partial<FleetInputs> = {}): FleetInputs {
  return {
    host: 'devbox', label: 'Dev box', local: false, kind: 'ssh-tunnel',
    status: { connected: true, phase: 'connected', phaseLabel: 'Connected to Dev box', connectedAt: NOW - 600_000 },
    rttMs: 38, profile: profile(), vitals: { value: vitals(), at: NOW, stale: false },
    spendUsd: 1234.456, spendFrom: '2026-10-01',
    server: { enabled: true, program: 'replica', phase: 'running', build: '0.6.20-abc', phone: 'connected', message: null },
    daemon: { version: '0.6.20', startedAt: NOW - 3600_000, startup: 'service', runtime: 'bun', vitals: true },
    now: NOW, ...over,
  }
}

describe('the placement fields', () => {
  it('carry session placement\'s own view of the host when it knows the load', () => {
    const h = withPlacement(buildFleetHost(inputs({ load: { known: true, score: 7.5, busy: false, reasons: [], weight: 100 } })))
    expect(h.placement).toMatchObject({ score: 7.5, busy: false, reasons: [], weight: 100 })
    expect(h.line).not.toContain('busy')
  })
  it('say which caps a busy host is over, in the agent line too', () => {
    const h = withPlacement(buildFleetHost(inputs({ load: { known: true, score: 0, busy: true, reasons: ['CPU 97% busy', '3% memory available'], weight: 50 } })))
    expect(h.placement).toMatchObject({ score: 0, busy: true, reasons: ['CPU 97% busy', '3% memory available'] })
    expect(h.line).toContain('too busy for new sessions: CPU 97% busy, 3% memory available')
  })
  it('are unknown, never busy, when placement cannot read the host; weight 0 says placement never picks it', () => {
    const unknown = withPlacement(buildFleetHost(inputs({ load: { known: false, score: 0, busy: true, reasons: ['its load is unknown'], weight: 0 } })))
    expect(unknown.placement).toMatchObject({ score: null, busy: null, reasons: [], weight: 0 })
    expect(unknown.line).toContain('placement never picks it (weight 0)')
    expect(withPlacement(buildFleetHost(inputs())).placement).toMatchObject({ score: null, busy: null, weight: null })
  })
})

describe('the long-running verdict', () => {
  it('a connected host with a running server, a service daemon and a good week fits', () => {
    const h = withPlacement(buildFleetHost(inputs()))
    expect(h.placement.longRunning).toEqual({ ok: true, reasons: [] })
  })

  it('names every reason it does not fit', () => {
    const h = withPlacement(buildFleetHost(inputs({
      status: { connected: false, phase: 'failed', phaseLabel: 'x', error: 'ssh refused' },
      server: { enabled: true, program: 'replica', phase: 'error', build: null, phone: null, message: 'crashed' },
      daemon: { version: '0.6.20', startedAt: null, startup: 'on-demand', runtime: 'bun', vitals: true },
      vitals: { value: vitals({}, { online: 0.9, minutes: 7 * 1440 }), at: NOW, stale: true },
    })))
    expect(h.placement.longRunning.ok).toBe(false)
    expect(h.placement.longRunning.reasons).toEqual([
      'Walnut is not connected to it now.',
      'Its Walnut server is not running (stopped on an error).',
      'Its daemon does not start by itself after a reboot (Walnut checks it once connected).',
      'It was up 90% of the last 7 days.',
    ])
    expect(h.connection).toMatchObject({ since: null, rttMs: null, error: 'ssh refused' })
    expect(h.sessions).toMatchObject({ running: 19, source: 'host' }) // a stale reading keeps its count, with its time
  })

  it('a host with no server, and the Mac as a laptop', () => {
    expect(longRunningReasons(buildFleetHost(inputs({ server: { enabled: false, program: null, phase: 'off', build: null, phone: null, message: null } }))))
      .toEqual(['No Walnut server runs on it (Settings, Remote Hosts, host servers).'])
    const mac = buildFleetHost(inputs({ host: '__local__', local: true, kind: 'local', server: null, profile: profile('laptop'), daemon: { version: '1', startedAt: 1, startup: 'on-demand', runtime: 'binary', vitals: true } }))
    expect(longRunningReasons(mac)).toEqual(['It is a laptop: a job here stops while it sleeps.'])
  })

  it('a week under one day of ledger, or a bridge host, is not judged on what it cannot know', () => {
    const young = buildFleetHost(inputs({ vitals: { value: vitals({}, { online: 0.5, minutes: 600 }), at: NOW, stale: false } }))
    expect(longRunningReasons(young)).toEqual([])
    const cloud = buildFleetHost(inputs({ kind: 'bridge', server: null }))
    expect(longRunningReasons(cloud)).toEqual([])
  })
})

describe('the card', () => {
  it('counts sessions by the host\'s last reading, kept until a new one comes; Walnut\'s records for a host never read; says why when neither', () => {
    const fresh = buildFleetHost(inputs({ recordedSessions: 4 })).sessions
    expect(fresh).toMatchObject({ running: 19, source: 'host', why: null })
    // An old reading keeps its own count with its time (2026-11-04: "cache should cache ... until the real data come").
    const stale = { value: vitals(), at: NOW - 19 * 60_000, stale: true }
    expect(buildFleetHost(inputs({ vitals: stale, recordedSessions: 4 })).sessions).toEqual({ running: 19, source: 'host', why: null, at: NOW - 19 * 60_000 })
    expect(buildFleetHost(inputs({ vitals: stale, recordedSessions: 4, status: { ...inputs().status, connected: false } })).sessions.running).toBe(19)
    expect(buildFleetHost(inputs({ vitals: null, recordedSessions: 0 })).sessions).toEqual({ running: 0, source: 'records', why: null, at: null })
    // Every combination with no number names why.
    for (const vit of [null]) for (const connected of [true, false]) for (const kind of ['ssh-tunnel', 'bridge'] as const) {
      const s = buildFleetHost(inputs({ vitals: vit, kind, recordedSessions: null, status: { ...inputs().status, connected } })).sessions
      expect(s.running).toBeNull()
      expect(s.why, JSON.stringify({ vit: !!vit, connected, kind })).toBeTruthy()
    }
  })
  it('carries the GPU, the disk and the last 12 hours from the daemon, and null from an older one', () => {
    const v = vitals({ gpuUtil: 0.4, disk: { totalBytes: 1000 * GB, freeBytes: 300 * GB } })
    const recent = { from: NOW - 12 * 3_600_000, stepMinutes: 15, up: [15], cpu: [0.2], mem: [0.5], gpu: [0.4], disk: [0.7], sessions: [3] }
    v.history.recent = recent
    const h = buildFleetHost(inputs({ vitals: { value: v, at: NOW, stale: false } }))
    expect(h.now).toMatchObject({ gpuUtil: 0.4, disk: { totalBytes: 1000 * GB, freeBytes: 300 * GB } })
    expect(h.history?.recent).toEqual(recent)
    const old = buildFleetHost(inputs())
    expect(old.now).toMatchObject({ gpuUtil: null, disk: null })
    expect(old.history?.recent).toBeUndefined()
  })
  it('carries the system, now, history, spend and one line', () => {
    const h: FleetHost = withPlacement(buildFleetHost(inputs()))
    expect(h.system).toMatchObject({ os: 'Debian 12', cpus: 32, memBytes: 128 * GB, kind: 'private-cloud-vm' })
    expect(h.now).toMatchObject({ cpus: 32, cpuUtil: 0.25, load: [6.2, 8.1, 14.7], stale: false })
    expect(h.sessions.running).toBe(19)
    expect(h.spend).toEqual({ last30dUsd: 1234.46, from: '2026-10-01', basis: 'list-price' })
    expect(h.history?.daemonStarts).toBe(15)
    expect(h.line).toBe('Dev box (devbox); connected over SSH tunnel; Debian 12; can: always on; 25% CPU of 32, 96 of 128 GB free; up 99% over 7 days; 19 sessions open; $1234 in 30 days (list price); Walnut server running')
  })

  it('a host with no probe, no vitals and no spend yet', () => {
    const h = withPlacement(buildFleetHost(inputs({ profile: null, vitals: null, spendUsd: null, daemon: null })))
    expect(h).toMatchObject({ system: null, now: null, history: null, spend: null, daemon: null, sessions: { running: null } })
    expect(h.placement).toMatchObject({ score: null, busy: null })
  })
})

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

describe('words, never codes', () => {
  // Every phase the host server manager can be in, read from its type, so a new phase fails here.
  const union = /export type HostServerPhase =([^;]+)/.exec(read('src/core/host-server/manager.ts'))![1]
  const phases = [...union.matchAll(/'([a-z-]+)'/g)].map((m) => m[1])

  it('every Walnut server phase has words, and neither the reasons nor the line print a code', () => {
    expect(phases.length).toBeGreaterThan(5)
    for (const phase of phases) {
      const words = SERVER_PHASE_WORDS[phase as keyof typeof SERVER_PHASE_WORDS]
      expect(words, phase).toBeTruthy()
      const h = withPlacement(buildFleetHost(inputs({ server: { enabled: true, program: 'replica', phase: phase as never, build: null, phone: null, message: null } })))
      expect(h.server?.phaseLabel).toBe(words)
      const text = [h.line, ...h.placement.longRunning.reasons].join('\n')
      expect(h.line, phase).toContain(`Walnut server ${words}`)
      // No kebab-case code anywhere in what a person or an agent reads.
      expect(text.replace(/`[^`]*`/g, ''), phase).not.toMatch(/\b[a-z]+-[a-z]+(-[a-z]+)*\b/)
    }
  })

  it('a connection that is down is named by its words', () => {
    const h = withPlacement(buildFleetHost(inputs({ status: { connected: false, phase: 'waiting-for-host', phaseLabel: 'Waiting for Dev box' } })))
    expect(h.line).toContain('not connected (Waiting for Dev box)')
    expect(h.line).not.toContain('waiting-for-host')
  })
})

describe('recorded spans', () => {
  it('count minutes under an hour, never "0 hours"', () => {
    expect(recordedSpan(0)).toBe('0 minutes')
    expect(recordedSpan(1)).toBe('1 minute')
    expect(recordedSpan(10)).toBe('10 minutes')
    expect(recordedSpan(59)).toBe('59 minutes')
    expect(recordedSpan(60)).toBe('1 hour')
    expect(recordedSpan(90)).toBe('1.5 hours')
    expect(recordedSpan(1440)).toBe('1 day')
    expect(recordedSpan(3 * 1440)).toBe('3 days')
    const fresh = withPlacement(buildFleetHost(inputs({ vitals: { value: vitals({}, { online: 1, minutes: 10 }), at: NOW, stale: false } })))
    expect(fresh.line).toContain('up 100% over 10 minutes')
  })
})

describe('starting after a reboot', () => {
  const boot = (over: Partial<FleetBootStart> = {}): FleetBootStart => ({ mode: 'boot', backend: 'cron', reason: null, checkedAt: NOW, setupRunning: false, setupError: null, ...over })
  const onDemand = (bootStart: FleetBootStart | null) => ({ version: '1', startedAt: 1, startup: 'on-demand', runtime: 'bun', vitals: true, bootStart })

  it('the host\'s own answer wins over the start mode the daemon reports', () => {
    const cron = buildFleetHost(inputs({ daemon: onDemand(boot()) }))
    expect(cron.daemon).toMatchObject({ startsAfterReboot: true, reboot: 'starts by itself after a reboot (from its crontab)' })
    const gone = buildFleetHost(inputs({ daemon: { ...onDemand(boot({ mode: 'none', backend: null, reason: 'the @reboot line is missing from its crontab' })), startup: 'service' } }))
    expect(gone.daemon).toMatchObject({ startsAfterReboot: false, reboot: 'does not start by itself after a reboot: the @reboot line is missing from its crontab' })
    expect(longRunningReasons(gone)).toContain('Its daemon does not start by itself after a reboot (the @reboot line is missing from its crontab).')
  })

  it('a login-only service, a setup in progress and a setup that failed each say so', () => {
    const login = buildFleetHost(inputs({ daemon: onDemand(boot({ mode: 'login', backend: 'systemd-user', reason: 'linger is off' })) }))
    expect(login.daemon).toMatchObject({ startsAfterReboot: false, reboot: 'starts after a reboot only once you log in there (linger is off)' })
    const running = buildFleetHost(inputs({ daemon: onDemand(boot({ mode: 'none', backend: null, setupRunning: true })) }))
    expect(running.daemon).toMatchObject({ startsAfterReboot: false, reboot: 'Walnut is setting it up to start after a reboot' })
    expect(longRunningReasons(running)).toContain('Its daemon does not start by itself after a reboot (Walnut is setting it up now).')
    const failed = buildFleetHost(inputs({ daemon: onDemand(boot({ mode: 'none', backend: null, reason: 'nothing on it starts the daemon at boot', setupError: 'Walnut could not set it up: no cron daemon is enabled at boot or running here' })) }))
    expect(failed.daemon?.reboot).toBe('does not start by itself after a reboot: Walnut could not set it up: no cron daemon is enabled at boot or running here')
  })

  it('a remote Mac\'s login agent stays a home for long-running work, and its words name the login', () => {
    const mac = buildFleetHost(inputs({ daemon: { ...onDemand(boot({ mode: 'login', backend: 'launchd', reason: 'a login agent starts it when you log in on that Mac' })), startup: 'service' } }))
    expect(mac.daemon).toMatchObject({ startsAfterReboot: true, reboot: 'starts after a reboot only once you log in there (a login agent starts it when you log in on that Mac)' })
    expect(longRunningReasons(mac)).toEqual([])
  })

  it('the cloud box comes back with its companion, whatever its daemon reports', () => {
    const cloud = withPlacement(buildFleetHost(inputs({ kind: 'bridge', server: null, daemon: { version: '1', startedAt: 1, startup: 'on-demand', runtime: 'bun', vitals: true } })))
    expect(cloud.daemon?.startsAfterReboot).toBe(true)
    expect(cloud.placement.longRunning).toEqual({ ok: true, reasons: [] })
  })

  it('a service daemon does; an on-demand one on SSH does not, and the advice names a command that exists', () => {
    expect(buildFleetHost(inputs()).daemon?.startsAfterReboot).toBe(true)
    const linux = longRunningReasons(buildFleetHost(inputs({ daemon: { version: '1', startedAt: 1, startup: 'on-demand', runtime: 'bun', vitals: true } })))
    const mac = { ...profile(), probed: { ...profile().probed!, os: { platform: 'darwin', release: '24', prettyName: 'macOS 15' } } }
    const darwin = longRunningReasons(buildFleetHost(inputs({ profile: mac, daemon: { version: '1', startedAt: 1, startup: 'on-demand', runtime: 'bun', vitals: true } })))
    expect(linux).toEqual(['Its daemon does not start by itself after a reboot (Walnut checks it once connected).'])
    expect(darwin).toEqual(['Its daemon does not start by itself after a reboot (run `walnut daemon install --yes` on it).'])
    // The action named is one `walnut daemon` accepts.
    const actions = /\[('status'[^\]]*)\]\.includes\(action\)/.exec(read('src/providers/daemon-service-cli.ts'))![1]
    const named = /`walnut daemon (\w+)/.exec(darwin[0])![1]
    expect(actions).toContain(`'${named}'`)
    expect(read('src/providers/daemon-service-cli.ts')).toContain('--yes')
  })
})
