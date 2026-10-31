/**
 * The fleet card's pure rules (core/hosts/fleet-model.ts): the free-capacity
 * score, the long-running verdict and its reasons, and how the inputs become
 * one card and one line for an agent.
 */
import { describe, expect, it } from 'vitest'
import {
  buildFleetHost, longRunningReasons, withPlacement, type FleetHost, type FleetInputs,
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
      'Its Walnut server is not running (error).',
      'Its daemon does not start by itself after a reboot (run `walnut daemon service install` on it).',
      'It was up 90% of the last 7 days.',
    ])
    expect(h.connection).toMatchObject({ since: null, rttMs: null, error: 'ssh refused' })
    expect(h.sessions.running).toBeNull() // a stale reading does not count sessions
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
  it('carries the system, now, history, spend and one line', () => {
    const h: FleetHost = withPlacement(buildFleetHost(inputs()))
    expect(h.system).toMatchObject({ os: 'Debian 12', cpus: 32, memBytes: 128 * GB, kind: 'private-cloud-vm' })
    expect(h.now).toMatchObject({ cpus: 32, cpuUtil: 0.25, load: [6.2, 8.1, 14.7], stale: false })
    expect(h.sessions.running).toBe(19)
    expect(h.spend).toEqual({ last30dUsd: 1234.46, from: '2026-10-01', basis: 'list-price' })
    expect(h.history?.daemonStarts).toBe(15)
    expect(h.line).toBe('Dev box (devbox); connected over ssh-tunnel; Debian 12; 25% CPU of 32, 96 of 128 GB free; up 99% over 7 days; 19 sessions open; $1234 in 30 days (list price); Walnut server running')
  })

  it('a host with no probe, no vitals and no spend yet', () => {
    const h = withPlacement(buildFleetHost(inputs({ profile: null, vitals: null, spendUsd: null, daemon: null })))
    expect(h).toMatchObject({ system: null, now: null, history: null, spend: null, daemon: null, sessions: { running: null } })
    expect(h.placement).toMatchObject({ score: null, busy: null })
  })
})
