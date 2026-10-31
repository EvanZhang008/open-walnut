/**
 * The fleet view's shape and its pure rules: one card per host, built from what
 * Walnut already holds (the connection, the host's profile, its Walnut server,
 * the spend by host) plus the host's own `host.vitals` reply. No I/O here, so
 * every rule is pinned by a unit test (tests/core/hosts/fleet-model.test.ts);
 * fleet.ts gathers the inputs.
 */
import type { HostStats, HostVitals, VitalsBucket, VitalsOutage, VitalsWindow } from '../../providers/host-vitals-core.js'
import type { HostProfile } from './host-profile.js'
import type { HostLoadView } from './placement.js'

export type FleetConnectionKind = 'local' | 'ssh-tunnel' | 'bridge'

export interface FleetHost {
  host: string
  label: string
  local: boolean
  connection: {
    kind: FleetConnectionKind
    connected: boolean
    phase: string
    phaseLabel: string
    /** When the current link came up (ms), null while it is down. */
    since: number | null
    rttMs: number | null
    error: string | null
  }
  /** What the host is, from its last probe (host.facts). */
  system: {
    os: string | null
    arch: string | null
    cpus: number | null
    memBytes: number | null
    diskFreeBytes: number | null
    kind: string
    probedAt: string | null
  } | null
  /** How it is doing now (host.vitals), with when it was read; stale once the host stops answering. */
  now: (Pick<HostStats, 'cpus' | 'cpuUtil' | 'load' | 'memTotalBytes' | 'memAvailBytes' | 'uptimeSec' | 'bootedAt' | 'linked'> & { at: number; stale: boolean }) | null
  /** The host's own minute ledger, folded (host.vitals). */
  history: {
    coverageFrom: number | null
    windows: VitalsWindow[]
    bucketMinutes: number
    buckets: VitalsBucket[]
    outages: VitalsOutage[]
    boots: number[]
    daemonStarts: number
  } | null
  /** Claude Code sessions whose process is alive on the host (idle ones included; ACP workers not counted). */
  sessions: { running: number | null }
  /** Model spend of the sessions that ran there, last 30 days, at public list prices (not a bill). */
  spend: { last30dUsd: number; from: string; basis: 'list-price' } | null
  /** The Walnut server the host runs for this Mac (replica or plain host server); null for the Mac and the cloud box. */
  server: { enabled: boolean; program: string | null; phase: string; build: string | null; phone: string | null; message: string | null } | null
  daemon: { version: string | null; startedAt: number | null; startup: string; runtime: string | null; vitals: boolean } | null
  placement: {
    /**
     * Where new work goes, as session placement judges it now (src/core/hosts/placement.ts
     * judgeHost, scaled by placement_weights): the room score (higher is more, 0 when
     * busy), whether the host is over a cap and which ones, and its weight. All null
     * when its load is not known (not connected, no answer in time, the companion).
     */
    score: number | null
    busy: boolean | null
    reasons: string[]
    weight: number | null
    /** Whether a job that must keep running fits here, and why not. */
    longRunning: { ok: boolean; reasons: string[] }
  }
  checkedAt: number
  /** The card in one line, for an agent (fleetHostLine). */
  line: string
}

export const LONG_RUNNING_MIN_ONLINE = 0.95

/** Plain reasons a job that must keep running does not belong on this host now. */
export function longRunningReasons(h: Pick<FleetHost, 'local' | 'connection' | 'server' | 'daemon' | 'history' | 'system'>): string[] {
  const reasons: string[] = []
  if (!h.connection.connected) reasons.push('Walnut is not connected to it now.')
  if (h.local && h.system?.kind === 'laptop') reasons.push('It is a laptop: a job here stops while it sleeps.')
  if (!h.local && h.connection.kind !== 'bridge') {
    if (!h.server?.enabled) reasons.push('No Walnut server runs on it (Settings, Remote Hosts, host servers).')
    else if (h.server.phase !== 'running') reasons.push(`Its Walnut server is not running (${h.server.phase}).`)
  }
  if (h.daemon && h.daemon.startup !== 'service' && !h.local) reasons.push('Its daemon does not start by itself after a reboot (run `walnut daemon service install` on it).')
  const week = h.history?.windows.find((w) => w.days === 7)
  if (week && week.online !== null && week.minutes >= 24 * 60 && week.online < LONG_RUNNING_MIN_ONLINE) {
    reasons.push(`It was up ${Math.round(week.online * 1000) / 10}% of the last 7 days.`)
  }
  return reasons
}

export interface FleetInputs {
  host: string
  label: string
  local: boolean
  kind: FleetConnectionKind
  status: { connected: boolean; phase: string; phaseLabel: string; connectedAt?: number; error?: string | null }
  rttMs: number | null
  profile: HostProfile | null
  vitals: { value: HostVitals; at: number; stale: boolean } | null
  /** Placement's view of the host (hostLoads in placement.ts); null or absent when not known. */
  load?: Pick<HostLoadView, 'known' | 'score' | 'busy' | 'reasons' | 'weight'> | null
  spendUsd: number | null
  spendFrom: string | null
  server: FleetHost['server']
  daemon: FleetHost['daemon']
  now: number
}

export function buildFleetHost(i: FleetInputs): FleetHost {
  const probed = i.profile?.probed
  const system: FleetHost['system'] = probed ? {
    os: probed.os?.prettyName ?? ([probed.os?.platform, probed.os?.release].filter(Boolean).join(' ') || null),
    arch: probed.arch ?? null,
    cpus: probed.cpus || null,
    memBytes: probed.memBytes || null,
    diskFreeBytes: typeof probed.diskFreeBytes === 'number' ? probed.diskFreeBytes : null,
    kind: i.profile?.kind ?? 'unknown',
    probedAt: probed.probedAt ?? null,
  } : null
  const v = i.vitals?.value
  const now: FleetHost['now'] = v ? {
    cpus: v.stats.cpus, cpuUtil: v.stats.cpuUtil, load: v.stats.load,
    memTotalBytes: v.stats.memTotalBytes, memAvailBytes: v.stats.memAvailBytes,
    uptimeSec: v.stats.uptimeSec, bootedAt: v.stats.bootedAt, linked: v.stats.linked,
    at: i.vitals!.at, stale: i.vitals!.stale,
  } : null
  const history: FleetHost['history'] = v ? { ...v.history } : null
  const base = {
    local: i.local,
    connection: {
      kind: i.kind,
      connected: i.status.connected,
      phase: i.status.phase,
      phaseLabel: i.status.phaseLabel,
      since: i.status.connected ? (i.status.connectedAt ?? null) : null,
      rttMs: i.status.connected && i.rttMs ? i.rttMs : null,
      error: i.status.error ?? null,
    },
    server: i.server,
    daemon: i.daemon,
    history,
    system,
  }
  return {
    host: i.host,
    label: i.label,
    ...base,
    now,
    sessions: { running: v && !i.vitals!.stale ? v.stats.running : null },
    spend: i.spendUsd === null ? null : { last30dUsd: Math.round(i.spendUsd * 100) / 100, from: i.spendFrom ?? '', basis: 'list-price' },
    placement: i.load?.known
      ? { score: i.load.score, busy: i.load.busy, reasons: i.load.reasons, weight: i.load.weight ?? null, longRunning: { ok: false, reasons: [] } }
      : { score: null, busy: null, reasons: [], weight: i.load?.weight ?? null, longRunning: { ok: false, reasons: [] } },
    checkedAt: i.now,
    line: '',
  }
}

/** Fill in the long-running verdict once the card is whole. */
export function withPlacement(h: FleetHost): FleetHost {
  const reasons = longRunningReasons(h)
  const placed = { ...h, placement: { ...h.placement, longRunning: { ok: reasons.length === 0, reasons } } }
  return { ...placed, line: fleetHostLine(placed) }
}

/** The day buckets and outages are long; a short text for an agent reads the card in a line. */
export function fleetHostLine(h: FleetHost): string {
  const parts: string[] = [`${h.label} (${h.host})`]
  parts.push(h.connection.connected ? `connected over ${h.connection.kind}` : `not connected (${h.connection.phase})`)
  if (h.system?.os) parts.push(h.system.os)
  if (h.now) {
    const cpu = h.now.cpuUtil === null ? null : `${Math.round(h.now.cpuUtil * 100)}% CPU of ${h.now.cpus}`
    const mem = h.now.memAvailBytes === null ? null : `${Math.round(h.now.memAvailBytes / 1024 ** 3)} of ${Math.round(h.now.memTotalBytes / 1024 ** 3)} GB free`
    parts.push([cpu, mem].filter(Boolean).join(', ') + (h.now.stale ? ' (last reading)' : ''))
  }
  const week = h.history?.windows.find((w) => w.days === 7)
  if (week?.online !== null && week?.online !== undefined) {
    const over = week.minutes >= 1440 ? `${Math.round(week.minutes / 1440 * 10) / 10} days` : `${Math.round(week.minutes / 60 * 10) / 10} hours`
    parts.push(`up ${Math.round(week.online * 1000) / 10}% over ${over}`)
  }
  if (h.sessions.running !== null) parts.push(`${h.sessions.running} sessions open`)
  if (h.spend) parts.push(`$${Math.round(h.spend.last30dUsd)} in 30 days (list price)`)
  if (h.server) parts.push(h.server.enabled ? `Walnut server ${h.server.phase}` : 'no Walnut server')
  if (h.placement.weight === 0) parts.push('placement never picks it (weight 0)')
  else if (h.placement.busy) parts.push('too busy for new sessions: ' + h.placement.reasons.join(', '))
  if (!h.placement.longRunning.ok && h.placement.longRunning.reasons.length) parts.push('not for long-running jobs: ' + h.placement.longRunning.reasons.join(' '))
  return parts.join('; ')
}
