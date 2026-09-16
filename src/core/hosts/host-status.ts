/**
 * ONE shape for "where does this remote host stand", shared by the HTTP hydrate
 * (`GET /api/hosts/status`), the live WS push (`host:status`) and the folder
 * picker. Pure: a state snapshot in, a renderable record out, no I/O — so the
 * phase→text mapping is unit-tested exhaustively instead of being re-derived
 * (differently) in each surface.
 */

import type { DaemonConnectPhase, DaemonConnectState } from '../../providers/daemon-connection.js'
import type { Config } from '../types.js'
import type { HostWarmupState } from './host-warmup.js'
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
  /** ms until an automatic retry is allowed again. */
  retryInMs?: number
  warmup?: HostWarmupState
  discovered?: boolean
  /** When this snapshot was taken (ms epoch) — the client orders pushes by it. */
  at: number
}

export function buildHostStatus(
  hostKey: string,
  hostDef: HostDef,
  state: DaemonConnectState,
  warmup?: HostWarmupState,
  now: number = Date.now(),
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
    const { kind, hint } = classifyHostConnectError(
      state.error, sshTargetText, [hostKey, label, hostDef.hostname, hostDef.user ?? ''],
    )
    status.kind = kind
    status.hint = hint
  }
  if (state.retryInMs !== undefined) status.retryInMs = state.retryInMs
  if (warmup) status.warmup = warmup
  if (hostDef.discovered) status.discovered = true
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
