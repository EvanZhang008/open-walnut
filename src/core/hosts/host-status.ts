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
  classifyHostConnectError,
  connectPhaseNote,
  describeConnectPhase,
  describeConnectSteps,
  type ConnectStep,
  type HostConnectErrorKind,
} from '../sessions/host-connect-hint.js'

export type { HostWarmupState }

/**
 * The connection's own phases plus ONE the warmup adds: `queued` = this host is
 * waiting its turn behind another host's connect (the warmup is strictly
 * sequential). Without it a host that the human just asked to connect reads as
 * 'idle' ("Not connected") for the whole time the host before it is installing.
 */
export type HostStatusPhase = DaemonConnectPhase | 'queued'

/** The subset of a config.hosts entry this module needs. */
export interface HostDef {
  hostname: string
  user?: string
  port?: number
  label?: string
  enabled?: boolean
  discovered?: boolean
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
  /** ms until an automatic retry is allowed again. */
  retryInMs?: number
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

export function buildHostStatus(
  hostKey: string,
  hostDef: HostDef,
  state: DaemonConnectState,
  warmup?: HostWarmupState,
  now: number = Date.now(),
  readiness?: HostReadiness,
): HostStatus {
  const label = hostDef.label ?? hostKey
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
    const sshTargetText = hostDef.user ? `${hostDef.user}@${hostDef.hostname}` : hostDef.hostname
    const { kind, hint, retryable } = classifyHostConnectError(
      state.error, sshTargetText, [hostKey, label, hostDef.hostname, hostDef.user ?? ''],
      { hostname: hostDef.hostname, ...(hostDef.port ? { port: hostDef.port } : {}) },
    )
    status.kind = kind
    status.hint = hint
    status.retryable = retryable
  }
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
  // A readiness answer describes the daemon we are talking to now; while the
  // host is down the connect error is the thing to show.
  if (readiness && state.connected) {
    const extra = connectReadinessProblems(state, label)
    status.readiness = extra.length ? { ...readiness, problems: [...readiness.problems, ...extra] } : readiness
  }
  return status
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
