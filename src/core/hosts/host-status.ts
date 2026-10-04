/**
 * ONE shape for "where does this remote host stand", shared by the HTTP hydrate
 * (`GET /api/hosts/status`), the live WS push (`host:status`) and the folder
 * picker. Pure: a state snapshot in, a renderable record out, no I/O — so the
 * phase→text mapping is unit-tested exhaustively instead of being re-derived
 * (differently) in each surface.
 */

import type { DaemonConnectPhase, DaemonConnectState } from '../../providers/daemon-connection.js'
import type { RemoteRuntime } from '../../providers/remote-runtime.js'
import { MIN_DAEMON_FREE_MB, daemonDirWarning, displayDaemonDir } from '../../providers/remote-daemon-dir.js'
import type { Config } from '../types.js'
import type { HostWarmupState } from './host-warmup.js'
import type { HostReadiness, ReadinessProblem } from './host-readiness.js'
import {
  CREDENTIAL_WAIT_KINDS,
  RETRYABLE,
  classifyHostConnectError,
  hintForKind,
  connectPhaseNote,
  describeConnectPhase,
  describeConnectSteps,
  type ConnectStep,
  type HostConnectErrorKind,
} from '../sessions/host-connect-hint.js'

import { OFF_PHASE_LABEL } from './host-problem.js'

export type { HostWarmupState }

/**
 * The connection's own phases plus ONE the warmup adds: `queued` = this host is
 * waiting its turn behind another host's connect (the warmup is strictly
 * sequential). Without it a host that the human just asked to connect reads as
 * 'idle' ("Not connected") for the whole time the host before it is installing.
 */
export type HostStatusPhase = DaemonConnectPhase | 'queued' | 'off'

/** The subset of a config.hosts entry this module needs. */
export interface HostDef {
  hostname: string
  user?: string
  port?: number
  label?: string
  enabled?: boolean
  discovered?: boolean
  /** The paired cloud box (core/hosts/cloud-box-host.ts): reached over the companion's tunnel, not SSH. */
  cloud_box?: boolean
}

export interface HostStatus {
  host: string
  label: string
  hostname: string
  user?: string
  connected: boolean
  phase: HostStatusPhase
  /** One sentence a first-time user can act on. */
  phaseLabel: string
  steps: ConnectStep[]
  /** Only on the slow first-connect steps. */
  note?: string
  phaseElapsedMs: number
  connectElapsedMs: number
  /** One-line summary of the last connect failure, while it is still cached. */
  error?: string
  kind?: HostConnectErrorKind
  hint?: string
  /** A plain retry can work with nothing changed (see HostConnectHint.retryable). */
  retryable?: boolean
  /** ms until the failure cache lets an automatic retry through. NOT a promise of a retry: see retryAt. */
  retryInMs?: number
  /** Epoch ms of the next attempt Walnut really has scheduled (credential re-dial or standing slow probe). */
  retryAt?: number
  /** The reconnect loop's last failure while the phase is still 'reconnecting'. */
  lastError?: string
  lastKind?: HostConnectErrorKind
  lastHint?: string
  /** When the host dropped (the current reconnect began), epoch ms. */
  reconnectSince?: number
  /** When the current connect attempt began, epoch ms. */
  attemptStartedAt?: number
  /** When the current connection came up, epoch ms (a readiness answer older than this is stale). */
  connectedAt?: number
  /** The server clock when this frame was built (= at): clients correct their skew with it. */
  serverNow?: number
  warmup?: HostWarmupState
  discovered?: boolean
  /**
   * What the connected host can run (host.preflight). Only while connected, and
   * only from a daemon with 'preflight-v1'; `problems` is empty when all is well.
   */
  readiness?: HostReadiness
  /** Which runtime the daemon ended up on after any fallback (bun, the prebuilt binary, or node). */
  runtime?: RemoteRuntime | 'unknown'
  /**
   * Where the daemon keeps its files on the host. `fallback` = it moved to
   * ~/.cache/open-walnut because /tmp could not take it (`reason` says why).
   */
  daemonDir?: { path: string; display: string; fallback: boolean; reason?: string; freeMb?: number }
  /** Lines worth saying even when nothing is broken ("Using ~/.cache/open-walnut … because /tmp is read-only"). */
  warnings?: string[]
  /** false: this host cannot open a terminal (hostOffersTerminal), so a session there shows no Terminal tab. */
  terminal?: false
  /** When this snapshot was taken (ms epoch) — the client orders pushes by it. */
  at: number
}

/**
 * Readiness lines that come from the CONNECT (the daemon dir probe), merged
 * after the daemon's own preflight problems: a relocated daemon dir and a disk
 * too full for sessions. Same shape, so every surface already renders them.
 */
export function connectReadinessProblems(state: Pick<DaemonConnectState, 'daemonDir'>, hostLabel: string): ReadinessProblem[] {
  const dir = state.daemonDir
  if (!dir) return []
  const out: ReadinessProblem[] = []
  const shown = displayDaemonDir(dir.path, dir.home)
  const warning = daemonDirWarning(dir, dir.home)
  // Each line names the host (the UI then drops its own "<host>: " prefix) and
  // quotes paths and commands in backticks (rendered as code).
  if (warning) out.push({ kind: 'daemon_dir_fallback', message: `${hostLabel}: ${warning}`, commands: [] })
  if (typeof dir.freeMb === 'number' && dir.freeMb < MIN_DAEMON_FREE_MB) {
    const df = `df -h ${dir.fallback ? '~/.cache' : '/tmp'}`
    out.push({
      kind: 'disk_low',
      message: `${hostLabel} has only ${dir.freeMb} MB free where the session daemon keeps its files (\`${shown}\`); sessions need at least ${MIN_DAEMON_FREE_MB} MB. Free some space there (\`${df}\` shows where it went).`,
      commands: [df],
    })
  }
  return out
}

/** Facts from outside the connection that change what the frame says. */
export interface HostStatusExtra {
  /** Remote hosts are off on this server by design (an ephemeral test server). */
  off?: boolean
  /** host-warmup's armed credential re-dial for this host (epoch ms). */
  credentialRetryAt?: number
}

export function buildHostStatus(
  hostKey: string,
  hostDef: HostDef,
  state: DaemonConnectState,
  warmup?: HostWarmupState,
  now: number = Date.now(),
  readiness?: HostReadiness,
  extra: HostStatusExtra = {},
): HostStatus {
  const label = hostDef.label ?? hostKey
  if (extra.off) return offHostStatus(hostKey, hostDef, now)
  const status: HostStatus = {
    host: hostKey,
    label,
    hostname: hostDef.hostname,
    connected: state.connected,
    phase: state.phase,
    phaseLabel: describeConnectPhase(state.phase, label),
    steps: describeConnectSteps(state.phase),
    phaseElapsedMs: state.phaseElapsedMs,
    connectElapsedMs: state.connectElapsedMs,
    at: now,
    serverNow: now,
  }
  if (hostDef.user) status.user = hostDef.user
  // Waiting in the warmup's line, and the connection itself has nothing newer
  // to say (never tried, or its last failure was cleared by the human's retry):
  // that wait is the status, not "idle".
  if (warmup === 'queued' && !state.connected && (state.phase === 'idle' || (state.phase === 'failed' && !state.error))) {
    status.phase = 'queued'
    status.phaseLabel = `Waiting for another host to finish connecting, then ${label}`
    status.steps = describeConnectSteps('idle')  // nothing active: it has not started
    status.phaseElapsedMs = 0
    status.connectElapsedMs = 0
  }
  const note = connectPhaseNote(state.phase, label)
  if (note) status.note = note
  if (state.phase === 'failed' && state.error) {
    status.error = state.error
    // The ssh target as the USER would type it — the hint quotes it back.
    const c = classifyFor(state.error, hostKey, hostDef, label)
    // A reconnect's standing cause knows its kind better than its summary does.
    const kind = (state.kind as HostConnectErrorKind | undefined) ?? c.kind
    status.kind = kind
    status.hint = kind === c.kind ? c.hint : hintForKind(kind, sshTargetOf(hostDef), targetOf(hostDef, label))
    status.retryable = RETRYABLE[kind] ?? c.retryable
    const retryAt = state.retryAt ?? (CREDENTIAL_WAIT_KINDS.has(kind) ? extra.credentialRetryAt : undefined)
    if (typeof retryAt === 'number') status.retryAt = retryAt
  }
  if (state.phase === 'reconnecting' && !state.connected) {
    if (state.reconnectSince) status.reconnectSince = state.reconnectSince
    if (state.lastError) {
      const c = classifyFor(state.lastError, hostKey, hostDef, label)
      const kind = (state.lastKind as HostConnectErrorKind | undefined) ?? c.kind
      status.lastError = state.lastError
      status.lastKind = kind
      status.lastHint = kind === c.kind ? c.hint : hintForKind(kind, sshTargetOf(hostDef), targetOf(hostDef, label))
    }
  } else if (state.reconnectSince && status.error) status.reconnectSince = state.reconnectSince
  if (state.attemptStartedAt && !state.connected) status.attemptStartedAt = state.attemptStartedAt
  if (state.connectedAt && state.connected) status.connectedAt = state.connectedAt
  if (state.runtime) status.runtime = state.runtime
  if (state.daemonDir) {
    const d = state.daemonDir
    status.daemonDir = {
      path: d.path, display: displayDaemonDir(d.path, d.home), fallback: d.fallback,
      ...(d.reason ? { reason: d.reason } : {}), ...(d.freeMb !== undefined ? { freeMb: d.freeMb } : {}),
    }
    const warning = daemonDirWarning(d, d.home)
    if (warning) status.warnings = [warning]
  }
  if (state.retryInMs !== undefined) status.retryInMs = state.retryInMs
  if (warmup) status.warmup = warmup
  if (hostDef.discovered) status.discovered = true
  // The cloud box has two of the steps: the companion's tunnel (which, on a
  // first connect, waits for the companion to start this Mac's daemon), then
  // the daemon's hello. SSH, probe and deploy never happen there.
  if (hostDef.cloud_box) {
    status.steps = status.steps.filter((s) => s.phase === 'tunnel' || s.phase === 'handshake')
    if (status.phase === 'tunnel') status.phaseLabel = `Reaching ${label} through the cloud companion`
  }
  if (!hostOffersTerminal(hostDef)) status.terminal = false
  // A readiness answer describes the daemon we are talking to now; while the
  // host is down the connect error is the thing to show.
  if (readiness && state.connected) {
    const extra = connectReadinessProblems(state, label)
    status.readiness = extra.length ? { ...readiness, problems: [...readiness.problems, ...extra] } : readiness
  }
  return status
}

function sshTargetOf(def: HostDef): string {
  return def.user ? `${def.user}@${def.hostname}` : def.hostname
}

function targetOf(def: HostDef, label: string): { label: string; hostname: string; user?: string; port?: number } {
  return { label, hostname: def.hostname, ...(def.user ? { user: def.user } : {}), ...(def.port ? { port: def.port } : {}) }
}

/** The ONE classification call every frame field uses: label, hostname and port all reach the hint. */
function classifyFor(message: string, hostKey: string, def: HostDef, label: string) {
  return classifyHostConnectError(message, sshTargetOf(def), [hostKey, label, def.hostname, def.user ?? ''], targetOf(def, label))
}

/** An ephemeral test server never dials remotes: one quiet grey frame, no error, no hint, no problems. */
function offHostStatus(hostKey: string, def: HostDef, now: number): HostStatus {
  return {
    host: hostKey, label: def.label ?? hostKey, hostname: def.hostname, ...(def.user ? { user: def.user } : {}),
    connected: false, phase: 'off', phaseLabel: OFF_PHASE_LABEL, steps: describeConnectSteps('idle'),
    phaseElapsedMs: 0, connectElapsedMs: 0, at: now, serverNow: now,
    ...(hostOffersTerminal(def) ? {} : { terminal: false as const }),
  }
}

/**
 * Can a session on this host open a terminal? A terminal is an ssh + dtach
 * session to the host (web/terminal/spawn.ts), so a host Walnut reaches any
 * other way (the cloud box, through the companion's daemon tunnel) cannot.
 */
export function hostOffersTerminal(def: HostDef): boolean {
  return def.cloud_box !== true
}

/**
 * The hosts a status surface should show: exactly the folder picker's list
 * (`GET /api/sessions/working-dirs`), so the two never disagree about which
 * hosts exist. `enabled` defaults to true when unset; `__local__` is never a
 * configured host (it is the Mac itself and has no ssh/daemon-install story).
 */
export function listStatusHosts(config: Config): Array<{ key: string; def: HostDef }> {
  const hosts = config.hosts ?? {}
  return Object.entries(hosts)
    .filter(([key, def]) => key !== '__local__' && def.enabled !== false)
    .map(([key, def]) => ({ key, def: def as HostDef }))
}
