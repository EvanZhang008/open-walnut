/**
 * DaemonConnection — WebSocket client + SSH tunnel to remote walnut-daemon.
 *
 * ARCHITECTURE:
 * One DaemonConnection per remote host. Manages:
 *   1. Deploying daemon.cjs to the remote host
 *   2. Starting the daemon (or connecting to existing)
 *   3. SSH tunnel (localhost:localPort → remote:daemonPort)
 *   4. WebSocket connection through the tunnel
 *   5. Automatic reconnection on tunnel/connection failure
 *
 * LIFECYCLE:
 *   connect() → [send() commands] → disconnect()
 *   On tunnel death: auto-reconnect (daemon survives)
 *   On daemon death: auto-redeploy + restart
 *
 * PROTOCOL:
 *   Commands: { id, cmd, ...params }
 *   Responses: { id, ok, ...data }
 *   Events: { ev, ...data } (no id — unsolicited)
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { WebSocket } from 'ws'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { log } from '../logging/index.js'
import { getDaemonSource, resolveDaemonSourceVersion } from './daemon-source.js'
import { REQUIRED_DAEMON_CAPABILITIES } from './daemon-capabilities.js'
import { DAEMON_BINARIES_DIR, IS_EPHEMERAL } from '../constants.js'
import { buildRemotePreamble } from './session-io.js'
import { buildDaemonStartCmd, buildDaemonStopCmd } from './daemon-start-cmd.js'
import { diagnoseDaemonStartLog } from './daemon-start-diagnose.js'
import { updateRemoteDaemonService } from './daemon-service-update.js'
import { daemonGzCachePath } from './daemon-gz-cache.js'
import { buildTurnRetryEnv } from './daemon-core.js'
import type { SshTarget } from './session-io.js'
import {
  localDaemon,
  classifyServiceTakeover,
  daemonServiceConfigPaths,
  serviceTakeoverEvidence,
  serviceTakeoverInstruction,
  type ServiceProbeState,
  type ServiceTakeover,
} from './local-daemon.js'
// Leaf module (zero runtime imports) — safe to import statically from a provider.
import { isRecoverableSessionError, isRescuableStoppedRecord } from '../core/session-error-kind.js'
// Also a leaf (types.js only) — capability lookup, no session-layer cycle.
import { isAcpEngine } from '../core/agents/engine-registry.js'
import type { SessionRecord } from '../core/types.js'
import { sessionCronMetadata } from '../core/sessions/session-cron-metadata.js'
import { classifyHostConnectError, credentialRetryDelayMs, PROXY_LOGIN_EVIDENCE } from '../core/sessions/host-connect-hint.js'
import { isSshTransportFailure, markedUploadCommand, extractMarkedOutput, runRemoteSh, runSshBounded, shq, userShellPathScript } from './remote-sh.js'
import {
  PROD_REMOTE_DAEMON_DIR, buildDaemonDirProbeScript, chooseDaemonDir, daemonDirEnv, parseDaemonDirProbe,
  buildLiveDaemonScanScript, liveDaemonScanFoundNone, parseLiveDaemonScan, productionDaemonDirs, type DaemonDirChoice,
} from './remote-daemon-dir.js'
import {
  buildBunInstallScript, buildBunProbeScript, installTailForError, isRuntimeStartFailure, nextRuntimeAfterStartFailure,
  parseBunInstall, parseBunProbe, type RemoteRuntime,
} from './remote-runtime.js'
import { annotateCredentialFailure, SSH_EVIDENCE_PREFIX } from './ssh-credential-evidence.js'
import {
  clearReconnectCause, decideReconnectStep, getReconnectCause, isCredentialWaitKind, lastHostSignalAt, recordReconnectCause,
} from './daemon-reconnect-cause.js'

/** The source-deploy uploads (daemon.cjs + sidecars, tens of KB each). */
const SOURCE_UPLOAD_TIMEOUT_MS = 60_000

// ── Types ──

export interface DaemonCommandResult {
  ok: boolean
  error?: string
  [key: string]: unknown
}

/** L2: daemon-authoritative per-session background-task state, returned by the `getState` RPC.
 *  The daemon materializes this from the same task_* events Walnut sees, so Walnut can PULL it
 *  to reconcile a lost-terminal event without guessing liveness. `resourceVersion` = the byte
 *  offset of the latest applied event (monotonic, rebuilt from the jsonl after a daemon restart). */
export interface DaemonTaskStateEntry { status: string; v: number; t: number; description?: string; isBackgrounded?: boolean; toolUseId?: string }
export interface DaemonTaskState {
  tasks: Record<string, DaemonTaskStateEntry>
  resourceVersion: number
  updatedAt: number
  derivedRunning: number
  recentTransitions: Array<{ taskId: string; status: string; v: number; t: number }>
}
/** Reply shape of the `getState` RPC. `exists:false` = daemon has no record (treat as no bg work).
 *  Extends DaemonCommandResult so a `conn.send()` result casts cleanly (carries `ok`). */
export interface DaemonGetStateResult extends DaemonCommandResult {
  exists?: boolean
  alive?: boolean
  state?: 'running' | 'dead'
  taskState?: DaemonTaskState
  /** C1: assembled SessionSnapshot (absent from pre-snapshot daemons). */
  snapshot?: import('./daemon-fold.js').SessionSnapshot
}

export interface DaemonEvent {
  ev: string
  sid?: string
  line?: string
  lines?: string[]
  /** L1 versioned events: monotonic per-session byte offset (end of this line in the
   *  append-only jsonl). Identical whether the line is delivered live or via replay, so the
   *  client orders + dedupes by `v` alone. Absent from old daemons — RSM falls back to uuid dedup. */
  v?: number
  agent?: string
  code?: number
  /** Stderr content from the process (only present on exit events with non-zero code) */
  stderr?: string
  /** Authoritative lifecycle state broadcast ('running' | 'dead' | 'spawning') */
  state?: string
  /** Exit code on session_state=dead */
  exitCode?: number
  /** Reason string on session_state=dead (e.g. 'proc-exit', 'send-enxio', 'idle-scan-missed-exit') */
  reason?: string
  /** C1 snapshot push ({ev:'snapshot'}): the assembled SessionSnapshot. */
  snapshot?: import('./daemon-fold.js').SessionSnapshot
  [key: string]: unknown
}

type EventHandler = (event: DaemonEvent) => void

interface PendingCommand {
  resolve: (result: DaemonCommandResult) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  /** Command name + dispatch time, used to log the round-trip RTT when the
   *  daemon's response resolves this command. Lets `debug` logs surface
   *  SSH-tunnel/daemon latency that the enqueue→delivered `deliveryMs` misses. */
  cmd?: string
  startedAt?: number
  traceId?: string
}

// ── Mobile-relay enqueue ledger (post-delivery idempotency) ──
// The durable queue dedupes by messageId only while the row is still queued;
// once delivered+drained, a phone retry (lost ack) would re-enqueue the same
// turn. This bounded in-memory ledger of recently accepted qm-mobile ids
// closes that window. Module-scope on purpose: reconnects create fresh
// DaemonConnection instances but replays must still dedupe. Restart loses it —
// acceptable, since the retry window (phone tap) is minutes, not days.
const MOBILE_ENQUEUE_LEDGER_MAX = 500
const recentMobileEnqueues = new Set<string>()
function rememberMobileEnqueue(messageId: string): void {
  recentMobileEnqueues.add(messageId)
  if (recentMobileEnqueues.size > MOBILE_ENQUEUE_LEDGER_MAX) {
    // Set iteration is insertion-ordered — drop the oldest.
    const oldest = recentMobileEnqueues.values().next().value
    if (oldest !== undefined) recentMobileEnqueues.delete(oldest)
  }
}

// ── OS-service takeover on a remote host ──

/**
 * The remote host runs its daemon as an OS service, and right now that daemon
 * is not usable — so walnut refuses the unmanaged alternative (nohup deploy, or
 * killing the managed process to redeploy) instead of silently doing it.
 *
 * `kind` lets callers recognize it without string matching; the message names
 * the evidence and the exact `walnut daemon …` command to run on that host.
 */
export class DaemonServiceNotReadyError extends Error {
  readonly kind = 'service-not-ready'
  readonly hostKey: string
  readonly present: string[]
  readonly unknown: string[]

  constructor(hostKey: string, what: string, takeover: ServiceTakeover) {
    // Only a config Walnut actually saw makes "runs as an OS service" a fact.
    const claim = takeover.present.length ? 'runs' : 'may run'
    super(
      `remote host '${hostKey}' ${claim} the walnut session daemon as an OS service `
      + `(${serviceTakeoverEvidence(takeover)}) — ${what}. Run on that host: ${serviceTakeoverInstruction()}`,
    )
    this.name = 'DaemonServiceNotReadyError'
    this.hostKey = hostKey
    this.present = takeover.present
    this.unknown = takeover.unknown
  }
}

/**
 * A takeover verdict that may be NO verdict: `undetermined` says why the probe
 * got no answer (ssh timed out, the reply was cut short). `managed` stays true so
 * every guard that only reads it still refuses destructive steps, but callers
 * must not treat it as a finding: nothing was seen, so nothing is claimed, and
 * the decision it blocked is asked again.
 */
export type RemoteServiceTakeover = ServiceTakeover & {
  undetermined?: string
  /** The runtime dir the probe classified (its own marker file lives there). */
  dir?: string
}

/**
 * The service probe got no answer, so nobody knows whether an OS service owns
 * the daemon. Not "managed", not "unmanaged": Walnut does nothing destructive,
 * claims nothing, and retries (the reconnect loop for a connect, a timer for a
 * live connection). Before this, a 5s ssh timeout under load read as "runs the
 * daemon as an OS service": hosts with no service at all failed reconnects with
 * that message, and a stale daemon was kept until some later reconnect.
 */
export class DaemonServiceProbeError extends Error {
  readonly kind = 'service-probe-no-answer'
  readonly hostKey: string

  constructor(hostKey: string, what: string, reason: string) {
    super(`could not check whether '${hostKey}' runs its session daemon as an OS service (${reason}); ${what}. Walnut checks again on its own.`)
    this.name = 'DaemonServiceProbeError'
    this.hostKey = hostKey
  }
}

/** Per-attempt deadlines for the service probe: a loaded Mac or proxy can take more than one short window. */
export const SERVICE_PROBE_TIMEOUTS_MS = [10_000, 20_000]

/**
 * When a postponed daemon update is checked again on a live connection. Ends
 * on a slow steady step: the reasons are transient (no probe answer, an ACP
 * turn open) and the check is one small ssh round trip.
 */
export const UPGRADE_RECHECK_DELAYS_MS = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000]

/** Marker files the probe below classifies, in the order it reports them. */
export function remoteServiceProbePaths(runtimeDir = '/tmp/open-walnut'): string[] {
  // Both platforms' config paths are probed: the remote could be a Mac, and one
  // extra `[ -e ]` per path is far cheaper than a wrong "not installed".
  return [
    path.posix.join(runtimeDir, 'daemon.service'),
    ...daemonServiceConfigPaths('linux', '$HOME'),
    ...daemonServiceConfigPaths('darwin', '$HOME'),
  ]
}

const REMOTE_SERVICE_PROBE_SENTINEL = 'walnut-service-probe-done'

/**
 * One shell command that classifies every path as present / absent / unknown.
 *
 * `[ -e ]` cannot distinguish "missing" from "parent dir I may not read", so an
 * unreadable parent is reported as `unknown` explicitly, and the trailing
 * sentinel proves the command ran to completion at all (a truncated reply from a
 * dead ControlMaster must not read as a row of absences).
 */
export function buildRemoteServiceProbeCmd(paths: string[]): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
  const tests = paths.map((p) => {
    const q = p.startsWith('$HOME/') ? `"$HOME"/${quote(p.slice(6))}` : quote(p)
    const present = quote(`present ${p}`)
    const absent = quote(`absent ${p}`)
    const unknown = quote(`unknown ${p}`)
    return `if [ -e ${q} ] || [ -L ${q} ]; then printf '%s\\n' ${present}; `
      + `else P=${q}; while [ ! -d "$P" ] && [ "$P" != / ]; do P=$(dirname "$P"); done; `
      + `if [ -r "$P" ] && [ -x "$P" ]; then printf '%s\\n' ${absent}; `
      + `else printf '%s\\n' ${unknown}; fi; fi`
  })
  return `${tests.join('; ')}; echo ${REMOTE_SERVICE_PROBE_SENTINEL}`
}

/**
 * Parse the probe output. A path the reply never mentions is `unknown`, not
 * absent — same rule as the sentinel: silence is never evidence of absence.
 */
export function parseRemoteServiceProbe(output: string, paths: string[]): RemoteServiceTakeover {
  const seen = new Map<string, ServiceProbeState>()
  let complete = false
  for (const line of output.split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (line === REMOTE_SERVICE_PROBE_SENTINEL) { complete = true; continue }
    const match = /^(present|absent|unknown) (.+)$/.exec(line)
    if (match) seen.set(match[2], match[1] as ServiceProbeState)
  }
  const takeover = classifyServiceTakeover(paths.map((p) => ({
    path: p,
    state: complete ? (seen.get(p) ?? 'unknown') : 'unknown',
  })))
  return complete ? takeover : { ...takeover, undetermined: 'the probe reply was cut short' }
}

class DaemonShutdownPendingError extends Error {}

/** The errors that are a lifecycle DECISION (refuse, retry), never an ssh failure to swallow. */
function isServiceDecisionError(err: unknown): boolean {
  return err instanceof DaemonShutdownPendingError || err instanceof DaemonServiceNotReadyError
    || err instanceof DaemonServiceProbeError
}

/**
 * Commands a re-check's stop waits for: cut mid-way, each leaves a session or a
 * file in a state nobody knows. Reads and pings just fail and are asked again.
 */
const UPGRADE_HOLD_COMMANDS = new Set([
  'send', 'sendRaw', 'start', 'attach', 'stop', 'rename', 'setMode',
  'acpSend', 'acpStop', 'acpCancel', 'acpSetConfigOption',
  'fs.write', 'fs.rm', 'fs.rename', 'fs.copy', 'fs.mkdir', 'host.fix', 'triggers.run', 'triggers.ack', 'offline.ack',
])

/** A re-check's connection is gone: its decision is dropped, the reconnect makes a fresh one. */
const UPGRADE_STALE = 'stale'
/** What a re-check's gate answers right before a stop: go (null), stale, or a reason to wait. */
type UpgradeHold = null | typeof UPGRADE_STALE | string

/**
 * Where a connect() attempt currently is. A first connect to a fresh host can
 * run well over a minute (bun download on the remote, source upload, daemon
 * start), and a UI that only sees "not connected yet" reads that as "broken".
 * Each step of connect() stamps its phase so callers can say what is going on.
 */
export type DaemonConnectPhase =
  | 'idle'
  | 'ssh'
  | 'probe'
  | 'install-runtime'
  | 'upload'
  | 'start'
  | 'tunnel'
  | 'handshake'
  | 'connected'
  | 'reconnecting'
  | 'failed'

// ── DaemonConnection ──

export class DaemonConnection {
  private ws: WebSocket | null = null
  private tunnel: ChildProcess | null = null
  private sshTarget: SshTarget | null
  private hostKey: string
  private localPort: number | null = null
  private remotePort: number | null = null
  private _connected = false
  private _connecting = false
  private _destroyed = false
  private _disconnectedSince: number | null = null
  private _phase: DaemonConnectPhase = 'idle'
  private _phaseSince = Date.now()
  /** When the current connect() attempt began (null = no attempt yet). Phase
   *  elapsed only tells you about the CURRENT step; a first connect that has
   *  spent 90s across four steps needs the whole-attempt clock to read right. */
  private _connectStartedAt: number | null = null
  private cmdCounter = 0
  private pendingCommands = new Map<number, PendingCommand>()
  private eventHandlers: EventHandler[] = []
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** The reconnect() attempt running now: a concurrent caller joins it instead of starting a second connect(). */
  private _reconnectInFlight: Promise<void> | null = null
  /** The backoff delay the pending timer continues from (so an expedited attempt keeps its place in the chain). */
  private _reconnectChainDelayMs = 0
  private pingTimer: ReturnType<typeof setInterval> | null = null
  /** Timestamp of last pong received — used for stale connection detection. */
  private lastPongAt = 0
  /** True while a ping has been sent and its pong not yet received. */
  private _pongPending = false
  /** Consecutive awake ping ticks with the pong still outstanding. */
  private _missedPongs = 0
  /** Counter of consecutive reconnect attempts since last successful connect. Reset in setConnected(true). */
  private _reconnectAttempts = 0
  /** Consecutive reconnects that failed on a credential wait (index into credentialRetryDelayMs). */
  private _credentialReconnects = 0
  /** Last WebSocket URL opened — logged on close for troubleshooting. */
  private _lastWsUrl: string | null = null
  /**
   * Daemon instance ID from the most recent successful `hello`. Null until the
   * first handshake. Comparing against the daemon.instance file (or a later
   * hello) detects the "you reconnected to a different daemon" scenario that
   * previously surfaced as stale-state bugs.
   */
  private _daemonInstanceId: string | null = null
  /** Daemon start timestamp from the most recent successful `hello`. */
  private _daemonStartedAt: number | null = null
  /**
   * Capability list from the most recent successful `hello`, null until one
   * completes. EVERY connect path runs the handshake (connect / reconnect /
   * connectDirect), so null in practice means "the daemon answered no hello" —
   * a pre-hello binary or a minimal test fixture. Used to gate optional flows
   * ('snapshot-v1') on a per-host basis.
   */
  private _capabilities: string[] | null = null
  private _daemonStartup = 'on-demand'
  private cronMetadataToken: object | null = null
  /** Cloud-bridge liveness from the last bridge.configure reply (null = unknown / disabled). */
  private _lastBridgeConnected: boolean | null = null
  private _lastBridgeCheckedAt: number | null = null
  /** Periodic bridge-config re-push while connected — keeps the health surface
   *  fresh AND heals a wedged bridge (cmdBridgeConfigure reconciles). */
  private bridgeRepushTimer: ReturnType<typeof setInterval> | null = null
  /** True while a bridge.configure push is in flight — periodic re-pushes
   *  must never overlap (a slow RPC + a 5-min tick would stack them). */
  private bridgePushInFlight = false
  /** hooks.configure serialization (see pushDaemonHooks): in-flight guard +
   *  coalesced rerun flag + last-acked hash for RPC dedup. The hash resets on
   *  disconnect so a reconnect always re-pushes (the daemon may be a fresh
   *  process that never saw the rules). */
  private hooksPushInFlight = false
  private hooksPushRerun = false
  private lastHooksPushHash: string | null = null
  /** triggers.configure serialization — same three fields, same reasons (see pushTriggers). */
  private triggersPushInFlight = false
  private triggersPushRerun = false
  private lastTriggersPushHash: string | null = null
  /** host.slice serialization (see pushHostSlice) — same three fields, same reasons. */
  private hostSlicePushInFlight = false
  private hostSlicePushRerun = false
  private lastHostSlicePushHash: string | null = null
  /** The daemon's offline journal may hold records: set on connect and on its offline-journal event. */
  private offlineDrainDue = true
  /** One pending retry after a failed push (a starved daemon timed out the drain). */
  private hostSliceRetryTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Bulk data channel — a SECOND WebSocket to the same daemon (same tunnel
   * localPort; each TCP connection becomes an independent SSH channel, and
   * SSH interleaves channels in ~32KB packets). MB-scale response frames
   * (BULK_COMMANDS) ride here so they can't head-of-line-block interactive
   * commands on the strictly-ordered main socket. Purely an optional
   * accelerator: dialed in the background after connect, used only when
   * open+verified, silently falling back to the main WS otherwise. Its
   * failures NEVER touch _connected / handleConnectionLost.
   */
  private bulkWs: WebSocket | null = null
  /** At most one pending bulk redial at a time (unref'd). */
  private bulkRedialTimer: ReturnType<typeof setTimeout> | null = null
  /** Dial generation — bumped on every dial/teardown so a slow in-flight
   *  dial can't install a socket for a connection that has since moved on
   *  (reconnect allocates a NEW localPort). */
  private bulkDialSeq = 0

  /**
   * Last upgrade attempt (expected version + timestamp). Circuit breaker for
   * shouldUpgradeDaemon: if a just-upgraded daemon still reports a mismatch,
   * the stamping/deploy pipeline is broken and killing it again won't help.
   */
  private _lastUpgradeAttempt: { expected: string, at: number } | null = null

  /** Command timeout in ms. Generous for initial deploy operations. */
  private static COMMAND_TIMEOUT_MS = 30_000
  /**
   * Commands whose responses can be MB-scale frames (1MB JSONL chunks,
   * base64 images, git diffs up to 64MB) — routed to the bulk channel when
   * it's open. Everything else (fs.ls, status, sends, events) stays on the
   * main WS. Membership is by response size, not command family.
   */
  private static readonly BULK_COMMANDS = new Set(['fs.read', 'fs.readRange', 'fs.readImage', 'git.diff', 'changes.compute', 'changes.file', 'transcript.rewindProbe'])
  /** Delay before re-dialing the bulk channel after it drops (main stays up). */
  private static BULK_REDIAL_DELAY_MS = 10_000
  /** Within this window, refuse a second upgrade toward the same expected version. */
  private static UPGRADE_RETRY_COOLDOWN_MS = 10 * 60_000
  /** Initial reconnect delay after connection loss (doubles each attempt, caps at MAX). */
  private static RECONNECT_DELAY_MS = 2_000
  /** Maximum reconnect delay — retries forever at this interval. */
  private static RECONNECT_MAX_DELAY_MS = 30_000
  /**
   * Backoff cap when the failure is a standing condition no amount of retrying
   * fixes — expired SSH cert (`Permission denied (publickey)` until the user
   * runs mwinit) or a hostname that no longer resolves (host recycled). At the
   * normal 30s cap those hammered 2 hosts × ~19h on 2026-08-01 (each attempt
   * spawning several ssh processes, amplified by endpoint-security agents) and
   * read as "Walnut is frozen". Recovery after the user fixes auth is bounded
   * by this delay, which is acceptable for a condition that took hours anyway.
   */
  private static RECONNECT_STANDING_FAILURE_DELAY_MS = 10 * 60_000
  /** Ping interval for keepalive. */
  private static PING_INTERVAL_MS = 15_000
  /**
   * Periodic bridge.configure re-push interval. The daemon's configure handler
   * is idempotent AND self-healing (reconcile restarts a wedged dial), so
   * re-pushing identical config is a no-op on a healthy bridge and a heal on a
   * broken one. Each push also refreshes _lastBridgeConnected/_lastBridgeCheckedAt,
   * so /api/system/health never shows bridge state staler than this window.
   */
  private static BRIDGE_REPUSH_INTERVAL_MS = 5 * 60_000

  /** Cached remote arch (detected once per connection). */
  private _remoteArch: string | null = null
  /** SSH ControlMaster socket path — all SSH commands multiplex through one connection. */
  private _controlPath: string | null = null
  /** ControlMaster SSH process — kept alive for the lifetime of this DaemonConnection. */
  private _controlMaster: ChildProcess | null = null
  /** Tracks whether the last deploy used source (not binary) — affects startDaemon() command. */
  private _deployedViaSource = false
  /** Resolved path to bun on the remote host, or null if unavailable / not yet probed. */
  private _bunPath: string | null = null
  /**
   * The daemon dir on the host: /tmp/open-walnut, or $HOME/.cache/open-walnut
   * when /tmp cannot take it (remote-daemon-dir.ts). Decided at every probe
   * phase; every remote path below is built from it.
   */
  private _remoteDir: string = PROD_REMOTE_DAEMON_DIR
  private _dirChoice: DaemonDirChoice | null = null
  /** $HOME on the host, from the dir probe (pins the streams dir for a relocated daemon). */
  private _remoteHome: string | null = null
  /** The runtime the connected daemon runs on (null until a probe or start tells). */
  private _runtime: RemoteRuntime | 'unknown' | null = null
  /** Why a bun install failed on this connect, carried into the final error. */
  private _bunInstallNote: string | null = null
  /**
   * Runtimes that died at start on THIS host (exec format, illegal instruction,
   * GLIBC), with why. Kept for the connection's life (the pool keeps one per
   * host until its target changes), so a CPU the binary cannot run does not get
   * the 37MB binary re-uploaded on every connect.
   */
  private _failedRuntimes = new Map<RemoteRuntime, string>()

  constructor(hostKey: string, sshTarget: SshTarget | null) {
    this.hostKey = hostKey
    this.sshTarget = sshTarget
  }

  /**
   * Access sshTarget with non-null assertion. Only call from SSH-only code paths
   * (connect, deploy, tunnel) — never from connectDirect.
   */
  private get ssh(): SshTarget {
    if (!this.sshTarget) {
      throw new Error(
        `DaemonConnection(${this.hostKey}): SSH path taken but sshTarget is null. ` +
        `This is a bug — local connections should not reach SSH code. ` +
        `Use connectDirect() and reconnect's __local__ branch instead.`
      )
    }
    return this.sshTarget
  }

  /**
   * True when this connection must run read-only against a SHARED remote daemon:
   * an ephemeral server connecting to a real (non-__local__) host. Ephemeral servers
   * run over a snapshot of production data and may ATTACH to an already-running remote
   * daemon to debug live sessions — but they must NEVER deploy, start, stop, or redeploy
   * it. The remote daemon is a singleton (fixed /tmp/open-walnut/daemon.*); two servers
   * deploying/restarting it is what caused the crash loop. Local daemons are exempt:
   * same machine + same binary version means ensureRunning() reuses rather than fights.
   */
  private get isReadOnlyRemote(): boolean {
    return IS_EPHEMERAL && this.hostKey !== '__local__'
  }

  /**
   * An ephemeral server stays off shared remote hosts unless started with
   * WALNUT_EPHEMERAL_REMOTE_HOSTS=1. A remote daemon is one per host and hands
   * relayed work (phone requests, the `walnut` calls of its sessions) to
   * whichever server it sees first: attached there, a test server could answer
   * the real Walnut's traffic, and its own test sessions' calls could land on
   * the real Walnut. Read only when IS_EPHEMERAL, so the flag leaking down a
   * process tree changes nothing for any other server.
   */
  private get ephemeralRemoteRefused(): boolean {
    return this.isReadOnlyRemote && process.env.WALNUT_EPHEMERAL_REMOTE_HOSTS !== '1'
  }

  // ── Binary deployment helpers ──

  /**
   * Detect the remote host's architecture via `uname -m`.
   * Cached per connection — only one SSH round-trip.
   */
  private async detectRemoteArch(): Promise<string> {
    if (this._remoteArch) return this._remoteArch
    const raw = (await this.sshExec('uname -m')).trim()
    this._remoteArch = raw === 'aarch64' ? 'arm64' : 'x64'
    return this._remoteArch
  }

  /** Binary name for the detected remote arch. */
  private async getRemoteBinaryName(): Promise<string> {
    return `daemon-linux-${await this.detectRemoteArch()}`
  }

  /** Full remote path where the binary is deployed. */
  private async getRemoteDaemonPath(): Promise<string> {
    return `${this._remoteDir}/${await this.getRemoteBinaryName()}`
  }

  /**
   * Check if pre-compiled daemon binaries exist locally.
   * Returns the local binary path if available, null otherwise.
   */
  private async getLocalBinaryPath(): Promise<string | null> {
    const binaryPath = path.join(DAEMON_BINARIES_DIR, await this.getRemoteBinaryName())
    try {
      if (fs.statSync(binaryPath).isFile()) return binaryPath
    } catch { /* not built yet */ }
    return null
  }

  get connected(): boolean { return this._connected }
  get disconnectedSince(): number | null { return this._disconnectedSince }
  /** Host key this connection serves ('__local__' for the local daemon). */
  get host(): string { return this.hostKey }
  /** True when the last `hello` advertised the capability (false pre-handshake). */
  hasCapability(cap: string): boolean { return this._capabilities?.includes(cap) ?? false }
  /** False until a `hello` handshake has SUCCEEDED on this connection. All
   *  connect paths attempt it, so false = the daemon answered no hello. */
  get capabilitiesKnown(): boolean { return this._capabilities !== null }
  get daemonStartup(): string { return this._daemonStartup }
  /** 'snapshot-v1' shorthand — the C2 intake gate (contract §5). */
  get supportsSnapshots(): boolean { return this.hasCapability('snapshot-v1') }
  get daemonInstanceId(): string | null { return this._daemonInstanceId }
  get daemonStartedAt(): number | null { return this._daemonStartedAt }
  /** Last bridge.configure reply's connected flag (null = never pushed / bridge disabled). */
  get lastBridgeConnected(): boolean | null { return this._lastBridgeConnected }
  get lastBridgeCheckedAt(): number | null { return this._lastBridgeCheckedAt }
  /** Which connect() step is running (or 'connected' / 'failed' / 'idle'). */
  get connectPhase(): DaemonConnectPhase { return this._phase }
  /** When the current phase began (ms epoch). */
  get connectPhaseSince(): number { return this._phaseSince }
  /** When the current/last connect() attempt began (null = never attempted). */
  get connectStartedAt(): number | null { return this._connectStartedAt }
  /** Where the daemon keeps its files on the host, once a probe has decided. */
  get remoteDirChoice(): DaemonDirChoice | null { return this._dirChoice }
  /** Where the daemon keeps its files on the host (/tmp/open-walnut unless it had to move). */
  get remoteDaemonDir(): string { return this._remoteDir }
  get remoteHome(): string | null { return this._remoteHome }
  /** Which runtime the daemon runs on ('unknown' = attached to one we could not identify). */
  get remoteRuntime(): RemoteRuntime | 'unknown' | null { return this._runtime }

  private setPhase(phase: DaemonConnectPhase): void {
    if (this._phase === phase) return
    this._phase = phase
    this._phaseSince = Date.now()
    if (phase === 'failed') {
      // connect()'s catch lands here BEFORE the pool's catch records the cause in
      // the failure cache, so announcing now would push a failure with no error
      // text, and that cause-less version is the one a UI pins (it arrives first
      // and replaces the wait). The pool announces right after its cache write;
      // this deferred notify only speaks for a failure nobody cached (the
      // reconnect path), once the pool has had its turn.
      const t = setImmediate(() => {
        if (this._phase === 'failed' && !failureCache.has(this.hostKey)) notifyDaemonPhaseChange(this.hostKey)
      })
      t.unref?.()
      return
    }
    notifyDaemonPhaseChange(this.hostKey)
  }

  /**
   * A human deliberately cleared this host's failure (Retry / Connect now): the
   * terminal 'failed' must not outlive the cause it was explaining, or the very
   * next status push reads "Could not connect" with no error, no retry clock and
   * no sign that a new attempt is about to start. Back to 'idle' until connect()
   * moves it again. Silent: the caller announces once, after the cache is gone.
   */
  resetFailedPhase(): void {
    if (this._phase !== 'failed') return
    this._phase = 'idle'
    this._phaseSince = Date.now()
  }

  /** True when this pooled connection was built for the given ssh target. */
  targetsSame(sshTarget: SshTarget | null): boolean {
    const a = this.sshTarget
    const b = sshTarget
    if (!a || !b) return a === b
    return a.hostname === b.hostname && (a.user ?? '') === (b.user ?? '') && (a.port ?? 22) === (b.port ?? 22)
  }

  /**
   * Test seam ONLY (@internal): drive a phase transition without ssh. The real
   * transitions all go through the private setPhase above; this exists so the
   * pool-level phase-listener contract can be pinned without spawning ssh.
   */
  setPhaseForTest(phase: DaemonConnectPhase): void { this.setPhase(phase) }

  /**
   * Centralized setter for _connected — fires the pool-level callback
   * whenever the connection state actually changes, so the server can
   * broadcast the new daemon status to the frontend.
   */
  private setConnected(value: boolean): void {
    const changed = this._connected !== value
    this._connected = value
    if (changed) this._connectionEpoch++
    if (value) {
      this._disconnectedSince = null
      this._reconnectAttempts = 0
      this._credentialReconnects = 0
      clearReconnectCause(this.hostKey)
      this.setPhase('connected')
    } else if (changed) {
      this._disconnectedSince = Date.now()
      this.setPhase('reconnecting')
    }
    if (!value) {
      // Bridge liveness rode this (now dead) connection — a stale `true` would
      // render the contradictory 'Disconnected · bridge ✓' in the health UI.
      this._lastBridgeConnected = null
      this._lastBridgeCheckedAt = null
    }
    if (changed && onPoolStatusChange) {
      try {
        const result: void | Promise<void> = onPoolStatusChange()
        // Handle async callbacks: swallow unhandled rejection warnings.
        // The registered callback already has its own inner try/catch for logging.
        if (result instanceof Promise) {
          result.catch(() => {})
        }
      } catch {}
    }
    if (changed) {
      if (value && this.hasCapability('cron-metadata-v1') && this._daemonInstanceId) {
        const token = this.cronMetadataToken = {}
        sessionCronMetadata.connect(this.hostKey, token, this._daemonInstanceId)
        void this.send('cron.metadata', {}, 5000).then((reply) => {
          if (!this._connected || this.cronMetadataToken !== token || !Array.isArray(reply.values)) return
          for (const metadata of reply.values) sessionCronMetadata.apply(this.hostKey, token, metadata)
        }).catch(() => {})
      } else if (this.cronMetadataToken) {
        sessionCronMetadata.disconnect(this.hostKey, this.cronMetadataToken)
        this.cronMetadataToken = null
      }
    }
    if (changed && value) notifyHostConnected(this.hostKey, this)
    // Push the cloud-bridge config on every (re)connect. Single choke point:
    // connect(), reconnect() and forceRedeployAndReconnect() all land here.
    // Fire-and-forget — bridge provisioning must never block or fail a connect.
    if (changed && value) this.pushBridgeConfig()
    // Push the compiled daemon-hook rules on every (re)connect. Cheap (the
    // daemon hash-skips no-ops) and idempotent; changes are hot-pushed by
    // pushDaemonHooksToAllHosts on config/file change. The hash cache resets
    // on disconnect: a reconnect may be a FRESH daemon process that never saw
    // the rules, so "same hash as last push" must not skip it.
    if (changed) this.lastHooksPushHash = null
    if (changed && value) this.pushDaemonHooks()
    // Same choke point for the armed trigger set: a reconnect may be a FRESH
    // daemon process, and one that came back from a reboot with a stale
    // triggers.json must be corrected by the server's own view.
    if (changed) this.lastTriggersPushHash = null
    if (changed && value) this.pushTriggers()
    // And for the offline host: first take back what the daemon did while we
    // were away, then hand it a fresh read copy (docs/plan/daemon-first-hosts.md).
    if (changed) { this.lastHostSlicePushHash = null; this.offlineDrainDue = true }
    if (changed && value) this.pushHostSlice()
    // Distribute the walnut skill to this host's engine-native discovery
    // surfaces (claude skill store / codex AGENTS.md) on every (re)connect —
    // same freshness mechanism as the shims, hash-skipped daemon-side.
    if (changed) this.lastSkillSyncHash = null
    if (changed && value) this.pushSkillSync()
    // Keep bridge health fresh while connected: without a periodic re-push,
    // _lastBridgeConnected only updates on (re)connect and rots for days.
    if (changed) {
      if (value) this.startBridgeRepush()
      else this.stopBridgeRepush()
    }
    // Dial the bulk data channel in the background on every (re)connect —
    // same choke-point rationale as pushBridgeConfig. Reconnects allocate a
    // new localPort, so the dial must follow every transition to connected.
    if (changed && value) this.dialBulkChannel()
  }

  /**
   * Tell the daemon where to dial for the phone→cloud→daemon path (see
   * bridge.configure in daemon-standalone.ts). Ephemeral sandboxes skip, on
   * EVERY host: a shared remote daemon must not be rewired, and their own local
   * daemon would otherwise dial the cloud with the user's real bridge secret and
   * take phone traffic meant for the real Walnut.
   */
  private pushBridgeConfig(): void {
    if (IS_EPHEMERAL) return
    // In-flight guard: a slow configure RPC + the 5-min re-push tick must not
    // stack overlapping pushes against the same daemon.
    if (this.bridgePushInFlight) return
    this.bridgePushInFlight = true
    void (async () => {
      try {
        const { getBridgeConfigForHost } = await import('../integrations/cloud-bridge-config.js')
        const cfg = await getBridgeConfigForHost(this.hostKey)
        // Push disabled too — an operator turning the bridge off must reach
        // daemons that already hold a persisted bridge.json.
        const reply = await this.send('bridge.configure', cfg as unknown as Record<string, unknown>)
        if (reply.ok !== true) {
          // Rejected configure — the daemon refused/errored the command. That
          // says nothing about bridge liveness, so don't record `false`; keep
          // the previous observation and log the rejection on its own branch.
          log.session.warn('DaemonConnection: bridge config push rejected by daemon', {
            host: this.hostKey, error: typeof reply.error === 'string' ? reply.error : undefined,
          })
          return
        }
        // Record the daemon's own bridge liveness so /api/system/health can
        // surface phone-reachability per host (a wedged bridge dial used to
        // rot for days with zero observability).
        // NOTE: `reply.connected` reflects the adapter AT REPLY TIME — a
        // reconcile that just kicked off a fresh dial answers connected:false
        // even though it's healing; the next periodic re-push self-corrects.
        this._lastBridgeConnected = cfg.enabled ? reply.connected === true : null
        this._lastBridgeCheckedAt = Date.now()
        if (cfg.enabled && reply.connected !== true) {
          log.session.warn('DaemonConnection: bridge enabled but NOT connected on daemon', {
            host: this.hostKey,
          })
        } else {
          log.session.info('DaemonConnection: bridge config pushed', {
            host: this.hostKey, enabled: cfg.enabled, bridgeConnected: this._lastBridgeConnected,
          })
        }
      } catch (err) {
        log.session.warn('DaemonConnection: bridge config push failed', {
          host: this.hostKey, error: err instanceof Error ? err.message : String(err),
        })
      } finally {
        this.bridgePushInFlight = false
      }
    })()
  }

  /**
   * Push the compiled daemon-hook rules (see core/hooks/daemon-hooks.ts).
   * The rules JSON is the ONLY artifact the daemon ever gets — everything a
   * hook needs must be inside it, so there is no side-file distribution
   * problem. Ephemeral sandboxes skip (they attach to production daemons and
   * must not rewire them); pre-hooks-v1 daemons are skipped (they enforce via
   * the legacy WALNUT_ENFORCE_SESSION_CRON spawn env instead).
   *
   * Serialized per connection: overlapping calls (connect racing a
   * config:changed) could otherwise land out of order and leave the daemon
   * holding a stale rule set until the next reconnect. A call arriving while
   * one is in flight sets a rerun flag instead of stacking — the in-flight
   * push recompiles from fresh config on the rerun, so the LAST state always
   * wins. Also skips the RPC when the compiled hash matches the last push to
   * this host (config:changed fires for many unrelated keys — focus bar,
   * favorites, ordering — and each would otherwise cost an RPC per host).
   */
  pushDaemonHooks(): void {
    if (this.isReadOnlyRemote) return
    if (this._capabilities && !this.hasCapability('hooks-v1')) return
    if (this.hooksPushInFlight) { this.hooksPushRerun = true; return }
    this.hooksPushInFlight = true
    void (async () => {
      try {
        do {
          this.hooksPushRerun = false
          const [{ compileDaemonHooks }, { getConfig }] = await Promise.all([
            import('../core/hooks/daemon-hooks.js'),
            import('../core/config-manager.js'),
          ])
          const config = compileDaemonHooks(await getConfig())
          if (config.hash === this.lastHooksPushHash) continue
          const reply = await this.send('hooks.configure', { config: config as unknown as Record<string, unknown> })
          if (reply.ok !== true) {
            log.session.warn('DaemonConnection: daemon hooks push rejected', {
              host: this.hostKey, error: typeof reply.error === 'string' ? reply.error : undefined,
            })
            continue
          }
          this.lastHooksPushHash = config.hash
          log.session.info('DaemonConnection: daemon hooks pushed', {
            host: this.hostKey, hash: config.hash, hooks: config.hooks.length,
            changed: (reply as Record<string, unknown>).changed === true,
          })
        } while (this.hooksPushRerun)
      } catch (err) {
        log.session.warn('DaemonConnection: daemon hooks push failed', {
          host: this.hostKey, error: err instanceof Error ? err.message : String(err),
        })
      } finally {
        this.hooksPushInFlight = false
      }
    })()
  }

  /**
   * Distribute the walnut skill to this host: ONE canonical copy at
   * `~/.open-walnut/distributed-skills/walnut/SKILL.md`, symlinked into the engines'
   * native skill folders (`~/.claude/skills/walnut`, `~/.agents/skills/walnut`
   * — see core/skill-sync.ts for what and why). The daemon owns the writes
   * (marker-guarded, production-dir only); this just ships the current
   * content. Capability-gated: an old daemon simply keeps the previous copies
   * until auto-deploy upgrades it. Fire-and-forget — distribution must never
   * block or fail a connect.
   */
  private lastSkillSyncHash: string | null = null
  private skillSyncInFlight = false

  pushSkillSync(): void {
    if (this.isReadOnlyRemote) return
    if (this._capabilities && !this.hasCapability('skill-sync-v2')) return
    if (this.skillSyncInFlight) return
    this.skillSyncInFlight = true
    void (async () => {
      try {
        const { buildSkillSyncPayload } = await import('../core/skill-sync.js')
        const payload = await buildSkillSyncPayload()
        if (!payload || payload.hash === this.lastSkillSyncHash) return
        const reply = await this.send('skills.sync', {
          hash: payload.hash,
          // `skill` rides along for a daemon that predates the multi-skill
          // payload: it reads that field alone and still gets `walnut`.
          skill: payload.skill,
          skills: payload.skills,
        })
        if (reply.ok !== true) {
          log.session.warn('DaemonConnection: skill sync rejected', {
            host: this.hostKey, error: typeof reply.error === 'string' ? reply.error : undefined,
          })
          return
        }
        this.lastSkillSyncHash = payload.hash
        log.session.info('DaemonConnection: walnut skills synced', {
          host: this.hostKey, hash: payload.hash, skills: payload.skills.map((s) => s.name),
          changed: (reply as Record<string, unknown>).changed === true,
          wrote: (reply as Record<string, unknown>).wrote,
        })
      } catch (err) {
        log.session.warn('DaemonConnection: skill sync failed', {
          host: this.hostKey, error: err instanceof Error ? err.message : String(err),
        })
      } finally {
        this.skillSyncInFlight = false
      }
    })()
  }

  /**
   * Push the armed trigger set for this host (`triggers.configure`, see
   * docs/plan/walnut-trigger.md). Same shape and the same reasons as
   * pushDaemonHooks: read-only sandboxes never rewire a shared daemon,
   * pre-triggers-v1 daemons are skipped (they simply have no triggers), pushes
   * are serialized per connection so a mutation racing a connect cannot leave a
   * stale set behind, and an unchanged hash skips the RPC entirely (every
   * routine mutation on ANY host would otherwise cost one RPC per host).
   *
   * The set itself is compiled by a REGISTERED PROVIDER, never imported: the
   * routines layer already reaches into this pool, so a static import back into
   * cron/routines would close the cycle (see core/routines/trigger-bridge.ts).
   * No provider (server still booting) means NO push — an empty set would
   * disarm every trigger this daemon is already polling.
   */
  /**
   * True once a `triggers.configure` for this connection was accepted, i.e. the
   * daemon's armed set is this server's. The routines layer asks before acking a
   * fire for a job it does not know: our push makes the unknown id an orphan of
   * a deleted routine; no push yet means the fire may be another server's, and
   * acking it would eat it (a stale test server adopting the production daemon
   * is a recorded incident).
   */
  get triggersPushed(): boolean {
    return this.lastTriggersPushHash !== null
  }

  pushTriggers(): void {
    if (this.isReadOnlyRemote) return
    if (this._capabilities && !this.hasCapability('triggers-v1')) return
    if (this.triggersPushInFlight) { this.triggersPushRerun = true; return }
    this.triggersPushInFlight = true
    void (async () => {
      try {
        do {
          this.triggersPushRerun = false
          const { getTriggerPayloadProvider } = await import('../core/routines/trigger-bridge.js')
          const provider = getTriggerPayloadProvider()
          if (!provider) return
          const compiled = await provider(this.hostKey)
          if (!compiled) return
          if (compiled.hash === this.lastTriggersPushHash) continue
          const reply = await this.send('triggers.configure', {
            config: compiled.payload as unknown as Record<string, unknown>,
          })
          if (reply.ok !== true) {
            log.session.warn('DaemonConnection: triggers push rejected', {
              host: this.hostKey, error: typeof reply.error === 'string' ? reply.error : undefined,
            })
            continue
          }
          this.lastTriggersPushHash = compiled.hash
          log.session.info('DaemonConnection: triggers pushed', {
            host: this.hostKey, hash: compiled.hash, triggers: compiled.payload.triggers.length,
          })
        } while (this.triggersPushRerun)
      } catch (err) {
        log.session.warn('DaemonConnection: triggers push failed', {
          host: this.hostKey, error: err instanceof Error ? err.message : String(err),
        })
      } finally {
        this.triggersPushInFlight = false
      }
    })()
  }

  /**
   * Offline host (`offline-host-v1`, docs/plan/daemon-first-hosts.md): drain the
   * daemon's journal of what it answered while this server was away, then push
   * this Walnut's read copy for the host (`host.slice`, which also tells the
   * daemon which socket is ours). Same discipline as pushTriggers: read-only
   * sandboxes never write a shared daemon, serialized per connection with a
   * rerun flag so the LAST state wins, and an unchanged copy skips the RPC. The
   * drain runs only when the journal can hold something: after a (re)connect,
   * and when the daemon says it wrote one (offline-journal event, or
   * pendingHandover on the push reply). Every task change re-pushes, so a drain
   * per push was a round trip per change to every host.
   */
  pushHostSlice(): void {
    if (this.isReadOnlyRemote) return
    // Only on a daemon that said it has it (hello runs before any push): a copy
    // pushed to anything else is a command it answers "unknown".
    if (!this.hasCapability('offline-host-v1')) return
    if (this.hostSlicePushInFlight) { this.hostSlicePushRerun = true; return }
    this.hostSlicePushInFlight = true
    void (async () => {
      try {
        do {
          this.hostSlicePushRerun = false
          const [{ runOfflineHandover }, { buildHostSlice, ensureHostSliceSync }] = await Promise.all([
            import('../core/offline-handover.js'),
            import('../core/host-slice.js'),
          ])
          ensureHostSliceSync()
          if (this.offlineDrainDue) {
            this.offlineDrainDue = false
            try {
              await runOfflineHandover({ hostKey: this.hostKey, send: (cmd, params, timeoutMs) => this.send(cmd, params, timeoutMs) })
            } catch (err) {
              this.offlineDrainDue = true
              throw err
            }
          }
          const slice = await buildHostSlice(this.hostKey)
          if (slice.hash === this.lastHostSlicePushHash) continue
          const reply = await this.send('host.slice', { slice: slice as unknown as Record<string, unknown> })
          if (reply.ok !== true) {
            log.session.warn('DaemonConnection: host slice push rejected', {
              host: this.hostKey, error: typeof reply.error === 'string' ? reply.error : undefined,
            })
            continue
          }
          this.lastHostSlicePushHash = slice.hash
          log.session.info('DaemonConnection: host slice pushed', {
            host: this.hostKey, hash: slice.hash, sessions: slice.sessions.length, tasks: slice.tasks.length,
            requests: slice.requests.length, changed: (reply as Record<string, unknown>).changed === true,
          })
          // Records written while the handover ran (the daemon answered here
          // until its journal was empty) go in the next round.
          if ((reply as Record<string, unknown>).pendingHandover === true) { this.offlineDrainDue = true; this.hostSlicePushRerun = true }
        } while (this.hostSlicePushRerun)
      } catch (err) {
        log.session.warn('DaemonConnection: host slice push failed', {
          host: this.hostKey, error: err instanceof Error ? err.message : String(err),
        })
        // Pushes ride task changes; a quiet board would otherwise leave the
        // daemon answering offline (its journal untaken) while we are connected.
        if (!this.hostSliceRetryTimer && !this._destroyed) {
          this.hostSliceRetryTimer = setTimeout(() => {
            this.hostSliceRetryTimer = null
            if (this._connected && !this._destroyed) this.pushHostSlice()
          }, 30_000)
          this.hostSliceRetryTimer.unref?.()
        }
      } finally {
        this.hostSlicePushInFlight = false
      }
    })()
  }

  /**
   * Re-push the bridge config every BRIDGE_REPUSH_INTERVAL_MS while connected.
   * Same timer discipline as pingTimer: (re)armed on every transition to
   * connected, cleared on disconnect/destroy and connection loss.
   */
  private startBridgeRepush(): void {
    if (this.bridgeRepushTimer) clearInterval(this.bridgeRepushTimer)
    if (this.isReadOnlyRemote) return
    this.bridgeRepushTimer = setInterval(() => {
      if (this._destroyed || !this._connected) return
      this.pushBridgeConfig()
    }, DaemonConnection.BRIDGE_REPUSH_INTERVAL_MS)
    // Never keep the process alive just for bridge health refreshes.
    this.bridgeRepushTimer.unref?.()
  }

  private stopBridgeRepush(): void {
    if (this.bridgeRepushTimer) {
      clearInterval(this.bridgeRepushTimer)
      this.bridgeRepushTimer = null
    }
  }

  // ── Event subscription ──

  /**
   * Subscribe to unsolicited daemon events (jsonl, exit, agent).
   * Returns an unsubscribe function.
   */
  onEvent(handler: EventHandler): () => void {
    // Defensive: never register the same handler reference twice. A double
    // registration makes every daemon event dispatch to that handler twice in
    // a single tick — the root cause of streamed text doubling. RSM routes all
    // (re)subscribes through rebindEventListener() (which unsubscribes first),
    // so this is a belt-and-suspenders guard against any future leaking path.
    if (this.eventHandlers.includes(handler)) {
      return () => {
        const idx = this.eventHandlers.indexOf(handler)
        if (idx >= 0) this.eventHandlers.splice(idx, 1)
      }
    }
    this.eventHandlers.push(handler)
    // DUP-DEBUG: handler count > 1 means multiple subscribers on the same conn —
    // every daemon-pushed event will fan out to all of them, doubling downstream
    // processing. Used to diagnose tool_use rendered twice in remote sessions.
    log.session.info('DaemonConnection.onEvent registered', {
      host: this.hostKey,
      daemonInstanceId: this._daemonInstanceId,
      handlerCount: this.eventHandlers.length,
    })
    return () => {
      const idx = this.eventHandlers.indexOf(handler)
      if (idx >= 0) this.eventHandlers.splice(idx, 1)
      log.session.info('DaemonConnection.onEvent unsubscribed', {
        host: this.hostKey,
        daemonInstanceId: this._daemonInstanceId,
        handlerCount: this.eventHandlers.length,
      })
    }
  }

  // ── Connection ──

  /**
   * Connect to the remote daemon. If no daemon is running, deploy and start one.
   * Sets up SSH tunnel and WebSocket connection.
   */
  async connect(): Promise<void> {
    if (this._connected || this._connecting) return
    this._connecting = true
    // A reconnect timer must never fire under a running connect: its reconnect()
    // stops the ControlMaster this attempt is building (C12b). A failure below
    // puts the loop back on its schedule, so cancelling never ends recovery.
    const resumeLoop = this.cancelReconnectTimer()
    // A real attempt starts here (after the early return), so the whole-attempt
    // clock never counts time spent waiting on somebody else's connect.
    this._connectStartedAt = Date.now()
    // Reset destroyed flag — allows reconnection after a previous disconnect().
    // Without this, handleConnectionLost() and scheduleReconnect() silently abort
    // (they gate on _destroyed), so any future connection loss would be permanent.
    this._destroyed = false

    try {
      // Local daemon fast-path: no SSH deploy/tunnel. Ensure the in-process
      // local daemon is running and connect its WebSocket directly. Mirrors
      // reconnect()'s __local__ branch. WITHOUT this, DaemonFileReader('__local__')
      // — used for ALL local session-data reads under the daemon-uniform model —
      // would fall into the SSH path below and try to `ssh __local__` (a literal,
      // unresolvable hostname), failing every local history read whenever the
      // connection pool hadn't already been warmed by an attached session. The
      // pool is only warmed lazily by RemoteSessionManager.connectDirect(), so a
      // history fetch that raced ahead of any session attach (e.g. right after a
      // server restart) returned 0 messages. Self-warming here removes that
      // ordering dependency entirely.
      if (this.hostKey === '__local__') {
        const { localDaemon } = await import('./local-daemon.js')
        await localDaemon.ensureRunning()
        const wsUrl = localDaemon.wsUrl
        if (!wsUrl) throw new Error('Local daemon has no wsUrl after ensureRunning')
        await this.connectWebSocket(wsUrl)
        const ok = await this.verifyCapabilities()
        if (!ok) {
          log.session.warn('DaemonConnection: local connect hello failed — proceeding anyway', {
            host: this.hostKey,
          })
        }
        this.setConnected(true)
        this.startPing()
        this._connecting = false
        log.session.info('DaemonConnection: local connected (direct)', {
          host: this.hostKey, wsUrl, instanceId: this._daemonInstanceId,
        })
        return
      }

      if (this.ephemeralRemoteRefused) {
        throw new Error(
          `ephemeral server: remote host '${this.hostKey}' is off for test servers ` +
          `(set WALNUT_EPHEMERAL_REMOTE_HOSTS=1 to attach anyway)`,
        )
      }

      // Step 0: Establish SSH ControlMaster (one connection for all subsequent commands)
      this.setPhase('ssh')
      await this.ensureControlMaster()

      // Step 1: Where the daemon lives on this host, then is it already running
      this.setPhase('probe')
      await this.resolveRemoteDir()
      let daemonPort = await this.checkDaemonRunning()

      if (daemonPort === null) {
        if (this.isReadOnlyRemote) {
          // Ephemeral: attach-only. If no daemon is already running on the shared
          // remote host, do NOT deploy/start one — that would let the throwaway
          // sandbox fight the production server over the singleton daemon.
          throw new Error(
            `ephemeral server: no daemon running on '${this.hostKey}' and ephemeral ` +
            `sandboxes do not deploy/start remote daemons (attach-only)`,
          )
        }
        // Steps 2-3: deploy (stamps install-runtime / upload) and start, with
        // one runtime fallback chain if the start fails in a runtime-shaped way.
        daemonPort = await this.deployAndStart()
      }

      this.remotePort = daemonPort

      // Step 4: Create SSH tunnel
      this.setPhase('tunnel')
      this.localPort = await this.createTunnel(daemonPort)

      // Step 5: Connect WebSocket
      this.setPhase('handshake')
      await this.connectWebSocket(this.localPort)

      // Step 6: Capability handshake — final guard against protocol drift.
      // Run BEFORE setConnected(true) so the pool-status broadcast doesn't let
      // external callers send real commands (e.g. sendRaw) through a stale
      // daemon. verifyCapabilities uses _sendHandshake() which bypasses the
      // _connected gate in send().
      //
      // Even if version strings match (Layers 1-3 happy), the binary could be
      // corrupted or hand-swapped. An old daemon without `hello` returns
      // `unknown command: hello` → redeploy. A newer daemon that's somehow
      // missing a capability → redeploy. See daemon-capabilities.ts for the
      // required list.
      const handshakeOk = await this.verifyCapabilities()
      if (!handshakeOk) {
        if (this.isReadOnlyRemote) {
          // Ephemeral attach-only: a capability mismatch must NOT trigger a redeploy
          // (that would restart the production daemon). The running daemon belongs to
          // production and is almost certainly fine; bail instead of fighting it.
          throw new Error(
            `ephemeral server: capability handshake failed on '${this.hostKey}' and ` +
            `ephemeral sandboxes do not redeploy remote daemons (attach-only)`,
          )
        }
        log.session.warn('DaemonConnection: capability handshake failed — forcing redeploy', {
          host: this.hostKey,
        })
        // Tear down tunnel + WS, stop remote daemon, redeploy, reconnect.
        // forceRedeployAndReconnect handles its own setConnected(true) on
        // success; on failure it throws, caught by the outer try/catch.
        // An OS-managed daemon is refused there BEFORE any teardown, so this
        // attempt's transport is still up and has to be closed here.
        try {
          await this.forceRedeployAndReconnect()
        } catch (err) {
          if (err instanceof DaemonServiceNotReadyError || err instanceof DaemonServiceProbeError) this.closeTransport()
          throw err
        }
      } else {
        this.setConnected(true)
      }
      this._connecting = false

      // Start ping keepalive
      this.startPing()

      log.session.info('DaemonConnection: connected', {
        host: this.hostKey,
        localPort: this.localPort,
        remotePort: daemonPort,
      })

      // Initial connection: recover any sessions that were left in error state
      // from a previous server run (e.g. server restart while sessions were error).
      this.recoverDisconnectedSessions().catch(() => {})
    } catch (err) {
      // Ask the local agent why an auth failure happened (expired certificate,
      // no agent) before anyone reads the error. Still inside _connecting, so a
      // second caller keeps waiting on this attempt.
      const annotated = this.sshTarget ? await annotateCredentialFailure(err, this.sshHostString) : err
      this._connecting = false
      this.setPhase('failed')
      if (resumeLoop) void this.handleReconnectFailure(annotated, this._reconnectChainDelayMs || DaemonConnection.RECONNECT_DELAY_MS, true)
      throw annotated
    }
  }

  /**
   * Send a command to the daemon and wait for a response.
   *
   * Auto-injects a `traceId` into the payload when the caller hasn't supplied
   * one. This lets `grep <traceId>` stitch together a turn across walnut logs,
   * daemon logs, and (via --debug) Claude CLI logs. Callers who want a trace
   * ID that outlives one `send()` (e.g. the whole turn — send → jsonl → result)
   * should supply their own.
   */
  async send(
    cmd: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = DaemonConnection.COMMAND_TIMEOUT_MS,
  ): Promise<DaemonCommandResult> {
    if (!this._connected || !this.ws) {
      throw new Error(`DaemonConnection not connected to ${this.hostKey}`)
    }

    const id = ++this.cmdCounter
    const traceId = typeof params.traceId === 'string' && params.traceId
      ? params.traceId
      : crypto.randomBytes(4).toString('hex')
    const payload = { id, cmd, ...params, traceId }
    const message = JSON.stringify(payload)

    // Per-command send log — paired with daemon's cmd_recv log (same traceId).
    // Skip `ping` to avoid spamming the logs (it fires every 15s, adds nothing
    // we can't infer from the pong gap timer).
    if (cmd !== 'ping') {
      log.session.debug('DaemonConnection: send', {
        host: this.hostKey,
        cmd,
        id,
        traceId,
        sid: typeof params.sid === 'string' ? params.sid : undefined,
        daemonInstanceId: this._daemonInstanceId,
      })
    }

    // Bulk routing: big-response commands ride the second socket when it's
    // open, so their MB-scale frames can't head-of-line-block interactive
    // commands on the main WS. Shared pendingCommands map — the response is
    // matched by id regardless of which socket delivers it.
    const bulkSocket = DaemonConnection.BULK_COMMANDS.has(cmd) && this.bulkWs?.readyState === WebSocket.OPEN
      ? this.bulkWs
      : null

    const startedAt = Date.now()
    return new Promise<DaemonCommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id)
        // A bulk-routed timeout means the bulk socket may be half-dead
        // (TCP up, daemon unreachable through it). Terminate it so the next
        // bulk command falls back to the main WS immediately; the close
        // handler schedules a redial. Main-socket timeouts keep today's
        // behavior (ping staleness owns main liveness).
        if (bulkSocket && this.bulkWs === bulkSocket) {
          log.session.warn('DaemonConnection: bulk command timeout — terminating bulk channel', {
            host: this.hostKey, cmd, traceId,
          })
          try { bulkSocket.terminate() } catch {}
        }
        reject(new Error(`daemon command timeout: ${cmd} (${timeoutMs}ms) [traceId=${traceId}]`))
      }, timeoutMs)

      this.pendingCommands.set(id, { resolve, reject, timer, cmd, startedAt, traceId })
      ;(bulkSocket ?? this.ws!).send(message)
    })
  }

  /**
   * Answer a daemon-relayed STT request (phone voice input arriving over the
   * cloud bridge while this box holds the transcription engine). Runs the
   * configured local engine and replies with an `stt-result` carrying the
   * relayId. Errors are reported back (not thrown) so the daemon can fail the
   * bridge request and let the cloud box fall back to OpenAI. The audio
   * payload is never logged.
   */
  private async handleSttRequest(event: DaemonEvent): Promise<void> {
    const relayId = event.relayId
    const audio = event.audio
    const format = event.format
    if (typeof relayId !== 'number' || typeof audio !== 'string' || typeof format !== 'string') return
    let reply: Record<string, unknown>
    try {
      const { getConfig } = await import('../core/config-manager.js')
      const { transcribeAudio } = await import('../core/stt/index.js')
      const result = await transcribeAudio(await getConfig(), {
        audio, format,
        language: typeof event.language === 'string' && event.language !== '' ? event.language : undefined,
      })
      log.session.info('DaemonConnection: stt relay transcribed', {
        host: this.hostKey, relayId, chars: result.text.length, durationMs: result.durationMs,
      })
      reply = { relayId, text: result.text, durationMs: result.durationMs }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.session.warn('DaemonConnection: stt relay failed', { host: this.hostKey, relayId, message })
      reply = { relayId, error: message }
    }
    try {
      await this.send('stt-result', reply)
    } catch (err) {
      log.session.warn('DaemonConnection: stt-result send failed', {
        host: this.hostKey, relayId, message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Answer a daemon-relayed session-launch request (phone creating a session
   * over the cloud bridge while this box holds the session records + config).
   * Runs the shared mobile-launch core (validation + quickStartSession) and
   * replies with a `launch-result` carrying the relayId. Errors are reported
   * back with an errorKind (not thrown) so the daemon can fail the bridge
   * request and the cloud route can map a precise 4xx for the phone.
   */
  private async handleLaunchRequest(event: DaemonEvent): Promise<void> {
    const relayId = (event as unknown as { relayId?: unknown }).relayId
    const action = (event as unknown as { action?: unknown }).action
    const params = (event as unknown as { params?: unknown }).params
    if (typeof relayId !== 'number' || typeof action !== 'string') return
    let reply: Record<string, unknown>
    try {
      const { handleLaunchRelayRequest } = await import('../core/sessions/mobile-launch.js')
      const outcome = await handleLaunchRelayRequest(action, params)
      if (outcome.ok) {
        log.session.info('DaemonConnection: launch relay handled', { host: this.hostKey, relayId, action })
        reply = { relayId, result: outcome.result }
      } else {
        log.session.warn('DaemonConnection: launch relay refused', {
          host: this.hostKey, relayId, action, error: outcome.error, errorKind: outcome.errorKind,
        })
        reply = { relayId, error: outcome.error, errorKind: outcome.errorKind, ...(outcome.details ? { details: outcome.details } : {}) }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.session.warn('DaemonConnection: launch relay failed', { host: this.hostKey, relayId, message })
      reply = { relayId, error: message, errorKind: 'internal' }
    }
    try {
      await this.send('launch-result', reply)
    } catch (err) {
      log.session.warn('DaemonConnection: launch-result send failed', {
        host: this.hostKey, relayId, message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Answer a daemon-relayed session-control request (phone driving model/
   * effort/fork/model-options over the cloud bridge while this box holds the
   * session records + live CLIs). Runs the shared session-controls core and
   * replies with a `control-result` carrying the relayId. Errors are reported
   * back with an errorKind (not thrown) so the daemon can fail the bridge
   * request and the cloud route can map a precise 4xx for the phone.
   */
  private async handleControlRequest(event: DaemonEvent): Promise<void> {
    const relayId = (event as unknown as { relayId?: unknown }).relayId
    const action = (event as unknown as { action?: unknown }).action
    const sessionId = (event as unknown as { sessionId?: unknown }).sessionId
    const params = (event as unknown as { params?: unknown }).params
    if (typeof relayId !== 'number' || typeof action !== 'string') return
    let reply: Record<string, unknown>
    try {
      // Honoured only through the Mac's own daemon (the cloud replica's bridge):
      // a remote exec host's daemon forwards whatever a process there sends it.
      const { controlRefusedForHost, controlRelayOrigin } = await import('../core/sessions/control-host-policy.js')
      const refusal = controlRefusedForHost(action, this.hostKey)
      if (refusal) {
        log.session.warn('DaemonConnection: control relay refused for this host', { host: this.hostKey, relayId, action })
        await this.send('control-result', { relayId, error: refusal, errorKind: 'forbidden' })
        return
      }
      const { handleSessionControlRelay } = await import('../core/sessions/session-controls.js')
      // Any op the action runs acts for the relay's sender, never for this Mac.
      const outcome = await handleSessionControlRelay(action, sessionId, params, controlRelayOrigin(this.hostKey))
      if (outcome.ok) {
        log.session.info('DaemonConnection: control relay handled', { host: this.hostKey, relayId, action, sessionId })
        reply = { relayId, result: outcome.result }
      } else {
        log.session.warn('DaemonConnection: control relay refused', {
          host: this.hostKey, relayId, action, sessionId, error: outcome.error, errorKind: outcome.errorKind,
        })
        reply = {
          relayId, error: outcome.error, errorKind: outcome.errorKind,
          ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.session.warn('DaemonConnection: control relay failed', { host: this.hostKey, relayId, message })
      reply = { relayId, error: message, errorKind: 'internal' }
    }
    try {
      await this.send('control-result', reply)
    } catch (err) {
      log.session.warn('DaemonConnection: control-result send failed', {
        host: this.hostKey, relayId, message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Answer a daemon-relayed session-message request (a phone sending into a
   * session over the cloud bridge). Enqueues into the SAME durable message
   * queue web sends use — sendMessageToSession → session-runner delivery
   * (FIFO / mid-turn / --resume) with crash-safe reconnect redelivery. This
   * replaces the cloud path's old direct marker+send/bridgeResume sequence,
   * whose non-atomicity lost messages when the daemon died mid-sequence
   * (2026-08-13 family). The stable messageId (qm-mobile-*) makes the
   * enqueue idempotent end-to-end.
   */
  private async handleMessageRequest(event: DaemonEvent): Promise<void> {
    const relayId = (event as unknown as { relayId?: unknown }).relayId
    const sessionId = (event as unknown as { sessionId?: unknown }).sessionId
    const message = (event as unknown as { message?: unknown }).message
    const messageId = (event as unknown as { messageId?: unknown }).messageId
    const stopFence = (event as unknown as { stopFence?: unknown }).stopFence ?? null
    if (typeof relayId !== 'number') return
    let reply: Record<string, unknown>
    try {
      if (typeof sessionId !== 'string' || typeof message !== 'string' || message === ''
        || typeof messageId !== 'string' || messageId === ''
        || (stopFence !== null && typeof stopFence !== 'string')) {
        reply = { relayId, error: 'invalid message relay payload', errorKind: 'bad_request' }
      } else if (recentMobileEnqueues.has(messageId)) {
        const { sessionStops, SessionStopSupersededError } = await import('../core/sessions/session-stop.js')
        if (await sessionStops.fence(sessionId) !== stopFence) {
          throw new SessionStopSupersededError('Message predates the latest stop; send a new message to continue')
        }
        // Post-delivery idempotency: the queue-level dedupe only sees rows
        // still IN the queue. A phone retry after a lost ack, arriving after
        // the message was delivered and drained, would re-enqueue a duplicate
        // turn — this ledger closes that window.
        log.session.info('DaemonConnection: message relay replay deduped (ledger)', {
          host: this.hostKey, relayId, sessionId, messageId,
        })
        reply = { relayId, result: { messageId } }
      } else {
        const { getSessionByClaudeId } = await import('../core/session-tracker.js')
        const record = await getSessionByClaudeId(sessionId)
        if (!record) {
          reply = { relayId, error: `Session not found: ${sessionId}`, errorKind: 'not_found' }
        } else {
          // Output mode: this is the phone's send arriving over the cloud bridge,
          // so it owes the model the same instruction/reminder a console send
          // does — the replica has no session record to resolve it from, and the
          // edge marker lives here on the primary, which is why the wrapping
          // happens at the enqueue rather than back on the EC2 box.
          const { prepareOutputModeSend } = await import('../core/sessions/output-mode-send.js')
          const outputMode = await prepareOutputModeSend(sessionId, record, message)
          const { sendMessageToSession } = await import('../core/session-message-queue.js')
          const msg = await sendMessageToSession(sessionId, message, {
            source: 'mobile',
            taskId: record.taskId,
            messageId,
            stopFence,
            ...(outputMode.changed ? { enqueueMessage: outputMode.enqueueText } : {}),
          })
          await outputMode.commit()
          rememberMobileEnqueue(messageId)
          log.session.info('DaemonConnection: message relay enqueued (durable)', {
            host: this.hostKey, relayId, sessionId, messageId: msg.id,
          })
          reply = { relayId, result: { messageId: msg.id } }
        }
      }
    } catch (err) {
      const message2 = err instanceof Error ? err.message : String(err)
      log.session.warn('DaemonConnection: message relay failed', { host: this.hostKey, relayId, message: message2 })
      const { isSessionStopSuperseded } = await import('../core/sessions/session-stop.js')
      reply = { relayId, error: message2, errorKind: isSessionStopSuperseded(err) ? 'session_stopped' : 'internal' }
    }
    try {
      await this.send('message-result', reply)
    } catch (err) {
      // The enqueue is durable — even if this ack never reaches the daemon
      // (bridge flap), the message delivers via the queue; the phone's retry
      // dedupes on messageId.
      log.session.warn('DaemonConnection: message-result send failed', {
        host: this.hostKey, relayId, message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Answer a daemon-relayed agent-gateway request (a `walnut` CLI inside one of
   * this host's sessions calling tools.list / tools.call over the daemon's
   * unix socket). Runs the hub-side capability router and replies with a
   * `gateway-result` carrying the relayId. Errors are reported back with an
   * errorCode (not thrown) so the daemon can fail the unix-socket request
   * with a precise typed error.
   */
  private async handleGatewayRequest(event: DaemonEvent): Promise<void> {
    const relayId = (event as unknown as { relayId?: unknown }).relayId
    const capability = (event as unknown as { capability?: unknown }).capability
    const callerSid = (event as unknown as { callerSid?: unknown }).callerSid
    const payload = (event as unknown as { payload?: unknown }).payload
    if (typeof relayId !== 'number' || typeof capability !== 'string' || typeof callerSid !== 'string') return
    let reply: Record<string, unknown>
    try {
      const { handleGatewayCapability } = await import('../core/peers/capability-router.js')
      const outcome = await handleGatewayCapability(
        capability,
        callerSid,
        typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : undefined,
        this.hostKey,
      )
      if (outcome.ok) {
        log.session.info('DaemonConnection: gateway relay handled', { host: this.hostKey, relayId, capability, callerSid })
        reply = { relayId, result: outcome.result }
      } else {
        log.session.warn('DaemonConnection: gateway relay refused', {
          host: this.hostKey, relayId, capability, callerSid, errorCode: outcome.error.code,
        })
        reply = { relayId, error: outcome.error.message, errorCode: outcome.error.code }
        const detail: Record<string, unknown> = {
          ...(typeof outcome.error.detail === 'object' && outcome.error.detail !== null ? outcome.error.detail as Record<string, unknown> : {}),
          ...(outcome.error.retryAfterMs !== undefined ? { retryAfterMs: outcome.error.retryAfterMs } : {}),
        }
        if (Object.keys(detail).length > 0) reply.detail = detail
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.session.warn('DaemonConnection: gateway relay failed', { host: this.hostKey, relayId, message })
      reply = { relayId, error: message, errorCode: 'internal' }
    }
    try {
      await this.send('gateway-result', reply)
    } catch (err) {
      log.session.warn('DaemonConnection: gateway-result send failed', {
        host: this.hostKey, relayId, message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Disconnect from the daemon and clean up SSH tunnel.
   * Does NOT stop the daemon — it continues running independently.
   *
   * WARNING: Sets _destroyed=true, which permanently disables auto-reconnect
   * (handleConnectionLost and scheduleReconnect both gate on this flag).
   * Only use for intentional teardown (e.g. disconnectAllDaemons on server shutdown).
   * NEVER call on a shared pool connection from error-recovery paths — use
   * `this.conn = null` instead to drop the local reference safely.
   */
  // ── Auxiliary port forwards (embedded VS Code, service previews) ──
  // Separate from the daemon tunnel: these carry browser
  // iframe traffic, live/die independently, and are re-dialed on demand by
  // ensurePortForward rather than by the reconnect loop.
  // Keyed by `<target>:<remotePort>` — the host-side address ssh connects to.
  // `evictable` = a service-preview forward (bounded, oldest first), never the
  // embedded VS Code one.
  private portForwards = new Map<string, { localPort: number; proc: ChildProcess; evictable: boolean }>()
  // Concurrent calls for one key share a single dial (a double click or a Retry
  // while resolving would otherwise spawn two ssh and orphan one).
  private portForwardDials = new Map<string, Promise<number>>()
  private static readonly MAX_EVICTABLE_FORWARDS = 12

  /**
   * Ensure an SSH local forward 127.0.0.1:<local> → remote <target>:<remotePort>
   * exists, creating it if needed. Returns the local port. Reuses a live
   * forward for the same target across calls (idempotent per target:port).
   *
   * `target` is resolved ON THE REMOTE HOST (the `-L` destination): the default
   * 127.0.0.1 reaches a service bound to loopback or to every interface; the
   * service-preview path passes the host's own name when the model wrote the
   * URL with it, so a service bound to one external interface still answers.
   */
  ensurePortForward(remotePort: number, target = '127.0.0.1', opts: { evictable?: boolean } = {}): Promise<number> {
    const key = `${target}:${remotePort}`
    const dialing = this.portForwardDials.get(key)
    if (dialing) return dialing
    const dial = this.dialPortForward(key, remotePort, target, opts.evictable === true)
      .finally(() => { if (this.portForwardDials.get(key) === dial) this.portForwardDials.delete(key) })
    this.portForwardDials.set(key, dial)
    return dial
  }

  /** Drop one forward (a service probe found nothing behind it). */
  closePortForward(remotePort: number, target = '127.0.0.1'): void {
    const key = `${target}:${remotePort}`
    const fwd = this.portForwards.get(key)
    if (!fwd) return
    this.portForwards.delete(key)
    try { fwd.proc.kill('SIGTERM') } catch {}
  }

  private async dialPortForward(key: string, remotePort: number, target: string, evictable: boolean): Promise<number> {
    const existing = this.portForwards.get(key)
    if (existing && existing.proc.exitCode === null) {
      // Verify it still accepts connections — an ssh that lost its transport
      // can linger with exitCode null while the forward is dead.
      if (await this.waitForTunnel(existing.localPort, 1_500)) {
        // Refresh recency (Map order is the eviction order).
        this.portForwards.delete(key)
        this.portForwards.set(key, existing)
        return existing.localPort
      }
      try { existing.proc.kill('SIGTERM') } catch {}
      this.portForwards.delete(key)
    }

    const { createServer } = await import('node:net')
    const localPort = await new Promise<number>((resolve, reject) => {
      const srv = createServer()
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        srv.close(() => resolve(port))
      })
      srv.on('error', reject)
    })

    const args = [
      ...this.baseSshArgs,
      '-L', `${localPort}:${target}:${remotePort}`,
      '-N',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      this.sshHostString,
    ]
    // stderr is DRAINED: without a mux master this ssh owns the listener and
    // logs "channel N: open failed" per refused connection; an unread pipe
    // fills, ssh blocks, and the forward freezes while its port still accepts.
    const proc = spawn('ssh', args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderrTail = ''
    proc.stderr?.on('data', (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString()).slice(-2_000) })
    proc.unref()
    proc.on('exit', (code) => {
      log.session.warn('DaemonConnection: port forward died', {
        host: this.hostKey, code, localPort, remotePort, target, stderr: stderrTail.trim().slice(-300),
      })
      const cur = this.portForwards.get(key)
      if (cur?.proc === proc) this.portForwards.delete(key)
    })

    const ready = await this.waitForTunnel(localPort, 10_000)
    if (!ready) {
      try { proc.kill('SIGTERM') } catch {}
      const why = stderrTail.trim().split('\n').pop()
      throw new Error(`port forward to ${this.hostKey} ${target}:${remotePort} not accepting connections after 10s${why ? ` (${why})` : ''}`)
    }
    this.portForwards.set(key, { localPort, proc, evictable })
    if (evictable) this.evictOldPortForwards()
    log.session.info('DaemonConnection: port forward created', {
      host: this.hostKey, localPort, remotePort, target,
    })
    return localPort
  }

  /** Keep at most MAX_EVICTABLE_FORWARDS service forwards; the least recently used go first. */
  private evictOldPortForwards(): void {
    const evictable = [...this.portForwards].filter(([, f]) => f.evictable)
    for (const [key, fwd] of evictable.slice(0, Math.max(0, evictable.length - DaemonConnection.MAX_EVICTABLE_FORWARDS))) {
      this.portForwards.delete(key)
      try { fwd.proc.kill('SIGTERM') } catch {}
      log.session.info('DaemonConnection: port forward evicted', { host: this.hostKey, key })
    }
  }

  disconnect(): void {
    this._destroyed = true
    this.setConnected(false)
    this._connecting = false

    // Cancel reconnect, and a postponed update check (it only runs on a live connection)
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.clearUpgradeRecheck()
    if (this.sshTarget) clearReconnectCause(this.hostKey)

    // Stop ping
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }

    // Stop bridge re-push (setConnected(false) above also stops it when the
    // state actually changed; this covers the already-disconnected case).
    this.stopBridgeRepush()

    // Reject pending commands
    for (const [id, pending] of this.pendingCommands) {
      clearTimeout(pending.timer)
      pending.reject(new Error('connection closed'))
    }
    this.pendingCommands.clear()

    // Close WebSockets (bulk first — it must never outlive the main socket)
    this.closeBulkChannel()
    if (this.ws) {
      try { this.ws.close() } catch {}
      this.ws = null
    }

    // Kill SSH tunnel
    if (this.tunnel) {
      try { this.tunnel.kill('SIGTERM') } catch {}
      this.tunnel = null
    }

    // Kill auxiliary port forwards (embedded VS Code iframes go stale with us)
    for (const [, fwd] of this.portForwards) {
      try { fwd.proc.kill('SIGTERM') } catch {}
    }
    this.portForwards.clear()

    // Stop SSH ControlMaster (fire-and-forget — cleanup only)
    this.stopControlMaster().catch(() => {})

    log.session.info('DaemonConnection: disconnected', { host: this.hostKey })
  }

  // ── Private: SSH helpers ──

  private get sshHostString(): string {
    return this.ssh.user
      ? `${this.ssh.user}@${this.ssh.hostname}`
      : this.ssh.hostname
  }

  private get baseSshArgs(): string[] {
    return this.buildSshArgs({ useControlMaster: true })
  }

  /**
   * Build SSH args. ControlMaster muxing forwards stdin fine on OpenSSH ≥9; the
   * `useControlMaster: false` opt-out remains for callers that explicitly want a
   * fresh TCP connection (e.g. chunked retry path that tries to dodge a flaky
   * mux session on transient proxy errors).
   */
  private buildSshArgs(opts: { useControlMaster: boolean } = { useControlMaster: true }): string[] {
    const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no']
    if (this.ssh.port) args.push('-p', String(this.ssh.port))
    if (opts.useControlMaster && this._controlPath) {
      args.push('-o', `ControlPath=${this._controlPath}`)
    }
    return args
  }

  /**
   * Start an SSH ControlMaster — a persistent background SSH connection that
   * all subsequent SSH commands multiplex through. This avoids opening 5-7
   * separate SSH connections during connect(), which triggers rate-limiting
   * on corporate hosts.
   */
  private async ensureControlMaster(): Promise<void> {
    if (this._controlMaster) return
    const socketPath = path.join(os.tmpdir(), `walnut-ssh-${this.hostKey}-${process.pid}`)
    this._controlPath = socketPath

    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no',
      '-o', `ControlPath=${socketPath}`,
      '-o', 'ControlMaster=yes',
      '-o', 'ControlPersist=300',  // keep alive 5 min after last use
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
    ]
    if (this.ssh.port) args.push('-p', String(this.ssh.port))
    args.push('-fN', this.sshHostString)  // -f: background, -N: no command

    try {
      // Bounded (remote-sh.ts runSshBounded): execFile's own timeout killed ssh but
      // then waited for the ProxyCommand child holding its stderr, 15 minutes once.
      const run = await runSshBounded(args, { timeoutMs: 15_000 })
      if (run.spawnError) throw run.spawnError
      if (run.timedOut || run.code !== 0) {
        throw new Error(`Command failed: ssh ${args.join(' ')}\n${run.timedOut ? 'timed out after 15000ms' : run.stderr.trim() || `exit code ${run.code}`}`)
      }
      // ssh returns once -f backgrounds. ControlMaster is now running.
      log.session.info('DaemonConnection: SSH ControlMaster started', {
        host: this.hostKey, socketPath,
      })
    } catch (err) {
      log.session.warn('DaemonConnection: ControlMaster failed, falling back to individual connections', {
        host: this.hostKey, error: err instanceof Error ? err.message : String(err),
      })
      this._controlPath = null
    }
  }

  /**
   * Stop the SSH ControlMaster connection.
   */
  private async stopControlMaster(): Promise<void> {
    if (this._controlPath) {
      // Nothing to check: a master that is already gone is the usual case here.
      try {
        await runSshBounded(['-o', `ControlPath=${this._controlPath}`, '-O', 'exit', this.sshHostString], { timeoutMs: 5_000 })
      } catch { /* already gone */ }
      this._controlPath = null
    }
    this._controlMaster = null
  }

  /**
   * Stream a single buffer to a remote file in one SSH connection.
   * Uses ControlMaster mux when available so we don't pay handshake cost.
   * Verifies remote sha256 + size before resolving — some corporate SSH proxies
   * sometimes truncate mid-stream while still exiting code 0.
   * Returns true on success, false on any failure (caller decides whether to fall back).
   */
  private async pipeSingleStream(data: Buffer, remotePath: string, expectedSha256: string): Promise<boolean> {
    const q = shq(remotePath)
    const args = [
      ...this.baseSshArgs,
      this.sshHostString,
      // `sh -c` + markers (remote-sh.ts): the login shell may be csh, and an rc
      // banner on stdout must not read as the checksum.
      markedUploadCommand(remotePath, `sha256sum ${q} | awk '{print $1}' && wc -c < ${q}`),
    ]
    const proc = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    proc.stdin!.on('error', () => {})

    let stdout = ''
    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString() })

    const ok = await new Promise<boolean>((resolve) => {
      proc.on('error', () => resolve(false))
      // Generous timeout — 100MB at ~5MB/s = 20s; allow 3min for headroom.
      const timer = setTimeout(() => { proc.kill('SIGTERM'); resolve(false) }, 180_000)
      proc.on('close', (code) => { clearTimeout(timer); resolve(code === 0) })
      proc.stdin!.end(data)
    })

    if (!ok) return false

    const marked = extractMarkedOutput(stdout)
    const lines = (marked.found ? marked.body : '').trim().split(/\s+/).filter(Boolean)
    const remoteSha = lines[0]
    const remoteSize = parseInt(lines[1] ?? '0', 10)
    if (remoteSize !== data.length || remoteSha !== expectedSha256) {
      log.session.warn('DaemonConnection: single-stream upload verification failed', {
        host: this.hostKey, expectedBytes: data.length, gotBytes: remoteSize,
        expectedSha: expectedSha256.slice(0, 12), gotSha: remoteSha?.slice(0, 12),
      })
      return false
    }
    return true
  }

  /**
   * Pipe a data chunk to a remote file via SSH stdin.
   * Writes to a per-chunk file (overwrite, not append) so retries don't produce duplicates.
   * Verifies the remote file size matches the data length.
   * Returns true on success, false if the connection was killed or data was truncated.
   */
  private async pipeChunk(data: Buffer, remoteDir: string, chunkIndex: number): Promise<boolean> {
    const chunkFile = `${remoteDir}/chunk_${String(chunkIndex).padStart(4, '0')}`
    // Write data then echo the byte count for verification (marked: see pipeSingleStream)
    const args = [...this.buildSshArgs({ useControlMaster: false }), this.sshHostString, markedUploadCommand(chunkFile, `wc -c < ${shq(chunkFile)}`)]
    const proc = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    proc.stdin!.on('error', () => {})  // swallow EPIPE if SSH dies mid-write

    let stdout = ''
    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString() })

    const ok = await new Promise<boolean>((resolve) => {
      proc.on('error', () => resolve(false))
      const timer = setTimeout(() => { proc.kill('SIGTERM'); resolve(false) }, 30_000)
      proc.on('close', (code) => { clearTimeout(timer); resolve(code === 0) })
      proc.stdin!.end(data)
    })

    if (!ok) return false

    // Verify size — proxy can kill mid-write but SSH may still exit 0
    const marked = extractMarkedOutput(stdout)
    const remoteSize = parseInt(marked.found ? marked.body.trim() : '', 10)
    if (remoteSize !== data.length) {
      log.session.warn('DaemonConnection: chunk size mismatch', {
        host: this.hostKey, chunkIndex, expected: data.length, got: remoteSize,
      })
      return false
    }
    return true
  }

  /**
   * Run a POSIX sh script on the remote host and return its output, trimmed.
   * Uses ControlMaster if available (single TCP connection for all commands).
   *
   * The script never reaches the user's login shell: the remote command is
   * `sh -s` and the script rides stdin, and only the text between Walnut's
   * markers counts (remote-sh.ts). A csh/fish login shell or an rc file that
   * prints a banner used to corrupt every JSON or port-number answer here.
   */
  private async sshExec(remoteCmd: string, timeoutMs = 10_000): Promise<string> {
    return runRemoteSh([...this.baseSshArgs, this.sshHostString], remoteCmd, timeoutMs)
  }

  /**
   * Decide where the daemon lives on this host (remote-daemon-dir.ts): a live
   * daemon's dir wins, then a usable /tmp/open-walnut, then
   * $HOME/.cache/open-walnut. One round trip that also learns the arch.
   *
   * An ssh-level failure (exit 255, no markers) is the real connect error and
   * is thrown now: every later step would fail the same way, only with a less
   * truthful message. Anything else keeps the previous choice.
   */
  private async resolveRemoteDir(): Promise<void> {
    // No answer means no deploy: guessing /tmp while a daemon runs from
    // ~/.cache would start a second one on the same streams dir, and its
    // orphan adoption would take every CLI from the first. So a probe that
    // times out or answers garbage fails this connect (retryable), always.
    let output: string
    try {
      output = await this.sshExec(buildDaemonDirProbeScript({ writeTest: !this.isReadOnlyRemote }), 15_000)
    } catch (err) {
      if (isSshTransportFailure(err)) throw err
      const detail = (err instanceof Error ? err.message : String(err)).split('\n').filter(Boolean).pop() ?? 'no answer'
      throw new Error(`daemon dir check on ${this.hostKey} did not finish (${detail.slice(0, 200)}); Walnut will not guess where the daemon lives, and retries the connect`)
    }
    const probe = parseDaemonDirProbe(output)
    if (!probe) {
      throw new Error(`daemon dir check on ${this.hostKey} answered without its result lines; Walnut will not guess where the daemon lives, and retries the connect`)
    }
    if (probe.arch) this._remoteArch = probe.arch.trim() === 'aarch64' ? 'arm64' : 'x64'
    if (probe.home) this._remoteHome = probe.home
    const choice = chooseDaemonDir(probe)
    if (choice.path !== this._remoteDir || choice.fallback !== this._dirChoice?.fallback) {
      const logFn = choice.fallback || choice.unusable ? log.session.warn : log.session.info
      logFn.call(log.session, 'DaemonConnection: daemon dir chosen', {
        host: this.hostKey, dir: choice.path, fallback: choice.fallback, reason: choice.reason,
        freeMb: choice.freeMb, unusable: choice.unusable, tmp: probe.tmp, cache: probe.cache,
      })
    }
    this._remoteDir = choice.path
    this._dirChoice = choice
  }

  /** Env the daemon needs for the chosen dir (empty on /tmp). */
  private get dirEnv(): Record<string, string> {
    return daemonDirEnv(this._dirChoice, this._remoteHome ?? undefined)
  }

  /** A daemon already answers from the other production dir: that dir is this host's now. */
  private adoptLiveDaemonDir(dir: string): void {
    const fallback = dir !== PROD_REMOTE_DAEMON_DIR
    log.session.warn('DaemonConnection: adopting the daemon already running in the other daemon dir', {
      host: this.hostKey, from: this._remoteDir, to: dir,
    })
    this._remoteDir = dir
    this._dirChoice = fallback
      ? { path: dir, fallback: true, reason: 'a daemon started there earlier is still running', ...(this._dirChoice?.freeMb !== undefined && this._dirChoice.path === dir ? { freeMb: this._dirChoice.freeMb } : {}) }
      : { path: dir, fallback: false }
  }

  /** `env K='V' ` for commands that must find the relocated daemon (its --status), '' on /tmp. */
  private get dirEnvPrefix(): string {
    const entries = Object.entries(this.dirEnv)
    return entries.length ? `env ${entries.map(([k, v]) => `${k}=${shq(v)}`).join(' ')} ` : ''
  }

  // ── Private: Daemon management ──

  /**
   * Is this host's daemon owned by an OS service manager (launchd / systemd)?
   *
   * Answers from SURVIVING CONFIG, not from "is it enabled/active": a disabled
   * unit still belongs to the manager, and walnut must never enable or edit it.
   * An unreadable dir resolves to managed (see the rule block in local-daemon.ts).
   * No answer at all (ssh failed or timed out, the reply was cut short) is asked
   * once more with a longer deadline, then comes back `undetermined`: still
   * refused like managed, but never reported as a service. One SSH round trip
   * when the host answers.
   */
  private async detectServiceTakeover(): Promise<RemoteServiceTakeover> {
    const dir = this._remoteDir
    const paths = remoteServiceProbePaths(dir)
    let reason = 'no answer'
    for (let attempt = 0; attempt < SERVICE_PROBE_TIMEOUTS_MS.length; attempt++) {
      const timeoutMs = SERVICE_PROBE_TIMEOUTS_MS[attempt]
      try {
        const takeover = parseRemoteServiceProbe(await this.sshExec(buildRemoteServiceProbeCmd(paths), timeoutMs), paths)
        if (!takeover.undetermined) return { ...takeover, dir }
        reason = takeover.undetermined
      } catch (err) {
        const detail = (err instanceof Error ? err.message : String(err)).split('\n').map((l) => l.trim()).filter(Boolean).pop()
        reason = (detail ?? 'no answer').slice(0, 200)
      }
      log.session.warn('DaemonConnection: OS-service probe got no answer', {
        host: this.hostKey, attempt: attempt + 1, of: SERVICE_PROBE_TIMEOUTS_MS.length, timeoutMs, reason,
      })
    }
    return {
      ...classifyServiceTakeover(paths.map((p) => ({ path: p, state: 'unknown' as ServiceProbeState }))),
      undetermined: reason,
      dir,
    }
  }

  /**
   * Check if daemon is already running on the remote host.
   * Returns the port number if running, null otherwise — or throws
   * DaemonServiceNotReadyError when an OS service owns a daemon that is not
   * answering (never null, which would license an unmanaged nohup start), and
   * DaemonServiceProbeError when no daemon answers and the service probe got
   * no answer either (retryable; nothing is started).
   *
   * The pid/port files are read first (one shell script, no daemon code
   * executed); the on-disk binary's `--status` is only asked when that scan
   * gave no readable answer.
   */
  private async checkDaemonRunning(opts: { strict?: boolean } = {}): Promise<number | null> {
    // Record OS takeover BEFORE any decision: a service-managed daemon may be
    // reused as-is (never upgraded/killed from here), and its momentary absence
    // must NOT fall through to deploy + nohup — that squats the runtime dir and
    // wedges every future managed start behind "service handover is required".
    // Ephemeral servers already refuse every destructive path, so skip the probe.
    const service: RemoteServiceTakeover = this.isReadOnlyRemote
      ? { managed: false, present: [], unknown: [] }
      : await this.detectServiceTakeover()
    // A real answer replaces the stand-in a recent stop of our own provides.
    if (!service.undetermined) this._stoppedUnmanaged = null

    // Runtime-agnostic file probe. Whichever runtime started the daemon (node,
    // bun, binary), it wrote daemon.pid + daemon.port. Reading those + `kill -0`
    // works without knowing which runtime we used last time — important when
    // this DaemonConnection was just constructed and _bunPath isn't populated
    // yet, but a bun-started daemon is still alive from a previous server run.
    //
    // This goes FIRST, and a clean "none" settles the question, because the
    // other probe EXECUTES the binary on disk, and source deploys never refresh
    // that file (see shouldUpgradeDaemon): on a bun host it is whatever the last
    // binary deploy left, running code this server never chose. 2026-10-02: a
    // remote held a month-old binary whose `--status` still ran its boot-time
    // hooks loader, so every reconnect wrote one more daemon-d-*.log there
    // (3,260 one-line files).
    let fileSshErr: unknown = null
    let scanSettled = false
    try {
      // BOTH production dirs, the chosen one first: a daemon already alive in
      // the other one is adopted, never duplicated (a second daemon on the same
      // streams dir takes over every CLI of the first). The runtime token comes
      // from the live process's command line (status / diagnostics).
      const dirs = productionDaemonDirs(this._remoteDir, this._remoteHome)
      const output = await this.sshExec(buildLiveDaemonScanScript(dirs), 5_000)
      const status = parseLiveDaemonScan(output, dirs)
      scanSettled = status !== null || liveDaemonScanFoundNone(output)
      if (status) {
        if (status.dir !== this._remoteDir) this.adoptLiveDaemonDir(status.dir)
        // A running daemon can be outdated whatever started it (it writes
        // daemon.version at startup). Without this, an old daemon would stay
        // alive forever.
        const remotePath = await this.getRemoteDaemonPath()
        if (await this.shouldUpgradeDaemon(remotePath, service)) {
          return service.managed ? this.checkDaemonRunning(opts) : null
        }
        this._runtime = status.runtime
        log.session.info('DaemonConnection: daemon already running', {
          host: this.hostKey, port: status.port, pid: status.pid, runtime: this._runtime, dir: status.dir,
          serviceManaged: service.managed || undefined,
        })
        return status.port
      }
    } catch (err) {
      if (isServiceDecisionError(err)) throw err
      fileSshErr = err
    }

    // Fallback for a scan that could not answer (the link failed, an unreadable
    // reply): ask the binary on disk. Shell uses `|| true` so sshExec only
    // rejects on real SSH failures (dead ControlMaster, tunnel, network). A
    // missing daemon just returns empty stdout. Without this, a dead
    // ControlMaster is indistinguishable from a dead daemon and triggers a
    // wasteful redeploy on every tunnel hiccup.
    let binarySshErr: unknown = null
    if (!scanSettled) {
      try {
        const remotePath = await this.getRemoteDaemonPath()
        const result = await this.sshExec(`${this.dirEnvPrefix}${shq(remotePath)} --status 2>/dev/null || true`)
        if (result) {
          const status = JSON.parse(result)
          if (status.running && status.port) {
            if (await this.shouldUpgradeDaemon(remotePath, service)) {
              return service.managed ? this.checkDaemonRunning(opts) : null
            }
            // The pid files say a daemon runs, not what runs it: the hello says that.
            log.session.info('DaemonConnection: daemon already running (status probe)', {
              host: this.hostKey, port: status.port, pid: status.pid,
              serviceManaged: service.managed || undefined,
            })
            return status.port
          }
        }
      } catch (err) {
        if (isServiceDecisionError(err)) throw err
        binarySshErr = err
      }
    }

    // No live daemon AND the OS owns it → this is a service problem, and the
    // only honest answer is to say so. Returning null here is what let a 5s
    // launchd/systemd gap turn into a permanent unmanaged squatter, so the throw
    // deliberately precedes BOTH the "genuinely absent → deploy" return and the
    // non-strict "SSH failed → treat as absent" return: neither may swallow it.
    // A probe with no answer refuses the deploy just as firmly, but says what it
    // knows (nothing) and is retried by the reconnect loop.
    if (service.undetermined) {
      const sshErr = binarySshErr ?? fileSshErr
      // The link itself is failing: in strict mode say so, as before, so the
      // reconnect loop reads the ssh error (credentials, DNS, timeout) itself.
      if (opts.strict && sshErr) throw sshErr as Error
      // This connection stopped an unmanaged daemon moments ago on a determined
      // answer (a postponed update going ahead), and this is the reconnect that
      // replaces it: refusing would leave the host dark until a probe answers.
      if (!sshErr && this.takeRecentUnmanagedStop()) {
        log.session.info('DaemonConnection: no service answer, but this connection just stopped an unmanaged daemon; deploying its replacement', {
          host: this.hostKey, reason: service.undetermined,
        })
        return null
      }
      throw new DaemonServiceProbeError(
        this.hostKey,
        'no daemon is answering, and Walnut will not start one before it knows',
        service.undetermined,
      )
    }
    if (service.managed) {
      throw new DaemonServiceNotReadyError(
        this.hostKey,
        'no daemon is answering and walnut will not start an unmanaged one alongside the service',
        service,
      )
    }

    // Both probes reached SSH but got back empty → daemon genuinely absent.
    if (!binarySshErr && !fileSshErr) return null

    // Strict mode (reconnect path): SSH itself failed — propagate so callers can
    // retry/rebuild ControlMaster instead of misdiagnosing as "daemon died".
    if (opts.strict) {
      throw (binarySshErr ?? fileSshErr) as Error
    }
    // Non-strict (initial connect): treat SSH failure as absent → deploy.
    return null
  }

  /**
   * Decide whether the RUNNING remote daemon is stale and must be replaced.
   * If stale, stop it and return true (caller should redeploy).
   *
   * Probes /tmp/open-walnut/daemon.version — written at startup by whichever
   * daemon is actually running (compiled binary or source daemon.cjs).
   *
   * MUST NOT probe by executing the on-disk binary's --version: deployDaemon
   * prefers source deploys (bun + daemon.cjs) and never refreshes the binary
   * file, so the binary on disk can be permanently stale while the running
   * daemon is current. Probing the binary made the mismatch unresolvable —
   * every reconnect cycle --stop'ed the healthy daemon, redeployed source,
   * and 30s later found the same stale binary again (infinite kill loop,
   * surfaced as ECONNRESET on every in-flight session).
   */
  private async shouldUpgradeDaemon(
    remotePath: string, service?: RemoteServiceTakeover, gate?: () => UpgradeHold,
  ): Promise<boolean> {
    // Ephemeral attach-only: never upgrade (which would --stop the production
    // daemon). Version skew between the ephemeral's binary and production's is
    // expected and must not trigger a restart of the shared singleton.
    if (this.isReadOnlyRemote) return false
    let expected: string | null = null
    let remoteVersion = ''
    try {
      expected = this.getExpectedDaemonVersion()
      if (!expected) return false
      const takeover = service ?? await this.detectServiceTakeover()

      remoteVersion = (await this.sshExec(
        `cat ${shq(this._remoteDir + '/daemon.version')} 2>/dev/null || true`, 5_000,
      )).trim()

      if (remoteVersion === expected) this.clearUpgradeRecheck()

      // No answer about the service: no update now (that needs a stop or a
      // service call), no "run walnut daemon install" either. Ask again later.
      if (takeover.undetermined) {
        if (remoteVersion !== expected) {
          this.postponeUpgrade(`could not check the OS-service state (${takeover.undetermined})`, expected, remoteVersion)
        }
        return false
      }
      // Anything from here on is a decision; only an open ACP turn or a held
      // gate asks again, each on its own clock.
      this.clearUpgradeRecheck()

      if (takeover.managed) {
        if (remoteVersion !== expected) {
          if (this.holdUpgrade(gate, expected, remoteVersion)) return false
          if (await this.updateManagedDaemon(takeover, expected)) return true
          log.session.error(
            'DaemonConnection: managed daemon update was deferred; use `walnut daemon install --yes --executable <daemon binary>` on that host.',
            {
              host: this.hostKey,
              expected,
              remoteVersion: remoteVersion || '(missing)',
              serviceEvidence: serviceTakeoverEvidence(takeover),
            },
          )
        }
        return false
      }

      if (remoteVersion === expected) {
        this._lastUpgradeAttempt = null
        return false
      }

      // Circuit breaker: if we already upgraded toward this same expected
      // version moments ago and the daemon STILL reports a mismatch, the
      // upgrade pipeline itself is broken (e.g. version stamping regressed).
      // Killing the daemon again won't converge — keep the running daemon
      // alive and scream instead of looping.
      if (
        this._lastUpgradeAttempt
        && this._lastUpgradeAttempt.expected === expected
        && Date.now() - this._lastUpgradeAttempt.at < DaemonConnection.UPGRADE_RETRY_COOLDOWN_MS
      ) {
        log.session.error('DaemonConnection: daemon version still mismatched after recent upgrade — refusing to loop', {
          host: this.hostKey, expected, remoteVersion: remoteVersion || '(missing)',
          lastAttemptAgoMs: Date.now() - this._lastUpgradeAttempt.at,
        })
        return false
      }

      // Upgrade-vs-live-work guard (same contract as local-daemon.ts): the
      // daemon advertises open ACP turns in acp-busy.json; killing it mid-turn
      // writes turn-interrupted:shutdown into live user work. Defer while busy
      // (stale >2min = not busy, so this can never wedge upgrades).
      try {
        const busyRaw = (await this.sshExec(
          `cat ${shq(this._remoteDir + '/acp-busy.json')} 2>/dev/null || true`, 5_000,
        )).trim()
        if (busyRaw) {
          const busy = JSON.parse(busyRaw) as { busySids?: string[]; updatedAt?: number }
          if (
            typeof busy.updatedAt === 'number'
            && Date.now() - busy.updatedAt < 2 * 60_000
            && Array.isArray(busy.busySids) && busy.busySids.length > 0
          ) {
            log.session.warn('DaemonConnection: daemon upgrade DEFERRED (ACP turns open)', {
              host: this.hostKey, expected, remoteVersion: remoteVersion || '(missing)',
              busySids: busy.busySids,
            })
            this.postponeUpgrade('ACP turns are open', expected, remoteVersion, { steady: true })
            return false
          }
        }
      } catch {}

      if (this.holdUpgrade(gate, expected, remoteVersion)) return false
      // Mismatch (or legacy daemon that predates daemon.version) → upgrade.
      log.session.info('DaemonConnection: daemon version mismatch — stopping for upgrade', {
        host: this.hostKey, expected, remoteVersion: remoteVersion || '(missing)',
      })
      // The answer read above, not a second probe: it is seconds old, and a
      // second ssh round trip is a second chance to get no answer.
      await this.stopUnmanagedDaemon(takeover)
      this._lastUpgradeAttempt = { expected, at: Date.now() }
      return true
    } catch (error) {
      if (isServiceDecisionError(error)) throw error
      // The version read failed: don't block, reuse the existing daemon, and
      // check again later.
      if (expected) {
        const detail = (error instanceof Error ? error.message : String(error)).split('\n').filter(Boolean).pop() ?? 'no answer'
        this.postponeUpgrade(`the version check did not finish (${detail.slice(0, 200)})`, expected, remoteVersion)
      }
      return false
    }
  }

  /** A re-check's gate said not now: drop the decision (stale) or ask again (busy). */
  private holdUpgrade(gate: (() => UpgradeHold) | undefined, expected: string, remoteVersion: string): boolean {
    const hold = gate?.() ?? null
    if (hold === null) return false
    if (hold !== UPGRADE_STALE) this.postponeUpgrade(hold, expected, remoteVersion, { steady: true })
    return true
  }

  /** The pending re-run of a postponed daemon update, and how many times it has been put off. */
  private upgradeRecheckTimer: ReturnType<typeof setTimeout> | null = null
  private _upgradeRecheckAttempt = 0
  /** The re-run in progress: a reconnect waits for it, so the two never stop or deploy at once. */
  private _upgradeRecheckInFlight: Promise<void> | null = null
  /** The unmanaged daemon this connection last stopped itself, and where (see checkDaemonRunning). */
  private _stoppedUnmanaged: { at: number; dir: string } | null = null
  /** Bumped on every connected/disconnected flip, so a re-check can tell its connection is gone. */
  private _connectionEpoch = 0

  /**
   * An update that could not be decided NOW is decided later, never dropped.
   * Each of these reasons used to end the matter for the life of the
   * connection: an ssh hiccup in the service probe (2026-10-01: a deploy's fix
   * never reached a remote host), an ACP turn open at connect, a version read that
   * timed out. Nothing else re-ran the check until some later reconnect.
   */
  private postponeUpgrade(reason: string, expected: string, remoteVersion: string, opts: { steady?: boolean } = {}): void {
    if (this.isReadOnlyRemote || this._destroyed) return
    // Work in progress ends on its own: ask again every minute. No answer may
    // last a while: back off.
    const delays = UPGRADE_RECHECK_DELAYS_MS
    const delayMs = opts.steady ? delays[0] : delays[Math.min(this._upgradeRecheckAttempt, delays.length - 1)]
    if (!opts.steady) this._upgradeRecheckAttempt += 1
    log.session.warn('DaemonConnection: daemon update postponed; checking again', {
      host: this.hostKey, reason, expected, remoteVersion: remoteVersion || '(missing)',
      attempt: this._upgradeRecheckAttempt, retryInMs: delayMs,
    })
    if (this.upgradeRecheckTimer) clearTimeout(this.upgradeRecheckTimer)
    this.upgradeRecheckTimer = setTimeout(() => {
      this.upgradeRecheckTimer = null
      void this.recheckPostponedUpgrade()
    }, delayMs)
    this.upgradeRecheckTimer.unref?.()
  }

  private clearUpgradeRecheck(): void {
    if (this.upgradeRecheckTimer) clearTimeout(this.upgradeRecheckTimer)
    this.upgradeRecheckTimer = null
    this._upgradeRecheckAttempt = 0
  }

  /**
   * Re-run the update decision on a live connection. When it goes ahead, the
   * old daemon is already stopped (or its service replaced it), so the
   * connection is dropped and the ordinary reconnect path deploys and dials the
   * new build, the same as after a server restart. A connection that is down
   * needs nothing here: the reconnect that brings it back runs the decision.
   */
  private recheckPostponedUpgrade(): Promise<void> {
    if (this._upgradeRecheckInFlight) return this._upgradeRecheckInFlight
    const run = this.runUpgradeRecheck().finally(() => { this._upgradeRecheckInFlight = null })
    this._upgradeRecheckInFlight = run
    return run
  }

  private async runUpgradeRecheck(): Promise<void> {
    if (this._destroyed || this.isReadOnlyRemote) return
    // A connect or reconnect still dialling may already be past its own
    // decision (the one that postponed this): ask again once it settles.
    if (this._connecting || this._reconnectInFlight) {
      const expected = this.getExpectedDaemonVersion()
      if (expected) this.postponeUpgrade('a connect was in progress', expected, '(not read)', { steady: true })
      return
    }
    // Down with nothing dialling: the reconnect loop's next attempt decides.
    if (!this._connected) return
    const epoch = this._connectionEpoch
    const live = () => !this._destroyed && this._connected && this._connectionEpoch === epoch
      && !this._connecting && !this._reconnectInFlight && !this.reconnectTimer
    // Asked right before the stop: the ssh round trips above it take seconds,
    // and the connection may have dropped (or work started) meanwhile.
    const gate = (): UpgradeHold => {
      if (!live()) return UPGRADE_STALE
      const writes = [...this.pendingCommands.values()].filter((p) => p.cmd && UPGRADE_HOLD_COMMANDS.has(p.cmd)).length
      if (writes > 0) return `${writes} daemon command(s) that change a session or a file are in flight`
      return null
    }
    let goAhead = false
    try {
      goAhead = await this.shouldUpgradeDaemon(await this.getRemoteDaemonPath(), undefined, gate)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.session.warn('DaemonConnection: postponed daemon update check failed', { host: this.hostKey, error: msg })
      const expected = this.getExpectedDaemonVersion()
      // A managed update that failed has its own cooldown and says so loudly;
      // anything else (a stop the daemon refused, an ssh error) is asked again.
      if (expected && live() && !(err instanceof DaemonServiceNotReadyError)) {
        this.postponeUpgrade(`the check failed (${msg.split('\n')[0].slice(0, 200)})`, expected, '')
      }
      return
    }
    if (!goAhead) return
    log.session.info('DaemonConnection: postponed daemon update going ahead; reconnecting to the new build', { host: this.hostKey })
    // The stop usually drops the socket first, and that loss already scheduled the reconnect.
    if (this._connected && this._connectionEpoch === epoch) this.handleConnectionLost()
  }

  private async updateManagedDaemon(takeover: ServiceTakeover, expected: string): Promise<boolean> {
    if (this.isReadOnlyRemote || takeover.unknown.length
      || !takeover.present.includes('$HOME/.config/systemd/user/open-walnut-daemon.service')
      || takeover.present.includes('/etc/systemd/system/open-walnut-daemon.service')) return false
    if (this._lastUpgradeAttempt?.expected === expected
      && Date.now() - this._lastUpgradeAttempt.at < DaemonConnection.UPGRADE_RETRY_COOLDOWN_MS) return false
    const binary = await this.getLocalBinaryPath()
    if (!binary) return false
    this._lastUpgradeAttempt = { expected, at: Date.now() }
    try {
      await updateRemoteDaemonService(binary, expected, {
        run: (command, timeout) => this.sshExec(command, timeout),
        chunk: (data, directory, index) => this.pipeChunk(data, directory, index),
      })
    } catch (error) {
      throw new DaemonServiceNotReadyError(this.hostKey, `managed update did not complete: ${String(error)}`, takeover)
    }
    return true
  }

  /**
   * Did this connection stop an unmanaged daemon in this runtime dir in the
   * last 2 minutes? Answers yes once: it licenses the one deploy that replaces it.
   */
  private takeRecentUnmanagedStop(): boolean {
    const stop = this._stoppedUnmanaged
    this._stoppedUnmanaged = null
    return !!stop && stop.dir === this._remoteDir && Date.now() - stop.at < 2 * 60_000
  }

  private async stopUnmanagedDaemon(known?: RemoteServiceTakeover): Promise<void> {
    // A verdict for another runtime dir (the live daemon was adopted from the
    // other production dir after the probe) never saw this dir's marker file.
    const takeover = known && known.dir === this._remoteDir ? known : await this.detectServiceTakeover()
    if (takeover.undetermined) {
      throw new DaemonServiceProbeError(this.hostKey, 'Walnut will not stop a daemon it cannot classify', takeover.undetermined)
    }
    if (takeover.managed) throw new DaemonServiceNotReadyError(this.hostKey, 'refusing an unmanaged stop', takeover)
    try {
      const output = await this.sshExec(buildDaemonStopCmd(this._remoteDir), 45_000)
      if (!output.split('\n').includes('walnut-daemon-stop-confirmed')) throw new Error('missing shutdown confirmation')
      this._stoppedUnmanaged = { at: Date.now(), dir: this._remoteDir }
    } catch (error) {
      throw new DaemonShutdownPendingError(`Daemon shutdown was not confirmed; no replacement was started: ${String(error)}`)
    }
  }

  /**
   * The daemon version this server expects on the remote host.
   *
   * MUST be the same value getDaemonSource() stamps into a deploy, so it
   * delegates to resolveDaemonSourceVersion(): a bundled server expects the
   * version of the template ITS OWN build carries (the .version sidecar), a
   * source-run server expects the worktree hash. Computing the worktree hash
   * here while deploying the bundle's template let a stale server label old
   * bytes with the new version — after which no server ever saw a mismatch
   * again (clouddev, 2026-08-22).
   */
  private getExpectedDaemonVersion(): string | null {
    try {
      const v = resolveDaemonSourceVersion()
      return v && v !== 'dev-source' ? v : null
    } catch {
      return null
    }
  }

  /**
   * Send one command directly on this.ws, bypassing the _connected gate that
   * send() enforces. Used exclusively by verifyCapabilities() during the
   * pre-connect handshake window, when the ws is open but _connected has not
   * yet been flipped true.
   */
  private _sendHandshake(cmd: string, params: Record<string, unknown> = {}): Promise<DaemonCommandResult> {
    if (!this.ws) {
      return Promise.reject(new Error(`DaemonConnection: ws not open for ${this.hostKey}`))
    }
    const id = ++this.cmdCounter
    const message = JSON.stringify({ id, cmd, ...params })
    return new Promise<DaemonCommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id)
        reject(new Error(`daemon command timeout: ${cmd} (${DaemonConnection.COMMAND_TIMEOUT_MS}ms)`))
      }, DaemonConnection.COMMAND_TIMEOUT_MS)
      this.pendingCommands.set(id, { resolve, reject, timer })
      this.ws!.send(message)
    })
  }

  /**
   * Send `hello` to the daemon and verify it advertises every required
   * capability. Returns true on full match, false on any mismatch (including
   * "unknown command: hello" from pre-hello daemons).
   *
   * Called right after the WS opens, before any real commands are sent.
   *
   * Pre-hello daemons may not respond at all (they don't even return
   * 'unknown command') — the send() timeout is what catches that case, so
   * timeout == drift.
   */
  private async verifyCapabilities(): Promise<boolean> {
    try {
      const res = await this._sendHandshake('hello', {})
      if (!res.ok) {
        log.session.warn('DaemonConnection: hello returned !ok', {
          host: this.hostKey, reason: res.reason, error: res.error,
        })
        return false
      }
      const caps = Array.isArray(res.capabilities) ? res.capabilities as string[] : []
      this._capabilities = caps
      // What actually runs the daemon (bun, the prebuilt binary, node): the pid
      // files cannot tell a bun-run daemon from the binary, the daemon can.
      if (res.runtime === 'bun' || res.runtime === 'binary' || res.runtime === 'node') this._runtime = res.runtime
      const startup = (res.cronSupervision as { startup?: unknown } | undefined)?.startup
      this._daemonStartup = typeof startup === 'string' && ['boot', 'login', 'on-demand', 'service'].includes(startup) ? startup : 'on-demand'
      const missing = REQUIRED_DAEMON_CAPABILITIES.filter(c => !caps.includes(c))
      if (missing.length > 0) {
        log.session.warn('DaemonConnection: daemon missing capabilities', {
          host: this.hostKey,
          version: res.version,
          missing,
          got: caps,
        })
        return false
      }
      // Capture instance ID — if this differs from a prior value, the daemon
      // was swapped out from under us. We don't fail here (could be the first
      // handshake, or a deliberate restart), but downstream reconnect logic
      // can compare and decide whether to invalidate per-session state.
      const newInstanceId = typeof res.instanceId === 'string' ? res.instanceId : null
      const newStartedAt = typeof res.startedAt === 'number' ? res.startedAt : null
      const changed =
        this._daemonInstanceId !== null &&
        newInstanceId !== null &&
        this._daemonInstanceId !== newInstanceId
      if (changed) {
        log.session.warn('DaemonConnection: daemon instance changed across reconnect', {
          host: this.hostKey,
          priorInstanceId: this._daemonInstanceId,
          newInstanceId,
          newStartedAt,
        })
      }
      this._daemonInstanceId = newInstanceId
      this._daemonStartedAt = newStartedAt
      log.session.info('DaemonConnection: capability handshake OK', {
        host: this.hostKey,
        version: res.version,
        capCount: caps.length,
        instanceId: newInstanceId,
        uptimeSec: typeof res.uptimeSec === 'number' ? res.uptimeSec : undefined,
      })
      return true
    } catch (err) {
      // Timeout or WS closed mid-hello — treat as drift, force redeploy
      log.session.warn('DaemonConnection: hello failed', {
        host: this.hostKey, error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  /**
   * Tear down the current connection, stop the remote daemon, redeploy, and
   * reconnect. Used when the capability handshake reveals a stale binary.
   *
   * Throws if redeploy/reconnect fails or the post-redeploy handshake still
   * fails — caller (connect()) will catch and surface the error. The internal
   * try/catch ensures a mid-helper throw still leaves the object in a clean
   * disconnected state (ws/tunnel nulled, _connected=false) so reconnect
   * logic can retry.
   */
  private async forceRedeployAndReconnect(): Promise<void> {
    // Backstop: ephemeral attach-only must never redeploy/restart a shared remote
    // daemon. Callers (connect, reconnect) already guard, but this is the single
    // method that performs the destructive --stop + deploy + start, so refuse here
    // too — defense in depth against any future caller.
    if (this.isReadOnlyRemote) {
      throw new Error(
        `ephemeral server: refusing forceRedeployAndReconnect on '${this.hostKey}' (attach-only)`,
      )
    }

    // OS-service backstop, BEFORE the WS/tunnel teardown below: capability drift
    // is not a licence to kill a managed process. The `--stop` + `kill $(cat
    // daemon.pid)` further down would be undone by launchd/systemd restarting it
    // right back, racing our own nohup daemon for the runtime dir's instance
    // lock. Refusing early also keeps the CURRENT connection intact (a drifted
    // daemon that still answers is strictly better than a dark host), so the
    // caller surfaces one actionable error instead of a half-torn connection.
    const takeover = await this.detectServiceTakeover()
    if (takeover.undetermined) {
      throw new DaemonServiceProbeError(
        this.hostKey,
        "the daemon's capabilities do not match this server, and Walnut will not replace a daemon it cannot classify",
        takeover.undetermined,
      )
    }
    if (takeover.managed) {
      throw new DaemonServiceNotReadyError(
        this.hostKey,
        'its capabilities do not match this server and walnut will not stop or replace a service-managed daemon',
        takeover,
      )
    }

    log.session.info('DaemonConnection: forcing redeploy due to capability drift', {
      host: this.hostKey,
    })

    // Close WS + tunnel, but keep ControlMaster (we'll reuse it).
    this.closeBulkChannel()
    try { this.ws?.close() } catch {}
    this.ws = null
    this.setConnected(false)

    if (this.tunnel) {
      try { this.tunnel.kill('SIGTERM') } catch {}
      this.tunnel = null
    }
    this.localPort = null

    try {
      await this.stopUnmanagedDaemon(takeover)

      // Redeploy + start + tunnel + reconnect
      const daemonPort = await this.deployAndStart()
      this.remotePort = daemonPort
      this.localPort = await this.createTunnel(daemonPort)
      await this.connectWebSocket(this.localPort)

      // Re-verify BEFORE flipping _connected so external sends can't slip
      // through if the new binary is also broken.
      const ok = await this.verifyCapabilities()
      if (!ok) {
        log.session.error('DaemonConnection: capability handshake STILL failing after redeploy', {
          host: this.hostKey,
        })
        throw new Error('DaemonConnection: capability handshake still failing after forced redeploy — giving up')
      }
      this.setConnected(true)
    } catch (err) {
      // Ensure clean teardown so the outer reconnect machinery can retry.
      // Casts are needed because TS control-flow has narrowed this.ws /
      // this.tunnel to `never` after the pre-try assignments to null above;
      // connectWebSocket and createTunnel re-populate them via side effects
      // that TS can't track through an async call boundary.
      this.closeBulkChannel()
      const currentWs = this.ws as WebSocket | null
      try { currentWs?.close() } catch {}
      this.ws = null
      const currentTunnel = this.tunnel as ChildProcess | null
      if (currentTunnel) {
        try { currentTunnel.kill('SIGTERM') } catch {}
        this.tunnel = null
      }
      this.localPort = null
      this.setConnected(false)
      throw err
    }
  }

  /**
   * Deploy daemon to the remote host and say which runtime it will start on.
   *
   * Prefers bun + source (tiny upload) when a bun on the host RUNS, then the
   * prebuilt binary, then node + source (see remote-runtime.ts).
   */
  private async deployDaemon(): Promise<RemoteRuntime> {
    // Preferred path: bun + ~63KB JS source. Bypasses corporate-proxy bulk-transfer kills
    // entirely (binary is 37MB compressed; source is gzipped to ~17KB on the
    // wire). Bun is a single static binary so probe-or-install completes in a
    // few seconds when missing. Falls through to binary on probe/install
    // failure (offline hosts, restrictive networks, glibc-too-old for bun).
    this.setPhase('install-runtime')
    this._bunInstallNote = null
    const skipBun = this._failedRuntimes.has('bun')
    if (skipBun) log.session.info('DaemonConnection: bun already failed to run the daemon on this host, skipping it', { host: this.hostKey })
    const bunPath = skipBun ? null : await this.probeOrInstallBun()
    this.setPhase('upload')
    if (bunPath) {
      // Set BEFORE deploySource: it skips the npm `ws` install under bun.
      this._bunPath = bunPath
      try {
        await this.deploySource()
        this._deployedViaSource = true
        return 'bun'
      } catch (err) {
        log.session.warn('DaemonConnection: bun source deploy failed, falling back to binary', {
          host: this.hostKey, error: err instanceof Error ? err.message : String(err),
        })
        this._bunPath = null
      }
    }

    const skipBinary = this._failedRuntimes.has('binary')
    if (skipBinary) log.session.info('DaemonConnection: the prebuilt binary already failed to run on this host, skipping it', { host: this.hostKey })
    const localBinary = skipBinary ? null : await this.getLocalBinaryPath()

    if (localBinary) {
      try {
        await this.deployBinary(localBinary)
        this._deployedViaSource = false
        return 'binary'
      } catch (err) {
        // Binary deploy failed (e.g. SSH proxy killed the transfer).
        // Fall back to lightweight source deploy (~44KB, always passes).
        log.session.warn('DaemonConnection: binary deploy failed, falling back to source deploy', {
          host: this.hostKey, error: err instanceof Error ? err.message : String(err),
        })
      }
    } else {
      log.session.info('DaemonConnection: no binary found, falling back to source deploy', {
        host: this.hostKey, binaryDir: DAEMON_BINARIES_DIR,
      })
    }

    this._bunPath = null
    await this.deploySource()
    this._deployedViaSource = true
    return 'node'
  }

  /**
   * Deploy, then start; when the start fails in a runtime-shaped way (exec
   * format, illegal instruction, GLIBC, a runtime killed by a signal), move
   * along bun → binary → node inside THIS connect. Each runtime is tried at most
   * once, so there is exactly one fallback chain per connect and no loop.
   */
  private async deployAndStart(): Promise<number> {
    let runtime = await this.deployDaemon()
    // A runtime that already died at start here is never tried again (node,
    // the cheap last resort, always stays eligible).
    const tried = new Set<RemoteRuntime>([runtime, ...[...this._failedRuntimes.keys()].filter((r) => r !== 'node')])
    for (;;) {
      this.setPhase('start')
      try {
        const port = await this.startDaemon(runtime)
        this._runtime = runtime
        return port
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err)
        if (isRuntimeStartFailure(text)) this._failedRuntimes.set(runtime, text.slice(0, 300))
        const next = nextRuntimeAfterStartFailure(runtime, text, { haveBinary: !!(await this.getLocalBinaryPath()), tried })
        if (!next) throw this.withBunInstallNote(err)
        log.session.warn('DaemonConnection: daemon start failed on this runtime, trying the next one', {
          host: this.hostKey, failed: runtime, next, error: text.slice(0, 500),
        })
        tried.add(next)
        this.setPhase('upload')
        try {
          await this.deployForRuntime(next)
          runtime = next
        } catch (deployErr) {
          // The binary would not even deploy: node is the last way in.
          if (next !== 'binary' || tried.has('node')) throw this.withBunInstallNote(deployErr)
          tried.add('node')
          await this.deployForRuntime('node')
          runtime = 'node'
        }
      }
    }
  }

  /** Put `runtime`'s artifact in place for a fallback start. */
  private async deployForRuntime(runtime: RemoteRuntime): Promise<void> {
    if (runtime === 'binary') {
      const localBinary = await this.getLocalBinaryPath()
      if (!localBinary) throw new Error('no prebuilt daemon binary for this host')
      await this.deployBinary(localBinary)
      this._deployedViaSource = false
      return
    }
    if (runtime === 'node') this._bunPath = null
    await this.deploySource()
    this._deployedViaSource = true
  }

  /** A failed bun install explains a later failure: keep its log tail on the error. */
  private withBunInstallNote(err: unknown): unknown {
    if (!this._bunInstallNote) return err
    const message = err instanceof Error ? err.message : String(err)
    return new Error(`${message}\nbun install failed: ${this._bunInstallNote}`)
  }

  /**
   * Find a bun on the host that RUNS (`bun --version`, 10s cap), installing one
   * when there is none. Returns its absolute path, or null: a bun that is there
   * but cannot run is "no bun" (its output is logged, it is not reinstalled
   * over), and a failed install keeps its log on the host (bun-install.log in
   * the daemon dir) with the tail in this connect's error.
   */
  private async probeOrInstallBun(): Promise<string | null> {
    const probeScript = buildBunProbeScript()
    let probe
    try {
      probe = parseBunProbe(await this.sshExec(probeScript, 20_000))
    } catch (err) {
      log.session.warn('DaemonConnection: bun probe failed', {
        host: this.hostKey, error: err instanceof Error ? err.message : String(err),
      })
      return null
    }

    if (probe.path && probe.ok) {
      log.session.info('DaemonConnection: bun present', { host: this.hostKey, path: probe.path, version: probe.version })
      return probe.path
    }
    if (probe.path) {
      log.session.warn('DaemonConnection: bun is installed but does not run, using another runtime', {
        host: this.hostKey, path: probe.path, error: probe.error,
      })
      return null
    }

    // Install. The install script writes to ~/.bun/bin/bun and downloads ~30MB
    // straight from bun.sh — that's a remote-host outbound HTTPS connection,
    // bypassing the corporate proxy entirely. 90s budget covers slow corporate egress.
    const logPath = `${this._remoteDir}/bun-install.log`
    log.session.info('DaemonConnection: bun absent, attempting one-shot install', { host: this.hostKey, logPath })
    let install
    try {
      install = parseBunInstall(await this.sshExec(buildBunInstallScript(logPath), 90_000))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this._bunInstallNote = `the installer did not finish (${message.split('\n').pop()}); log: ${logPath}`
      log.session.warn('DaemonConnection: bun install failed, falling back to the binary or node', { host: this.hostKey, error: message })
      return null
    }
    if (install.rc !== 0) {
      this._bunInstallNote = `exit ${install.rc}: ${installTailForError(install) || '(no output)'}; log: ${install.logPath ?? logPath}`
      log.session.warn('DaemonConnection: bun install failed, falling back to the binary or node', {
        host: this.hostKey, rc: install.rc, log: install.logPath ?? logPath, tail: install.tail.slice(-1500),
      })
      return null
    }

    try {
      const after = parseBunProbe(await this.sshExec(probeScript, 20_000))
      if (after.path && after.ok) {
        log.session.info('DaemonConnection: bun installed', { host: this.hostKey, path: after.path, version: after.version })
        return after.path
      }
      this._bunInstallNote = `installed, but ${after.error ?? 'bun is still missing'}; log: ${install.logPath ?? logPath}`
      log.session.warn('DaemonConnection: bun installed but does not run', { host: this.hostKey, error: after.error, tail: install.tail.slice(-1500) })
    } catch (err) {
      log.session.warn('DaemonConnection: bun re-probe after install failed', {
        host: this.hostKey, error: err instanceof Error ? err.message : String(err),
      })
    }
    return null
  }

  /**
   * Deploy a pre-compiled binary to the remote host.
   * Much faster than source deploy — no npm install, no node PATH discovery.
   */
  private async deployBinary(localBinaryPath: string): Promise<void> {
    const t0 = Date.now()
    const binarySize = fs.statSync(localBinaryPath).size

    try {
      // Create directory
      await this.sshExec(`mkdir -p ${shq(this._remoteDir)}`)

      // Check if remote binary is already up to date by comparing version strings.
      // The binary embeds a version via --define at build time.
      // We read the local version from a sidecar .version file (written by build script)
      // because the binary is cross-compiled for Linux and can't run on the local host.
      let needsDeploy = true
      try {
        const versionFile = localBinaryPath + '.version'
        const localVersion = fs.readFileSync(versionFile, 'utf-8').trim()
        const remoteDaemonPath = await this.getRemoteDaemonPath()
        const remoteVersion = await this.sshExec(`${shq(remoteDaemonPath)} --version 2>/dev/null`, 5_000)
        if (localVersion && remoteVersion && localVersion === remoteVersion) {
          needsDeploy = false
          log.session.info('DaemonConnection: binary already up to date', {
            host: this.hostKey, version: localVersion,
          })
        }
      } catch { /* version check failed — deploy fresh */ }

      if (needsDeploy) {
        // Strategy: stream the whole gzipped binary in one SSH connection (mux'd
        // through ControlMaster). Empirically ~5s on success for our 37MB binary,
        // sha256-verified end-to-end. some corporate SSH proxies kill large
        // transfers *probabilistically* — at 37MB roughly 60% succeed; at 40MB+
        // success rate drops sharply (measured 0/2 at 40MB, 0/2 at 45MB). The
        // proxy decision isn't deterministic on size alone, so we always try
        // single-stream first (huge win when it works), then fall back to a
        // chunked path (256KB × N over individual SSH connections) which
        // survives proxy interference at the cost of being ~10x slower.
        const remotePath = await this.getRemoteDaemonPath()
        const gzPath = await daemonGzCachePath(localBinaryPath)

        // Compress if needed (cached alongside the binary, or in the data dir
        // when the package is read-only: daemon-gz-cache.ts)
        if (!fs.existsSync(gzPath)) {
          await new Promise<void>((resolve, reject) => {
            const out = fs.createWriteStream(gzPath)
            const gzip = spawn('gzip', ['-c', localBinaryPath], { stdio: ['pipe', 'pipe', 'pipe'] })
            gzip.stdout!.pipe(out)
            out.on('finish', resolve)
            gzip.on('error', reject)
            out.on('error', reject)
          })
        }

        const gzData = fs.readFileSync(gzPath)
        const gzSize = gzData.length
        const gzSha256 = crypto.createHash('sha256').update(gzData).digest('hex')

        // Try single-stream first.
        const singleOk = await this.pipeSingleStream(gzData, `${remotePath}.gz`, gzSha256)
        if (singleOk) {
          const unpackResult = await this.sshExec(
            `gunzip -f ${shq(remotePath + '.gz')} && chmod +x ${shq(remotePath)} && ${shq(remotePath)} --version`,
            30_000,
          )
          const remoteBinaryName = await this.getRemoteBinaryName()
          log.session.info('DaemonConnection: binary deployed via single SSH stream', {
            host: this.hostKey, deployMs: Date.now() - t0,
            bytes: binarySize, gzBytes: gzSize, binary: remoteBinaryName,
            remoteVersion: unpackResult.trim(),
          })
          return
        }

        log.session.warn('DaemonConnection: single-stream deploy failed, falling back to chunked', {
          host: this.hostKey, gzBytes: gzSize,
        })
        // Fall through to chunked path below.
        // 256KB — deep under the corporate proxy’s ~5MB kill threshold AND any per-connection
        // byte-rate throttling. Larger chunks (1MB) were the main failure mode
        // pre-2026-05-05: corp proxies would kill ~half the chunks on a ~40MB
        // binary, blowing past MAX_RETRIES=2, falling back to source deploy,
        // which then failed on old-glibc hosts — leaving the daemon dead.
        //
        // Tune by observation, not theory — too small wastes SSH setup overhead
        // (per-chunk connection cost dominates); too large hits proxy kills.
        // 256KB was chosen after observing proxy kills consistently at ~1MB and
        // confirming 256KB survives reliably across proxy variants.
        const CHUNK_SIZE = 262_144
        const totalChunks = Math.ceil(gzSize / CHUNK_SIZE)
        const chunkDir = `${this._remoteDir}/deploy_chunks`

        // Clean any partial previous transfer
        await this.sshExec(`rm -rf ${shq(chunkDir)} && mkdir -p ${shq(chunkDir)}`, 5_000).catch(() => {})

        // Per-chunk retry budget: proxy kills are transient. 5 attempts per
        // chunk with exponential backoff (3s → 5s → 10s → 15s → 20s) gives
        // us ~53s per bad chunk before accepting defeat.
        //
        // Total failure cap: ~5 min worst case under sustained proxy
        // interference (30 failures × mixed backoffs + per-chunk SSH cost).
        // Source-deploy fallback is still faster than giving up on upgrade
        // permanently, so err on the robust side here.
        //
        // Values chosen empirically — 5 retries per chunk handled the observed
        // proxy transient kills on 40MB deploys during the 2026-05-05 incident.
        // Tune downward only with data; the cost of failing the deploy is
        // ~30min of blocked remote sessions until the user notices.
        const MAX_CHUNK_RETRIES = 5
        const BACKOFF_MS = [3_000, 5_000, 10_000, 15_000, 20_000]
        const MAX_TOTAL_FAILURES = 30
        let totalFailures = 0

        for (let i = 0; i < totalChunks; i++) {
          // Abort fast if the connection was torn down mid-deploy — user should
          // not have to wait out retries/backoff after a destroy().
          if (this._destroyed) throw new Error('deploy aborted: connection destroyed')

          const offset = i * CHUNK_SIZE
          const chunk = gzData.subarray(offset, offset + CHUNK_SIZE)

          let chunkAttempt = 0
          // Each chunk writes to its own file (overwrite) — retries are safe
          let ok = await this.pipeChunk(chunk, chunkDir, i)
          while (!ok) {
            chunkAttempt++
            totalFailures++
            if (totalFailures > MAX_TOTAL_FAILURES) {
              throw new Error(
                `binary deploy failed: ${totalFailures} total chunk failures across ${totalChunks} chunks — proxy actively blocking, will fall back to source deploy`,
              )
            }
            if (chunkAttempt > MAX_CHUNK_RETRIES) {
              throw new Error(
                `binary deploy failed: chunk ${i + 1}/${totalChunks} killed ${chunkAttempt} times — will fall back to source deploy`,
              )
            }
            // ±20% jitter prevents lockstep retry collision when multiple
            // Walnut instances happen to be deploying to the same host.
            const baseDelay = BACKOFF_MS[Math.min(chunkAttempt - 1, BACKOFF_MS.length - 1)]
            const delayMs = Math.round(baseDelay * (0.8 + Math.random() * 0.4))
            log.session.info('DaemonConnection: chunk transfer killed by proxy, retrying', {
              host: this.hostKey, chunk: i + 1, totalChunks,
              chunkAttempt, totalFailures, delayMs,
            })
            // Second abort gate: don't burn the full backoff if we're being torn down.
            if (this._destroyed) throw new Error('deploy aborted: connection destroyed')
            await new Promise(r => setTimeout(r, delayMs))
            ok = await this.pipeChunk(chunk, chunkDir, i)
          }

          // Progress log every 16 chunks (~4MB) so a 160-chunk (~40MB) upload
          // shows ~10 progress markers without log spam.
          if (i % 16 === 0 || i === totalChunks - 1) {
            log.session.info('DaemonConnection: binary deploy progress', {
              host: this.hostKey, chunk: i + 1, totalChunks,
              percent: Math.round(((i + 1) / totalChunks) * 100),
            })
          }

          // Brief pause between chunks to avoid triggering rate limits.
          // 250ms (vs old 1000ms) because 256KB chunks = 4x as many chunks;
          // keep total deploy wall-clock roughly constant.
          if (i < totalChunks - 1) {
            await new Promise(r => setTimeout(r, 250))
          }
        }

        // Reassemble chunks and verify size before unpacking
        const remoteSize = parseInt(
          await this.sshExec(`cat ${shq(chunkDir)}/chunk_* > ${shq(remotePath + '.gz')} && wc -c < ${shq(remotePath + '.gz')}`, 30_000),
          10,
        )
        if (remoteSize !== gzSize) {
          await this.sshExec(`rm -rf ${shq(chunkDir)} ${shq(remotePath + '.gz')}`, 5_000).catch(() => {})
          throw new Error(`binary deploy size mismatch: remote=${remoteSize} local=${gzSize}`)
        }

        // Unpack and make executable
        const unpackResult = await this.sshExec(
          `rm -rf ${shq(chunkDir)} && gunzip -f ${shq(remotePath + '.gz')} && chmod +x ${shq(remotePath)} && ${shq(remotePath)} --version`,
          30_000,
        )

        const remoteBinaryName = await this.getRemoteBinaryName()
        log.session.info('DaemonConnection: binary deployed via chunked pipe', {
          host: this.hostKey, deployMs: Date.now() - t0,
          bytes: binarySize, gzBytes: gzSize, chunks: totalChunks,
          totalFailures, binary: remoteBinaryName, remoteVersion: unpackResult.trim(),
        })
      }
    } catch (err) {
      throw new Error(`Failed to deploy daemon binary to ${this.hostKey}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Source-based deploy: pipe daemon.cjs (~44KB) + npm install ws.
   * Primary fallback when binary deploy fails (e.g. SSH proxy kills large transfers).
   */
  private async deploySource(): Promise<void> {
    const source = getDaemonSource()
    const t0 = Date.now()
    const preamble = buildRemotePreamble(this.ssh.shell_setup)

    try {
      // Create directory and clean up legacy daemon.js (which breaks under "type":"module")
      const dir = this._remoteDir
      await this.sshExec(`mkdir -p ${shq(dir)} && rm -f ${shq(dir + '/daemon.js')}`)

      const args = [...this.baseSshArgs, this.sshHostString, markedUploadCommand(`${dir}/daemon.cjs`)]
      // Bounded: these uploads had no deadline at all (remote-sh.ts runSshBounded).
      const upload = await runSshBounded(args, { input: source, timeoutMs: SOURCE_UPLOAD_TIMEOUT_MS })
      if (upload.spawnError) throw upload.spawnError
      if (upload.timedOut) throw new Error(`daemon source deploy timed out after ${SOURCE_UPLOAD_TIMEOUT_MS}ms`)
      if (upload.code !== 0) throw new Error(`daemon source deploy failed with code ${upload.code}`)

      // Sidecar bundles: the source template can't import modules, so each of
      // these is require()d next to daemon.cjs and gates its own capability.
      // Best-effort per file — a missing sidecar (npm-package install without
      // dist/daemon-binaries) just means that host keeps the server-side
      // fallback (changes) or reports no external sessions (external-scan).
      for (const sidecarFile of ['changes-core.cjs', 'external-scan-core.cjs', 'path-resolve-core.cjs', 'vscode-server-core.cjs', 'transcript-rewind-core.cjs', 'daemon-cron-runtime.cjs', 'daemon-instance-lock.cjs', 'daemon-service-cli.cjs', 'trigger-check-core.cjs']) {
        try {
          const sidecar = fs.readFileSync(path.join(DAEMON_BINARIES_DIR, sidecarFile), 'utf-8')
          const scArgs = [...this.baseSshArgs, this.sshHostString, markedUploadCommand(`${dir}/${sidecarFile}`)]
          const sc = await runSshBounded(scArgs, { input: sidecar, timeoutMs: SOURCE_UPLOAD_TIMEOUT_MS })
          if (sc.spawnError) throw sc.spawnError
          if (sc.timedOut) throw new Error(`${sidecarFile} sidecar deploy timed out after ${SOURCE_UPLOAD_TIMEOUT_MS}ms`)
          if (sc.code !== 0) throw new Error(`${sidecarFile} sidecar deploy failed with code ${sc.code}`)
        } catch (err) {
          log.session.info('DaemonConnection: sidecar not deployed (fallback stays)', {
            host: this.hostKey, sidecar: sidecarFile,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      // Ensure 'ws' package is available for the daemon's WebSocket server.
      // When bun is the runtime we skip this entirely — daemon-source.ts has a
      // raw HTTP-upgrade fallback (createManualWsServer) that kicks in when
      // require('ws') fails, and that's what serves WS under bun. Skipping
      // saves 5-30s and avoids EBADPLATFORM on hosts without npm.
      if (!this._bunPath) {
        try {
          await this.sshExec(`${userShellPathScript(preamble)}\ncd ${shq(dir)} && node -e "require('ws')" 2>/dev/null || (rm -f package.json && npm install --prefix ${shq(dir)} ws 2>/dev/null)`, 30_000)
        } catch {
          log.session.debug('DaemonConnection: ws install skipped', { host: this.hostKey })
        }
      }

      log.session.info('DaemonConnection: daemon source deployed', {
        host: this.hostKey, deployMs: Date.now() - t0, bytes: source.length,
      })
    } catch (err) {
      throw new Error(`Failed to deploy daemon source to ${this.hostKey}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Start the daemon on the remote host. Returns the listening port.
   *
   * Uses the binary directly when deployed (no PATH discovery needed).
   * Falls back to node + preamble for source-based deployments.
   */
  private async startDaemon(runtime?: RemoteRuntime): Promise<number> {
    try {
      // Start command is built by the PURE builder in daemon-start-cmd.ts —
      // env vars ride as structured data (rendered `nohup env K=V cmd`; a
      // bare `nohup K=V cmd` makes nohup exec 'K=V' as the program — the
      // 2026-08-12 clouddev outage), and the generated shell is EXECUTED
      // against a fake runtime in tests/providers/daemon-start-cmd.test.ts.
      // Rationale for the probe/confirm shell shapes lives in that module.
      //
      // Why `--status` / `kill -0` AFTER `cat daemon.port`: the port file can
      // linger from a previous daemon that crashed, making `cat daemon.port`
      // look like success while the current spawn is already dead. Binary has
      // a `--status` subcommand; source daemon doesn't, so it uses `kill -0`
      // on the PID file. See daemon-source.ts — no --status handler.

      // Opt-in session-only cron policy (config session.cron_policy): the
      // daemon reads WALNUT_ENFORCE_SESSION_CRON at boot, so it must be in
      // the spawn env. Default 'unrestricted' → no var → daemon does nothing.
      const daemonEnv: Record<string, string> = {}
      try {
        const { getConfig } = await import('../core/config-manager.js')
        const cfg = await getConfig()
        if (cfg.session?.cron_policy === 'session-only') {
          daemonEnv.WALNUT_ENFORCE_SESSION_CRON = '1'
        }
        // Turn-error auto-retry: the Mac owns POLICY (user config), the daemon
        // owns EXECUTION (it survives Mac sleep / tunnel loss). Only emitted
        // when enabled, so a default install ships a daemon that does nothing.
        Object.assign(daemonEnv, buildTurnRetryEnv(cfg.session?.turn_retry))
      } catch { /* config unavailable — default policy */ }

      // A relocated daemon (remote-daemon-dir.ts) learns its dir from the env.
      Object.assign(daemonEnv, this.dirEnv)
      const dir = this._remoteDir
      const chosen: RemoteRuntime = runtime
        ?? (this._deployedViaSource && this._bunPath ? 'bun'
          : !this._deployedViaSource && await this.getLocalBinaryPath() ? 'binary' : 'node')
      let startCmd: string
      if (chosen === 'bun' && this._bunPath) {
        startCmd = buildDaemonStartCmd({ runtime: 'bun', execPath: this._bunPath, env: daemonEnv, dir })
      } else if (chosen === 'binary') {
        startCmd = buildDaemonStartCmd({ runtime: 'binary', execPath: await this.getRemoteDaemonPath(), env: daemonEnv, dir })
      } else {
        startCmd = buildDaemonStartCmd({
          runtime: 'node',
          env: daemonEnv,
          dir,
          // The node PATH comes from the user's own shell running the preamble
          // (remote-sh.ts), since the start itself now runs under sh.
          preamble: userShellPathScript(buildRemotePreamble(this.ssh.shell_setup)),
        })
      }

      // A non-zero exit here is the start failing (no port file, --status says
      // not running): read the start log either way, since the runtime's own
      // death (walnut-daemon-exit=N, "Illegal instruction") is recorded THERE
      // and the runtime fallback reads it. Only a dead link is rethrown as is.
      let output = ''
      let startErr = ''
      try {
        output = await this.sshExec(startCmd, 60_000)
      } catch (err) {
        if (isSshTransportFailure(err)) throw err
        startErr = (err instanceof Error ? err.message : String(err)).split('\n').slice(1).join(' ').trim()
      }

      // Parse out port + status confirmation. Only the marked output reaches
      // here (remote-sh.ts), but the node branch still runs shell_setup, which
      // may print: match by shape. port = pure digits, status = "running":true.
      const lines = output.trim().split('\n').map(l => l.trim()).filter(Boolean)
      // Extract port: prefer a pure-digit line, fall back to leading digits of
      // any line (handles cases where port file has no trailing newline and
      // concatenates with the next command's output, e.g. "32899{\"running\":true}").
      let portStr = lines.find(l => /^\d+$/.test(l)) || ''
      if (!portStr) {
        for (const l of lines) {
          const m = l.match(/^(\d+)/)
          if (m) { portStr = m[1]; break }
        }
      }
      const statusLine = lines.find(l => l.includes('"running":true')) || ''
      const port = parseInt(portStr, 10)

      if (startErr || isNaN(port) || port < 1 || port > 65535 || !statusLine.includes('"running":true')) {
        // Read the startup log for diagnostics and detect the specific failure
        // modes we've seen in production.
        let startLog = ''
        try { startLog = await this.sshExec(`cat ${shq(dir + '/daemon-start.log')} 2>/dev/null || true`, 5_000) } catch {}

        const hint = diagnoseDaemonStartLog(startLog, this.hostKey)

        throw new Error(
          `daemon failed to start (port='${portStr}', status='${statusLine}')${hint}. `
          + `Startup log: ${startLog.slice(0, 500)}`
          + (startErr ? `. Start command said: ${startErr.slice(0, 300)}` : ''),
        )
      }

      log.session.info('DaemonConnection: daemon started', { host: this.hostKey, port })
      return port
    } catch (err) {
      throw new Error(`Failed to start daemon on ${this.hostKey}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Create an SSH tunnel from localPort to remote daemonPort.
   * Returns the local port number.
   */
  private async createTunnel(remotePort: number): Promise<number> {
    // Find a free local port
    const { createServer } = await import('node:net')
    const localPort = await new Promise<number>((resolve, reject) => {
      const srv = createServer()
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        srv.close(() => resolve(port))
      })
      srv.on('error', reject)
    })

    // Create SSH tunnel (ssh -L localPort:localhost:remotePort -N host)
    const args = [
      ...this.baseSshArgs,
      '-L', `${localPort}:127.0.0.1:${remotePort}`,
      '-N',  // No remote command — just tunnel
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      this.sshHostString,
    ]

    this.tunnel = spawn('ssh', args, {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.tunnel.unref()
    // What ssh said while setting the tunnel up ("Port forwarding is disabled
    // to avoid man-in-the-middle attacks" after a host key change): the error
    // below quotes it so the failure can be classified. Bounded, then ignored.
    let tunnelStderr = ''
    this.tunnel.stderr?.on('data', (d: Buffer) => { if (tunnelStderr.length < 4096) tunnelStderr += d.toString() })

    // Monitor tunnel death for auto-reconnect
    this.tunnel.on('exit', (code) => {
      log.session.warn('DaemonConnection: SSH tunnel died', {
        host: this.hostKey, code, localPort, remotePort,
      })
      this.tunnel = null
      this.handleConnectionLost()
    })

    // Wait for tunnel to be ready — poll until the local port accepts connections.
    // SSH tunnel needs time to establish the port forwarding. Fixed sleeps are unreliable.
    const tunnelReady = await this.waitForTunnel(localPort, 10_000)
    if (!tunnelReady) {
      const said = tunnelStderr.trim().split('\n').slice(-6).join('\n')
      throw new Error(`SSH tunnel created but port ${localPort} not accepting connections after 10s${said ? `\n${said}` : ''}`)
    }

    log.session.info('DaemonConnection: SSH tunnel created', {
      host: this.hostKey, localPort, remotePort,
    })

    return localPort
  }

  /**
   * Wait for the SSH tunnel local port to accept TCP connections.
   * Polls every 200ms up to timeoutMs.
   */
  private async waitForTunnel(localPort: number, timeoutMs: number): Promise<boolean> {
    const { createConnection } = await import('node:net')
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const ok = await new Promise<boolean>((resolve) => {
        const sock = createConnection({ host: '127.0.0.1', port: localPort }, () => {
          sock.destroy()
          resolve(true)
        })
        sock.on('error', () => { sock.destroy(); resolve(false) })
        sock.setTimeout(500, () => { sock.destroy(); resolve(false) })
      })
      if (ok) return true
      await new Promise(r => setTimeout(r, 200))
    }
    return false
  }

  /**
   * Connect directly to a WebSocket URL, bypassing SSH deploy/tunnel.
   * Used for the LOCAL daemon (`__local__`, via getDirectDaemonConnection) and
   * by tests to connect RemoteSessionManager to a MockDaemon.
   *
   * Runs the same `hello` handshake as connect()/reconnect(). It used to skip
   * it, which left `_capabilities` null forever on every direct connection — so
   * `supportsSnapshots` was false for the local daemon and
   * getPooledSnapshotConnection('__local__') never matched: the C2 pull channel
   * was dead for ALL local sessions (C31), and every local session's snapshot
   * flow depended on pushes alone. A failed handshake is NOT fatal here (unlike
   * the SSH path there is nothing to redeploy — a test MockDaemon may not even
   * implement `hello`); it only leaves optional capabilities unadvertised.
   */
  async connectDirect(wsUrl: string): Promise<void> {
    if (this._connected) return
    await this.connectWebSocket(wsUrl)
    const ok = await this.verifyCapabilities()
    if (!ok) {
      log.session.warn('DaemonConnection: direct connect hello failed — proceeding anyway', {
        host: this.hostKey, wsUrl,
      })
    }
    this.setConnected(true)
    this.startPing()
  }

  /**
   * Connect WebSocket through the SSH tunnel (or directly via URL).
   */
  private connectWebSocket(urlOrPort: number | string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = typeof urlOrPort === 'string' ? urlOrPort : `ws://127.0.0.1:${urlOrPort}`
      this._lastWsUrl = url
      // maxPayload stays at the ws default (100MB) DELIBERATELY — it is the
      // tripwire that caught inc-1783842393500 (134MB one-frame fs.read of a
      // whale JSONL → "Max payload size exceeded"). DaemonFileReader chunks all
      // big file reads to 1MB frames now; the largest remaining legit frame is
      // a git.diff response (git stdout capped at 64MB in cmdGitDiff), so do
      // NOT lower this without chunking git.diff first.
      const ws = new WebSocket(url, { handshakeTimeout: 10_000 })

      ws.on('open', () => {
        this.ws = ws
        this.lastPongAt = Date.now()
        this._pongPending = false
        this._missedPongs = 0
        resolve()
      })

      ws.on('error', (err) => {
        if (!this._connected) {
          const errDetails = (err as Error & { code?: string }).code || err.message || 'no details'
          reject(new Error(
            `WebSocket connection failed: ${errDetails} (host=${this.hostKey}, url=${url})`
          ))
        } else {
          log.session.warn('DaemonConnection: WebSocket error', {
            host: this.hostKey, error: err.message,
          })
        }
      })

      ws.on('close', () => {
        if (this._connected) {
          let localDaemonPidAlive: boolean | null = null
          if (this.hostKey === '__local__') {
            try {
              const pid = localDaemon.pid
              if (pid !== null && pid !== undefined) {
                try { process.kill(pid, 0); localDaemonPidAlive = true }
                catch { localDaemonPidAlive = false }
              }
            } catch {}
          }
          log.session.warn('DaemonConnection: WebSocket closed', {
            host: this.hostKey,
            wsUrl: this._lastWsUrl,
            localDaemonPidAlive,
          })
          this.handleConnectionLost()
        }
      })

      ws.on('message', (data) => {
        this.handleMessage(typeof data === 'string' ? data : data.toString())
      })

      ws.on('pong', () => {
        this.lastPongAt = Date.now()
        this._pongPending = false
        this._missedPongs = 0
      })

      // Timeout
      const timer = setTimeout(() => {
        ws.close()
        reject(new Error('WebSocket connection timeout'))
      }, 10_000)

      ws.on('open', () => clearTimeout(timer))
    })
  }

  // ── Private: Message handling ──

  /**
   * Resolve a command-response frame (has numeric `id`) against the shared
   * pendingCommands map. Called from BOTH the main and bulk socket message
   * handlers — the map is shared, ids are monotonic, so a response resolves
   * correctly no matter which socket delivered it. Returns true if the frame
   * was a command response (matched or stale).
   */
  private resolveCommandFrame(msg: Record<string, unknown>): boolean {
    if (!('id' in msg) || typeof msg.id !== 'number') return false
    const pending = this.pendingCommands.get(msg.id)
    if (pending) {
      clearTimeout(pending.timer)
      this.pendingCommands.delete(msg.id)
      // Per-command round-trip RTT — paired with the `DaemonConnection: send`
      // dispatch log by traceId. This is the SSH-tunnel/daemon hop that the
      // enqueue→delivered `deliveryMs` field omits; on a slow tunnel a `send`
      // RTT spike here is the smoking gun for "message send is slow". Skip
      // `ping` (fires every 15s, adds noise). Gated at debug (zero overhead by
      // default); enable with WALNUT_LOG_LEVEL=debug.
      if (pending.cmd && pending.cmd !== 'ping' && pending.startedAt != null) {
        log.session.debug('DaemonConnection: recv (rtt)', {
          host: this.hostKey,
          cmd: pending.cmd,
          id: msg.id,
          traceId: pending.traceId,
          rttMs: Date.now() - pending.startedAt,
          ok: (msg as { ok?: boolean }).ok ?? null,
        })
      }
      pending.resolve(msg as unknown as DaemonCommandResult)
    }
    return true
  }

  /**
   * Hand one trigger event to the registered sink. The daemon frames events with
   * `ev`; the shared contract discriminates on `type`, so the frame's own name is
   * copied across here rather than duplicated on the wire. Never throws: a bad
   * event must not take the socket down.
   */
  private dispatchTriggerEvent(event: DaemonEvent): void {
    void (async () => {
      const { getTriggerEventSink } = await import('../core/routines/trigger-bridge.js')
      const sink = getTriggerEventSink()
      if (!sink) {
        log.session.warn('DaemonConnection: trigger event with no sink registered', {
          host: this.hostKey, ev: event.ev, id: (event as { id?: string }).id,
        })
        return
      }
      sink(this.hostKey, { ...(event as unknown as Record<string, unknown>), type: event.ev } as never)
    })().catch((err) => {
      log.session.warn('DaemonConnection: trigger event dispatch failed', {
        host: this.hostKey, ev: event.ev, error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>
    try { msg = JSON.parse(raw) } catch { return }

    // Command response (has 'id' field)
    if (this.resolveCommandFrame(msg)) return

    // Unsolicited event (has 'ev' field)
    if ('ev' in msg) {
      const event = msg as unknown as DaemonEvent
      if (event.ev === 'cron-metadata') {
        if (this._connected && this.cronMetadataToken) sessionCronMetadata.apply(this.hostKey, this.cronMetadataToken, event.value)
        return
      }
      // STT relay (cloud voice input): the daemon forwards phone audio from
      // its bridge here because this box has the transcription engine. Handled
      // internally — session-level eventHandlers never see it.
      if (event.ev === 'stt-request') {
        void this.handleSttRequest(event)
        return
      }
      // Launch relay (cloud session creation): the daemon forwards a phone's
      // create-session request from its bridge here because this box owns the
      // session records + quick-start core. Handled internally — session-level
      // eventHandlers never see it.
      if (event.ev === 'launch-request') {
        void this.handleLaunchRequest(event)
        return
      }
      // Control relay (cloud model/effort/fork): same internal handling as
      // launch-request — session-level eventHandlers never see it.
      if (event.ev === 'control-request') {
        void this.handleControlRequest(event)
        return
      }
      // Message relay (cloud phone send → durable queue): same internal
      // handling — session-level eventHandlers never see it.
      if (event.ev === 'message-request') {
        void this.handleMessageRequest(event)
        return
      }
      // Agent-gateway relay (walnut CLI peers.list/peers.send): same internal
      // handling — session-level eventHandlers never see it.
      if (event.ev === 'gateway-request') {
        void this.handleGatewayRequest(event)
        return
      }
      // Offline host: the daemon answered one of our sessions itself (we were
      // away or still taking the handover) and asks us to drain its journal.
      if (event.ev === 'offline-journal') {
        this.offlineDrainDue = true
        this.pushHostSlice()
        return
      }
      // walnut-trigger: the daemon's check reports. Routed to the registered
      // sink (never to session eventHandlers — a trigger belongs to a ROUTINE,
      // not to a session) before the generic fan-out.
      if (event.ev === 'trigger.checked' || event.ev === 'trigger.fired') {
        this.dispatchTriggerEvent(event)
        return
      }
      // DUP-DEBUG: if handlerCount > 1, every event below fans out N times.
      // jsonl events are high-frequency — only log when something is off
      // (multiple handlers) or for low-frequency event types.
      if (this.eventHandlers.length !== 1 || event.ev !== 'jsonl') {
        log.session.debug('DaemonConnection: dispatch event', {
          host: this.hostKey,
          ev: event.ev,
          sid: (event as { sid?: string }).sid,
          handlerCount: this.eventHandlers.length,
        })
      }
      for (const handler of this.eventHandlers) {
        try { handler(event) } catch {}
      }
    }
  }

  // ── Private: Bulk channel ──

  /**
   * Dial the bulk data channel in the background. Fire-and-forget from
   * setConnected(true) — a bulk dial failure NEVER affects the main
   * connection (worst case bulk commands keep riding the main WS, which is
   * exactly today's behavior).
   *
   * The dial verifies via `hello` that the socket reached the SAME daemon
   * instance as the main connection before routing anything to it. On
   * close/error after establishment it schedules ONE redial (10s) while the
   * main connection is still up; reconnects re-dial via setConnected(true)
   * (the localPort changes on every reconnect).
   */
  private dialBulkChannel(): void {
    this.closeBulkChannel()
    const url = this._lastWsUrl
    if (!url || !this._connected || this._destroyed) return
    const seq = ++this.bulkDialSeq
    const isCurrent = () => seq === this.bulkDialSeq && this._connected && !this._destroyed

    let ws: WebSocket
    try {
      ws = new WebSocket(url, { handshakeTimeout: 10_000 })
    } catch (err) {
      log.session.debug('DaemonConnection: bulk channel dial failed', {
        host: this.hostKey, url, error: err instanceof Error ? err.message : String(err),
      })
      return
    }
    let established = false

    // Responses to bulk-routed commands resolve through the SHARED pending
    // map. Event frames are dropped — the main socket owns event dispatch
    // (session_state broadcasts to ALL daemon clients; forwarding here would
    // double-dispatch every event). Exceptions: stt-request / launch-request,
    // which the daemon sends to its FIRST trusted client — after a main-WS
    // reconnect that can be this socket, and dropping them would break phone
    // voice input / cloud session creation.
    ws.on('message', (data) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(typeof data === 'string' ? data : data.toString()) } catch { return }
      if (this.resolveCommandFrame(msg)) return
      if ('ev' in msg && (msg as { ev?: string }).ev === 'stt-request') {
        void this.handleSttRequest(msg as unknown as DaemonEvent)
      }
      if ('ev' in msg && (msg as { ev?: string }).ev === 'launch-request') {
        void this.handleLaunchRequest(msg as unknown as DaemonEvent)
      }
      if ('ev' in msg && (msg as { ev?: string }).ev === 'control-request') {
        void this.handleControlRequest(msg as unknown as DaemonEvent)
      }
      // message-request also targets the daemon's FIRST trusted client — after
      // a main-WS reconnect that can be this bulk socket; dropping it would
      // strand every phone send until the next reconnect.
      if ('ev' in msg && (msg as { ev?: string }).ev === 'message-request') {
        void this.handleMessageRequest(msg as unknown as DaemonEvent)
      }
      // gateway-request also targets the daemon's FIRST trusted client — after
      // a main-WS reconnect that can be this bulk socket; dropping it here
      // would silently time out every walnut CLI call until the next reconnect.
      if ('ev' in msg && (msg as { ev?: string }).ev === 'gateway-request') {
        void this.handleGatewayRequest(msg as unknown as DaemonEvent)
      }
      // Trigger reports are host-authoritative and unrepeatable (a fire waits in
      // pendingFires until acked, but a checked event is gone). After a main-WS
      // reconnect this socket can be the daemon's first trusted client, so
      // dropping them here would stall every trigger on the host.
      const ev = (msg as { ev?: string }).ev
      if ('ev' in msg && (ev === 'trigger.checked' || ev === 'trigger.fired')) {
        this.dispatchTriggerEvent(msg as unknown as DaemonEvent)
      }
    })

    ws.on('open', () => {
      if (!isCurrent()) { try { ws.terminate() } catch {}; return }
      // Verify daemon identity on THIS socket before routing to it. The reply
      // arrives on the bulk socket and resolves via resolveCommandFrame.
      const id = ++this.cmdCounter
      const hello = new Promise<DaemonCommandResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingCommands.delete(id)
          reject(new Error('bulk hello timeout'))
        }, 10_000)
        this.pendingCommands.set(id, { resolve, reject, timer })
        ws.send(JSON.stringify({ id, cmd: 'hello' }))
      })
      hello.then((res) => {
        if (!isCurrent()) { try { ws.terminate() } catch {}; return }
        const instanceId = typeof res.instanceId === 'string' ? res.instanceId : null
        if (!res.ok || (this._daemonInstanceId !== null && instanceId !== null && instanceId !== this._daemonInstanceId)) {
          // Wrong/unhealthy daemon behind this socket — the main-connection
          // machinery owns daemon-identity problems. Invalidate the dial gen
          // so the close handler does NOT redial.
          log.session.warn('DaemonConnection: bulk channel hello mismatch — not using', {
            host: this.hostKey, ok: res.ok, instanceId, mainInstanceId: this._daemonInstanceId,
          })
          this.bulkDialSeq++
          try { ws.terminate() } catch {}
          return
        }
        established = true
        this.bulkWs = ws
        log.session.info('DaemonConnection: bulk channel connected', {
          host: this.hostKey, url, instanceId,
        })
      }).catch((err) => {
        // Terminate UNCONDITIONALLY: disconnect() rejects the shared pending
        // map (including this hello) but closeBulkChannel only terminates an
        // INSTALLED bulkWs — a mid-hello socket would otherwise leak open.
        try { ws.terminate() } catch {}
        if (!isCurrent()) return
        log.session.debug('DaemonConnection: bulk channel hello failed', {
          host: this.hostKey, error: err instanceof Error ? err.message : String(err),
        })
        // close handler schedules the redial
      })
    })

    ws.on('error', () => { /* close always follows — handled there */ })

    ws.on('close', () => {
      if (seq !== this.bulkDialSeq) return // superseded or deliberately torn down
      if (this.bulkWs === ws) this.bulkWs = null
      if (established) {
        log.session.info('DaemonConnection: bulk channel down — falling back to main socket', {
          host: this.hostKey,
        })
      }
      // One pending redial at a time, only while the main connection is up.
      if (this._connected && !this._destroyed && !this.bulkRedialTimer) {
        this.bulkRedialTimer = setTimeout(() => {
          this.bulkRedialTimer = null
          if (this._connected && !this._destroyed) this.dialBulkChannel()
        }, DaemonConnection.BULK_REDIAL_DELAY_MS)
        this.bulkRedialTimer.unref?.()
      }
    })
  }

  /** True when the bulk data channel is open and routing bulk commands.
   *  Observability + test hook — never required for correctness. */
  get bulkChannelActive(): boolean {
    return this.bulkWs?.readyState === WebSocket.OPEN
  }

  private closeTransport(): void {
    this.closeBulkChannel()
    if (this.ws) {
      try { this.ws.close() } catch {}
      this.ws = null
    }
    if (this.tunnel) {
      try { this.tunnel.kill('SIGTERM') } catch {}
      this.tunnel = null
    }
    this.localPort = null
    this.setConnected(false)
  }

  private closeBulkChannel(): void {
    this.bulkDialSeq++ // invalidate any in-flight dial/close callbacks
    if (this.bulkRedialTimer) {
      clearTimeout(this.bulkRedialTimer)
      this.bulkRedialTimer = null
    }
    if (this.bulkWs) {
      try { this.bulkWs.terminate() } catch {}
      this.bulkWs = null
    }
  }

  // ── Private: Reconnection ──

  private handleConnectionLost(): void {
    // Stop ping BEFORE the early return. When a second loss signal arrives on an
    // already-disconnected instance (ws 'close' after a stale-pong loss, or a
    // pingTimer that outlived its connection), returning with the timer alive
    // leaves a zombie interval logging "no pong received" every 15s forever —
    // observed 2026-08-01: lastPongAgoMs grew to 12.6h across 1138 warns.
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }

    if (this._destroyed || !this._connected) return

    this.setConnected(false)

    // Close WebSockets. The bulk channel rides the same tunnel — when the
    // main socket is gone the tunnel is suspect, so tear bulk down too; the
    // reconnect path re-dials it via setConnected(true).
    this.closeBulkChannel()
    if (this.ws) {
      try { this.ws.close() } catch {}
      this.ws = null
    }

    log.session.info('DaemonConnection: connection lost, scheduling reconnect', {
      host: this.hostKey, delayMs: DaemonConnection.RECONNECT_DELAY_MS,
    })

    // Schedule reconnect with exponential backoff (2s → 4s → 8s → … → 60s max), forever
    this.scheduleReconnect(DaemonConnection.RECONNECT_DELAY_MS)
  }

  /** The reconnect attempt running now (null between attempts). */
  get reconnectInFlight(): Promise<void> | null { return this._reconnectInFlight }

  /** A backoff timer is waiting to re-dial. */
  get reconnectPending(): boolean { return this.reconnectTimer !== null }

  /** A connect() is running on this instance (the pool's connectingPromises holds it). */
  get connecting(): boolean { return this._connecting }

  /**
   * Run the reconnect loop's next attempt NOW instead of at its timer (a human's
   * Connect now, or a caller that needs the host during the backoff wait), and
   * join an attempt already dialling. A failure reschedules on the loop's own
   * step, so the loop and its retryAt outlive a failed Connect now.
   */
  reconnectNow(): Promise<void> {
    if (this._reconnectInFlight) return this._reconnectInFlight
    if (this._connected) return Promise.resolve()
    if (this._destroyed) return Promise.reject(new Error(`Connection to ${this.hostKey} was closed`))
    this.cancelReconnectTimer()
    // A cleared failure ('idle') or a standing one ('failed') reads as trying now.
    if (this._phase !== 'reconnecting') this.setPhase('reconnecting')
    return this.runReconnectAttempt(this._reconnectChainDelayMs || DaemonConnection.RECONNECT_DELAY_MS)
  }

  /** Drop the pending backoff timer (a human's Connect now dials at once instead). */
  cancelReconnectTimer(): boolean {
    if (!this.reconnectTimer) return false
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    return true
  }

  /** A wake or network change: run the pending re-dial now, keeping its place in the backoff chain. */
  expediteReconnect(): boolean {
    if (!this.cancelReconnectTimer()) return false
    this.scheduleReconnect(0, this._reconnectChainDelayMs || DaemonConnection.RECONNECT_DELAY_MS)
    return true
  }

  private scheduleReconnect(delayMs: number, chainDelayMs: number = delayMs): void {
    if (this._destroyed || this._connected || this.reconnectTimer) return
    this._reconnectChainDelayMs = chainDelayMs

    // Auto-reconnect for __local__ is a pool-instance privilege. A __local__
    // connection outside the pool is an orphan from the pre-pool leak (or a
    // future bypass construction site) — letting it keep a permanent backoff
    // loop is exactly how the 100-instance reconnect storm formed. Scoped to
    // __local__: tests legitimately hold private direct-ws connections to
    // per-test MockDaemons under other host keys. WALNUT_LOCAL_CONN_POOL=0
    // (legacy private-connection mode) disables the guard too.
    if (this.hostKey === '__local__' && process.env.WALNUT_LOCAL_CONN_POOL !== '0' && !isPooledConnection(this)) {
      log.session.warn('DaemonConnection: skipping auto-reconnect for non-pooled __local__ instance', {
        host: this.hostKey,
      })
      this.disconnect()
      return
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this._destroyed || this._connected) return
      // A connect() owns this instance right now: reconnect() would stop the
      // ControlMaster it is building (C12b). Wait one more step; a success ends the loop.
      if (this._connecting) {
        this.scheduleReconnect(Math.max(chainDelayMs, DaemonConnection.RECONNECT_DELAY_MS), chainDelayMs)
        return
      }
      this.runReconnectAttempt(chainDelayMs).catch(() => { /* the failure already rescheduled the loop */ })
    }, delayMs)
  }

  /** One reconnect attempt (the timer's or reconnectNow's). Rejects with the attempt's error after rescheduling. */
  private runReconnectAttempt(chainDelayMs: number): Promise<void> {
    this._reconnectAttempts += 1
    // Each attempt restarts the whole-attempt clock, or attemptStartedAt keeps the first dial's time forever.
    this._connectStartedAt = Date.now()
    const run = (async () => {
      try {
        await this.reconnect()
      } catch (rawErr) {
        throw await this.handleReconnectFailure(rawErr, chainDelayMs)
      }
    })()
    const inFlight: Promise<void> = run.finally(() => { if (this._reconnectInFlight === inFlight) this._reconnectInFlight = null })
    this._reconnectInFlight = inFlight
    return inFlight
  }

  /**
   * A reconnect attempt failed (or a connect() that interrupted the loop did):
   * record the cause every surface reads and schedule the next attempt. Returns
   * the error as the local credential evidence explains it.
   */
  private async handleReconnectFailure(rawErr: unknown, chainDelayMs: number, annotated = false): Promise<unknown> {
    // Same local evidence as a first connect: an expired certificate on a
    // host that WAS connected must read as cert_expired, not plain auth.
    const err = annotated || !this.sshTarget ? rawErr : await annotateCredentialFailure(rawErr, this.sshHostString)
    if (this._destroyed || this._connected) return err
    const msg = err instanceof Error ? err.message : String(err)
    // Standing failures: retrying every 30s can't fix an expired SSH cert
    // (needs a login), a changed host key, or a hostname that no longer
    // resolves. Credential waits follow the warmup's schedule (1, 2, 5
    // minutes, then every 5) so a login done elsewhere reconnects soon;
    // the rest back off to a slow probe (RECONNECT_STANDING_FAILURE_DELAY_MS).
    const kind = this.sshTarget
      ? classifyHostConnectError(msg, this.sshHostString, [this.hostKey, this.ssh.hostname, this.ssh.user ?? '']).kind
      : 'unknown'
    // Which of these, and the cause every surface reads: daemon-reconnect-cause.ts.
    const now = Date.now()
    const step = decideReconnectStep({
      kind, now, delayMs: chainDelayMs, credentialAttempt: this._credentialReconnects, lastSignalAt: lastHostSignalAt(),
      standingDelayMs: DaemonConnection.RECONNECT_STANDING_FAILURE_DELAY_MS,
      maxDelayMs: DaemonConnection.RECONNECT_MAX_DELAY_MS, credentialDelayMs: credentialRetryDelayMs,
    })
    const { credentialWait, standing, nextDelayMs } = step
    if (credentialWait) this._credentialReconnects++
    else this._credentialReconnects = 0
    recordReconnectCause(this.hostKey, {
      summary: summarizeConnectFailure(msg), kind, since: this._disconnectedSince ?? now, at: now, standing,
      ...(step.retryAt ? { retryAt: step.retryAt } : {}),
    })
    log.session.warn('DaemonConnection: reconnect failed, will retry', {
      host: this.hostKey,
      attempt: this._reconnectAttempts,
      stuckForMs: this._disconnectedSince ? Date.now() - this._disconnectedSince : null,
      error: msg,
      standingFailure: standing || undefined,
      kind,
      nextDelayMs,
    })
    this.scheduleReconnect(nextDelayMs)
    // A standing cause reads 'failed' on screen while recovery goes on; a
    // transient one reads 'reconnecting' (also after a cleared or standing
    // failure, whose phase would otherwise outlive its cause).
    if (standing && this._phase !== 'failed') this.setPhase('failed')
    else if (!standing && this._phase !== 'reconnecting') this.setPhase('reconnecting')
    else notifyDaemonPhaseChange(this.hostKey)
    return err
  }

  /**
   * Reconnect to the daemon after connection loss.
   * The daemon is still running — we just need a new tunnel + WebSocket.
   */
  private async reconnect(): Promise<void> {
    if (this._destroyed) return

    log.session.info('DaemonConnection: attempting reconnect', { host: this.hostKey })

    // Local daemon path: no SSH tunnel / ControlMaster — just re-ensure the
    // in-process daemon is running and reconnect the WebSocket. Going through
    // the SSH branch would dereference sshTarget (null for __local__) and loop
    // forever in backoff.
    if (this.hostKey === '__local__' || !this.sshTarget) {
      const { localDaemon } = await import('./local-daemon.js')
      await localDaemon.ensureRunning()
      const wsUrl = localDaemon.wsUrl
      if (!wsUrl) throw new Error('Local daemon has no wsUrl after ensureRunning')
      await this.connectWebSocket(wsUrl)
      // Re-verify capabilities + refresh instance ID. Skipping this leaves
      // _daemonInstanceId pointing at the pre-crash daemon; downstream
      // instance-change detection would then silently miss restarts.
      const ok = await this.verifyCapabilities()
      if (!ok) {
        log.session.warn('DaemonConnection: local reconnect hello failed — proceeding anyway', {
          host: this.hostKey,
        })
      }
      this.setConnected(true)
      this.startPing()
      log.session.info('DaemonConnection: local reconnected', {
        host: this.hostKey, wsUrl, instanceId: this._daemonInstanceId,
      })
      this.recoverDisconnectedSessions().catch(() => {})
      return
    }

    // A postponed update going ahead drops the socket while its stop is still
    // confirming: wait for it, or this reconnect would kill the ControlMaster
    // under that stop and race it to the deploy.
    if (this._upgradeRecheckInFlight) await this._upgradeRecheckInFlight.catch(() => {})

    // Reset deploy flags — if daemon is still alive we skip deploy entirely;
    // if daemon died, deployDaemon() will set these correctly.
    this._deployedViaSource = false
    this._bunPath = null

    // Kill old tunnel if any (bulk channel rides it — tear that down first;
    // usually already gone via handleConnectionLost, this is belt-and-braces)
    this.closeBulkChannel()
    if (this.tunnel) {
      try { this.tunnel.kill('SIGTERM') } catch {}
      this.tunnel = null
    }

    // When the WebSocket/tunnel drops, the ControlMaster usually died with it.
    // Tear it down and rebuild before probing — otherwise every SSH command
    // silently fails through a dead socket and we misdiagnose a live daemon
    // as dead, burning ~10s on a pointless redeploy.
    await this.stopControlMaster().catch(() => {})
    await this.ensureControlMaster()

    // Check if daemon is still running. Strict mode: an SSH failure now means
    // the link is still broken (not that the daemon died) — surface it so the
    // outer reconnect loop retries with backoff instead of redeploying.
    let daemonPort: number | null
    try {
      await this.resolveRemoteDir()
      daemonPort = await this.checkDaemonRunning({ strict: true })
    } catch (err) {
      log.session.warn('DaemonConnection: daemon status probe failed via SSH — will retry reconnect', {
        host: this.hostKey,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }

    if (daemonPort === null) {
      if (this.isReadOnlyRemote) {
        // Ephemeral attach-only: the shared remote daemon is genuinely gone. Do NOT
        // redeploy/restart it (that race is the crash loop). Surface so the reconnect
        // loop backs off; if production restarts the daemon, a later attach succeeds.
        throw new Error(
          `ephemeral server: daemon absent on '${this.hostKey}' — attach-only, not redeploying`,
        )
      }
      // Daemon genuinely absent — redeploy and restart
      log.session.info('DaemonConnection: daemon not running, redeploying', { host: this.hostKey })
      daemonPort = await this.deployAndStart()
    }

    this.remotePort = daemonPort

    // Create new tunnel
    this.localPort = await this.createTunnel(daemonPort)

    // Connect WebSocket
    await this.connectWebSocket(this.localPort)

    // Re-verify capabilities + refresh daemon instance ID. If instance
    // changed (daemon was restarted out-of-band), verifyCapabilities logs
    // the transition — downstream session probes then resume via --resume
    // naturally, but the log line is the critical diagnostic.
    const priorInstanceId = this._daemonInstanceId
    const handshakeOk = await this.verifyCapabilities()
    if (!handshakeOk) {
      if (this.isReadOnlyRemote) {
        // Ephemeral attach-only: don't redeploy on reconnect handshake failure.
        throw new Error(
          `ephemeral server: reconnect handshake failed on '${this.hostKey}' — attach-only, not redeploying`,
        )
      }
      log.session.warn('DaemonConnection: reconnect hello failed — forcing redeploy', {
        host: this.hostKey,
      })
      // Same contract as connect(): a service-managed daemon is refused before
      // any teardown, so close this attempt's transport instead of leaking it.
      try {
        await this.forceRedeployAndReconnect()
      } catch (err) {
        if (err instanceof DaemonServiceNotReadyError || err instanceof DaemonServiceProbeError) this.closeTransport()
        throw err
      }
      // forceRedeploy handles setConnected(true). recoverDisconnectedSessions
      // still needs to run even on forced-redeploy path.
      this.recoverDisconnectedSessions().catch(() => {})
      return
    }
    this.setConnected(true)
    this.startPing()

    log.session.info('DaemonConnection: reconnected', {
      host: this.hostKey,
      localPort: this.localPort,
      remotePort: daemonPort,
      instanceId: this._daemonInstanceId,
      instanceChanged: priorInstanceId !== null && priorInstanceId !== this._daemonInstanceId,
    })

    // Auto-recover sessions that were marked error due to disconnect
    this.recoverDisconnectedSessions().catch(() => {})
  }

  /**
   * Re-subscribe a recovered session's manager to the daemon push stream.
   *
   * Under the session-bound watcher model the daemon's file tailer never
   * stopped — but `ws.close` removed us from the session's `subscribers` Set,
   * so `send('attach')` (inside reattachWatcher) is what re-adds us and replays
   * the bytes we missed from our tracked fromOffset. Under the older per-ws
   * watcher model it was the ONLY way to get push back at all. Either way the
   * call is correct and idempotent.
   *
   * Shared by BOTH recovery branches (snapshot-handled and legacy-alive) —
   * record convergence differs between them, ws re-subscription does not.
   * `quiet` suppresses the "no manager registered" debug line on the snapshot
   * branch, where an attach-only session with no live manager is expected.
   */
  private async reattachRecoveredSession(sessionId: string, quiet = false): Promise<void> {
    try {
      const { getRegisteredSessionManager } = await import('./session-manager.js')
      const mgr = getRegisteredSessionManager(sessionId)
      type Reattachable = { reattachWatcher?: () => Promise<boolean> }
      const reattachable = mgr as unknown as Reattachable | undefined
      if (reattachable?.reattachWatcher) {
        await reattachable.reattachWatcher()
      } else if (!quiet) {
        log.session.debug('DaemonConnection: no manager to reattach — session has no active subscriber', {
          sessionId, host: this.hostKey,
        })
      }
    } catch (err) {
      log.session.warn('DaemonConnection: reattach watcher failed (recovery continued)', {
        sessionId, host: this.hostKey,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** After successful reconnect, recover sessions marked error due to connection loss. */
  private async recoverDisconnectedSessions(): Promise<void> {
    try {
      const {
        emitSessionStatusChanged,
        listSessions,
        updateSessionRecord,
        updateSessionRecordConditionally,
        getSessionsForTaskSync,
      } = await import('../core/session-tracker.js')
      const sessions = await listSessions()

      // Bound the stopped-record rescue probes per pass: each is one `status`
      // RPC, and the 24h recency window in isRescuableStoppedRecord already
      // keeps the candidate set small, but a pathological store must not turn
      // one reconnect into an unbounded probe storm.
      const MAX_STOPPED_PROBES = 25
      let stoppedProbes = 0
      let clippedStoppedProbes = 0

      for (const s of sessions) {
        // Normalize host before comparing: local sessions persist no `host`
        // field (host=null/undefined), but the local connection's hostKey is
        // '__local__'. A raw `s.host !== this.hostKey` is therefore ALWAYS true
        // for local sessions, so every local session was silently skipped here
        // — after any local-daemon WS flap their daemon-side subscriber was
        // never re-added, the JSONL watcher fan'd new output to a dead
        // subscriber set, and the UI froze ("running, no output") until a manual
        // refresh re-subscribed. Mirror the canonical `host ?? '__local__'`
        // normalization used elsewhere (e.g. frequent-dirs.ts).
        if ((s.host ?? '__local__') !== this.hostKey) continue
        if (s.archived) continue

        // Reattach any non-terminal session. Both `running` (mid-turn) and
        // `idle` (FIFO session between turns, CLI alive waiting for stdin) must
        // be re-subscribed: on ws close the daemon's handleDisconnect removes
        // us from session.subscribers, but the session-bound JSONL watcher
        // keeps running — any new CLI output after reconnect is fan'd out to a
        // dead subscriber set and lost. Skipping `idle` here was the cause of
        // "messages deliver but Claude never replies in UI" after any WS flap.
        // `stopped` is terminal (CLI dead). An `error` whose cause is positively
        // the work's own fault (refusal, auth, a stop the user asked for) is left
        // alone — the next user message can spawn a fresh --resume.
        //
        // The classification MUST be structural (session-error-kind), not a match
        // on the message text. `!s.errorMessage?.includes('Connection lost')` is
        // what this line used to say, and the C2 snapshot projection writes
        // 'error' with NO message, so every snapshot-projected error read as
        // "non-recoverable" and was skipped here forever — 51 sessions, including
        // one that stayed dead for 3.5h after its host came back
        // (inc-1787439819342).
        // 'stopped' is otherwise a dead end no recovery path ever re-examines,
        // so skipping it is only safe when the stop is POSITIVELY intentional
        // (user action / terminal-class reason). A recent 'stopped' with an
        // infra or unknown cause is a claim about process death the daemon can
        // cheaply refute — inc-1787511363340: a spawn whose `start` command
        // timed out was marked stopped, the command executed 15s later anyway,
        // and the live CLI ran 1.6h behind a record every loop here skipped.
        // ACP records stay skipped: their liveness probe is acpState on
        // acpRuntimeId, and the branch below would relabel a dead one 'idle'.
        const rescuableStopped = s.process_status === 'stopped'
          && !isAcpEngine(s.engine)
          && isRescuableStoppedRecord(s)
        const isTerminal = s.process_status === 'stopped' && !rescuableStopped
        const isNonRecoverableError = s.process_status === 'error'
          && !isRecoverableSessionError(s)
        if (isTerminal || isNonRecoverableError) continue

        // pid to re-adopt onto a rescued record. A rescued-stopped record has
        // pid null (spawn "failed" before a pid arrived, or the terminal-clear
        // stripped it); leaving it null re-wedges within 2min — the health
        // monitor's orphan dead-pool drain marks any local pid-less
        // non-terminal record 'stopped' again. Written AFTER the status flips
        // (a pid written onto a still-'stopped' record is immediately stripped
        // by the tracker's terminal-state PID clear).
        let rescuedPid: number | null = null
        if (rescuableStopped) {
          // Cheap registry probe FIRST: only a LIVE process justifies running
          // the full recovery flow on a record that already claims death. Dead,
          // unknown, or over budget → leave the record exactly as it is (no
          // writes, no auto-resume): probing must cost nothing when the record
          // was right.
          if (stoppedProbes >= MAX_STOPPED_PROBES) { clippedStoppedProbes++; continue }
          stoppedProbes++
          try {
            const probe = await this.send('status', { sid: s.claudeSessionId })
            if (!(probe.ok && probe.alive)) continue
            rescuedPid = typeof probe.pid === 'number' ? probe.pid : null
          } catch { continue }
          log.session.info('DaemonConnection: live CLI behind a stopped record — rescuing', {
            sessionId: s.claudeSessionId, host: this.hostKey, pid: rescuedPid,
            statusReason: s.status_reason ?? null,
            changedBy: s.status_changed_by ?? null,
          })
        }

        if (isAcpEngine(s.engine)) {
          if (!s.acpRuntimeId) {
            log.session.warn('DaemonConnection: cannot recover ACP session without runtime ID', {
              sessionId: s.claudeSessionId,
              host: this.hostKey,
            })
            continue
          }

          try {
            const result = await this.send('acpState', { sid: s.acpRuntimeId })
            if (result.ok) {
              try {
                const { sessionRunner } = await import('./claude-code-session.js')
                const session = sessionRunner.findAcpSession(s.claudeSessionId)
                  ?? sessionRunner.findAcpSession(s.acpRuntimeId)
                await session?.reattachWatcher()
              } catch (err) {
                log.session.warn('DaemonConnection: ACP re-subscribe failed (recovery continued)', {
                  sessionId: s.claudeSessionId, host: this.hostKey,
                  error: err instanceof Error ? err.message : String(err),
                })
              }
              const state = result.result as import('./acp-worker/protocol.js').WorkerStateSnapshot | undefined
              if (!state || typeof state.turnActive !== 'boolean' || typeof state.controlActive !== 'boolean'
                || !Array.isArray(state.pendingPermissions)) {
                log.session.warn('DaemonConnection: ACP recovery state incomplete', { sessionId: s.claudeSessionId, host: this.hostKey })
                continue
              }
              if (state.controlActive && !state.turnActive) continue
              const recoveredStatus = state.turnActive || state.pendingPermissions.length > 0 ? 'running' : 'idle'
              const updated = await updateSessionRecordConditionally(s.claudeSessionId, {
                process_status: recoveredStatus,
                errorMessage: undefined,
                activity: recoveredStatus === 'idle' ? undefined : s.activity,
                ...(recoveredStatus === 'idle' ? { pendingPermission: undefined } : {}),
                last_status_change: new Date().toISOString(),
                status_reason: 'daemon_reconnected',
                status_changed_by: 'daemon',
              }, (current) => !current.archived
                && current.statusRevision === s.statusRevision
                && current.acpRuntimeId === s.acpRuntimeId
                && current.lastAcceptedAcpCommandId === s.lastAcceptedAcpCommandId
                && (current.process_status !== recoveredStatus
                  || (recoveredStatus === 'idle' && (!!current.activity || !!current.pendingPermission))))
              if (!updated) continue
              emitSessionStatusChanged(
                updated,
                {},
                ['*'],
                { source: 'daemon-reconnect', urgency: 'urgent' },
              )
              if (recoveredStatus === 'idle' && (s.process_status !== 'idle' || !!s.activity || !!s.pendingPermission)) {
                const { handBackTaskOnSessionEnd } = await import('../core/phase.js')
                await handBackTaskOnSessionEnd(updated.taskId, s.claudeSessionId, 'daemon-reconnect:acp-turn-ended', {
                  shouldApply: () => {
                    const current = getSessionsForTaskSync(updated.taskId).find((record) => record.claudeSessionId === s.claudeSessionId)
                    return current?.statusRevision === updated.statusRevision
                      && current?.acpRuntimeId === updated.acpRuntimeId
                      && current?.lastAcceptedAcpCommandId === updated.lastAcceptedAcpCommandId
                  },
                })
              }
              log.session.info('DaemonConnection: auto-recovered ACP session after reconnect', {
                sessionId: s.claudeSessionId,
                runtimeId: s.acpRuntimeId,
                host: this.hostKey,
                priorStatus: s.process_status,
                recoveredStatus,
              })

            } else if (result.errorKind === 'no_worker') {
              const updated = await updateSessionRecordConditionally(s.claudeSessionId, {
                process_status: 'idle',
                errorMessage: undefined,
                activity: undefined,
                pendingPermission: undefined,
                last_status_change: new Date().toISOString(),
                status_reason: 'daemon_reported_exit',
                status_changed_by: 'daemon',
              }, (current) => !current.archived
                && current.statusRevision === s.statusRevision
                && current.acpRuntimeId === s.acpRuntimeId
                && current.lastAcceptedAcpCommandId === s.lastAcceptedAcpCommandId
                && (current.process_status !== 'idle' || !!current.pendingPermission || !!current.activity))
              if (!updated) continue
              emitSessionStatusChanged(
                updated,
                {},
                ['*'],
                { source: 'daemon-reconnect', urgency: 'urgent' },
              )
              const { handBackTaskOnSessionEnd } = await import('../core/phase.js')
              await handBackTaskOnSessionEnd(updated.taskId, s.claudeSessionId, 'daemon-reconnect:acp-worker-gone', {
                shouldApply: () => {
                  const current = getSessionsForTaskSync(updated.taskId).find((record) => record.claudeSessionId === s.claudeSessionId)
                  return current?.statusRevision === updated.statusRevision
                    && current?.acpRuntimeId === updated.acpRuntimeId
                    && current?.lastAcceptedAcpCommandId === updated.lastAcceptedAcpCommandId
                },
              })
              log.session.info('DaemonConnection: ACP worker gone after reconnect', {
                sessionId: s.claudeSessionId,
                runtimeId: s.acpRuntimeId,
                host: this.hostKey,
                priorStatus: s.process_status,
              })
            } else {
              log.session.warn('DaemonConnection: ACP recovery probe inconclusive', {
                sessionId: s.claudeSessionId, host: this.hostKey, errorKind: result.errorKind, error: result.error,
              })
            }
          } catch (err) {
            log.session.debug('DaemonConnection: failed to probe ACP session during recovery', {
              sessionId: s.claudeSessionId,
              runtimeId: s.acpRuntimeId,
              host: this.hostKey,
              error: err instanceof Error ? err.message : String(err),
            })
          }
          continue
        }

        // Ask daemon if this session's process is still alive
        try {
          // ── C2 reconnect pull (contract §5): snapshot-capable daemon →
          // getState carries the authoritative snapshot; feed the projection.
          // In ENFORCE mode a successfully-routed snapshot REPLACES the manual
          // record patching below (applySnapshot is the sole writer). In
          // shadow/off the legacy patching stays authoritative (shadow never
          // writes, so skipping the patch would strand 'Connection lost'
          // records) — and non-snapshot daemons always take the legacy path
          // (version-skew fallback).
          let result: DaemonCommandResult
          let snapshotHandled = false
          if (this.supportsSnapshots) {
            const { captureSnapshotReadGuard } = await import('../core/session-snapshot-apply.js')
            const canRecoverConnection = await captureSnapshotReadGuard(s.claudeSessionId)
            result = await this.send('getState', { sid: s.claudeSessionId }) as DaemonGetStateResult
            const snapshot = (result as DaemonGetStateResult).snapshot
            if (result.ok && snapshot) {
              try {
                const { applySnapshot, getSnapshotStatusMode } = await import('../core/session-snapshot-apply.js')
                const applied = await applySnapshot(s.claudeSessionId, snapshot, 'reconnect-pull', canRecoverConnection)
                snapshotHandled = getSnapshotStatusMode() === 'enforce'
                  && applied.outcome !== 'error'
                  && applied.outcome !== 'no-record'
                  && applied.outcome !== 'excluded'
                  && applied.outcome !== 'disabled'
              } catch (err) {
                log.session.warn('DaemonConnection: reconnect snapshot apply failed — falling back to legacy recovery', {
                  sessionId: s.claudeSessionId, host: this.hostKey,
                  error: err instanceof Error ? err.message : String(err),
                })
              }
            }
          } else {
            // ── CAPABILITY DOWNGRADE (contract §5 version-skew fallback) ──
            // This host no longer speaks snapshot-v1 (daemon redeployed to an
            // older build / rolled back). Any coverage this sid earned from a
            // previous snapshot-capable daemon is now a lie: no snapshot will
            // ever arrive to correct the record, yet in enforce mode the gate
            // would keep stripping the legacy category-① writers below
            // ('daemon'/'daemon_reconnected', 'daemon'/'daemon_reported_exit'),
            // freezing the record at its last status forever. Drop coverage
            // BEFORE patching so the legacy write lands. Coverage re-arms
            // automatically on the next applySnapshot for this sid.
            try {
              const { unmarkSnapshotCovered } = await import('../core/session-snapshot-gate.js')
              unmarkSnapshotCovered(s.claudeSessionId)
            } catch { /* gate unavailable — legacy patching is the fallback anyway */ }
            result = await this.send('status', { sid: s.claudeSessionId })
          }

          if (snapshotHandled) {
            // Record convergence is the projection's job now — but the ws
            // re-subscription is still ours (the daemon dropped us from
            // session.subscribers on close).
            if (result.ok && result.alive) {
              // Transport-fact patch (no status fields → bypasses the C2 gate):
              // the projection never writes pid, and a rescued record without
              // one is re-orphaned by the health monitor's dead-pool drain.
              if (rescuedPid != null) {
                await updateSessionRecord(s.claudeSessionId, { pid: rescuedPid } as any)
                  .catch(() => {})
              }
              await this.reattachRecoveredSession(s.claudeSessionId, true)
            } else {
              // The daemon is back and says the process is GONE. The projection
              // will write 'error'/'stopped' and we must not fight it — but the
              // record alone never comes back to life, so this branch used to be
              // a dead end (the whole 3.5h stall in inc-1787439819342 lived
              // exactly here). Arm an auto-resume: it goes through the normal
              // send path, which respawns via --resume and lets the runner write
              // the status legitimately.
              await this.scheduleAutoRecoverIfDead(s.claudeSessionId)
            }
            continue
          }

          if (result.ok && result.alive) {
            // Preserve 'idle' if that's what the session was before reconnect —
            // FIFO sessions sit in 'idle' between turns and forcing 'running'
            // would lie to the UI (no turn actually in flight). A 'stopped'
            // record whose CLI turns out to be alive is the same shape: the
            // process sits between turns, so 'idle' is the honest label — the
            // stream projection flips it to 'running' if a turn really starts.
            const recoveredStatus =
              s.process_status === 'idle' || s.process_status === 'stopped' ? 'idle' : 'running'
            const updated = await updateSessionRecord(s.claudeSessionId, {
              process_status: recoveredStatus,
              errorMessage: undefined,
              activity: undefined,
              last_status_change: new Date().toISOString(),
              status_reason: 'daemon_reconnected',
              status_changed_by: 'daemon',
            } as any)
            // Separate transport-fact patch (no status fields → bypasses the C2
            // gate, which drops the WHOLE stamped patch above for covered
            // sessions): a recovered record left with pid null is re-orphaned
            // by the health monitor's dead-pool drain within 2min. The daemon's
            // `status` reply carries the authoritative pid.
            const daemonPid = typeof result.pid === 'number' ? result.pid : rescuedPid
            if (daemonPid != null && s.pid !== daemonPid) {
              await updateSessionRecord(s.claudeSessionId, { pid: daemonPid } as any)
                .catch(() => {})
            }
            emitSessionStatusChanged(
              updated,
              {},
              ['*'],
              { source: 'daemon-reconnect', urgency: 'urgent' },
            )
            log.session.info('DaemonConnection: auto-recovered session after reconnect', {
              sessionId: s.claudeSessionId, host: this.hostKey,
              priorStatus: s.process_status,
              recoveredStatus,
            })

            // Re-subscribe this new ws to the session's push stream (shared
            // helper — identical work on the snapshot branch above).
            await this.reattachRecoveredSession(s.claudeSessionId)
          } else {
            // Process died during disconnect — mark stopped so session is resumable.
            // Don't inject a message; user's next message will trigger --resume naturally.
            // For stuck-running case: emitting 'stopped' triggers server.ts
            // belt-and-suspenders → sessionStreamBuffer.markDone+clear → UI Streaming
            // badge clears. JSONL history API serves full turn content independently.
            const updated = await updateSessionRecord(s.claudeSessionId, {
              process_status: 'stopped',
              errorMessage: undefined,
              activity: undefined,
              last_status_change: new Date().toISOString(),
              status_reason: 'daemon_reported_exit',
              status_changed_by: 'daemon',
            } as any)
            emitSessionStatusChanged(
              updated,
              {},
              ['*'],
              { source: 'daemon-reconnect', urgency: 'urgent' },
            )
            log.session.info('DaemonConnection: cleared error on dead session after reconnect', {
              sessionId: s.claudeSessionId, host: this.hostKey,
              priorStatus: s.process_status,
            })
            // Same reasoning as the snapshot branch: relabelling to 'stopped'
            // makes the session resumable but nothing actually resumes it. If
            // the work was in flight and the cause was infrastructure, resume it.
            // (Classified from the PRE-relabel record `s` — the relabel above
            // deliberately clears the cause we need to read.)
            await this.scheduleAutoRecoverIfDead(s.claudeSessionId, s)
          }
        } catch (err) {
          log.session.debug('DaemonConnection: failed to probe session during recovery', {
            sessionId: s.claudeSessionId, host: this.hostKey,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      if (clippedStoppedProbes > 0) {
        log.session.warn('DaemonConnection: stopped-record rescue probes clipped this pass', {
          host: this.hostKey, probed: stoppedProbes, clipped: clippedStoppedProbes,
        })
      }
    } catch (err) {
      log.session.warn('DaemonConnection: recoverDisconnectedSessions failed', {
        host: this.hostKey,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Arm an auto-resume for a session the daemon just reported dead.
   *
   * `causeRecord` is the record as it looked BEFORE any relabel in this pass —
   * the relabel clears errorMessage/errorKind, which is exactly the evidence the
   * classifier needs. When omitted, the freshly-read record is used (the snapshot
   * branch, where the projection keeps the cause the gate handed it).
   *
   * Never throws: recovery is best-effort and must not abort the sweep over the
   * host's other sessions.
   */
  private async scheduleAutoRecoverIfDead(
    sessionId: string,
    causeRecord?: SessionRecord,
  ): Promise<void> {
    try {
      const { getSessionByClaudeId } = await import('../core/session-tracker.js')
      const fresh = await getSessionByClaudeId(sessionId)
      if (!fresh) return
      // Budget/archive/type come from the CURRENT record; the cause comes from the
      // pre-relabel one when the caller has it.
      const forClassify: SessionRecord = causeRecord
        ? {
          ...fresh,
          errorKind: causeRecord.errorKind,
          errorMessage: causeRecord.errorMessage,
          status_reason: causeRecord.status_reason,
        }
        : fresh
      const { scheduleSessionAutoRecover } = await import('../core/session-auto-recover.js')
      scheduleSessionAutoRecover(forClassify, forClassify.status_reason ?? 'daemon_reported_exit')
    } catch (err) {
      log.session.debug('DaemonConnection: auto-recover scheduling failed', {
        sessionId, host: this.hostKey,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this._missedPongs = 0
    this._pongPending = false
    this.pingTimer = setInterval(() => {
      // Staleness = 3 consecutive AWAKE intervals with no pong (~45s), counted
      // per timer tick — NOT clock-based. Clock math ("now - lastPongAt > 45s")
      // is sleep-poisoned on Apple Silicon: BOTH Date.now() and hrtime advance
      // through macOS sleep there, so every lid-close/DarkWake made a healthy
      // link look stale and tore it down into a reconnect storm (2026-08-01).
      // A counter only advances when this callback actually runs, i.e. while
      // the process is awake — sleep of any length costs at most one tick.
      // 3x instead of 2x also absorbs transient event-loop stalls at boot
      // (index rebuild, session recovery) that used to cascade into mass reattach.
      if (this._pongPending) {
        this._missedPongs += 1
        if (this._missedPongs >= 3) {
          log.session.warn('DaemonConnection: no pong received, connection stale', {
            host: this.hostKey,
            missedPongs: this._missedPongs,
            lastPongAgoMs: this.lastPongAt > 0 ? Date.now() - this.lastPongAt : null,
          })
          this.handleConnectionLost()
          return
        }
      } else {
        this._missedPongs = 0
      }
      if (this.ws?.readyState === WebSocket.OPEN) {
        this._pongPending = true
        this.ws.ping()
      }
    }, DaemonConnection.PING_INTERVAL_MS)
  }
}

// ── Pool-level status change callback ──

let onPoolStatusChange: (() => void | Promise<void>) | null = null

/**
 * Register a callback that fires whenever any DaemonConnection's
 * connected state changes.  Used by server.ts to broadcast daemon
 * status to the frontend via WebSocket. May be async — the caller
 * swallows the returned promise's rejection.
 */
export function setOnDaemonStatusChange(cb: () => void | Promise<void>): void {
  onPoolStatusChange = cb
}

// ── Pool-level reconnect callback (event-driven message redelivery) ──

let onHostConnected: ((hostKey: string, connection: DaemonConnection) => void | Promise<void>) | null = null

/**
 * Register a callback fired when a host's daemon connection transitions to
 * connected. SessionRunner uses this to redeliver queue messages that were
 * stranded in 'pending' by a delivery failure (SSH outage) — the event-driven
 * replacement for the old behavior of spin-retrying after every SESSION_ERROR.
 *
 * Single-subscriber by design: a second registration silently clobbers the
 * previous callback. Registering anything other than SessionRunner's
 * redelivery hook would strand pending messages on reconnect, reintroducing
 * the 2026-06-10 message-loss bug.
 */
export function setOnDaemonHostConnected(cb: (hostKey: string, connection: DaemonConnection) => void | Promise<void>): void {
  onHostConnected = cb
}

/**
 * ADDITIVE host-connected listeners, for observers beyond SessionRunner's
 * single-subscriber slot above (which stays reserved for message redelivery —
 * see its doc). server.ts uses this to retire `host:<alias>` error
 * notifications the moment the outage that produced them ends. Returns an
 * unsubscribe so an in-process server restart (tests) doesn't accumulate
 * listeners across boots.
 */
const hostConnectedListeners = new Set<(hostKey: string) => void>()
export function addOnDaemonHostConnected(cb: (hostKey: string) => void): () => void {
  hostConnectedListeners.add(cb)
  return () => { hostConnectedListeners.delete(cb) }
}

/**
 * ADDITIVE pool-level connect-PHASE listeners. `addOnDaemonHostConnected` only
 * fires on the happy edge; this one fires on every step (ssh → probe → install
 * → … → connected) and on the failure edge, which is what lets the browser show
 * live progress for a two-minute first connect instead of an idle spinner.
 *
 * The payload is always built by getDaemonConnectState so there is exactly ONE
 * shape (and one place where the failure cache is folded in). Returns an
 * unsubscribe: the listener set is module-global, so an in-process server
 * restart must not stack listeners across boots.
 */
const phaseListeners = new Set<(state: DaemonConnectState) => void>()
export function addOnDaemonPhaseChange(cb: (state: DaemonConnectState) => void): () => void {
  phaseListeners.add(cb)
  return () => { phaseListeners.delete(cb) }
}

/** Internal: fan a phase/failure-cache change out to the pool listeners. */
function notifyDaemonPhaseChange(hostKey: string): void {
  if (phaseListeners.size === 0) return
  let state: DaemonConnectState
  try {
    state = getDaemonConnectState(hostKey)
  } catch { return }
  for (const listener of phaseListeners) {
    // Observers must never break a connect, including via a rejected promise:
    // this fires during boot where an unhandled rejection is fatal.
    try {
      const result = listener(state) as unknown
      if (result instanceof Promise) (result as Promise<unknown>).catch(() => {})
    } catch { /* observers must never break connect */ }
  }
}

/** Internal: invoked by DaemonConnection.setConnected(true) transitions. */
function notifyHostConnected(hostKey: string, connection: DaemonConnection): void {
  // The host is provably reachable — drop any stale failure-cache entry NOW.
  // setConnected(true) fires inside connect(), BEFORE getDaemonConnection's
  // .then() clears the cache; without this, an immediate redelivery would
  // fast-fail against the stale entry.
  failureCache.delete(hostKey)
  for (const listener of hostConnectedListeners) {
    // Observers must never break connect — including via a rejected promise:
    // this fires during boot, where an unhandled rejection is fatal.
    try {
      const result = listener(hostKey) as unknown
      if (result instanceof Promise) result.catch(() => {})
    } catch { /* observers must never break connect */ }
  }
  if (!onHostConnected) return
  try {
    const result = onHostConnected(hostKey, connection)
    if (result instanceof Promise) result.catch(() => {})
  } catch { /* redelivery must never break connect */ }
}

// ── Connection Pool ──

/** Pool of DaemonConnections — one per remote host. */
const connectionPool = new Map<string, DaemonConnection>()
/** Pending connection promises — prevents concurrent connect() races. */
const connectingPromises = new Map<string, Promise<DaemonConnection>>()
/** Cache recent connection failures to avoid repeated 42s SSH timeouts. */
const failureCache = new Map<string, { time: number; error: string }>()
const FAILURE_CACHE_TTL_MS = 60_000  // 60s — longer than the worst-case SSH timeout (~42s) to avoid retrying mid-failure

/**
 * Compress a connect failure to ONE greppable line for the cached-failure error.
 *
 * The cached message is re-thrown to every caller for 60s, and every caller logs
 * it at warn. A raw ssh failure is multi-line (the full command, "Connection
 * closed by UNKNOWN port 65535", sometimes a ws stack trace), so ONE real outage
 * produced 864 near-identical multi-line warns inside a single hour on
 * 2026-08-22 — the log became unreadable exactly when it was needed. The full
 * text is still logged once, at the moment the connect actually failed.
 * Terminal colour codes are dropped (a proxy prints its errors in red).
 */
export function summarizeConnectFailure(raw: string, maxLen = 160): string {
  // eslint-disable-next-line no-control-regex
  const lines = raw.split('\n').map((l) => l.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trim()).filter(Boolean)
  // Evidence the connect gathered locally (ssh-credential-evidence.ts) is the
  // part that says WHY, so it always survives the summary. A proxy's "login
  // expired" sentence is too long to survive the clip, so it becomes a tag too.
  const evidence = lines.find((l) => l.startsWith(SSH_EVIDENCE_PREFIX))
    ?? (classifyHostConnectError(raw, '').kind === 'proxy_login' ? PROXY_LOGIN_EVIDENCE : undefined)
  const rest = lines.filter((l) => l !== evidence && !/^@+$/.test(l))
  // Prefer the line that says what went wrong over the echoed command.
  const signal = rest.find((l) => /^(ssh|Connection|Permission|Host|kex_|Timeout|error:|Error:|Could not|shell_noise|Port forwarding|@\s+WARNING)/i.test(l)
    && !l.startsWith('Command failed:'))
    ?? rest.find((l) => !l.startsWith('Command failed:') && !l.includes(' -o '))
    ?? rest[0] ?? evidence ?? raw
  const clip = (text: string, len: number) => (text.length > len ? `${text.slice(0, Math.max(0, len - 1))}…` : text)
  const oneLine = signal.replace(/\s+/g, ' ')
  if (!evidence || signal === evidence) return clip(oneLine, maxLen)
  const tail = ` [${evidence.replace(/\s+/g, ' ')}]`
  return clip(oneLine, Math.max(20, maxLen - tail.length)) + clip(tail, maxLen)
}

/**
 * Hot-push the daemon-hook rules to every currently connected daemon.
 * Call after ~/.open-walnut/hooks/*.yaml or the cron_policy config changes —
 * a hook edit takes effect without a daemon restart. Fire-and-forget per
 * host; each push is hash-skipped daemon-side when nothing changed.
 */
export function pushDaemonHooksToAllHosts(): void {
  for (const conn of connectionPool.values()) {
    if (conn.connected) conn.pushDaemonHooks()
  }
}

/**
 * Re-arm ONE host's trigger set. Called after every routine mutation that
 * touches a check job (and after an auto-disable). Fire-and-forget and
 * hash-skipped; a cold host simply keeps polling its persisted set until it
 * reconnects, which is the behaviour the daemon's own persistence exists for.
 */
export function pushTriggersToHost(hostKey: string): void {
  getConnectedDaemonConnection(hostKey)?.pushTriggers()
}

/** Re-push every connected host's read copy (host-slice.ts debounces the callers). */
export function pushHostSliceToAllHosts(): void {
  for (const conn of connectionPool.values()) {
    if (conn.connected) conn.pushHostSlice()
  }
}

/** Re-arm every connected host — the connect-time and boot-time sweep. */
export function pushTriggersToAllHosts(): void {
  for (const conn of connectionPool.values()) {
    if (conn.connected) conn.pushTriggers()
  }
}

/**
 * Get or create a DaemonConnection for a remote host.
 * Returns a connected connection ready for commands.
 * Thread-safe: concurrent callers share the same connect() promise.
 *
 * Caches connection failures for 60s to avoid blocking the event loop
 * with repeated SSH timeout attempts when a host is unreachable.
 */
export async function getDaemonConnection(hostKey: string, sshTarget: SshTarget): Promise<DaemonConnection> {
  // Fast path: already connected
  const existing = connectionPool.get(hostKey)
  if (existing?.connected) return existing

  // The reconnect loop owns this instance (dialling, or waiting out its backoff):
  // join it through reconnectNow. A second connect() on the same instance would
  // race the reconnect's tunnel and ControlMaster (C12, C12b).
  if (existing && existing.targetsSame(sshTarget) && (existing.reconnectInFlight || existing.reconnectPending)) {
    // A standing cause (auth, host key, dns, credential) waits on purpose, so an
    // automatic caller fails fast with it; only a human's Connect now (reconnectHostNow) expedites it.
    const cause = existing.reconnectInFlight ? undefined : getReconnectCause(hostKey)
    if (cause?.standing) {
      throw new Error(`Connection to ${hostKey} failed ${Math.round((Date.now() - cause.at) / 1000)}s ago: ${cause.summary}`)
    }
    return existing.reconnectNow().then(() => {
      if (!existing.connected) throw new Error(`Connection to ${hostKey} is still reconnecting`)
      return existing
    })
  }

  // Check failure cache — avoid retrying a recently-failed host
  const cached = failureCache.get(hostKey)
  if (cached && Date.now() - cached.time < FAILURE_CACHE_TTL_MS) {
    // One line, not the whole ssh transcript — see summarizeConnectFailure.
    throw new Error(`Connection to ${hostKey} failed ${Math.round((Date.now() - cached.time) / 1000)}s ago: ${cached.error}`)
  }

  // Dedup: if another caller is already connecting, wait for their result
  const pending = connectingPromises.get(hostKey)
  if (pending) return pending

  // Create and connect
  let conn = connectionPool.get(hostKey)
  if (conn && !conn.connected && !conn.targetsSame(sshTarget)) {
    // The config now names a different machine for this alias (the user edited
    // the hostname; the startup warmup may even have dialled a half-typed one).
    // A pooled connection keeps its target for life, so without this every later
    // connect for the alias would ssh the OLD name until the server restarted.
    // Only while nothing is live: a connected pool entry stays until it drops.
    log.session.info('DaemonConnection: ssh target changed, replacing the pooled connection', { host: hostKey })
    conn.disconnect()
    connectionPool.delete(hostKey)
    conn = undefined
  }
  if (!conn) {
    conn = new DaemonConnection(hostKey, sshTarget)
    connectionPool.set(hostKey, conn)
  }

  const promise = conn.connect().then(() => {
    connectingPromises.delete(hostKey)
    failureCache.delete(hostKey)  // Clear failure cache on success
    return conn!
  }).catch((err) => {
    connectingPromises.delete(hostKey)
    // Cache the failure so subsequent requests fail fast. Store the SUMMARY: this
    // string is re-thrown to (and logged by) every caller for the next 60s.
    const raw = err instanceof Error ? err.message : String(err)
    failureCache.set(hostKey, { time: Date.now(), error: summarizeConnectFailure(raw) })
    // AFTER the cache write, so listeners read phase:'failed' with error/retryInMs
    // already populated (getDaemonConnectState folds the cache in).
    notifyDaemonPhaseChange(hostKey)
    // The full text, once, where it actually happened.
    log.session.warn('DaemonConnection: connect failed (full error logged once, summary cached)', {
      host: hostKey, error: raw,
    })
    throw err
  })

  connectingPromises.set(hostKey, promise)
  return promise
}

/**
 * Pooled variant of connectDirect() — ONE shared connection per WebSocket URL.
 *
 * Before this existed, every local session's RemoteSessionManager did a private
 * `new DaemonConnection(...).connectDirect(wsUrl)`, bypassing the pool. Those
 * instances were never destroyed (kill()/cleanup() deliberately leave the conn
 * alone, assuming it's shared) — so a server that had started 100+ local
 * sessions held 100+ live connections, each with its own ping timer and its own
 * permanent exponential-backoff reconnect loop. One local-daemon restart then
 * produced 100+ simultaneous reconnects (the observed reconnect storm) and the
 * daemon carried 100+ useless WS clients.
 *
 * Pool key is the wsUrl (`direct:<wsUrl>`), not the hostKey: tests spin up
 * per-test MockDaemons on distinct ports and must not share connections.
 *
 * Rollback: WALNUT_LOCAL_CONN_POOL=0 restores the private-connection behavior
 * at the call site (remote-session-manager.ts).
 */
export async function getDirectDaemonConnection(hostKey: string, wsUrl: string): Promise<DaemonConnection> {
  const poolKey = `direct:${wsUrl}`
  const existing = connectionPool.get(poolKey)
  if (existing?.connected) return existing

  const pending = connectingPromises.get(poolKey)
  if (pending) return pending

  let conn = connectionPool.get(poolKey)
  if (!conn) {
    conn = new DaemonConnection(hostKey, null)
    connectionPool.set(poolKey, conn)
  }

  const promise = conn.connectDirect(wsUrl).then(() => {
    connectingPromises.delete(poolKey)
    return conn!
  }).catch((err) => {
    connectingPromises.delete(poolKey)
    throw err
  })

  connectingPromises.set(poolKey, promise)
  return promise
}

/**
 * True when this instance is (still) the pooled connection for some key.
 * Auto-reconnect is a pool-instance privilege — see scheduleReconnect.
 */
export function isPooledConnection(conn: DaemonConnection): boolean {
  for (const pooled of connectionPool.values()) {
    if (pooled === conn) return true
  }
  return false
}

/**
 * Forget a cached connection failure so the next getDaemonConnection() retries
 * immediately instead of fast-failing for up to 60s. Call this on a user-initiated
 * retry (e.g. after they run mwinit) — the 60s cache is meant to throttle automatic
 * reconnects, not to block a deliberate human retry.
 */
export function clearDaemonFailureCache(hostKey?: string): void {
  // Whose state just changed — captured before the delete, since after it the
  // cache can no longer tell us which hosts were showing as failed.
  const affected = hostKey ? [hostKey] : [...failureCache.keys()]
  if (hostKey) failureCache.delete(hostKey)
  else failureCache.clear()
  // A cleared failure IS a status change (the UI must stop saying "failed,
  // retry in 42s" the moment the human hit retry). The connection's own phase
  // goes with it: 'failed' minus its cause would read as a fresh, unexplained
  // failure on every surface.
  for (const host of affected) {
    connectionPool.get(host)?.resetFailedPhase()
    notifyDaemonPhaseChange(host)
  }
}

/**
 * A human asked to connect now: drop the pending reconnect backoff so the next
 * getDaemonConnection dials at once (C11). True when a timer was cancelled.
 */
export function cancelReconnectBackoff(hostKey: string): boolean {
  return connectionPool.get(hostKey)?.cancelReconnectTimer() ?? false
}

/**
 * A human's Connect now for a host whose reconnect loop owns it (waiting on its
 * backoff or dialling): the loop's attempt runs now and the loop survives a
 * failure. null = no loop to join (dial with getDaemonConnection instead).
 */
export function reconnectHostNow(hostKey: string, sshTarget?: SshTarget | null): Promise<void> | null {
  const conn = connectionPool.get(hostKey)
  if (!conn || conn.connected || conn.connecting) return null
  if (!conn.reconnectPending && !conn.reconnectInFlight) return null
  // A changed hostname is a new machine: getDaemonConnection replaces the pooled connection.
  if (sshTarget !== undefined && !conn.targetsSame(sshTarget)) return null
  return conn.reconnectNow()
}

/** A wake or network change: run a pending reconnect of this host now. True when one was pending. */
export function expediteReconnect(hostKey: string): boolean {
  return connectionPool.get(hostKey)?.expediteReconnect() ?? false
}

/** Test seam ONLY (@internal): pool a connection built without dialling, or drop it (null). */
export function setPooledConnectionForTest(hostKey: string, conn: DaemonConnection | null): void {
  if (conn) connectionPool.set(hostKey, conn)
  else connectionPool.delete(hostKey)
}

/** Hosts whose reconnect loop is waiting on a timer or dialling right now. */
export function reconnectingHosts(): string[] {
  const out: string[] = []
  for (const [key, conn] of connectionPool) {
    if (!key.startsWith('direct:') && !conn.connected && (conn.reconnectPending || conn.reconnectInFlight)) out.push(key)
  }
  return out
}

/**
 * Hosts whose reconnect loop sits on its timer after a credential failure
 * (expired certificate, missing agent), with when that attempt failed. A loop
 * dialling right now is left out: that attempt already sees any new login.
 */
export function credentialWaitingHosts(): Array<{ host: string; failedAt: number }> {
  const out: Array<{ host: string; failedAt: number }> = []
  for (const [key, conn] of connectionPool) {
    if (key.startsWith('direct:') || conn.connected || !conn.reconnectPending || conn.reconnectInFlight) continue
    const cause = getReconnectCause(key)
    if (cause && isCredentialWaitKind(cause.kind)) out.push({ host: key, failedAt: cause.at })
  }
  return out
}

/**
 * Disconnect all daemon connections. Called on server shutdown.
 */
export function disconnectAllDaemons(): void {
  for (const [key, conn] of connectionPool) {
    conn.disconnect()
  }
  connectionPool.clear()
}

/** Status of a single daemon connection. */
export interface DaemonStatus {
  host: string
  connected: boolean
  /** Cloud-bridge liveness reported by the daemon (null = unknown / bridge not configured). */
  bridgeConnected: boolean | null
  /** Which connect() step the host is in; see DaemonConnectPhase. */
  phase: DaemonConnectPhase
}

/**
 * Snapshot of where a host's connection stands, for callers that need to tell
 * the user WHY there is no answer yet rather than just that there is none.
 * `error` and `retryInMs` come from the failure cache: a failed connect is
 * fast-failed for FAILURE_CACHE_TTL_MS, so "why" and "when it will try again"
 * are both known here.
 */
export interface DaemonConnectState {
  host: string
  connected: boolean
  phase: DaemonConnectPhase
  /** How long the current phase has been running (ms). */
  phaseElapsedMs: number
  /** How long the whole connect attempt has been running (ms; 0 = unknown). */
  connectElapsedMs: number
  /** One-line summary of the last connect failure, while it is still cached. */
  error?: string
  /** ms until the failure cache expires and an automatic retry is allowed. */
  retryInMs?: number
  /** The failure's kind when the connection knows it better than its summary (a reconnect's standing cause). */
  kind?: string
  /** Epoch ms of the next attempt really scheduled (a standing reconnect's slow probe or credential re-dial). */
  retryAt?: number
  /** The reconnect loop's last failure, while the phase is still 'reconnecting'. */
  lastError?: string
  lastKind?: string
  /** When the host dropped (the current reconnect began). */
  reconnectSince?: number
  /** When the current connect attempt began (epoch ms). */
  attemptStartedAt?: number
  /** When the current connection came up (epoch ms). */
  connectedAt?: number
  /** Which runtime the host's daemon ended up on (after any fallback). */
  runtime?: RemoteRuntime | 'unknown'
  /** Where the daemon keeps its files there, once a probe decided. */
  daemonDir?: DaemonDirChoice & { home?: string }
}

export function getDaemonConnectState(hostKey: string): DaemonConnectState {
  const conn = connectionPool.get(hostKey)
  const now = Date.now()
  const state: DaemonConnectState = {
    host: hostKey,
    connected: conn?.connected ?? false,
    phase: conn?.connectPhase ?? 'idle',
    phaseElapsedMs: conn ? Math.max(0, now - conn.connectPhaseSince) : 0,
    connectElapsedMs: conn?.connectStartedAt ? Math.max(0, now - conn.connectStartedAt) : 0,
  }
  if (conn?.remoteRuntime) state.runtime = conn.remoteRuntime
  const dir = conn?.remoteDirChoice
  if (dir) state.daemonDir = { ...dir, ...(conn?.remoteHome ? { home: conn.remoteHome } : {}) }
  const failure = failureCache.get(hostKey)
  if (failure && now - failure.time < FAILURE_CACHE_TTL_MS) {
    state.phase = 'failed'
    state.error = failure.error
    state.retryInMs = Math.max(0, FAILURE_CACHE_TTL_MS - (now - failure.time))
  } else if (failure && state.phase === 'failed') {
    // The throttle expired but nothing has tried since: the cause is still the
    // only true thing to say about this host (no retry clock — a retry is
    // allowed right now).
    state.error = failure.error
  }
  foldReconnectCause(state, conn, failure)
  return state
}

/** The reconnect loop's cause (daemon-reconnect-cause.ts) and the attempt clocks. */
function foldReconnectCause(state: DaemonConnectState, conn: DaemonConnection | undefined, failure?: { time: number }): void {
  if (conn?.connectStartedAt && !state.connected) state.attemptStartedAt = conn.connectStartedAt
  if (conn?.connected && state.phase === 'connected') state.connectedAt = conn.connectPhaseSince
  if (state.phase === 'reconnecting' && conn?.disconnectedSince) state.reconnectSince = conn.disconnectedSince
  const cause = getReconnectCause(state.host)
  if (!cause || state.connected) return
  if (state.phase === 'reconnecting') {
    state.lastError = cause.summary
    state.lastKind = cause.kind
    state.reconnectSince = cause.since
  } else if (state.phase === 'failed' && cause.standing) {
    // A first-connect failure NEWER than the loop's own explains the frame
    // better. A cache entry is never evicted, so gating on its mere presence hid
    // the loop's cause (and retryAt) for good after one connect() failure.
    if (!failure || failure.time <= cause.at) {
      state.error = cause.summary
      state.kind = cause.kind
      state.reconnectSince = cause.since
    }
    // retryAt is the loop's armed timer, true whichever text explains the failure.
    if (cause.retryAt && conn?.reconnectPending) state.retryAt = cause.retryAt
  }
}

/**
 * Get status of all daemon connections.
 * Used by the health notification panel to show remote host connectivity.
 */
/**
 * Check if a daemon connection for the given host is alive.
 * Used by the unified session liveness check.
 */
export function isDaemonConnected(hostKey: string): boolean {
  // Same direct-pool fallback as getConnectedDaemonConnection: the LOCAL
  // daemon's pooled connection is keyed `direct:<wsUrl>`, not '__local__', so a
  // bare map lookup answered "disconnected" for every '__local__' query and
  // silently excluded local sessions from callers' recovery/liveness logic.
  return getConnectedDaemonConnection(hostKey) !== null
}

export function getDaemonDisconnectedSince(hostKey: string): number | null {
  return connectionPool.get(hostKey)?.disconnectedSince ?? null
}

/**
 * The POOLED, CONNECTED connection for a host — never dials. Used by the
 * mobile events push (events-v1): a fire-and-forget event forward must not
 * pay SSH connect costs; when the pool is cold the event is simply dropped
 * (the phone's snapshot frame covers the gap on its next connect).
 */
export function getConnectedDaemonConnection(hostKey: string): DaemonConnection | null {
  const conn = connectionPool.get(hostKey)
  if (conn?.connected) return conn
  // Direct-pool entries are keyed `direct:<wsUrl>` (the local daemon usually
  // lives there) — same fallback scan as getPooledSnapshotConnection.
  for (const [key, pooled] of connectionPool) {
    if (!key.startsWith('direct:')) continue
    if (pooled.connected && pooled.host === hostKey) return pooled
  }
  return null
}

/**
 * C2 pull channel (contract §5): the POOLED, CONNECTED connection for a host,
 * but only when its daemon advertises 'snapshot-v1'. NEVER dials — a health
 * tick must not pay SSH connect costs; hosts without a live pooled connection
 * simply skip the pull until something else warms the pool.
 * Host is normalized like session records store it (null/undefined = local).
 */
export function getPooledSnapshotConnection(host: string | null | undefined): DaemonConnection | null {
  const hostKey = host ?? '__local__'
  // Direct-pool entries are keyed `direct:<wsUrl>`; the local host's tunnel
  // pool entry is keyed '__local__'. Check the hostKey entry first, then fall
  // back to scanning for a direct entry whose hostKey matches (local daemon).
  const conn = connectionPool.get(hostKey)
  if (conn?.connected && conn.supportsSnapshots) return conn
  for (const [key, pooled] of connectionPool) {
    if (!key.startsWith('direct:')) continue
    if (pooled.connected && pooled.supportsSnapshots && pooled.host === hostKey) return pooled
  }
  return null
}

export function getDaemonPoolStatus(): DaemonStatus[] {
  const result: DaemonStatus[] = []
  for (const [host, conn] of connectionPool) {
    result.push({ host, connected: conn.connected, bridgeConnected: conn.lastBridgeConnected, phase: conn.connectPhase })
  }
  return result
}

/**
 * Probe a remote daemon to check if a session's process is still alive.
 * Returns { alive: true/false } if daemon is reachable, null if not connected.
 * Used by session-health-monitor to auto-recover connection-lost sessions.
 */
export async function probeDaemonSession(
  hostKey: string,
  sessionId: string,
): Promise<{ alive: boolean; pid?: number } | null> {
  // Direct-pool fallback (see isDaemonConnected): '__local__' lives under a
  // `direct:<wsUrl>` key, so a bare map lookup could never probe local sessions.
  const conn = getConnectedDaemonConnection(hostKey)
  if (!conn) return null
  try {
    const result = await conn.send('status', { sid: sessionId })
    // result.ok = daemon recognized the session; result.alive = OS process is still running. Both required.
    return {
      alive: !!(result.ok && result.alive),
      ...(typeof result.pid === 'number' ? { pid: result.pid } : {}),
    }
  } catch (err) {
    log.session.debug('probeDaemonSession: status probe failed', {
      hostKey, sessionId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Read the argv a session's LIVE claude process was launched with, from the
 * daemon's registry (host-local truth). Returns null when the daemon is not
 * connected, the session is unknown or dead, or the daemon predates the
 * `includeArgs` flag (its status reply then simply has no `args`).
 */
export async function probeDaemonSessionArgs(
  hostKey: string,
  sessionId: string,
  deadlineMs = 2000,
): Promise<string[] | null> {
  const conn = getConnectedDaemonConnection(hostKey)
  if (!conn) return null
  try {
    const result = await Promise.race([
      conn.send('status', { sid: sessionId, includeArgs: true }),
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error(`status probe exceeded ${deadlineMs}ms`)), deadlineMs,
      ).unref?.()),
    ])
    if (!result.ok || !result.alive || !Array.isArray(result.args)) return null
    return (result.args as unknown[]).filter((a): a is string => typeof a === 'string')
  } catch (err) {
    log.session.debug('probeDaemonSessionArgs: status probe failed', {
      hostKey, sessionId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
