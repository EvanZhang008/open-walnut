/**
 * ONE shape for "where does this remote host stand", shared by the HTTP hydrate
 * (`GET /api/hosts/status`), the live WS push (`host:status`) and the folder
 * picker. Pure: a state snapshot in, a renderable record out, no I/O — so the
 * phase→text mapping is unit-tested exhaustively instead of being re-derived
 * (differently) in each surface.
 */

import { twinMachineLabelOf } from './daemon-twins.js'
import type { DaemonConnectPhase, DaemonConnectState } from '../../providers/daemon-connection.js'
import { ptyStreamMissingSentence } from './terminal-link.js'
import { daemonUpdateHowSentence, type DaemonLinkKind } from '../../providers/daemon-update-paths.js'
import { clockTime, daemonUpdateWaitSentence } from '../../providers/daemon-update-wait.js'
import type { SeenRuntime } from '../../providers/remote-runtime.js'
import { MIN_DAEMON_FREE_MB, daemonDirWarning, displayDaemonDir } from '../../providers/remote-daemon-dir.js'
import type { Config } from '../types.js'
import type { HostWarmupState } from './host-warmup.js'
import type { HostReadiness, ReadinessProblem } from './host-readiness.js'
import {
  CREDENTIAL_WAIT_KINDS,
  RETRYABLE,
  classifyHostConnectError,
  IN_PROGRESS_PHASES,
  hintForKind,
  connectPhaseNote,
  describeConnectPhase,
  describeConnectSteps,
  withTransfer,
  type ConnectStep,
  type HostConnectErrorKind,
} from '../sessions/host-connect-hint.js'

import { OFF_PHASE_LABEL } from './host-problem.js'
import { foundHostUnadopted } from './found-hosts.js'

export type { HostWarmupState }

/**
 * The connection's own phases plus ONE the warmup adds: `queued` = this host is
 * waiting its turn behind another host's connect (the warmup is strictly
 * sequential). Without it a host that the human just asked to connect reads as
 * 'idle' ("Not connected") for the whole time the host before it is installing.
 */
export type HostStatusPhase = DaemonConnectPhase | 'queued' | 'off'

/** How this machine reaches a host with no SSH route: a host-network machine, or the cloud box through the companion. */
export type HostRouteVia = 'host-network' | 'cloud'

/** The `ssh` and `via` fields of a host's frame: none for an SSH host. */
export function hostRouteFields(def: Pick<HostDef, 'cloud_box' | 'transport'>): { ssh?: false; via?: HostRouteVia } {
  if (hostHasSshRoute(def)) return {}
  return { ssh: false, via: def.cloud_box === true ? 'cloud' : 'host-network' }
}

/** The daemon link kind of a configured host, from its route alone (no connection needed). */
export function hostDaemonLinkKind(hostKey: string, def: Pick<HostDef, 'cloud_box' | 'transport'>): DaemonLinkKind {
  if (hostKey === '__local__') return 'local'
  const via = hostRouteFields(def).via
  return via === 'cloud' ? 'cloud-tunnel' : via === 'host-network' ? 'net' : 'ssh'
}

/** The subset of a config.hosts entry this module needs. */
export interface HostDef {
  hostname: string
  user?: string
  port?: number
  label?: string
  enabled?: boolean
  discovered?: boolean
  /** A found host's answer (found-hosts.ts). */
  connect?: 'ask' | 'yes' | 'not_now'
  /** The paired cloud box (core/hosts/cloud-box-host.ts): reached over the companion's tunnel, not SSH. */
  cloud_box?: boolean
  /** 'net': a machine on the host network (core/net/net-mac.ts), reached through walnut-net, not SSH. */
  transport?: 'ssh' | 'net'
  /** The user's capability tags for it (core/hosts/capabilities.ts). */
  capabilities?: string[]
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
  /**
   * The host's first connect is running: it had no daemon when probed and its link was never
   * up in this server (DaemonConnection.firstConnectRunning). The web console's background
   * card follows these; an established host's reconnect never carries it.
   */
  firstConnect?: true
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
  /** When the link dropped by itself in the last hour, epoch ms, oldest first (host-problem.ts reads "unstable" from it). */
  drops?: number[]
  /** The server clock when this frame was built (= at): clients correct their skew with it. */
  serverNow?: number
  warmup?: HostWarmupState
  discovered?: boolean
  /**
   * What the connected host can run (host.preflight). Only while connected, and
   * only from a daemon with 'preflight-v1'; `problems` is empty when all is well.
   */
  readiness?: HostReadiness
  /** What the host's daemon runs on: the compiled daemon, or (until its next update) the source daemon an older leader left under bun or node. */
  runtime?: SeenRuntime | 'unknown'
  /**
   * Where the daemon keeps its files on the host. `fallback` = it moved to
   * ~/.cache/open-walnut because /tmp could not take it (`reason` says why).
   */
  daemonDir?: { path: string; display: string; fallback: boolean; reason?: string; freeMb?: number }
  /** Lines worth saying even when nothing is broken ("Using ~/.cache/open-walnut … because /tmp is read-only"). */
  warnings?: string[]
  /**
   * false: this host cannot open a terminal now, so a session there shows no Terminal tab:
   * its daemon has no terminal streams (an older build, or one on Node) and the Mac has no
   * SSH route to it (hostTerminalNow). `terminalWhy` says so.
   */
  terminal?: false
  terminalWhy?: string
  /**
   * How this host's daemon gets a newer build, in one sentence (daemon-update-paths.ts
   * daemonUpdateHowSentence): the fix line under every "the daemon there needs an update"
   * (terminalWhy, a servers answer's why). Absent on an older server (the client has a fallback).
   */
  daemonUpdateHow?: string
  /**
   * false: this machine has no SSH route to the host (hostHasSshRoute), so what only SSH
   * can do (VS Code desktop's Remote-SSH) is not offered there; `via` names the route it
   * has. Absent = an SSH host (and on an older server).
   */
  ssh?: false
  via?: HostRouteVia
  /**
   * The name the host's machine calls itself (its daemon's hello), once a link has been up:
   * a chat link naming it opens in the Web view (web/src/utils/service-link.ts). Absent on an
   * older server, or before the host's daemon has said it.
   */
  machineName?: string
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
  // Another alias of a machine the person uses is named as that machine (daemon-twins.ts).
  const label = twinMachineLabelOf(hostKey, hostDef) ?? hostDef.label ?? hostKey
  if (extra.off) return offHostStatus(hostKey, hostDef, now, label)
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
    ...hostRouteFields(hostDef),
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
  if (state.firstConnect && !state.connected && IN_PROGRESS_PHASES.has(state.phase)) status.firstConnect = true
  // The daemon file's bytes on the host so far: the upload step's progress bar.
  const moving = withTransfer(status.steps, status.phase, state.transfer, label)
  status.steps = moving.steps
  if (moving.phaseLabel) status.phaseLabel = moving.phaseLabel
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
  // Also while a dial of the reconnect loop runs (foldReconnectCause): its last failure says why.
  if ((state.phase === 'reconnecting' || (state.lastError && IN_PROGRESS_PHASES.has(state.phase))) && !state.connected) {
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
  if (state.drops?.length) status.drops = state.drops
  if (state.runtime) status.runtime = state.runtime
  if (state.machineName) status.machineName = state.machineName
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
  // Known only from ~/.ssh/config, with no yes on it (found-hosts.ts): a yes is a configured host.
  if (foundHostUnadopted(hostDef)) status.discovered = true
  // The cloud box has two of the steps: the companion's tunnel (which, on a
  // first connect, waits for the companion to start this Mac's daemon), then
  // the daemon's hello. SSH, probe and deploy never happen there.
  if (hostDef.cloud_box) {
    status.steps = status.steps.filter((s) => s.phase === 'tunnel' || s.phase === 'handshake')
    if (status.phase === 'tunnel') status.phaseLabel = `Reaching ${label} through the cloud companion`
  }
  // A machine on the host network: the same two steps, through this Mac's walnut-net. An SSH
  // hint would send the user to a door this machine does not have.
  if (hostDef.transport === 'net') {
    status.steps = status.steps.filter((s) => s.phase === 'tunnel' || s.phase === 'handshake')
    if (status.phase === 'tunnel') status.phaseLabel = `Reaching ${label} through the host network`
    const hint = `Is ${label} on, with Walnut running? On it, \`walnut net status\` says whether it is on the host network.`
    if (status.hint) status.hint = hint
    if (status.lastHint) status.lastHint = hint
  }
  foldDaemonUpdate(status, state, label)
  const terminal = hostTerminalNow(hostDef, state, label)
  if (terminal !== true) { status.terminal = false; status.terminalWhy = terminal }
  status.daemonUpdateHow = daemonUpdateHowSentence(hostDaemonLinkKind(hostKey, hostDef), label, { host: hostKey })
  // A readiness answer describes the daemon we are talking to now; while the
  // host is down the connect error is the thing to show.
  if (readiness && state.connected) {
    const extra = connectReadinessProblems(state, label)
    status.readiness = extra.length ? { ...readiness, problems: [...readiness.problems, ...extra] } : readiness
  }
  return status
}

/** What a host's own daemon update makes the status say (daemon-net-update-record.ts). */
export function daemonUpdateSentence(label: string, update: { state: 'updating' | 'lost' | 'failed' | 'down'; at: number; message?: string }): string {
  if (update.state === 'updating') return `Updating the daemon on ${label} (since ${clockTime(update.at)}); it reconnects once the new one is up`
  // Away is all Walnut knows: a Mac that sleeps through its update is not broken (2026-11-04 review).
  if (update.state === 'lost') return `The daemon update on ${label} at ${clockTime(update.at)} has not come back yet; ${label} may be asleep, and it reconnects when it wakes`
  if (update.state === 'down') return `The daemon update on ${label} at ${clockTime(update.at)} left no daemon running there (${update.message ?? 'no reason was given'}); ${label} needs a restart or a new login to start Walnut again`
  return `The daemon update on ${label} at ${clockTime(update.at)} did not go through, so the daemon it had keeps serving: ${update.message ?? 'no reason was given'}`
}

/**
 * A host that went away during its own daemon update reads as that, not as a plain drop:
 * the sentence is the phase label and, once it has not come back, the failure's hint. Only
 * a record that says no daemon runs there (down) makes it a daemon failure (kind 'daemon':
 * "The session daemon on X did not start"); a host just away keeps its connect error's kind.
 * Back with an update that did not go through: a line in Settings, the reason included.
 * Connected with an update that waits (postponed, or skipped for now): a plain line in Settings
 * saying what it waits for and since when, never a warning (daemon-update-wait.ts).
 */
function foldDaemonUpdate(status: HostStatus, state: DaemonConnectState, label: string): void {
  if (state.connected && state.daemonUpdateWait) status.warnings = [...(status.warnings ?? []), daemonUpdateWaitSentence(label, state.daemonUpdateWait)]
  const update = state.daemonUpdate
  if (!update) return
  if (update.state === 'failed') {
    if (state.connected) status.warnings = [...(status.warnings ?? []), daemonUpdateSentence(label, update)]
    return
  }
  if (state.connected) return
  const sentence = daemonUpdateSentence(label, update)
  status.phaseLabel = sentence
  if (update.state === 'updating') return
  const down = update.state === 'down'
  if (status.phase === 'failed') {
    if (down) status.kind = 'daemon'
    status.hint = sentence
  } else {
    if (down) status.lastKind = 'daemon'
    status.lastHint = sentence
    status.lastError ??= sentence
  }
}

function sshTargetOf(def: HostDef): string {
  return def.user ? `${def.user}@${def.hostname}` : def.hostname
}

function targetOf(def: HostDef, label: string): { label: string; hostname: string; user?: string; port?: number; net?: boolean } {
  return { label, hostname: def.hostname, ...(def.user ? { user: def.user } : {}), ...(def.port ? { port: def.port } : {}), ...(def.transport === 'net' ? { net: true } : {}) }
}

/** The ONE classification call every frame field uses: label, hostname and port all reach the hint. */
function classifyFor(message: string, hostKey: string, def: HostDef, label: string) {
  return classifyHostConnectError(message, sshTargetOf(def), [hostKey, label, def.hostname, def.user ?? ''], targetOf(def, label))
}

/** An ephemeral test server never dials remotes: one quiet grey frame, no error, no hint, no problems. */
function offHostStatus(hostKey: string, def: HostDef, now: number, label: string): HostStatus {
  return {
    host: hostKey, label, hostname: def.hostname, ...(def.user ? { user: def.user } : {}),
    connected: false, phase: 'off', phaseLabel: OFF_PHASE_LABEL, steps: describeConnectSteps('idle'),
    phaseElapsedMs: 0, connectElapsedMs: 0, at: now, serverNow: now, ...hostRouteFields(def),
  }
}

/**
 * Every kind of host this Mac reaches opens a terminal: over SSH where it has an SSH
 * route, else as a terminal stream on the host's daemon link ('pty-stream-v1',
 * web/terminal/link-route.ts). A connection is an abstraction; a terminal never depends
 * on which one (the user, 2026-11-18: "it should always have ... no matter what
 * connection"). One row per transport: a new one fails to compile until it is given its
 * terminal, and the class guard (tests/web/terminal/terminal-every-host-kind.test.ts)
 * reads every transport from the source and fails for one missing here.
 */
export const TERMINAL_ROUTE_BY_TRANSPORT = { ssh: 'ssh', net: 'link' } as const satisfies Record<NonNullable<HostDef['transport']>, 'ssh' | 'link'>

/** How a terminal reaches a host of this kind: ssh where it has an SSH route, else its daemon link (the cloud box always). */
export function terminalRouteKind(def: Pick<HostDef, 'cloud_box' | 'transport'>): 'ssh' | 'link' {
  if (def.cloud_box === true) return 'link'
  const row = (TERMINAL_ROUTE_BY_TRANSPORT as Record<string, 'ssh' | 'link' | undefined>)[def.transport ?? 'ssh']
  return row ?? (hostHasSshRoute(def) ? 'ssh' : 'link')
}

/**
 * Can a session there open a terminal right now: true, or the sentence why not. Only a
 * link terminal depends on the daemon: one connected without terminal streams cannot.
 */
export function hostTerminalNow(def: HostDef, state: Pick<DaemonConnectState, 'noPtyStream'>, label: string): true | string {
  if (terminalRouteKind(def) === 'link' && state.noPtyStream) return ptyStreamMissingSentence(label)
  return true
}

/**
 * Whether this machine reaches the host over SSH at all. The cloud box (through the companion)
 * and a machine on the host network (its hostname a placeholder, `<alias>.walnut-net.invalid`)
 * have no SSH door: a command, a copy or a link for them goes through link(host), never ssh.
 */
export function hostHasSshRoute(def: Pick<HostDef, 'cloud_box' | 'transport'> | undefined): boolean {
  return !!def && def.cloud_box !== true && def.transport !== 'net'
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
