/**
 * Local Daemon — manages a daemon process on the local machine.
 *
 * The local daemon is the same binary (walnut-daemon) that runs on remote
 * Linux hosts, compiled for the current platform and architecture. It provides
 * unified session management: spawn, FIFO, JSONL tailing, permission policy —
 * same as remote.
 *
 * Lifecycle:
 *   1. Walnut startup: ensureRunning() checks /tmp/open-walnut/daemon.port
 *   2. If daemon is alive AND version matches binary: reuse it
 *   3. If version mismatches: SIGTERM the old daemon (session survive? they
 *      get killed — local CLIs are children of the daemon process group, but
 *      next request will respawn and users can re-send)
 *   4. Spawn the binary with --start, wait for port file
 *   5. Connect via ws://localhost:<port> (no SSH tunnel)
 *
 * Version auto-refresh: on every Walnut startup we compare the daemon's
 * reported version (via 'hello' command) against the binary's .version
 * sidecar. If they differ, the running daemon is stale and gets restarted
 * so bug fixes ship immediately without manual intervention.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { WebSocket } from '#ws'
import { log } from '../logging/index.js'
import { acpUpgradeHolds } from './acp-upgrade-hold.js'
import { execRunsReason, execRunsWait, runningJobs } from './exec-runs-hold.js'
import { daemonUpdateOverdue } from './daemon-update-behind.js'
import { fenceDaemonFileChanges } from './daemon-file-fence.js'
import { OVER_BUSY_FLAG } from './daemon-over-busy.js'
import { DAEMON_BINARIES_DIR, WALNUT_HOME } from '../constants.js'
import { parseServes, sharedDaemonVerdict, walnutKeyOf, REPLACE_BREAKER_MS, type DaemonServes } from './daemon-shared.js'
import { daemonServiceConfigFiles, serviceConfigGovernsDir } from './daemon-service-config.js'
import { resolveClaudeCliExecutable } from '../core/claude-cli-detect.js'
import { testRunnerClaude } from '../core/test-claude-guard.js'
import {
  DAEMON_OWNER_FILE,
  classifyAdoptedDaemonOwner,
  currentProdClaimPosture,
  ownerAuditKey,
  prodDaemonClaimRefusal,
  type DaemonOwnerStamp,
} from './daemon-ownership.js'
import { getDaemonSource, resolveDaemonSourceVersion } from './daemon-source.js'
import { resolveSessionHostLaunch } from './session-host.js'
import { classifySessionHostStart } from './session-host-core.js'
import { QOS_CLAMP_ENV, withUtilityQosClamp } from '../lib/background-qos.js'
import { isHostReplica } from '../core/server-role.js'
import { registryNeedsFoldPrewarm, runFoldPrewarm } from './fold-prewarm.js'
import { execFileReplaced, singleFile } from '../lib/single-file.js'
import { isProductionDaemonDir, localDaemonDirChoice, localProductionDaemonDir } from '../lib/daemon-dir.js'
import { clearDaemonSwap, expectDaemonSwap } from './daemon-drain-resend.js'
import { daemonLaunch, discardPending, keepPendingBinary, keepPreviousSource, keepRunningBinary, keptPrevious, previousDaemon, promotePending, ReplacementGate, trialDaemon } from './local-daemon-replace.js'
import { STAY_MS, StayWatch } from './local-daemon-stay.js'
import { provenBuilds, stayWatches } from './daemon-update-store.js'
import { backoffLeftMs, buildBackedOff, readBuildBackoff, writeBuildBackoff, type BuildBackoffEntry } from './daemon-build-backoff.js'

/** True only when the config says nothing runs on Claude Code (core/agents/claude-code-needed.ts); a read that fails says it may. */
/**
 * Why the daemon's environment has no claude: `null` when it has one; 'not-installed' when this
 * server cannot find one either (nothing installed yet, which Home's setup handles); 'env' when
 * the server finds one the daemon's environment would not (the 2026-08-28 outage: every session
 * then exits 127).
 */
export function claudeMissingAtSpawn(daemonResolves: boolean, serverResolves: () => boolean): null | 'not-installed' | 'env' {
  if (daemonResolves) return null
  return serverResolves() ? 'env' : 'not-installed'
}

async function claudeCodeNotNeeded(): Promise<boolean> {
  try {
    const { getConfig } = await import('../core/config-manager.js')
    const { claudeCodeNeeded } = await import('../core/agents/claude-code-needed.js')
    return !claudeCodeNeeded(await getConfig(), false)
  } catch {
    return false
  }
}

// Env-aware default so the singleton (exported below) isolates a demo server's
// daemon when WALNUT_DAEMON_DIR is set. Tests pass `daemonDir` explicitly and are
// unaffected. Production sets nothing → /tmp/open-walnut, or ~/.cache/open-walnut
// when another user on this machine owns that one (src/lib/daemon-dir.ts).
const DEFAULT_DAEMON_DIR = localDaemonDirChoice().dir

/** Patience for a daemon whose pid is alive but whose first hello timed out. */
const BUSY_DAEMON_HELLO_MS = 15_000
/** The longer wait for a port file while the Walnut Sessions host is still running (classifySessionHostStart). */
const SESSION_HOST_LATE_START_MS = 20_000

/** True when `binaryPath` is the compiled Walnut file this process runs from. */
function isCompiledSelf(binaryPath: string): boolean {
  return singleFile() !== null && binaryPath === process.execPath
}

export function getLocalDaemonBinaryName(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  return `daemon-${platform}-${arch}`
}

/**
 * First existing candidate for THIS host's daemon binary, or null when none of
 * the directories has it (the caller then falls back to the Node source daemon).
 *
 * Exact-name match only, on purpose: a Linux host must never execute the darwin
 * binary sitting next to it. That was the shape of issue #11 — the name was
 * hardcoded to daemon-darwin-arm64, so a Linux x64 box spawned a Mach-O file,
 * no port file ever appeared, and every local session failed after the 10s
 * timeout. "No binary" is a working degraded path (source fallback under node);
 * "the wrong binary" is a dead end with a confusing error.
 */
export function pickDaemonBinary(
  dirs: string[],
  binaryName: string,
  exists: (p: string) => boolean = fs.existsSync,
): string | null {
  for (const dir of dirs) {
    const candidate = path.join(dir, binaryName)
    if (exists(candidate)) return candidate
  }
  return null
}

/**
 * Parent-liveness contract for spawned daemons.
 *
 * An ISOLATED-dir daemon (Playwright test-server, sandbox, ephemeral demo)
 * serves exactly one walnut process; once that process dies the daemon is
 * garbage — but it is spawned detached, so nothing reaps it if the spawner
 * is SIGKILLed or crashes. 300+ such orphans piled up over two weeks of test
 * runs and starved the whole machine (2026-07-23 prod slow-load incident).
 * Passing our pid lets the daemon's own watchdog self-exit when we're gone.
 *
 * The PRODUCTION daemon (/tmp/open-walnut) must NEVER get this: surviving
 * server restarts is its whole point (CLI sessions live across deploys).
 */
export function parentWatchdogEnv(daemonDir: string): { WALNUT_DAEMON_PARENT_PID?: string } {
  if (isProductionDaemonDir(daemonDir)) return {}
  return { WALNUT_DAEMON_PARENT_PID: String(process.pid) }
}

// ── OS-service takeover (shared with DaemonConnection) ──
//
// Once the daemon runs under launchd/systemd, the OS manager owns its lifecycle:
// starting, restarting after a crash, and (via `walnut daemon install`) which
// artifact it executes. Walnut must then keep its hands off — an on-demand
// `nohup`/spawn while a service is installed squats the runtime dir, after which
// EVERY managed start refuses with "service handover is required" (the daemon's
// own instance lock), so launchd retries that failure forever (KeepAlive +
// ThrottleInterval 5) and systemd gives up after StartLimitBurst — either way
// cron supervision is gone. Killing the managed process is the same bug from the
// other side: the manager restarts it right back, racing our replacement.
//
// Two deliberate rules encoded below:
//   1. A SURVIVING CONFIG counts, not "is the service enabled/active". A
//      disabled unit still belongs to the OS manager, and Walnut must never
//      enable, disable, or edit it to make its own life easier.
//   2. "Could not tell" is NOT "not installed". A permission/IO failure reading
//      a config path resolves to managed, because the cost of guessing wrong is
//      an unmanaged second daemon (or a killed managed one), while the cost of
//      being conservative is one clear error telling the user which service
//      command to run.

/** Persistent service configs an install may have left on THIS platform. */
export function daemonServiceConfigPaths(
  platform: string = process.platform,
  home: string = os.homedir(),
): string[] {
  return daemonServiceConfigFiles(platform, home)
}

function serviceAccount(): { name: string | null; uid: number | null } {
  let name: string | null = null
  try { name = os.userInfo().username } catch { /* no passwd entry */ }
  return { name, uid: typeof process.getuid === 'function' ? process.getuid() : null }
}

/** How soon a local upgrade deferred for open ACP turns is tried again. */
export const LOCAL_UPGRADE_RECHECK_MS = 60_000
/** How long after a managed update of this Mac's daemon the same build is not tried again. */
export const LOCAL_MANAGED_UPDATE_COOLDOWN_MS = 600_000
/** The source daemon's sidecar bundles, copied next to its script (materializeSourceDaemon). */
const SOURCE_SIDECARS = ['changes-core.cjs', 'usage-core.cjs', 'path-resolve-core.cjs', 'port-scan-core.cjs', 'task-dir-core.cjs', 'host-exec-core.cjs', 'host-reach-core.cjs', 'net-core.cjs', 'secrets-core.cjs', 'transcript-rewind-core.cjs', 'history-ready-core.cjs', 'trigger-check-core.cjs', 'daemon-cron-runtime.cjs', 'daemon-instance-lock.cjs', 'daemon-service-cli.cjs', 'acp-daemon-core.cjs']
/** How often at most this server loads a service that runs nothing (reviveManagedService). */
export const REVIVE_EVERY_MS = 60_000

export type ServiceProbeState = 'present' | 'absent' | 'unknown'
export interface ServiceTakeoverProbe { path: string; state: ServiceProbeState }
export interface ServiceTakeover {
  /** OS manager owns this daemon → no unmanaged spawn, stop, or redeploy. */
  managed: boolean
  /** Configs/markers positively seen. */
  present: string[]
  /** Paths we could not classify — counted as managed, never as absent. */
  unknown: string[]
}

export function classifyServiceTakeover(probes: ServiceTakeoverProbe[]): ServiceTakeover {
  const present = probes.filter((p) => p.state === 'present').map((p) => p.path)
  const unknown = probes.filter((p) => p.state === 'unknown').map((p) => p.path)
  return { managed: present.length > 0 || unknown.length > 0, present, unknown }
}

/** Classify one config path without ever reporting a failure as "absent". */
export function classifyServiceConfigError(err: unknown): ServiceProbeState {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unknown'
}

export function serviceTakeoverInstruction(): string {
  return 'Use the service instead: `walnut daemon status`, `walnut daemon restart --yes`, '
    + 'or `walnut daemon update --yes --executable <daemon binary>` to move it to a new build. '
    + 'Automatic updates preserve enabled and stopped choices and never start an unmanaged replacement.'
}

export function serviceTakeoverEvidence(takeover: ServiceTakeover): string {
  const parts: string[] = []
  if (takeover.present.length) parts.push(`service config present: ${takeover.present.join(', ')}`)
  if (takeover.unknown.length) parts.push(`service state unverifiable: ${takeover.unknown.join(', ')}`)
  return parts.join('; ') || 'no evidence'
}

export function localServiceTakeoverMessage(action: 'spawn' | 'stop', takeover: ServiceTakeover): string {
  const what = action === 'spawn'
    ? 'refusing to start a second, unmanaged local daemon'
    : 'refusing to stop the OS-managed local daemon'
  return `local session daemon is owned by an OS service manager (${serviceTakeoverEvidence(takeover)}) — `
    + `${what}. ${serviceTakeoverInstruction()}`
}

// ESM-safe __dirname equivalent
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export interface LocalDaemonOptions {
  /** Override daemon dir (default: /tmp/open-walnut). Tests use this for isolation. */
  daemonDir?: string
  /** Override binary path (default: autodetected). Tests use this with a mock script. */
  binaryPath?: string
  /** Override the wait for a live-but-slow daemon's hello (default 15s). */
  busyHelloMs?: number
  /**
   * Outlive this server even from an isolated dir: no parent watchdog. The
   * cloud companion's tunnel daemon (providers/cloud-tunnel-daemon.ts) owns
   * another server's sessions, so the replica process exiting must not end them.
   */
  persistent?: boolean
  /** Applied last to the spawn env (undefined deletes a key). */
  envOverrides?: Record<string, string | undefined>
  /**
   * Only this server ever puts a build on this daemon, and the Walnut it serves reaches it
   * through this server (the companion's tunnel daemon: the Mac's pushes arrive with the
   * Mac's home). Its record then names another Walnut than this server's, which is no reason
   * to keep an old build: a server on a new build always replaces it (daemon-shared.ts).
   */
  soleManager?: boolean
}

export class LocalDaemon {
  private _port: number | null = null
  private _wsUrl: string | null = null
  private _spawnedPid: number | null = null
  /** PID of the Walnut Sessions host supervising the daemon, when one is in use.
   *  Kept SEPARATE from the daemon's pid: the host is the process macOS attributes
   *  file access to, and the daemon is the process everything else talks to. */
  private _sessionHostPid: number | null = null
  /** Bundle whose identity the running daemon inherited, for reporting. */
  private _sessionHostApp: string | null = null
  private _instanceId: string | null = null
  private _ensureInFlight: Promise<number> | null = null
  private _lastManagedUpdate: { expected: string; at: number } | null = null
  /**
   * A build whose managed update stopped the old daemon and then did not stay serving (the
   * CLI's own check, or the tail): not tried again for a day (daemon-build-backoff.ts, kept
   * across restarts; undefined until read). 2026-11-04 review: it was tried every 10 minutes,
   * each time a stop and a put-back of the daemon.
   */
  private _managedFail: BuildBackoffEntry | null | undefined = undefined
  /** When this server last loaded a service that ran nothing (reviveManagedService). Wall clock, in memory: a restart may revive at once. */
  private _lastRevive: number | null = null
  /** Whether a new build may replace the running daemon: its trial, and its refusals (refuseReplacement). */
  private readonly _gate = new ReplacementGate(Date.now, {
    read: () => readBuildBackoff(`local:${this.daemonDir}`),
    write: (entry) => writeBuildBackoff(`local:${this.daemonDir}`, entry),
  })
  /** stopIfIsolated ran: nothing started after it on a trial's end. */
  private _stoppedByOwner = false
  /**
   * The daemon started to replace another one, until it stayed serving (its probation,
   * local-daemon-replace.ts): looked at while it runs, and kept on disk, so a server restarted
   * inside it (a deploy) still judges it (2026-11-04 review 5: it lived in this object only).
   */
  /** The daemon file the last start check found (the probation's end keeps it as the way back). */
  private _binaryPath: string | null = null
  private readonly _stay = new StayWatch(STAY_MS, Date.now, {
    alive: (pid) => this.isPidAlive(pid),
    store: { read: () => stayWatches.read(`local:${this.daemonDir}`), write: (entry) => stayWatches.write(`local:${this.daemonDir}`, entry) },
    proven: { read: () => provenBuilds.read(`local:${this.daemonDir}`), write: (entry) => provenBuilds.write(`local:${this.daemonDir}`, entry) },
  })
  /**
   * The build whose probation just failed here (settleStay refused it), until a daemon runs again:
   * the next start with no daemon running is the kept build before it, never the build on disk
   * (2026-11-05 review 6: a newer build deployed inside the window was started instead, untried).
   * Undefined until this server saw a daemon run or settled a watch: then the gate's refusal on
   * disk says it (2026-11-05 review 7: a deploy restart between the refusal and the start forgot it).
   */
  private _backDue: string | null | undefined = undefined
  /** claude CLI resolvable in the env handed to the daemon we spawned (owner stamp). */
  private _spawnClaudeCli: string | null = null
  /** Last ownership verdict logged, so an audit that holds for the whole process
   *  is stated once instead of on every ensureRunning() (13 lines in a minute on
   *  the first deploy: session send, reconnect and startup all call it). */
  private _lastOwnerAudit: string | null = null
  private readonly daemonDir: string
  private readonly portFile: string
  private readonly pidFile: string
  private readonly instanceIdFile: string
  private readonly ownerFile: string
  private readonly overrideBinaryPath: string | undefined
  private readonly busyHelloMs: number
  private readonly persistent: boolean
  private readonly envOverrides: Record<string, string | undefined>
  private readonly soleManager: boolean

  constructor(opts: LocalDaemonOptions = {}) {
    this.daemonDir = path.resolve(opts.daemonDir ?? DEFAULT_DAEMON_DIR)
    this.portFile = path.join(this.daemonDir, 'daemon.port')
    this.pidFile = path.join(this.daemonDir, 'daemon.pid')
    this.instanceIdFile = path.join(this.daemonDir, 'daemon.instance')
    this.ownerFile = path.join(this.daemonDir, DAEMON_OWNER_FILE)
    this.overrideBinaryPath = opts.binaryPath ? path.resolve(opts.binaryPath) : undefined
    this.busyHelloMs = opts.busyHelloMs ?? BUSY_DAEMON_HELLO_MS
    this.persistent = opts.persistent === true
    this.envOverrides = opts.envOverrides ?? {}
    this.soleManager = opts.soleManager === true
  }

  get port(): number | null { return this._port }
  get wsUrl(): string | null { return this._wsUrl }
  /** The start in flight (boot), or null: a caller that needs the daemon can wait for it. */
  get starting(): Promise<number> | null { return this._ensureInFlight }
  /** PID of the DAEMON, never of the session host above it: under the host the
   *  process we spawn is the supervisor, and the daemon writes its own pid file.
   *  Null if unknown. */
  get pid(): number | null { return this._spawnedPid ?? this.readPidFile() }
  /** The macOS bundle a daemon THIS instance spawned is attributed to. Null means
   *  "plain node/bun identity, or an adopted daemon whose identity we did not
   *  choose" — deliberately not a claim that no separation exists. */
  get sessionHostApp(): string | null { return this._sessionHostApp }
  get sessionHostPid(): number | null { return this._sessionHostPid }
  /** Daemon instance ID (from hello or on-disk). Null if daemon hasn't been contacted. */
  get instanceId(): string | null { return this._instanceId ?? this.readInstanceIdFile() }

  async ensureRunning(): Promise<number> {
    // A host replica never starts or adopts a daemon: the host's daemon is the
    // one it follows, and a second one would take that host's sessions
    // (docs/plan/walnut-replica-servers-impl.md, WP1).
    if (isHostReplica()) throw new Error('a host replica never starts or adopts a local session daemon')
    // Posture guard: only an instance running as the real user may claim the
    // production daemon (daemon-ownership.ts documents the two incidents this
    // encodes and the one posture that is deliberately still allowed). It must
    // refuse ADOPTION too, not just spawning: a foreign-posture server driving
    // production's daemon would restart it on any version mismatch and inject
    // its own registry into it. Tests and demos that want a real daemon opt in
    // via WALNUT_DAEMON_DIR or an explicit `daemonDir`. startServer() catches
    // this throw and logs "local sessions will fail", which is the right outcome
    // for a process that should not have local sessions in the first place.
    if (isProductionDaemonDir(this.daemonDir)) {
      const refusal = prodDaemonClaimRefusal(currentProdClaimPosture(), this.daemonDir)
      if (refusal) throw new Error(refusal)
    }
    // In-flight guard: server startup, session-manager lazy init, and
    // reconnect callbacks all call this concurrently. Without it each caller
    // independently saw "no daemon" and spawned its own (observed: ~20 spawns
    // in 35s during one cold start). Concurrent callers share one attempt;
    // the promise clears on settle so a later call can retry after failure.
    if (this._ensureInFlight) return this._ensureInFlight
    this._ensureInFlight = this.ensureRunningInner().then((port) => {
      for (const cb of this.readyListeners) {
        try { cb() } catch { /* a listener never fails the start */ }
      }
      return port
    }).finally(() => {
      this._ensureInFlight = null
    })
    return this._ensureInFlight
  }

  private readonly readyListeners = new Set<() => void>()

  /**
   * Called after every ensureRunning() that ends with a daemon serving (adopted,
   * upgraded or spawned): the server's recovery signal for a failed start's card.
   */
  onReady(cb: () => void): () => void {
    this.readyListeners.add(cb)
    return () => { this.readyListeners.delete(cb) }
  }

  /** The fold prewarm for the upgrade to `version`: running until `done`. */
  private _foldPrewarm: { version: string; done: boolean } | null = null

  /**
   * True while the upgrade to `version` waits for its fold prewarm. Starts it on
   * the first call; when it settles (any outcome) the upgrade is tried again.
   */
  private async deferUpgradeForFoldPrewarm(binaryPath: string, version: string): Promise<boolean> {
    if (this._foldPrewarm?.version === version) return !this._foldPrewarm.done
    if (!(await registryNeedsFoldPrewarm(this.daemonDir))) return false
    const state = { version, done: false }
    this._foldPrewarm = state
    const env = await this.buildSpawnEnv()
    const stderrFd = this.openStderrLog()
    const run = runFoldPrewarm({ binaryPath, version, daemonDir: this.daemonDir, env, stderrFd })
    if (stderrFd !== null) { try { fs.closeSync(stderrFd) } catch { /* already closed */ } }
    void run.then((result) => {
      log.session.info('local daemon: fold checkpoints prepared for the upgrade', { version, ...result })
    }, (err: unknown) => {
      log.session.warn('local daemon: fold prewarm failed; upgrading without it', {
        version, error: err instanceof Error ? err.message : String(err),
      })
    }).finally(async () => {
      state.done = true
      // A quick prewarm settles inside the very start that deferred for it; a
      // retry joined to that start would return the old daemon and stop there.
      await this._ensureInFlight?.catch(() => {})
      this.ensureRunning().catch((err) => {
        log.session.warn('local daemon: upgrade after fold prewarm failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    })
    return true
  }

  /** The last kept shared daemon logged, `<running>><expected>` (daemon-shared.ts). */
  private _sharedKeptLogged: string | null = null
  /** When this server last replaced a daemon another Walnut used (the replace breaker, daemon-shared.ts). */
  private _sharedReplacedAt: number | null = null
  private _sharedReplacing = false
  /** The re-run of an upgrade deferred while ACP turns were open. */
  private _upgradeRecheck: ReturnType<typeof setTimeout> | null = null

  /**
   * A deferred upgrade needs a clock. "A later ensureRunning() does it" was
   * the plan, but while the connection stays up only a new session calls
   * ensureRunning(), so the old daemon could serve until the next server
   * restart. Re-running it is safe: a turn still open defers again, an idle
   * daemon is upgraded.
   */
  private scheduleUpgradeRecheck(delayMs = LOCAL_UPGRADE_RECHECK_MS): void {
    if (this._upgradeRecheck) return
    this._upgradeRecheck = setTimeout(() => {
      this._upgradeRecheck = null
      this.ensureRunning().catch((err) => {
        log.session.warn('local daemon: deferred upgrade check failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }, delayMs)
    this._upgradeRecheck.unref?.()
  }

  /** Whether to keep another build's daemon that another Walnut shares (daemon-shared.ts). */
  private keepSharedDaemon(hello: { version?: string; served?: DaemonServes | null }, expected: string): boolean {
    if (this.soleManager) return false
    const now = Date.now()
    const verdict = sharedDaemonVerdict({
      ourKey: walnutKeyOf(WALNUT_HOME), runningVersion: hello.version ?? '', running: hello.served ?? null, now,
      replacedRecently: this._sharedReplacedAt !== null && now - this._sharedReplacedAt < REPLACE_BREAKER_MS,
    })
    this._sharedReplacing = !verdict.keep && !!verdict.shared
    if (!verdict.keep) return false
    const key = `${hello.version}>${expected}`
    if (this._sharedKeptLogged !== key) {
      this._sharedKeptLogged = key
      log.session.info('local daemon: keeping the running daemon another Walnut uses', {
        running: hello.version, expected, otherWalnuts: verdict.others.length, why: verdict.why,
      })
    }
    return true
  }

  /** How long this Mac has run another daemon build, when that is past the bound (daemon-update-behind.ts); 0 otherwise. */
  private _overdueMs = 0
  private _overdueNoted: string | null = null
  /** Overdue on a managed daemon: its update passes `--over-busy`. */
  private _forceable = false

  private noteOverdue(running: string | undefined, expected: string | null | undefined, capabilities?: string[]): void {
    const verdict = daemonUpdateOverdue('__local__', running ?? '', !!running && !!expected && running !== expected)
    // A managed daemon is replaced with `--over-busy` (daemon-over-busy.ts); an unmanaged one is stopped from here.
    this._forceable = verdict.overdue && !!capabilities?.includes('cron-supervision-v1')
    this._overdueMs = verdict.overdue ? Math.max(1, verdict.behindMs) : 0
    if (!verdict.overdue) { this._overdueNoted = null; return }
    if (this._overdueNoted === expected) return
    this._overdueNoted = expected ?? null
    log.session.warn('local daemon update overdue; it goes ahead over the work that held it', { running, expected, behindMs: verdict.behindMs })
  }

  /** A replace went through: when the daemon it replaced was shared, the breaker starts. */
  private noteDaemonReplaced(): void {
    if (this._sharedReplacing) this._sharedReplacedAt = Date.now()
    this._sharedReplacing = false
  }

  private async ensureRunningInner(revived = false): Promise<number> {
    // The probation a server before this one started, taken up (a deploy restarted it inside it),
    // before the source daemon's files are written: those of a build on its probation wait beside
    // the way back (materializeSourceDaemon).
    await this._stay.resume(() => this.stayDue(true))
    const binaryPath = await this.findDaemonBinary()
    this._binaryPath = binaryPath
    const expectedVersion = this.readBinaryVersion(binaryPath)
    this._sharedReplacing = false
    // A build that replaced a daemon here and was gone before it stayed serving: refused as one
    // that did not start, so the start below is the kept build that ran before (refusedBuildFallback).
    await this.settleStay()
    /** The replaced daemon's own file, started again when the new one does not start. */
    let previous: string | null = null
    /** A running daemon of another build was stopped for this one (its trial passed). */
    let replacing = false

    // 1. Check if daemon is already running
    let existingPort = this.readPortFile()
    if (existingPort) {
      let helloResult = await this.ping(existingPort)
      // Alive but slow (a starved event loop on a loaded machine): wait for it
      // instead of spawning. A second daemon can never take over a live one's
      // runtime dir (its instance lock makes the newcomer exit), so each spawn
      // was pure cost: 321 futile Walnut.app + daemon launches in one day, every
      // one ending in "started but not responding to hello".
      const recordedPid = this.readPidFile()
      if (!helloResult.alive && helloResult.failure === 'timeout' && recordedPid && this.isPidAlive(recordedPid)) {
        log.session.warn('local daemon is alive but slow to answer hello — waiting instead of respawning', {
          port: existingPort, pid: recordedPid, waitMs: this.busyHelloMs,
        })
        helloResult = await this.ping(existingPort, this.busyHelloMs)
        if (!helloResult.alive && helloResult.failure === 'timeout' && this.isPidAlive(recordedPid)) {
          throw new Error(
            `Local daemon (pid ${recordedPid}, port ${existingPort}) is running but did not answer within `
            + `${this.busyHelloMs / 1000}s; not starting a second one`,
          )
        }
      }
      if (helloResult.alive) {
        // A daemon runs: the way back a failed probation asked for is no longer due.
        this._backDue = null
        // Another Walnut uses this daemon and this build brings nothing it lacks: keep it,
        // or each Walnut would put its own build back on every start (daemon-shared.ts).
        if (expectedVersion && helloResult.version && helloResult.version !== expectedVersion && this.keepSharedDaemon(helloResult, expectedVersion)) {
          this._port = existingPort
          this._wsUrl = `ws://localhost:${existingPort}`
          this._instanceId = helloResult.instanceId ?? this.readInstanceIdFile()
          this.auditOwnerOnAdopt(this._instanceId)
          return existingPort
        }
        // The bound on the whole update (daemon-update-behind.ts): behind this long, every hold below gives way.
        this.noteOverdue(helloResult.version, expectedVersion, helloResult.capabilities)
        if (helloResult.capabilities?.includes('cron-supervision-v1')) {
          if (expectedVersion && helloResult.version !== expectedVersion && this.deferForExecRuns(helloResult, existingPort, expectedVersion)) {
            return existingPort
          }
          // The update runs beside the daemon that serves, never in the way of a start: at boot the
          // server's listen waited on it (2026-11-04 review 4: the trial, two stays and a 60 s ready
          // wait could pass a deploy's readiness window, which rolled the deploy back).
          if (expectedVersion && helloResult.version !== expectedVersion) this.startManagedUpdate(binaryPath, expectedVersion, helloResult.version ?? null)
          this._port = existingPort
          this._wsUrl = `ws://localhost:${existingPort}`
          this._instanceId = helloResult.instanceId ?? this.readInstanceIdFile()
          this.auditOwnerOnAdopt(this._instanceId)
          return existingPort
        }
        // 2. Check version — auto-restart if stale. A daemon whose login session
        // ended (checkDaemonSessionInBackground) is replaced the same way, with the same holds:
        // it cannot look up its user or resolve names, nor can anything it starts.
        const sessionEnded = !!helloResult.instanceId && this._sessionEnded.has(helloResult.instanceId)
        if ((expectedVersion && helloResult.version && helloResult.version !== expectedVersion) || sessionEnded) {
          // The build that runs is the one watched with no pid yet (a server killed between its start
          // and the watch's pid, the next one with a newer build on disk): its pid named now, so its
          // death inside the window is its failure (2026-11-05 review 7: it was never judged).
          if (helloResult.version) this._stay.claim(helloResult.version, this.readPidFile())
          // Upgrade-vs-live-work guard: restarting the daemon closes every ACP
          // worker's stdin → turn-interrupted:shutdown for whatever the user is
          // mid-flight on (each dev:prod deploy used to kill live codex turns —
          // 6 shutdowns across 3 days on one session). The daemon advertises
          // open turns in acp-busy.json; while any are open, keep the old
          // daemon and try again on a clock (scheduleUpgradeRecheck).
          const busySids = this.readAcpBusySids()
          // The wait has an end: turns open this long get the upgrade anyway (acp-upgrade-hold.ts).
          const acpHold = acpUpgradeHolds('__local__', busySids.length > 0)
          if (busySids.length > 0 && (!acpHold.holds || this._overdueMs)) {
            log.session.warn('local daemon upgrade goes ahead over ACP turns open too long', { busySids, heldMs: acpHold.heldMs })
          }
          if (busySids.length > 0 && acpHold.holds && !this._overdueMs) {
            log.session.warn('local daemon version mismatch — upgrade DEFERRED (ACP turns open)', {
              running: helloResult.version,
              expected: expectedVersion,
              busySids,
            })
            this._port = existingPort
            this._wsUrl = `ws://localhost:${existingPort}`
            this._instanceId = helloResult.instanceId ?? this.readInstanceIdFile()
            // Deferring the upgrade still means driving that daemon, so it gets
            // the same ownership audit as the version-match path below.
            this.auditOwnerOnAdopt(this._instanceId)
            this.scheduleUpgradeRecheck()
            return existingPort
          }
          if (this.deferForExecRuns(helloResult, existingPort, expectedVersion ?? helloResult.version ?? '')) return existingPort
          if (expectedVersion && helloResult.version !== expectedVersion && this.deferForProbation(helloResult, existingPort, expectedVersion)) return existingPort
          // Prepare the new daemon's fold checkpoints first, while this one
          // still serves (fold-prewarm.ts): its adopt otherwise folds every
          // live stream before listening, minutes on a checkpoint format change.
          // A replacement of the same version (an ended login session) keeps the checkpoint format.
          if (expectedVersion && helloResult.version !== expectedVersion && await this.deferUpgradeForFoldPrewarm(binaryPath, expectedVersion)) {
            log.session.info('local daemon version mismatch — upgrade DEFERRED (preparing fold checkpoints)', {
              running: helloResult.version,
              expected: expectedVersion,
            })
            this._port = existingPort
            this._wsUrl = `ws://localhost:${existingPort}`
            this._instanceId = helloResult.instanceId ?? this.readInstanceIdFile()
            this.auditOwnerOnAdopt(this._instanceId)
            return existingPort
          }
          // A new build serves in a trial run before the old daemon is stopped, and the old one's
          // file is kept to go back to (local-daemon-replace.ts); isolated test dirs skip both.
          if (expectedVersion && helloResult.version !== expectedVersion && (isProductionDaemonDir(this.daemonDir) || this.persistent)) {
            if (await this.refuseReplacement(binaryPath, expectedVersion, existingPort, helloResult)) return existingPort
            try {
              previous = await previousDaemon({
                daemonDir: this.daemonDir, binaryPath, compiledSelf: isCompiledSelf(binaryPath), pid: this.readPidFile(), version: helloResult.version ?? '', durable: this.keepsDurable,
              })
            } catch (error) {
              // Keeping its file failed (a full disk, a clone refused): the old daemon is not stopped
              // without its way back, and is asked again on the upgrade clock (2026-11-04 review).
              log.session.error('local daemon: the running daemon\'s file could not be kept to go back to, so it keeps serving', {
                running: helloResult.version, expected: expectedVersion, error: error instanceof Error ? error.message : String(error),
              })
              this._port = existingPort
              this._wsUrl = `ws://localhost:${existingPort}`
              this._instanceId = helloResult.instanceId ?? this.readInstanceIdFile()
              this.auditOwnerOnAdopt(this._instanceId)
              this.scheduleUpgradeRecheck()
              return existingPort
            }
            replacing = true
            // Nothing to keep: a legacy daemon with no version, or the first update from a release
            // older than these copies of a binary or the compiled file on a Mac (local-daemon-replace.ts).
            if (!previous) log.session.warn('local daemon: no copy of the running daemon to go back to; replacing it without one', { running: helloResult.version, expected: expectedVersion, binaryPath })
          }
          log.session.info(sessionEnded ? 'local daemon in an ended login session — restarting' : 'local daemon version mismatch — restarting', {
            running: helloResult.version,
            expected: expectedVersion,
            runningInstanceId: helloResult.instanceId,
            previous,
          })
          // The same build started again (an ended login session) while it is on its probation:
          // this stop is not its failure, the start below names its new pid.
          if (!replacing && helloResult.version) this._stay.forgetPid(helloResult.version)
          // The new build's watch is on disk before the old daemon stops, its pid named at its start
          // (or by the next server's adopt): a server killed in between (a crash, a forced deploy)
          // left nothing, and the next one took the new build for one that had stayed (2026-11-05
          // review 6: on a Mac it kept that build over the way back).
          if (replacing && expectedVersion) await this._stay.start(expectedVersion, null, () => this.stayDue(true))
          // Requests in the gap wait for the next daemon instead of failing (daemon-drain-resend.ts).
          expectDaemonSwap('daemon:__local__')
          try {
            await this.stopDaemon()
          } catch (error) {
            clearDaemonSwap('daemon:__local__')
            // Not stopped: nothing of the new build runs, so its watch goes.
            if (replacing && expectedVersion) this._stay.clear()
            throw error
          }
          this.noteDaemonReplaced()
        } else {
          this._port = existingPort
          this._wsUrl = `ws://localhost:${existingPort}`
          this._instanceId = helloResult.instanceId ?? this.readInstanceIdFile()
          this.checkDaemonSessionInBackground(existingPort, helloResult)
          // The build on disk is the one that runs: its file is kept for its own replacement later,
          // once it stayed serving (keepServing).
          if (expectedVersion && helloResult.version === expectedVersion) this._stay.claim(expectedVersion, this.readPidFile())
          if (expectedVersion && helloResult.version === expectedVersion && !this._stay.watching(expectedVersion)) this.keepServing(binaryPath, expectedVersion, true)
          log.session.info('local daemon already running', {
            port: existingPort,
            version: helloResult.version,
            instanceId: this._instanceId,
          })
          this.auditOwnerOnAdopt(this._instanceId)
          return existingPort
        }
      } else {
        log.session.info('local daemon port file exists but daemon is dead, respawning', {
          staleExistingPort: existingPort,
          stalePidFromFile: this.readPidFile(),
          staleInstanceId: this.readInstanceIdFile(),
        })
      }
    }

    // 3. Spawn fresh daemon — but never behind an OS service manager's back.
    // Reached whenever the managed daemon is momentarily absent (login not yet
    // done, launchd restarting it, a crash between KeepAlive retries); spawning
    // here would squat the runtime dir and turn a 5-second gap into a permanent
    // handover refusal loop. spawnDaemon() re-checks at its own entry. A service
    // whose config is on disk and that runs nothing is started first, and the
    // daemon it brings is taken through the checks above once more.
    if (!revived && await this.reviveManagedService()) return this.ensureRunningInner(true)
    this.assertNoServiceTakeover('spawn')
    let port: number
    // No daemon answers while this build is refused here: the build that ran before, not this one.
    const held = replacing ? null : await this.refusedBuildFallback(binaryPath, expectedVersion)
    let fallback = held?.file ?? null
    // Not refused, and never proven here: the way back a failed probation asked for, or a start
    // made as a replacement (watched, the kept build before it to go back to).
    const cold = replacing || held ? null : await this.untriedStart(binaryPath, expectedVersion)
    if (cold?.kind === 'back') fallback = cold.file
    else if (cold) {
      previous = cold.previous
      replacing = true
      // Its watch on disk before it starts, as a replacement's is before the stop: a server killed
      // while it starts leaves the next one a watched build, never one it takes for proven and, on
      // a Mac, keeps over the way back (2026-11-05 review 6b).
      if (expectedVersion) await this._stay.start(expectedVersion, null, () => this.stayDue(true))
    }
    // A daemon starts now: the way back is taken, or not needed.
    this._backDue = null
    try {
      port = await this.spawnDaemon(fallback ?? binaryPath)
      // The kept build again after a failed probation: the build on disk replaces it next, through
      // its trial (refuseReplacement), on the upgrade clock.
      if (cold?.kind === 'back') this.scheduleUpgradeRecheck()
      if (previous) this._gate.replaced()
      // A probation that a reboot or a restart of the same build left without a pid: this is it.
      if (expectedVersion && !fallback) this._stay.claim(expectedVersion, this.pid)
      // Up once it stayed serving; gone before that, the next start is the one it replaced.
      if (replacing && expectedVersion && !fallback) this.watchStart(binaryPath, expectedVersion, true)
      // The refused build itself, started with nothing kept to start instead: watched the same way,
      // so one gone within the window is refused anew and says so (2026-11-04 review 4: it was not
      // watched, and crash looped unseen). Nothing else to start, so no start follows here.
      if (held && !fallback && expectedVersion) {
        this.watchStart(binaryPath, expectedVersion, false)
      }
      // The file this build serves from, kept for its own replacement later (a Mac has no /proc);
      // a watched start's only once it stayed (its window's end, or the next adopt).
      if (!fallback && !(expectedVersion && this._stay.watching(expectedVersion))) this.keepServing(binaryPath, expectedVersion)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (fallback) {
        log.session.error('local daemon: the build that ran before did not start; starting this build', { reason, fallback, expected: expectedVersion })
        port = await this.spawnDaemon(binaryPath)
        // The build on disk (refused here, or untried after a failed probation), watched like any
        // start of it (above), and kept once it stayed: the kept file just failed to start.
        if (expectedVersion) this.watchStart(binaryPath, expectedVersion, false)
        return this.adoptSpawned(port, expectedVersion)
      }
      // Passed its trial, did not start on the real dir: left alone until another build, whatever comes
      // next. A cold start ran no trial, so its one failed start (load at login, a slow hello) is held
      // only as a failed trial is, in memory (2026-11-05 review 6b: a day on disk), and its trial
      // decides once the kept build serves.
      if (expectedVersion && replacing) this._gate.refuse(expectedVersion, `it did not start on the real dir: ${reason}`, !cold)
      // Its watch, written before the stop, ends with it: nothing of it runs.
      if (expectedVersion && replacing && this._stay.watching(expectedVersion)) this._stay.clear()
      if (!previous) throw error
      log.session.error('local daemon: the new daemon did not start; starting the one it replaced again', { reason, previous, expected: expectedVersion })
      port = await this.spawnDaemon(previous)
    }
    return this.adoptSpawned(port, expectedVersion)
  }

  /**
   * The file of the build that serves, kept as the one to go back to. Never before it stayed: on
   * a Mac the copy of the build it replaced is the one slot, and a new build kept at its start put
   * itself there, so its own failure within the window started it again instead of the old one
   * (2026-11-04 review 5). `unlessRefused` (an adopt): a build refused here is not kept, since
   * a watch that ended says nothing of how (a start that raced its death serves it unwatched);
   * its own stay callback keeps one that stayed.
   */
  private keepServing(binaryPath: string, version: string | null, unlessRefused = false): void {
    void (async () => {
      if (unlessRefused && version) {
        await this._gate.load()
        if (this._gate.refusedNow(version)) return
      }
      // It serves with no probation running (or passed one): a later start of it with no daemon
      // running is a plain start (untriedStart).
      if (version && this.keepsDurable) this._stay.prove(version)
      await keepRunningBinary({ daemonDir: this.daemonDir, binaryPath, compiledSelf: isCompiledSelf(binaryPath), version, durable: this.keepsDurable })
    })().catch(() => {})
  }

  /**
   * The daemon just started from `binaryPath` is on its probation; a clone of its file waits in
   * the pending slot meanwhile (a Mac: a deploy inside the window replaces the file on disk).
   */
  private watchStart(binaryPath: string, expected: string, restart: boolean): void {
    void this._stay.start(expected, this.pid, () => this.stayDue(restart))
    void keepPendingBinary({ daemonDir: this.daemonDir, binaryPath, compiledSelf: isCompiledSelf(binaryPath), version: expected, durable: this.keepsDurable }).catch(() => {})
  }

  /**
   * The watch is due (its window is over, or its daemon is gone): one that stayed is
   * the build to go back to now (settleStay); one gone is refused, and (`restart`) the one it
   * replaced is started.
   */
  private stayDue(restart: boolean): void {
    if (this._stoppedByOwner) return
    void (async () => {
      if (await this.settleStay()) {
        if (restart) {
          await this.ensureRunning().catch((err: unknown) => {
            log.session.warn('local daemon: starting the daemon it replaced failed', { error: err instanceof Error ? err.message : String(err) })
          })
        }
      }
    })().catch((err: unknown) => {
      log.session.warn('local daemon: settling the new daemon\'s probation failed', { error: err instanceof Error ? err.message : String(err) })
    })
  }

  /**
   * The build that runs is on its probation: the file of the build before it is the way back
   * until it passed, so no other build replaces it yet (it would take that one slot). Asked again
   * on the upgrade clock.
   */
  private deferForProbation(hello: { version?: string; instanceId?: string }, port: number, expected: string): boolean {
    if (!hello.version || !this._stay.watching(hello.version)) return false
    log.session.warn('local daemon version mismatch — upgrade DEFERRED (the running build is on its probation)', {
      running: hello.version, expected, leftMs: Math.round(this._stay.leftMs(hello.version)),
    })
    this._port = port
    this._wsUrl = `ws://localhost:${port}`
    this._instanceId = hello.instanceId ?? this.readInstanceIdFile()
    this.auditOwnerOnAdopt(this._instanceId)
    this.scheduleUpgradeRecheck()
    return true
  }

  private async keepPassed(expected: string): Promise<void> {
    const binaryPath = this._binaryPath
    if (!(await promotePending(this.daemonDir, expected)) && binaryPath && this.readBinaryVersion(binaryPath) === expected) this.keepServing(binaryPath, expected)
  }

  /**
   * The watched new daemon is gone within its window: refused until another build (true), else
   * nothing to do. Another build serving the dir now replaced it (another Walnut on this daemon
   * dir): no verdict on it (2026-11-04 review 6: that was its failure for a day). Its pending files
   * go with any end but a pass.
   */
  private async settleStay(): Promise<boolean> {
    const before = this._stay.current()
    // Past its window the watch passes only on its own build answering here (StayWatch.settle).
    const served = before && this._stay.leftMs(before) === 0 ? await this.servedBuild() : undefined
    const gone = this._stay.settle((pid) => this.isPidAlive(pid), served)
    // The watch ended now: one stayed through is the way back from here on (its pending files, else
    // the file there while it still is that build); any other end drops its pending files.
    if (before && !this._stay.watching(before)) {
      if (this._stay.passed(before)) void this.keepPassed(before).catch(() => {})
      else void discardPending(this.daemonDir, before)
    }
    if (!gone) return false
    const serving = served !== undefined ? served : await this.servedBuild()
    if (serving && serving !== gone.expected) {
      log.session.warn('local daemon: the new daemon was replaced by another build inside its probation; no verdict on it', { expected: gone.expected, serving })
      return false
    }
    log.session.error('local daemon: the new daemon did not stay serving; the one it replaced is started again', { expected: gone.expected, reason: gone.reason })
    this._gate.refuse(gone.expected, gone.reason, true)
    this._backDue = gone.expected
    return true
  }

  /** The build the daemon on the port file answers as, or null when none answers. */
  private async servedBuild(): Promise<string | null> {
    const port = this.readPortFile()
    const hello = port ? await this.ping(port).catch(() => null) : null
    return hello?.alive ? hello.version ?? null : null
  }

  /**
   * The old daemon died while `expected` is refused here (its trial failed lately, or it did not
   * start on the real dir after a stop): the kept file of the build that ran before, if there is
   * one. 2026-11-04 review: the gate only held while an old daemon answered, so its death let the
   * next start launch the refused build.
   */
  private async refusedBuildFallback(binaryPath: string, expected: string | null): Promise<{ file: string | null; why: string } | null> {
    if (!expected || !(isProductionDaemonDir(this.daemonDir) || this.persistent)) return null
    await this._gate.load()
    const why = this._gate.refusedNow(expected)
    if (!why) return null
    const kept = await keptPrevious(this.daemonDir, binaryPath)
    if (!kept || kept.version === expected) {
      log.session.warn('local daemon: no daemon runs and this build is refused here, with no build that ran before kept; starting it, watched', { expected, why })
      return { file: null, why }
    }
    log.session.warn('local daemon: no daemon runs and this build is refused here; starting the build that ran before', { expected, previous: kept.version, why })
    return { file: kept.file, why }
  }

  /**
   * No daemon runs, `expected` is not refused here, and it never stayed through a probation here
   * (StayWatch.proven, or the kept build before is this one). 2026-11-05 review 6: such a start was
   * made as if the build had served here: unwatched, kept at once (on a Mac over the way back), and
   * after a failed probation it was the newer build deployed inside the window, untried, instead of
   * the build that ran before. Now:
   *   back      a probation just failed (_backDue, or the gate's refusal on disk after a restart)
   *             and a kept build other than that one is there:
   *             it starts, and the build on disk replaces it later through its own trial.
   *   replace   otherwise the start is a replacement: watched (its death within the window is
   *             refused, and the kept build follows), kept only once it passed; the kept build
   *             before it (`previous`, null: none) starts when it does not start at all.
   * null: a plain start (a build proven here, or a daemon dir that does not last).
   */
  private async untriedStart(binaryPath: string, expected: string | null): Promise<{ kind: 'back'; file: string } | { kind: 'replace'; previous: string | null } | null> {
    if (!expected || !this.keepsDurable) return null
    const kept = await keptPrevious(this.daemonDir, binaryPath)
    if (this._backDue === undefined) await this._gate.load()
    const back = this._backDue === undefined ? this._gate.refusedUntilNewBuild() : this._backDue
    // The kept build is this one (the way back itself), or it stayed serving here before.
    if (kept?.version === expected || await this._stay.proven(expected)) return null
    if (kept && back && kept.version !== back) {
      log.session.warn('local daemon: no daemon runs after a probation failed; starting the build that ran before, the build on disk replaces it after its trial', { failed: back, previous: kept.version, expected })
      return { kind: 'back', file: kept.file }
    }
    const previous = kept && kept.version !== back ? kept.file : null
    log.session.warn('local daemon: no daemon runs and this build never stayed serving here; starting it on its probation', { expected, previous: previous ? kept!.version : null })
    return { kind: 'replace', previous }
  }

  private adoptSpawned(port: number, expectedVersion: string | null): number {
    this._port = port
    this._wsUrl = `ws://localhost:${port}`
    // Pick up instance id from hello (spawnDaemon did one) or fall back to file
    if (!this._instanceId) this._instanceId = this.readInstanceIdFile()
    log.session.info('local daemon started', {
      port,
      pid: this._spawnedPid,
      version: expectedVersion,
      instanceId: this._instanceId,
    })
    this.writeOwnerStamp(this._instanceId)
    return port
  }

  getDirectWsUrl(): string {
    if (!this._wsUrl) throw new Error('Local daemon not running. Call ensureRunning() first.')
    return this._wsUrl
  }

  /**
   * host_exec runs in the running daemon end with it (exec-runs-hold.ts): keep it serving
   * and ask again on the upgrade clock. True when the upgrade waits.
   */
  private deferForExecRuns(hello: { version?: string; instanceId?: string; execRunning?: number }, port: number, expected: string): boolean {
    const why = execRunsWait('__local__', execRunsReason(hello.execRunning))
    if (!why) return false
    // Overdue: the update goes over them (daemon-update-behind.ts).
    if (this._overdueMs) return false
    log.session.warn('local daemon version mismatch — upgrade DEFERRED (host_exec runs)', { running: hello.version, expected, why })
    this._port = port
    this._wsUrl = `ws://localhost:${port}`
    this._instanceId = hello.instanceId ?? this.readInstanceIdFile()
    this.auditOwnerOnAdopt(this._instanceId)
    this.scheduleUpgradeRecheck()
    return true
  }

  /**
   * The new build must serve in a trial run before the old daemon is stopped (ReplacementGate).
   * True: the old daemon keeps serving for now, adopted here: the trial still runs beside it
   * (its end asks again), it failed (asked again after LOCAL_REPLACE_RETRY_MS), or the build
   * did not start on the real dir after a stop (left alone until another build comes).
   */
  private async refuseReplacement(binaryPath: string, expected: string, port: number, hello: { version?: string; instanceId?: string }): Promise<boolean> {
    await this._gate.load()
    const verdict = this._gate.check(expected, async () => trialDaemon(binaryPath, isCompiledSelf(binaryPath), await this.buildSpawnEnv()), () => {
      const reason = this._gate.refusal(expected)
      if (reason) log.session.error('local daemon: the new daemon did not start in a trial run; the running one keeps serving', { running: hello.version, expected, reason })
      else log.session.info('local daemon: the new daemon served in a trial run; replacing the running one', { running: hello.version, expected })
      // A start in flight may still hold the old answer: ask once it settled.
      if (this._stoppedByOwner) return
      void (this._ensureInFlight ?? Promise.resolve()).catch(() => {}).then(() => this.ensureRunning()).catch((err: unknown) => {
        log.session.warn('local daemon: the check after a trial run failed', { error: err instanceof Error ? err.message : String(err) })
      })
    })
    if (verdict === 'go') return false
    this._port = port
    this._wsUrl = `ws://localhost:${port}`
    this._instanceId = hello.instanceId ?? this.readInstanceIdFile()
    this.auditOwnerOnAdopt(this._instanceId)
    // The trial's own end asks again; a refusal waits for the upgrade clock.
    if (verdict !== 'wait') this.scheduleUpgradeRecheck()
    return true
  }

  /** The service of Walnut's this daemon runs under: exactly one config (the LaunchAgent, the user unit, or the cron boot script), never a system unit. */
  private managedScope(): 'user' | 'cron' | null {
    if (!isProductionDaemonDir(this.daemonDir)) return null
    const takeover = this.detectServiceTakeover()
    const configs = daemonServiceConfigPaths()
    const present = configs.filter((config) => takeover.present.includes(config))
    if (takeover.unknown.length || present.length !== 1) return null
    return present[0] === configs[0] ? 'user' : process.platform === 'linux' && present[0] === configs[2] ? 'cron' : null
  }

  /** A daemon dir that lasts (the production one, the companion's) keeps its copies where a reboot leaves them; a throwaway one beside its files. */
  private get keepsDurable(): boolean {
    return isProductionDaemonDir(this.daemonDir) || this.persistent
  }

  /** The managed update running beside the daemon that serves (startManagedUpdate); tests and shutdown wait for it. */
  private _managedUpdate: Promise<void> | null = null
  get managedUpdatePending(): Promise<void> { return this._managedUpdate ?? Promise.resolve() }

  /**
   * Update the service in the background while the running daemon is adopted (the unmanaged path's
   * trial runs the same way): its end adopts whatever serves then, the new daemon or the one a
   * failed update put back. One at a time.
   */
  private startManagedUpdate(binaryPath: string, expected: string, running: string | null): void {
    if (this._managedUpdate) return
    const run = this._managedUpdate = (async () => {
      let outcome: Awaited<ReturnType<LocalDaemon['updateManagedDaemon']>>
      try {
        outcome = await this.updateManagedDaemon(binaryPath, expected)
      } catch (error) {
        log.session.error('local daemon: managed update failed; the daemon that serves now is adopted', { running, expected, error: error instanceof Error ? error.message : String(error) })
        // What a failed update left serving (the one put back) is adopted, and the update is asked
        // again after its 10 minute cooldown, never left until the next start.
        await this.adoptAfterManagedUpdate()
        this.scheduleUpgradeRecheck()
        return
      }
      if (outcome === 'backoff') {
        // Its day off: the old daemon keeps serving, and the update is asked again once the day is over.
        this.scheduleUpgradeRecheck(this._managedFail ? backoffLeftMs(this._managedFail) : LOCAL_UPGRADE_RECHECK_MS)
      } else if (outcome === 'busy' || outcome === 'later') {
        // Work of its own started after the hello (a host_exec run), or a try within 10 minutes:
        // the old daemon keeps serving. Overdue (this._overdueMs), the next try goes over that work.
        this.scheduleUpgradeRecheck()
      } else if (outcome !== null) {
        this.noteDaemonReplaced()
        await this.adoptAfterManagedUpdate()
      } else if (this._managedSkipLogged !== `${running}>${expected}`) {
        this._managedSkipLogged = `${running}>${expected}`
        log.session.error('Managed local daemon version differs; automatic update was deferred; use walnut daemon install --yes --executable <daemon binary>', { running, expected })
      }
    })()
    void run.finally(() => { if (this._managedUpdate === run) this._managedUpdate = null })
  }

  private _managedSkipLogged: string | null = null

  /** After a managed update: the daemon that serves now, through a fresh start check (its hello, its version). */
  private async adoptAfterManagedUpdate(): Promise<void> {
    if (this._stoppedByOwner) return
    await (this._ensureInFlight ?? Promise.resolve()).catch(() => {})
    await this.ensureRunning().catch((err: unknown) => {
      log.session.warn('local daemon: the check after a managed update failed', { error: err instanceof Error ? err.message : String(err) })
    })
  }

  private async updateManagedDaemon(binaryPath: string, expected: string): Promise<number | null | 'busy' | 'later' | 'backoff'> {
    if (binaryPath.endsWith('.cjs')) return null
    const scope = this.managedScope()
    if (!scope) return null
    if (this._lastManagedUpdate?.expected === expected && Date.now() - this._lastManagedUpdate.at < LOCAL_MANAGED_UPDATE_COOLDOWN_MS) return 'later'
    if (this._managedFail === undefined) this._managedFail = await readBuildBackoff(`local:${this.daemonDir}`)
    // A build that answered ok and did not stay serving: asked again when its day off ends (startManagedUpdate).
    if (this._managedFail && buildBackedOff(this._managedFail, expected)) return 'backoff'
    this._lastManagedUpdate = { expected, at: Date.now() }
    // Detached, with the tail after it (local-daemon-service.ts): a server stopped mid-update no longer takes the update with it.
    const { updateLocalService } = await import('./local-daemon-service.js')
    // Its record kept from the launch: a server restarted mid-update reads it back first (local-daemon-service.ts).
    const key = `local:${this.daemonDir}`
    // Overdue (daemon-update-behind.ts): the CLI goes over the daemon's own work, in at most a minute.
    // Overdue, the old daemon may be restarted unprepared, and an older one's shutdown does not wait
    // for a file write: this server's file changes to it wait for the swap (daemon-file-fence.ts).
    const overBusy = this._forceable
    const release = overBusy ? fenceDaemonFileChanges('__local__') : () => {}
    let outcome: Awaited<ReturnType<typeof updateLocalService>>
    // Requests in the gap of the swap wait for the next daemon instead of failing (daemon-drain-resend.ts).
    // The update may first wait out the daemon's own work: the mark lasts as long as the CLI may run.
    expectDaemonSwap('daemon:__local__', 5 * 60_000)
    try {
      outcome = await updateLocalService(binaryPath, scope, { record: { key, expected }, overBusy }).catch((error: unknown) => {
        clearDaemonSwap('daemon:__local__')
        if ((error as { buildFailed?: unknown })?.buildFailed === true) {
          this._managedFail = { expected, at: Date.now(), reason: (error instanceof Error ? error.message : String(error)).slice(0, 300) }
          // Written to disk by updateLocalService too, before the update's record went (a double does not).
          void writeBuildBackoff(key, this._managedFail)
        }
        throw new Error(`Managed daemon update failed; no unmanaged replacement was started: ${error instanceof Error ? error.message : String(error)}`)
      })
    } finally { release() }
    if (outcome !== 'applied') {
      clearDaemonSwap('daemon:__local__')
      // Refused before anything changed (the daemon busy, launchd starting no jobs): asked again on the upgrade clock.
      this._lastManagedUpdate = null
      log.session.warn(`local daemon: managed update ${outcome === 'busy' ? 'refused while the daemon is busy, or another update or the last one\'s probation is at work' : 'deferred: launchd starts no jobs in this login session now'}; trying again later`, { expected })
      return 'busy'
    }
    const port = this.readPortFile()
    if (!port) {
      clearDaemonSwap('daemon:__local__')
      throw new Error('Managed daemon update returned without a runtime port')
    }
    return port
  }

  /**
   * The service's config is on disk and no daemon answers: load or start it before refusing
   * to start one here (local-daemon-service.ts). True when a daemon answers now. At most
   * once a minute; never while an update's runner is at work.
   */
  private async reviveManagedService(): Promise<boolean> {
    const scope = this.managedScope()
    if (!scope || (this._lastRevive !== null && Date.now() - this._lastRevive < REVIVE_EVERY_MS)) return false
    const { reviveLocalService } = await import('./local-daemon-service.js')
    const tail = await reviveLocalService(scope).catch((error: unknown) => ({ outcome: 'down' as const, words: error instanceof Error ? error.message : String(error) }))
    if (tail === 'updating') {
      log.session.info('local daemon: no daemon answers while a service update runs; its own check starts the service', { scope })
      return false
    }
    this._lastRevive = Date.now()
    const up = tail.outcome === 'loaded' || tail.outcome === 'serving' || tail.outcome === 'standin'
    // Not started (its words say why: the user's `launchctl disable` among them): logged as such.
    if (up) log.session.warn('local daemon: the service had no daemon running; Walnut started it', { scope, outcome: tail.outcome, words: tail.words })
    else log.session.error('local daemon: the service had no daemon running, and Walnut did not start one', { scope, outcome: tail.outcome, words: tail.words })
    return up
  }

  private readPortFile(): number | null {
    try {
      const content = fs.readFileSync(this.portFile, 'utf-8').trim()
      const port = parseInt(content, 10)
      return port > 0 ? port : null
    } catch {
      return null
    }
  }

  private readPidFile(): number | null {
    try {
      const content = fs.readFileSync(this.pidFile, 'utf-8').trim()
      const pid = Number(content)
      return Number.isSafeInteger(pid) && pid > 1 ? pid : null
    } catch {
      return null
    }
  }

  /**
   * ACP workers with an OPEN turn (acp-busy.json, maintained by acp-daemon).
   * Used to defer version-upgrade restarts. A stale file (daemon crashed >2min
   * ago, or predates the busy-file feature) reads as "not busy" so upgrades
   * can never be wedged by leftovers.
   */
  private readAcpBusySids(): string[] {
    try {
      const raw = fs.readFileSync(path.join(this.daemonDir, 'acp-busy.json'), 'utf-8')
      const parsed = JSON.parse(raw) as { busySids?: unknown; updatedAt?: unknown }
      if (typeof parsed.updatedAt !== 'number' || Date.now() - parsed.updatedAt > 2 * 60_000) return []
      return Array.isArray(parsed.busySids) ? parsed.busySids.filter((s): s is string => typeof s === 'string') : []
    } catch {
      return []
    }
  }

  private readInstanceIdFile(): string | null {
    try {
      const content = fs.readFileSync(this.instanceIdFile, 'utf-8').trim()
      return content || null
    } catch {
      return null
    }
  }

  /** Record the env we just handed a daemon we spawned. Best-effort by design:
   *  a diagnostic that cannot start a daemon must never stop one either. */
  private writeOwnerStamp(instanceId: string | null): void {
    const identity = currentProdClaimPosture()
    const stamp: DaemonOwnerStamp = {
      walnutHome: identity.walnutHome,
      envHome: identity.envHome,
      realHome: identity.realHome,
      instanceId,
      daemonPid: this._spawnedPid ?? this.readPidFile(),
      serverPid: process.pid,
      claudeCli: this._spawnClaudeCli,
      at: new Date().toISOString(),
    }
    try {
      fs.writeFileSync(this.ownerFile, JSON.stringify(stamp, null, 2) + '\n')
    } catch (err) {
      log.session.debug('could not write daemon owner stamp', {
        file: this.ownerFile, error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  readOwnerStamp(): DaemonOwnerStamp | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.ownerFile, 'utf-8')) as DaemonOwnerStamp
      return typeof parsed === 'object' && parsed !== null ? parsed : null
    } catch {
      return null
    }
  }

  /**
   * We are about to drive a daemon somebody else started. Say WHOSE env it has.
   *
   * A daemon serves sessions with its own inherited environment, so adopting one
   * that a foreign instance spawned is the 2026-08-28 outage: every new session
   * dies with exit 127 while the server looks healthy. The posture guard in
   * ensureRunning() stops walnut from CREATING that situation; this makes an
   * already-broken machine self-describing instead of costing an investigation.
   * Never re-stamps — see DaemonOwnerStamp.
   */
  private auditOwnerOnAdopt(instanceId: string | null): void {
    const stamp = this.readOwnerStamp()
    const mine = currentProdClaimPosture()
    const verdict = classifyAdoptedDaemonOwner(stamp, mine, instanceId)
    if (verdict === 'ours') return
    // Same verdict about the same daemon = same news (see ownerAuditKey).
    const auditKey = ownerAuditKey(verdict, instanceId, stamp?.instanceId)
    if (this._lastOwnerAudit === auditKey) return
    this._lastOwnerAudit = auditKey
    if (verdict === 'unstamped') {
      log.session.warn('local daemon has no owner stamp — spawned before this build, or by another instance', {
        daemonDir: this.daemonDir, instanceId,
      })
      return
    }
    const detail = {
      daemonDir: this.daemonDir,
      liveInstanceId: instanceId,
      stampedInstanceId: stamp?.instanceId,
      stampedWalnutHome: stamp?.walnutHome,
      stampedEnvHome: stamp?.envHome,
      stampedClaudeCli: stamp?.claudeCli,
      stampedServerPid: stamp?.serverPid,
      myWalnutHome: mine.walnutHome,
      myEnvHome: mine.envHome,
    }
    if (verdict === 'foreign-identity') {
      log.session.error(
        'local daemon was started by a DIFFERENT walnut instance — its sessions run with THAT env, '
        + 'so new sessions may fail with "claude: not found" (exit 127). Restart the daemon from a '
        + 'normal shell to reclaim it.',
        detail,
      )
    } else if (verdict === 'no-claude') {
      log.session.error(
        'local daemon was spawned from an environment with no resolvable claude CLI — new sessions '
        + 'will fail with exit 127 until it is restarted from a shell that has claude on PATH.',
        detail,
      )
    } else {
      log.session.warn('adopting a local daemon whose owner stamp is stale (a newer daemon replaced the stamped one)', detail)
    }
  }

  /**
   * Does an OS service manager own the daemon for THIS runtime dir?
   *
   * Scope matters: the installer pins this user's production runtime dir
   * (/tmp/open-walnut, or ~/.cache/open-walnut for a second user on the
   * machine), so an isolated dir (tests, sandbox, ephemeral demo) is
   * never governed by a persistent config — only by a `daemon.service` marker
   * inside its own dir, which exists exactly when a `--service` daemon claimed
   * it. Without that scoping, one installed LaunchAgent would make every test
   * server on the machine refuse to spawn its own throwaway daemon.
   */
  private detectServiceTakeover(): ServiceTakeover {
    const marker = path.join(this.daemonDir, 'daemon.service')
    const probes = [{ path: marker, state: this.probeServiceConfig(marker) }]
    if (isProductionDaemonDir(this.daemonDir)) {
      for (const file of daemonServiceConfigPaths()) probes.push({ path: file, state: this.probeServiceConfig(file, true) })
    }
    return classifyServiceTakeover(probes)
  }

  /**
   * `persistent`: an installed config, read to see whether it runs THIS daemon.
   * Two users on one machine each have their own production dir, so a config
   * that pins the other one, or another account's system unit, governs nothing
   * here. A config that cannot be read stays unknown (managed).
   */
  private probeServiceConfig(file: string, persistent = false): ServiceProbeState {
    try {
      fs.lstatSync(file)
    } catch (err) {
      return classifyServiceConfigError(err)
    }
    if (!persistent) return 'present'
    let text: string
    try {
      text = fs.readFileSync(file, 'utf-8')
    } catch {
      return 'unknown'
    }
    return serviceConfigGovernsDir(process.platform, text, this.daemonDir, serviceAccount()) ? 'present' : 'absent'
  }

  /**
   * Refuse an unmanaged lifecycle action while the OS owns this daemon.
   * Throwing (rather than degrading quietly) is the point: the user gets one
   * line naming the evidence and the exact service command to run.
   */
  private assertNoServiceTakeover(action: 'spawn' | 'stop'): void {
    const takeover = this.detectServiceTakeover()
    if (!takeover.managed) return
    const message = localServiceTakeoverMessage(action, takeover)
    log.session.error('local daemon lifecycle action refused — OS service manages this daemon', {
      action, daemonDir: this.daemonDir, present: takeover.present, unknown: takeover.unknown,
    })
    throw new Error(message)
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }

  /** Daemon instances whose login session this server has checked, and the ones found ended. */
  private _sessionChecked = new Set<string>()
  private _sessionEnded = new Set<string>()
  /** Replacements for an ended session this server made: a brake, never a loop. */
  private _sessionReplacements = 0

  /**
   * Whether the daemon on `port` runs in a login session macOS ended while this
   * server's own session works (login-session.ts): the daemon runs the probe the
   * server runs on itself (exec.run, host-exec-v1), twice, and only what both runs
   * see counts. In the background, never holding up a start; once per daemon
   * instance. A daemon found ended is replaced by the next ensureRunning, through
   * the version-mismatch path and its holds (open ACP turns, fold prewarm), and its
   * CLIs are recycled through the idle reaper (ended-session-clis.ts).
   */
  private checkDaemonSessionInBackground(port: number, hello: { instanceId?: string; capabilities?: string[] }): void {
    if (process.platform !== 'darwin' || !hello.instanceId || !hello.capabilities?.includes('host-exec-v1')) return
    if (!isProductionDaemonDir(this.daemonDir) && process.env.WALNUT_LOGIN_SESSION_CHECK_ISOLATED !== '1') return
    const id = hello.instanceId
    if (this._sessionChecked.has(id) || this._sessionReplacements >= 2) return
    this._sessionChecked.add(id)
    void (async () => {
      const { checkLoginSession, loginSessionSeen, confirmedProblems, LOGIN_SESSION_PROBE_SCRIPT } = await import('../core/login-session.js')
      await checkLoginSession()
      // This server's own session must work, or a new daemon would be no better.
      if (loginSessionSeen().some((p) => p !== 'cwd_gone')) return
      const uid = typeof process.getuid === 'function' ? process.getuid() : -1
      const probe = async () => {
        const reply = await this.rpc(port, 'exec.run', {
          jobId: `hx-walnut-login-${Date.now().toString(36)}`, argv: ['/bin/sh', '-c', LOGIN_SESSION_PROBE_SCRIPT],
          cwd: '/', timeoutMs: 10_000, caller: { task: 'walnut-login-session' },
        }, 20_000)
        return typeof reply?.output === 'string' ? reply.output : null
      }
      const problems = (await confirmedProblems(probe, uid)).filter((p) => p !== 'cwd_gone')
      if (!problems.length || this._instanceId !== id) return
      const { listNonTerminalSessions } = await import('../core/session-tracker.js')
      const { markEndedSessionClis } = await import('../core/sessions/ended-session-clis.js')
      const live = (await listNonTerminalSessions().catch(() => [])).filter((r) => !r.host || r.host === '__local__')
      const marked = markEndedSessionClis(live)
      this._sessionEnded.add(id)
      this._sessionReplacements++
      log.session.error('local daemon runs in a login session that ended — replacing it', {
        port, instanceId: id, problems, clisToRecycle: marked,
      })
      await this._ensureInFlight?.catch(() => {})
      await this.ensureRunning()
    })().catch((err: unknown) => {
      log.session.warn('local daemon login-session check failed', { error: err instanceof Error ? err.message : String(err) })
    })
  }

  /** One command to the daemon on `port` and its answer (null on no answer). */
  private rpc(port: number, cmd: string, payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      let ws: WebSocket | null = null
      const timeout = setTimeout(() => { try { ws?.terminate() } catch { /* closed */ } resolve(null) }, timeoutMs)
      try {
        const socket = new WebSocket(`ws://localhost:${port}`)
        ws = socket
        socket.on('open', () => socket.send(JSON.stringify({ ...payload, id: 7, cmd })))
        socket.on('message', (data) => {
          let msg: Record<string, unknown> | null = null
          try { msg = JSON.parse(data.toString()) } catch { /* not JSON */ }
          if (!msg || msg.id !== 7) return
          clearTimeout(timeout)
          socket.close()
          resolve(msg)
        })
        socket.on('error', () => { clearTimeout(timeout); resolve(null) })
      } catch {
        clearTimeout(timeout)
        resolve(null)
      }
    })
  }

  private async ping(port: number, timeoutMs = 2000): Promise<{
    alive: boolean; version?: string; capabilities?: string[]; instanceId?: string
    /** hello `served`: the Walnuts it serves (daemon-shared.ts); absent from an older daemon. */
    served?: DaemonServes | null
    /** host_exec runs going on in it (exec-runs-hold.ts); absent from a daemon older than that. */
    execRunning?: number
    /** Set when not alive: a timeout means something accepted or is holding the
     *  connection without answering; an error means nothing is listening. */
    failure?: 'timeout' | 'error' | 'bad-reply'
  }> {
    return new Promise((resolve) => {
      // 2s is generous for localhost WebSocket (typically <10ms) but handles
      // daemon startup jitter. This blocks Walnut server startup, so keep short.
      let ws: WebSocket | null = null
      // An answered hello whose follow-up ask (exec.list) is still out: a timeout keeps it.
      let hello: { alive: boolean; version?: string; capabilities?: string[]; instanceId?: string; served?: DaemonServes | null } | null = null
      const timeout = setTimeout(() => {
        try { ws?.terminate() } catch { /* already closed */ }
        resolve(hello ?? { alive: false, failure: 'timeout' })
      }, timeoutMs)
      try {
        const socket = new WebSocket(`ws://localhost:${port}`)
        ws = socket
        socket.on('open', () => {
          socket.send(JSON.stringify({ id: 1, cmd: 'hello' }))
        })
        socket.on('message', (data) => {
          let msg: { id?: unknown; ok?: boolean; version?: string; capabilities?: string[]; instanceId?: string; execRunning?: number; jobs?: unknown; served?: { twin?: unknown; walnuts?: unknown } } | null = null
          try { msg = JSON.parse(data.toString()) } catch { /* not JSON: a bad reply */ }
          if (hello && msg && msg.id === 2) {
            clearTimeout(timeout)
            socket.close()
            resolve(msg.ok === true ? { ...hello, execRunning: runningJobs(msg) } : hello)
            return
          }
          // The daemon pushes its events (a session's state, cron metadata) to
          // every client, this one too, and echoes a command's id: only the
          // answer to this hello counts. Taking the first message called a daemon
          // that had just ended a turn dead, and the respawn that followed failed
          // every local read for a while.
          if (msg && msg.id !== 1) return
          if (!msg) { clearTimeout(timeout); socket.close(); resolve({ alive: false, failure: 'bad-reply' }); return }
          const answer = {
            alive: msg.ok === true,
            version: msg.version,
            capabilities: msg.capabilities,
            instanceId: msg.instanceId,
            ...(msg.served && typeof msg.served === 'object'
              ? { served: parseServes({ version: msg.version ?? '', twin: msg.served.twin, capabilities: msg.capabilities ?? [], walnuts: msg.served.walnuts }) }
              : {}),
            ...(typeof msg.execRunning === 'number' ? { execRunning: msg.execRunning } : {}),
            ...(msg.ok === true ? {} : { failure: 'bad-reply' as const }),
          }
          // A daemon older than the count in its hello still lists its host_exec runs (exec-runs-hold.ts).
          if (answer.alive && answer.execRunning === undefined && answer.capabilities?.includes('host-exec-v1')) {
            hello = answer
            socket.send(JSON.stringify({ id: 2, cmd: 'exec.list' }))
            return
          }
          clearTimeout(timeout)
          socket.close()
          resolve(answer)
        })
        socket.on('error', () => { clearTimeout(timeout); resolve(hello ?? { alive: false, failure: 'error' }) })
      } catch {
        clearTimeout(timeout)
        resolve({ alive: false, failure: 'error' })
      }
    })
  }

  /**
   * Stop the daemon THIS instance manages — for isolated-dir owners (tests,
   * sandboxes) whose daemon must not outlive them. Refuses the production dir:
   * the prod daemon's job is to survive walnut restarts, and every historical
   * "kill the daemon on shutdown" path has caused a session-loss incident.
   */
  async stopIfIsolated(): Promise<void> {
    if (isProductionDaemonDir(this.daemonDir)) return
    if (this._upgradeRecheck) clearTimeout(this._upgradeRecheck)
    this._upgradeRecheck = null
    this._stay.clear()
    // A trial still running beside it must not start a daemon after this stop.
    this._stoppedByOwner = true
    await this.stopDaemon()
  }

  private async stopDaemon(): Promise<void> {
    // A SIGTERM/SIGKILL here is the manager's job, not ours: launchd/systemd
    // would restart the process right back and race whatever we start next.
    this.assertNoServiceTakeover('stop')
    const pid = this.readPidFile()
    if (!pid) return
    try { process.kill(pid, 'SIGTERM') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }

    // Wait for accepted FIFO writes and the stop request to reach disk; on timeout, do not force kill and do not remove a run marker that is still valid.
    for (let i = 0; i < 300; i++) {
      if (!this.isPidAlive(pid)) break
      await new Promise((r) => setTimeout(r, 100))
    }
    if (this.isPidAlive(pid)) {
      throw new Error('Local daemon shutdown is still pending; no replacement was started')
    }
    try { fs.unlinkSync(this.portFile) } catch {}
    try { fs.unlinkSync(this.pidFile) } catch {}
    try { fs.unlinkSync(this.instanceIdFile) } catch {}
    this._spawnedPid = null
    this._sessionHostPid = null
    this._sessionHostApp = null
    this._instanceId = null
  }

  private async spawnDaemon(binaryPath: string): Promise<number> {
    // Entry guard (defense in depth — ensureRunningInner checks too): every
    // unmanaged daemon process this class creates comes through here.
    this.assertNoServiceTakeover('spawn')
    fs.mkdirSync(this.daemonDir, { recursive: true })

    log.session.info('spawning local daemon', { binary: binaryPath })

    const env = await this.buildSpawnEnv()

    // Preflight the ONE thing a daemon cannot recover from: the CLI it exists to
    // spawn. The daemon inherits this env verbatim, and its spawn preamble looks
    // in the same places this resolver does (PATH, then the fallback tool
    // dirs under $HOME). A miss here means every session will exit 127, so
    // say it once, loudly, at the moment of spawn: the 2026-08-28 outage
    // reported itself only as a per-session "claude: not found" 20 times over.
    // Not fatal: the preamble also sources the user's shell rc, which can still
    // put claude on PATH, so a miss is a strong warning rather than a verdict.
    // Under vitest, sessions run the harness's stand-in instead (test-claude-guard.ts).
    this._spawnClaudeCli = testRunnerClaude() ?? resolveClaudeCliExecutable(env)
    const missing = claudeMissingAtSpawn(!!this._spawnClaudeCli, () => !!resolveClaudeCliExecutable(process.env))
    if (missing && !(await claudeCodeNotNeeded())) {
      // Not installed on this computer at all is a new user's first run: Home's setup says so
      // and installs it, so it is no error for the notification center (2026-11-09 review: a
      // fresh Walnut's bell read "Errors 2" with this line before the user did anything).
      log.session[missing === 'not-installed' ? 'warn' : 'error'](
        missing === 'not-installed'
          ? 'spawning the local daemon before Claude Code is installed: sessions start once it is'
          : 'spawning the local daemon with an environment where the claude CLI cannot be resolved: '
            + 'sessions will fail with exit 127 unless your shell rc adds it to PATH',
        {
          daemonDir: this.daemonDir,
          envHome: env.HOME,
          realHome: currentProdClaimPosture().realHome,
          pathEntries: (env.PATH ?? '').split(path.delimiter).length,
        },
      )
    }
    return this.spawnDaemonWithEnv(binaryPath, env)
  }

  /**
   * The environment the daemon is started with. Its own method so tests can
   * read what a daemon would inherit (a watchdog parent or not, the overrides)
   * without starting one.
   */
  async buildSpawnEnv(): Promise<NodeJS.ProcessEnv> {
    // Scrub test-runner identity before spawning. The daemon is long-lived shared
    // infrastructure: if a vitest-spawned process warms it, the inherited VITEST /
    // NODE_ENV=test / OPEN_WALNUT_HOME would flow daemon → every Claude CLI it
    // spawns → any `bun run dev:prod` executed inside such a CLI, and constants.ts'
    // test-guard then silently boots that "production" server against the empty
    // test-global temp dir (all sessions 404, tasks gone until the next restart).
    // Seen live 2026-07-05 (incident inc-1783280584117). The daemon itself never
    // needs these vars (it uses WALNUT_DAEMON_DIR / WALNUT_STREAMS_DIR /
    // WALNUT_HOME_OVERRIDE / HOME), so dropping them is always safe.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      WALNUT_DAEMON_DIR: this.daemonDir,
    }
    // Opt-in session-only cron policy (config session.cron_policy) — the daemon
    // reads WALNUT_ENFORCE_SESSION_CRON at boot, so it must ride the spawn env.
    // Best-effort: absent/unreadable config = default 'unrestricted' = no env
    // var = daemon does nothing.
    // Turn-error auto-retry (config session.turn_retry) rides the same
    // read-at-boot contract. Scrub any INHERITED values first: this env is built
    // from ...process.env, so a var left over from whatever spawned us must not
    // silently enable retries the user's config has turned off.
    // A remote test daemon's own identity (remote-isolation.ts), inherited when this server runs
    // inside one of its sessions: this machine's daemon is not that one.
    delete env.WALNUT_DAEMON_ISOLATED_FOR
    delete env.WALNUT_DAEMON_ORPHAN_EXIT_MS
    delete env.WALNUT_INSTALL_HOME
    delete env.WALNUT_TURN_RETRY
    delete env.WALNUT_TURN_RETRY_BUDGET_MS
    delete env.WALNUT_TURN_RETRY_MAX_ATTEMPTS
    delete env.WALNUT_TURN_RETRY_BACKOFF_MS
    delete env.WALNUT_TURN_RETRY_BACKOFF_MAX_MS
    try {
      const { getConfig } = await import('../core/config-manager.js')
      const cfg = await getConfig()
      if (cfg.session?.cron_policy === 'session-only') {
        env.WALNUT_ENFORCE_SESSION_CRON = '1'
      }
      const { buildTurnRetryEnv } = await import('./daemon-core.js')
      Object.assign(env, buildTurnRetryEnv(cfg.session?.turn_retry))
    } catch { /* config not loaded yet — default policy */ }
    // Scrub any INHERITED watchdog pid before (maybe) setting our own: for the
    // prod dir parentWatchdogEnv() returns {} and would otherwise leave a stale
    // value from an isolated-daemon-spawned CLI in place — the prod daemon's
    // watchdog would then trip on a dead pid and exit (killing its sessions once
    // the isolated-dir reap is in play). Same env-carrier chain as VITEST_*.
    delete env.WALNUT_DAEMON_PARENT_PID
    // Isolated-dir daemons die with us (see parentWatchdogEnv); prod never gets the var.
    if (!this.persistent) Object.assign(env, parentWatchdogEnv(this.daemonDir))
    delete env.VITEST
    delete env.VITEST_MODE
    delete env.VITEST_WORKER_ID
    delete env.VITEST_POOL_ID
    delete env.OPEN_WALNUT_HOME
    // The compiled file is its own daemon (`__daemon`), and it unpacks its runtime
    // tree before anything else runs. With OPEN_WALNUT_HOME gone it would unpack
    // into the REAL data home and prune other builds' trees there, even when this
    // server is a smoke boot or a test server. Hand it the tree this server runs
    // from (the same build, so the same files; runtime-tree.ts ensureRuntime).
    const compiled = singleFile()
    if (compiled) env.WALNUT_RUNTIME_DIR = path.dirname(compiled.root)
    // Legacy ephemeral marker: nothing reads it anymore (IS_EPHEMERAL is argv-based
    // now), but stale builds running inside daemon-spawned CLIs might — scrub it so
    // the daemon can never become a carrier again (incident 2026-07-14).
    delete env.OPEN_WALNUT_EPHEMERAL
    if (env.NODE_ENV === 'test') delete env.NODE_ENV
    // The clamp request describes THIS server's launch (an Interactive job). A
    // server an agent starts inside a session was not raised, so it must not
    // inherit the request through the daemon and the CLI.
    delete env[QOS_CLAMP_ENV]
    // The keep-sessions switch is one daemon's own exit policy (the cloud tunnel
    // daemon sets it through envOverrides): never inherit it.
    delete env.WALNUT_DAEMON_KEEP_SESSIONS
    // The service daemon's state dir is its own (its triggers, hooks, host copies): a daemon
    // started here is never the service, and with this var inherited from a session of the
    // service daemon it could reach that daemon's state.
    delete env.WALNUT_DAEMON_STATE_DIR
    for (const [key, value] of Object.entries(this.envOverrides)) {
      if (value === undefined) delete env[key]
      else env[key] = value
    }
    return env
  }

  private async spawnDaemonWithEnv(binaryPath: string, env: NodeJS.ProcessEnv): Promise<number> {
    // Source-fallback daemons are plain .cjs scripts (no compiled binary in
    // published npm installs), run under the current Node runtime; the compiled
    // Walnut file is its own daemon (src/binary/main.ts).
    const { cmd, args } = daemonLaunch(binaryPath, isCompiledSelf(binaryPath))

    // macOS execution identity. Without this the daemon inherits OUR responsible
    // process — the node running this server — so every file the CLI and its tools
    // read is attributed to a shared node build: the dialog says "node", the grant
    // dies with the next node upgrade, and it is shared with every other node
    // program on the machine. Launched through Walnut.app it is attributed to
    // Walnut, the app the user already grants to (src/providers/session-host.ts).
    // Note this is only needed because the server was started from a TERMINAL; a
    // server the Mac app started is already attributed to Walnut.
    //
    // Degrades on purpose: local sessions are the product, so anything wrong here
    // (no Walnut.app, an app too old to know the flag, not macOS) spawns the daemon
    // directly and says so, rather than taking local sessions down for an identity
    // upgrade.
    const host = await resolveSessionHostLaunch({
      program: cmd,
      args,
      daemonDir: this.daemonDir,
      prodDaemonDir: isProductionDaemonDir(this.daemonDir) ? this.daemonDir : localProductionDaemonDir(),
    }).catch((error: unknown): { available: false; reason: 'unsupported_app'; detail: string } => ({
      // Belt to the braces of the degradation rule: NOTHING about the identity
      // layer may turn into a thrown error that leaves the machine without local
      // sessions.
      available: false,
      reason: 'unsupported_app',
      detail: error instanceof Error ? error.message : String(error),
    }))
    if (!host.available && host.reason === 'unsupported_app') {
      log.session.error('the Walnut app could not supervise the daemon; it will run under the plain node/bun identity', {
        reason: host.reason,
        detail: host.detail,
      })
    }
    // Agent work stays in the utility QoS band when the deploy raised the server
    // above it (src/lib/background-qos.ts, opt-in); the clamp execs the program,
    // so pids are unchanged. Anywhere else the daemon inherits our band.
    const [spawnCmd, spawnArgs] = host.available
      ? withUtilityQosClamp(host.argv[0]!, host.argv.slice(1))
      : withUtilityQosClamp(cmd, args)
    // stderr → daemon-stderr.log (append, rotated). The daemon died silently
    // ≥7 times over 2026-08-11..13 with stdio:'ignore' discarding the only
    // evidence a runtime-level crash (Bun OOM/native abort) ever leaves — the
    // JS-level guards write daemon-exit-*.log, but a runtime death bypasses JS
    // entirely; this file is the last-resort black box. An inherited FILE fd
    // (not a pipe) keeps the detached daemon independent of our lifetime.
    const stderrFd = this.openStderrLog()
    // Port and pid files older than this are a dead daemon's (waitForPortFile).
    const spawnedAt = Date.now()
    const proc = spawn(spawnCmd, spawnArgs, {
      detached: true,
      cwd: this.daemonDir,
      stdio: ['ignore', 'ignore', stderrFd ?? 'ignore'],
      // Pass our daemonDir to the spawned binary so it writes its port/pid/streams
      // into the SAME dir this LocalDaemon instance watches. Without this the
      // daemonDir override is inert (binary defaults to /tmp/open-walnut). For
      // production daemonDir === '/tmp/open-walnut' so this is a no-op.
      env,
    })
    // The child holds its own dup of the fd; release ours immediately.
    if (stderrFd !== null) { try { fs.closeSync(stderrFd) } catch { /* already closed */ } }
    // Under the host, `proc` is the SUPERVISOR, not the daemon. Recording its pid
    // as the daemon's would make every later liveness check, owner stamp and stop
    // path aim at the wrong process, so it is kept apart and the daemon's own pid
    // file (written a moment later, next to the port file) stays the answer.
    this._sessionHostPid = host.available ? proc.pid ?? null : null
    this._sessionHostApp = host.available ? host.app : null
    this._spawnedPid = host.available ? null : proc.pid ?? null
    proc.unref()

    // Capture async spawn errors (ENOENT, EACCES) so they surface as rejection
    // instead of "unhandled error" crashes. The listener is single-use — once
    // spawn completes (error or success), nothing more arrives.
    let spawnError: Error | null = null
    proc.on('error', (err) => { spawnError = err })

    // Wait for port file (daemon writes it on startup)
    let port = await this.waitForPortFile(10000, spawnedAt)
    if (spawnError) {
      throw new Error(`Local daemon spawn failed: ${(spawnError as Error).message}`)
    }
    // The host refused, or died before its daemon came up. An identity upgrade
    // must never be able to leave the machine with no local sessions, so fall
    // back to the direct spawn once and say exactly what happened. The decision
    // (and the reason a retry is safe in exactly one case) lives in
    // classifySessionHostStart, where a fixture can pin all eight combinations:
    // this path is unreachable from a test on purpose, since the host never
    // engages for an isolated daemon dir.
    const hostPid = this._sessionHostPid
    const hostAlive = (): boolean => hostPid !== null && this.isPidAlive(hostPid)
    let startVerdict = classifySessionHostStart({ portFileSeen: port !== null, hostUsed: host.available, hostAlive: hostAlive() })
    if (startVerdict.verdict === 'wait_longer') {
      log.session.warn('the daemon is slow to start under the Walnut Sessions host; waiting longer', {
        host: this._sessionHostApp, hostPid, waitMs: SESSION_HOST_LATE_START_MS,
      })
      port = await this.waitForPortFile(SESSION_HOST_LATE_START_MS, spawnedAt)
      if (spawnError) {
        throw new Error(`Local daemon spawn failed: ${(spawnError as Error).message}`)
      }
      startVerdict = classifySessionHostStart({
        portFileSeen: port !== null, hostUsed: host.available, hostAlive: hostAlive(), graceSpent: true,
      })
    }
    // A warning, not an error: when this ends in a throw the caller reports it
    // (the boot's "failed to start local daemon" card), and a direct retry is
    // judged by its own outcome. One failure, one card.
    if (startVerdict.verdict !== 'started' && host.available) {
      log.session.warn('the daemon did not start under the Walnut Sessions host', {
        host: host.app,
        hostPid,
        reason: startVerdict.reason,
        stderrLog: path.join(this.daemonDir, 'daemon-stderr.log'),
        retryingDirectly: startVerdict.verdict === 'retry_directly',
      })
    }
    if (startVerdict.verdict === 'retry_directly') {
      this._sessionHostPid = null
      this._sessionHostApp = null
      const retryFd = this.openStderrLog()
      const [retryCmd, retryArgs] = withUtilityQosClamp(cmd, args)
      const retriedAt = Date.now()
      const retry = spawn(retryCmd, retryArgs, {
        detached: true,
        cwd: this.daemonDir,
        stdio: ['ignore', 'ignore', retryFd ?? 'ignore'],
        env,
      })
      if (retryFd !== null) { try { fs.closeSync(retryFd) } catch { /* already closed */ } }
      this._spawnedPid = retry.pid ?? null
      retry.unref()
      retry.on('error', (err) => { spawnError = err })
      port = await this.waitForPortFile(10000, retriedAt)
      if (spawnError) {
        throw new Error(`Local daemon spawn failed: ${(spawnError as Error).message}`)
      }
    }
    if (!port) {
      if (startVerdict.reason === 'host_still_running') {
        // Deliberately NOT retried: see classifySessionHostStart. Name the host
        // so the operator knows which process to look at, and point at the log
        // that holds the daemon's own last words.
        throw new Error(
          `Local daemon failed to start — port file not created within ${(10_000 + SESSION_HOST_LATE_START_MS) / 1000}s, and the Walnut Sessions `
          + `host (pid ${hostPid}) is still running, so a second spawn could race a daemon that is `
          + `about to come up. Check ${path.join(this.daemonDir, 'daemon-stderr.log')}, or set `
          + 'WALNUT_SESSION_HOST=0 to start the daemon without the identity host.',
        )
      }
      const stale = this.readPortFile()
      throw new Error(stale
        ? `Local daemon failed to start: within 10s nothing answered on port ${stale}, the port its port file names (a dead daemon's files, or a new one that did not come up)`
        : 'Local daemon failed to start: port file not created within 10s')
    }

    // Verify it responds
    const result = await this.ping(port)
    if (!result.alive) {
      throw new Error(`Local daemon started (port ${port}) but not responding to hello`)
    }
    if (result.instanceId) this._instanceId = result.instanceId

    return port
  }

  /**
   * Open <daemonDir>/daemon-stderr.log for append, rotating to .1 when it
   * exceeds the cap so an error loop can't grow it without bound. Returns
   * null on any failure — stderr capture is diagnostics, never a reason to
   * refuse spawning the daemon.
   */
  private openStderrLog(): number | null {
    const STDERR_LOG_MAX_BYTES = 5 * 1024 * 1024
    const logPath = path.join(this.daemonDir, 'daemon-stderr.log')
    try {
      try {
        if (fs.statSync(logPath).size > STDERR_LOG_MAX_BYTES) {
          fs.renameSync(logPath, logPath + '.1') // keep exactly one generation
        }
      } catch { /* absent or unstat-able — fresh file below */ }
      return fs.openSync(logPath, 'a')
    } catch (err) {
      log.session.warn('daemon stderr log open failed — spawning without capture', {
        logPath, error: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }

  private findDaemonBinary(): string | Promise<string> {
    if (this.overrideBinaryPath) return this.overrideBinaryPath
    // The compiled Walnut file carries the full daemon (`walnut __daemon`), so it
    // never needs a separate binary or the source fallback.
    if (singleFile()) return process.execPath
    // DAEMON_BINARIES_DIR is the canonical build output location
    const hit = pickDaemonBinary(
      [DAEMON_BINARIES_DIR, path.join(__dirname, '..', '..', 'dist', 'daemon-binaries')],
      getLocalDaemonBinaryName(),
    )
    if (hit) return hit
    // No compiled binary — the published npm package (bun binaries are ~280MB
    // and excluded from the tarball), or a non-darwin-arm64 host. Materialize
    // the embedded daemon source (same code SSH source-deploys ship to remote
    // hosts) and run it under the current Node. Feature scope matches the
    // source twin — see daemon-source.ts.
    return this.materializeSourceDaemon()
  }

  /**
   * Write the embedded daemon source to <daemonDir>/daemon-fallback.cjs and
   * return that path. spawnDaemon() detects the .cjs suffix and runs it with
   * process.execPath. A .version sidecar mirrors the binary convention so the
   * version-mismatch restart logic works unchanged — on package upgrade the
   * stamped version changes, the running daemon reports the old one, and
   * ensureRunningInner() restarts it with the new source.
   */
  /** The build of the daemon that started here last (it writes daemon.version at its start), or null. */
  private lastStartedVersion(): string | null {
    try { return fs.readFileSync(path.join(this.daemonDir, 'daemon.version'), 'utf8').trim() || null } catch { return null }
  }

  private async materializeSourceDaemon(): Promise<string> {
    const scriptPath = path.join(this.daemonDir, 'daemon-fallback.cjs')
    const source = getDaemonSource()
    const sourceHash = createHash('sha256').update(source).digest('hex').slice(0, 12)
    const hashFile = `${scriptPath}.sha256`

    // Async file work: the server's event loop runs this on every start check (2026-11-04 review 5).
    await fsp.mkdir(this.daemonDir, { recursive: true })
    const existingHash = (await fsp.readFile(hashFile, 'utf-8').catch(() => '')).trim() || null
    if (existingHash !== sourceHash) {
      // The files the running daemon was started from stay as the fallback for its replacement
      // (local-daemon-replace.ts); while it is on its probation, beside the build before it, which
      // stays the way back till it passed (2026-11-04 review 6: they took its place).
      const running = this.lastStartedVersion()
      const slot = running && this._stay.watching(running) ? 'next' : 'previous'
      if (existingHash) await keepPreviousSource(this.daemonDir, ['daemon-fallback.cjs', 'daemon-fallback.cjs.version', ...SOURCE_SIDECARS], running, undefined, this.keepsDurable, slot)
      await fsp.writeFile(scriptPath, source, 'utf-8')
      await fsp.writeFile(`${scriptPath}.version`, resolveDaemonSourceVersion(), 'utf-8')
      await fsp.writeFile(hashFile, sourceHash, 'utf-8')
      log.session.info('materialized source-fallback local daemon', { scriptPath, sourceHash })
    }
    // Sidecar bundles — the template require()s each next to itself and
    // advertises the matching capability only when the load succeeds.
    // Best-effort per file: an absent bundle (published npm package) just means
    // the server keeps its own fallback for that feature.
    // acp-daemon-core.cjs is local-only on purpose: ACP engines never run on a
    // remote host, so daemon-connection's remote deploy list leaves it out.
    for (const sidecarFile of SOURCE_SIDECARS) {
      try {
        const sidecarSrc = path.join(DAEMON_BINARIES_DIR, sidecarFile)
        const sidecarDst = path.join(this.daemonDir, sidecarFile)
        await fsp.copyFile(sidecarSrc, sidecarDst)
      } catch { /* absent, or not copied: the server-side fallback stays */ }
    }
    return scriptPath
  }

  private readBinaryVersion(binaryPath: string): string | null {
    if (isCompiledSelf(binaryPath)) {
      // An npm update replaced the file this server runs from: a daemon started now runs
      // the new version, so insisting on this build's would restart the daemon on every
      // check, each restart spawning the same new file. Keep the daemon that runs; the
      // next start of the server is the new version too.
      if (execFileReplaced()) return null
      return singleFile()!.daemonVersion
    }
    try {
      return fs.readFileSync(`${binaryPath}.version`, 'utf-8').trim()
    } catch {
      return null
    }
  }

  // 10s allows for: binary exec, Bun runtime init, directory creation,
  // socket bind, and port file write. Empirically sufficient for all tested hardware.
  /**
   * The port of the daemon just spawned (at `spawnedAt`): its port file and a live
   * pid in its pid file. A live pid is not proof on its own: after a restart (a
   * container's above all) the pid a dead daemon left may name another process,
   * and taking that daemon's stale port failed the start with "not responding to
   * hello" until the next try. So files older than the spawn count only when a
   * daemon answers hello on that port; the new daemon's own files (written after
   * the spawn) are taken at once, and a slow first hello is the caller's ping to judge.
   */
  private async waitForPortFile(timeoutMs: number, spawnedAt: number): Promise<number | null> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const port = this.readPortFile()
      if (port) {
        const pid = this.readPidFile()
        if (pid && this.isPidAlive(pid)) {
          if (this.writtenSince(spawnedAt)) return port
          if ((await this.ping(port, 1000)).alive) return port
        }
      }
      await new Promise(r => setTimeout(r, 200))
    }
    return null
  }

  /**
   * Both the port file and the pid file were written at or after `at` (ms epoch).
   * A second of slack: some file systems keep whole seconds, and a dead daemon's
   * files are older than that (it was found dead before the spawn).
   */
  private writtenSince(at: number): boolean {
    try {
      return fs.statSync(this.portFile).mtimeMs >= at - 1000 && fs.statSync(this.pidFile).mtimeMs >= at - 1000
    } catch {
      return false
    }
  }
}

export const localDaemon = new LocalDaemon()
