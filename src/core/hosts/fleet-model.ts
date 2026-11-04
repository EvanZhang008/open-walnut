/**
 * The fleet view's shape and its pure rules: one card per host, built from what
 * Walnut already holds (the connection, the host's profile, its Walnut server,
 * the spend by host) plus the host's own `host.vitals` reply. No I/O here, so
 * every rule is pinned by a unit test (tests/core/hosts/fleet-model.test.ts);
 * fleet.ts gathers the inputs.
 */
import type { HostStats, HostVitals, VitalsBucket, VitalsOutage, VitalsRecent, VitalsWindow } from '../../providers/host-vitals-core.js'
import type { HostProfile } from './host-profile.js'
import type { HostLoadView } from './placement.js'
import type { HostServerPhase } from '../host-server/manager.js'
import { capabilityWords, hostCapabilities, type HostCapabilities } from './capabilities.js'
import { bootStartWords } from '../../providers/remote-boot-start.js'

export type FleetConnectionKind = 'local' | 'ssh-tunnel' | 'host-network' | 'bridge'

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
    /** os.platform() of the host (linux, darwin), null when the probe did not say. */
    platform: string | null
    arch: string | null
    cpus: number | null
    memBytes: number | null
    diskFreeBytes: number | null
    kind: string
    probedAt: string | null
  } | null
  /** How it is doing now (host.vitals), with when it was read; stale once the host stops answering. */
  now: (Pick<HostStats, 'cpus' | 'cpuUtil' | 'load' | 'memTotalBytes' | 'memAvailBytes' | 'uptimeSec' | 'bootedAt' | 'linked'> & {
    /** 0..1, null with no GPU or an older daemon. */
    gpuUtil: number | null
    /** The disk holding HOME; null from an older daemon. */
    disk: { totalBytes: number; freeBytes: number } | null
    at: number; stale: boolean
  }) | null
  /** The host's own minute ledger, folded (host.vitals). */
  history: {
    coverageFrom: number | null
    windows: VitalsWindow[]
    bucketMinutes: number
    buckets: VitalsBucket[]
    outages: VitalsOutage[]
    boots: number[]
    daemonStarts: number
    /** The last 12 hours in 15 minute steps (absent from an older daemon). */
    recent?: VitalsRecent
  } | null
  /**
   * Sessions open on the host: its own count (Claude Code processes alive there, idle ones
   * included) while its reading is fresh, else Walnut's session records (`source`). `why`
   * says in words why there is no number, whenever `running` is null.
   */
  sessions: { running: number | null; source?: 'host' | 'records' | null; why?: string | null }
  /** Model spend of the sessions that ran there, last 30 days, at public list prices (not a bill). */
  spend: { last30dUsd: number; from: string; basis: 'list-price' } | null
  /** The Walnut server the host runs for this Mac (replica or plain host server); null for the Mac and the cloud box. */
  server: { enabled: boolean; program: string | null; phase: HostServerPhase; phaseLabel: string; build: string | null; phone: string | null; message: string | null } | null
  /**
   * `startup` is what the daemon reports ('service' or 'on-demand'). `bootStart` is the
   * host's own answer (src/providers/remote-boot-start.ts: which service, linger, the
   * crontab line), null until it was asked. `startsAfterReboot` is the verdict: the
   * host's answer when there is one, else a service daemon does, and so does the cloud
   * box's, which its systemd-run companion starts with itself. `reboot` says it in words.
   */
  daemon: {
    version: string | null; startedAt: number | null; startup: string; startsAfterReboot: boolean; runtime: string | null; vitals: boolean
    bootStart?: FleetBootStart | null
    reboot?: string
  } | null
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
  /** What the host can do (capabilities.ts): `tags` is what a `@tag` host selector matches. */
  capabilities: HostCapabilities
  checkedAt: number
  /** The card in one line, for an agent (fleetHostLine). */
  line: string
}

/** A host's boot start as the fleet shows it (BootStartView, flattened). */
export interface FleetBootStart {
  mode: 'boot' | 'login' | 'none'
  backend: string | null
  reason: string | null
  checkedAt: number
  setupRunning: boolean
  setupError: string | null
  /** What the Overview's button would do (BootStartNext); absent from an older server. */
  next?: 'install' | 'recheck' | null
}

export const LONG_RUNNING_MIN_ONLINE = 0.95

/** Words for each Walnut server phase; a phase code is never shown to a person or an agent. */
export const SERVER_PHASE_WORDS: Record<HostServerPhase, string> = {
  off: 'off',
  'waiting-for-host': 'waiting for the host to connect',
  unsupported: 'needs a newer daemon on the host',
  checking: 'checking the host',
  installing: 'installing',
  starting: 'starting',
  running: 'running',
  error: 'stopped on an error',
}

/** Words for how a host connects. */
export const CONNECTION_KIND_WORDS: Record<FleetConnectionKind, string> = { local: 'this computer', 'ssh-tunnel': 'SSH tunnel', 'host-network': 'the host network', bridge: 'bridge' }

/** A span of recorded minutes in words: minutes under an hour, hours under a day, then days. */
export function recordedSpan(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  if (m < 60) return m === 1 ? '1 minute' : `${m} minutes`
  if (m < 1440) { const h = Math.round(m / 6) / 10; return h === 1 ? '1 hour' : `${h} hours` }
  const d = Math.round(m / 144) / 10
  return d === 1 ? '1 day' : `${d} days`
}

/**
 * Why a daemon does not start by itself, and what makes it: the host's own
 * answer when there is one (Walnut sets up a Linux host itself; what stops it is
 * named there), else the command for a host that never answered.
 */
function rebootAdvice(d: NonNullable<FleetHost['daemon']>, platform: string | null | undefined): string {
  const b = d.bootStart
  if (b?.setupRunning) return 'Walnut is setting it up now'
  if (b) return b.setupError ?? b.reason ?? 'nothing on it starts the daemon at boot'
  return platform === 'darwin' ? 'run `walnut daemon install --yes` on it' : 'Walnut checks it once connected'
}

/** Plain reasons a job that must keep running does not belong on this host now. */
export function longRunningReasons(h: Pick<FleetHost, 'local' | 'connection' | 'server' | 'daemon' | 'history' | 'system'>): string[] {
  const reasons: string[] = []
  if (!h.connection.connected) reasons.push('Walnut is not connected to it now.')
  if (h.local && h.system?.kind === 'laptop') reasons.push('It is a laptop: a job here stops while it sleeps.')
  if (!h.local && h.connection.kind !== 'bridge') {
    if (!h.server?.enabled) reasons.push('No Walnut server runs on it (Settings, Remote Hosts, host servers).')
    else if (h.server.phase !== 'running') reasons.push(`Its Walnut server is not running (${h.server.phaseLabel}).`)
  }
  if (h.daemon && !h.daemon.startsAfterReboot && !h.local) reasons.push(`Its daemon does not start by itself after a reboot (${rebootAdvice(h.daemon, h.system?.platform)}).`)
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
  server: Omit<NonNullable<FleetHost['server']>, 'phaseLabel'> | null
  daemon: Omit<NonNullable<FleetHost['daemon']>, 'startsAfterReboot' | 'reboot'> | null
  /** The user's own tags for the host (config `hosts.<key>.capabilities`). */
  declaredCapabilities?: unknown
  /** Sessions open there by Walnut's own records (null: not known, absent: not asked). */
  recordedSessions?: number | null
  now: number
}

/** The host's own count while its reading is fresh, else Walnut's records; never a number with no source. */
function fleetSessions(i: FleetInputs): FleetHost['sessions'] {
  const v = i.vitals
  if (v && !v.stale) return { running: v.value.stats.running, source: 'host', why: null }
  if (typeof i.recordedSessions === 'number') return { running: i.recordedSessions, source: 'records', why: null }
  const why = i.kind === 'bridge' ? 'the cloud box runs no sessions of its own'
    : !i.status.connected ? 'Walnut is not connected to it'
    : v ? 'its reading is old and Walnut could not read its session records'
    : 'not read yet'
  return { running: null, source: null, why }
}

function fleetDaemon(d: NonNullable<FleetInputs['daemon']>, kind: FleetConnectionKind): NonNullable<FleetHost['daemon']> {
  const b = d.bootStart ?? null
  // A Mac's login agent is how a Mac runs a service: it counts as a home for long-running work, as it did
  // before the probe existed, while its words still say it waits for the login.
  const startsAfterReboot = kind === 'bridge'
    || (b ? (b.mode === 'boot' || (b.mode === 'login' && b.backend === 'launchd')) && !b.setupRunning : d.startup === 'service')
  return { ...d, bootStart: b, startsAfterReboot, reboot: rebootWords(b, startsAfterReboot) }
}

/** The Daemon row's words for a reboot. */
export function rebootWords(b: FleetBootStart | null, startsAfterReboot: boolean): string {
  if (!b) return startsAfterReboot ? 'starts by itself after a reboot' : 'does not start by itself after a reboot'
  return bootStartWords(b, { running: b.setupRunning, error: b.setupError })
}

export function buildFleetHost(i: FleetInputs): FleetHost {
  const probed = i.profile?.probed
  const system: FleetHost['system'] = probed ? {
    os: probed.os?.prettyName ?? ([probed.os?.platform, probed.os?.release].filter(Boolean).join(' ') || null),
    platform: probed.os?.platform ?? null,
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
    gpuUtil: v.stats.gpuUtil ?? null, disk: v.stats.disk ?? null,
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
    server: i.server ? { ...i.server, phaseLabel: SERVER_PHASE_WORDS[i.server.phase] ?? 'in a state this Walnut does not know' } : null,
    daemon: i.daemon ? fleetDaemon(i.daemon, i.kind) : null,
    history,
    system,
  }
  return {
    host: i.host,
    label: i.label,
    ...base,
    now,
    sessions: fleetSessions(i),
    spend: i.spendUsd === null ? null : { last30dUsd: Math.round(i.spendUsd * 100) / 100, from: i.spendFrom ?? '', basis: 'list-price' },
    placement: i.load?.known
      ? { score: i.load.score, busy: i.load.busy, reasons: i.load.reasons, weight: i.load.weight ?? null, longRunning: { ok: false, reasons: [] } }
      : { score: null, busy: null, reasons: [], weight: i.load?.weight ?? null, longRunning: { ok: false, reasons: [] } },
    capabilities: hostCapabilities({
      probed: probed ?? null, kind: i.profile?.kind ?? null, local: i.local,
      week: history?.windows.find((w) => w.days === 7) ?? null, declared: i.declaredCapabilities,
    }),
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
  parts.push(h.connection.connected ? `connected over ${CONNECTION_KIND_WORDS[h.connection.kind]}` : `not connected (${h.connection.phaseLabel})`)
  if (h.system?.os) parts.push(h.system.os)
  const can = h.capabilities ? capabilityWords(h.capabilities, { os: !h.system?.os }) : ''
  if (can) parts.push(`can: ${can}`)
  if (h.now) {
    const cpu = h.now.cpuUtil === null ? null : `${Math.round(h.now.cpuUtil * 100)}% CPU of ${h.now.cpus}`
    const mem = h.now.memAvailBytes === null ? null : `${Math.round(h.now.memAvailBytes / 1024 ** 3)} of ${Math.round(h.now.memTotalBytes / 1024 ** 3)} GB free`
    parts.push([cpu, mem].filter(Boolean).join(', ') + (h.now.stale ? ' (last reading)' : ''))
  }
  const week = h.history?.windows.find((w) => w.days === 7)
  if (week?.online !== null && week?.online !== undefined) {
    parts.push(`up ${Math.round(week.online * 1000) / 10}% over ${recordedSpan(week.minutes)}`)
  }
  if (h.sessions.running !== null) parts.push(`${h.sessions.running} sessions open`)
  if (h.spend) parts.push(`$${Math.round(h.spend.last30dUsd)} in 30 days (list price)`)
  if (h.server) parts.push(h.server.enabled ? `Walnut server ${h.server.phaseLabel}` : 'no Walnut server')
  if (h.placement.weight === 0) parts.push('placement never picks it (weight 0)')
  else if (h.placement.busy) parts.push('too busy for new sessions: ' + h.placement.reasons.join(', '))
  if (!h.placement.longRunning.ok && h.placement.longRunning.reasons.length) parts.push('not for a job that must keep running: ' + h.placement.longRunning.reasons.join(' '))
  return parts.join('; ')
}
