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
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { WebSocket } from 'ws'
import { log } from '../logging/index.js'
import { DAEMON_BINARIES_DIR } from '../constants.js'
import { DAEMON_SERVICE_PLIST_NAME, DAEMON_SERVICE_UNIT_NAME } from './daemon-service-config.js'
import { resolveClaudeCliExecutable } from '../core/claude-cli-detect.js'
import {
  DAEMON_OWNER_FILE,
  PROD_DAEMON_DIR,
  classifyAdoptedDaemonOwner,
  currentProdClaimPosture,
  ownerAuditKey,
  prodDaemonClaimRefusal,
  type DaemonOwnerStamp,
} from './daemon-ownership.js'
import { getDaemonSource, resolveDaemonSourceVersion } from './daemon-source.js'
import { resolveSessionHostLaunch } from './session-host.js'
import { classifySessionHostStart } from './session-host-core.js'

// Env-aware default so the singleton (exported below) isolates a demo server's
// daemon when WALNUT_DAEMON_DIR is set. Tests pass `daemonDir` explicitly and are
// unaffected. Production sets nothing → /tmp/open-walnut.
const DEFAULT_DAEMON_DIR = process.env.WALNUT_DAEMON_DIR || PROD_DAEMON_DIR

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
  if (path.resolve(daemonDir) === PROD_DAEMON_DIR) return {}
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
  if (platform === 'darwin') {
    return [path.join(home, 'Library', 'LaunchAgents', DAEMON_SERVICE_PLIST_NAME)]
  }
  if (platform === 'linux') {
    return [
      path.join(home, '.config', 'systemd', 'user', DAEMON_SERVICE_UNIT_NAME),
      path.join('/etc', 'systemd', 'system', DAEMON_SERVICE_UNIT_NAME),
    ]
  }
  return []
}

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

  constructor(opts: LocalDaemonOptions = {}) {
    this.daemonDir = opts.daemonDir ?? DEFAULT_DAEMON_DIR
    this.portFile = path.join(this.daemonDir, 'daemon.port')
    this.pidFile = path.join(this.daemonDir, 'daemon.pid')
    this.instanceIdFile = path.join(this.daemonDir, 'daemon.instance')
    this.ownerFile = path.join(this.daemonDir, DAEMON_OWNER_FILE)
    this.overrideBinaryPath = opts.binaryPath
  }

  get port(): number | null { return this._port }
  get wsUrl(): string | null { return this._wsUrl }
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
    // Posture guard: only an instance running as the real user may claim the
    // production daemon (daemon-ownership.ts documents the two incidents this
    // encodes and the one posture that is deliberately still allowed). It must
    // refuse ADOPTION too, not just spawning: a foreign-posture server driving
    // production's daemon would restart it on any version mismatch and inject
    // its own registry into it. Tests and demos that want a real daemon opt in
    // via WALNUT_DAEMON_DIR or an explicit `daemonDir`. startServer() catches
    // this throw and logs "local sessions will fail", which is the right outcome
    // for a process that should not have local sessions in the first place.
    if (path.resolve(this.daemonDir) === PROD_DAEMON_DIR) {
      const refusal = prodDaemonClaimRefusal(currentProdClaimPosture())
      if (refusal) throw new Error(refusal)
    }
    // In-flight guard: server startup, session-manager lazy init, and
    // reconnect callbacks all call this concurrently. Without it each caller
    // independently saw "no daemon" and spawned its own (observed: ~20 spawns
    // in 35s during one cold start). Concurrent callers share one attempt;
    // the promise clears on settle so a later call can retry after failure.
    if (this._ensureInFlight) return this._ensureInFlight
    this._ensureInFlight = this.ensureRunningInner().finally(() => {
      this._ensureInFlight = null
    })
    return this._ensureInFlight
  }

  private async ensureRunningInner(): Promise<number> {
    const binaryPath = this.findDaemonBinary()
    const expectedVersion = this.readBinaryVersion(binaryPath)

    // 1. Check if daemon is already running
    let existingPort = this.readPortFile()
    if (existingPort) {
      let helloResult = await this.ping(existingPort)
      if (helloResult.alive) {
        if (helloResult.capabilities?.includes('cron-supervision-v1')) {
          if (expectedVersion && helloResult.version !== expectedVersion) {
            const updatedPort = await this.updateManagedDaemon(binaryPath, expectedVersion)
            if (updatedPort !== null) {
              existingPort = updatedPort
              helloResult = await this.ping(updatedPort)
              if (!helloResult.alive || helloResult.version !== expectedVersion) throw new Error('Updated managed daemon did not answer with the expected version')
            } else {
              log.session.error('Managed local daemon version differs; automatic update was deferred; use walnut daemon install --yes --executable <daemon binary>', {
                running: helloResult.version, expected: expectedVersion,
              })
            }
          }
          this._port = existingPort
          this._wsUrl = `ws://localhost:${existingPort}`
          this._instanceId = helloResult.instanceId ?? this.readInstanceIdFile()
          this.auditOwnerOnAdopt(this._instanceId)
          return existingPort
        }
        // 2. Check version — auto-restart if stale
        if (expectedVersion && helloResult.version && helloResult.version !== expectedVersion) {
          // Upgrade-vs-live-work guard: restarting the daemon closes every ACP
          // worker's stdin → turn-interrupted:shutdown for whatever the user is
          // mid-flight on (each dev:prod deploy used to kill live codex turns —
          // 6 shutdowns across 3 days on one session). The daemon advertises
          // open turns in acp-busy.json; while any are open, keep the old
          // daemon and let a later ensureRunning() (post-turn) do the upgrade.
          const busySids = this.readAcpBusySids()
          if (busySids.length > 0) {
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
            return existingPort
          }
          log.session.info('local daemon version mismatch — restarting', {
            running: helloResult.version,
            expected: expectedVersion,
            runningInstanceId: helloResult.instanceId,
          })
          await this.stopDaemon()
        } else {
          this._port = existingPort
          this._wsUrl = `ws://localhost:${existingPort}`
          this._instanceId = helloResult.instanceId ?? this.readInstanceIdFile()
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
    // handover refusal loop. spawnDaemon() re-checks at its own entry.
    this.assertNoServiceTakeover('spawn')
    const port = await this.spawnDaemon(binaryPath)
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

  private async updateManagedDaemon(binaryPath: string, expected: string): Promise<number | null> {
    if (path.resolve(this.daemonDir) !== PROD_DAEMON_DIR || binaryPath.endsWith('.cjs')) return null
    const takeover = this.detectServiceTakeover()
    const configs = daemonServiceConfigPaths()
    if (takeover.unknown.length || !configs[0] || !takeover.present.includes(configs[0])
      || configs.slice(1).some((config) => takeover.present.includes(config))) return null
    if (this._lastManagedUpdate?.expected === expected && Date.now() - this._lastManagedUpdate.at < 600_000) return null
    this._lastManagedUpdate = { expected, at: Date.now() }
    const { runDaemonServiceCommand } = await import('./daemon-service-cli.js')
    const result = await runDaemonServiceCommand(binaryPath, ['walnut', 'daemon', 'update', '--yes', '--scope', 'user', '--executable', binaryPath])
    if (result.code !== 0) throw new Error(`Managed daemon update failed; no unmanaged replacement was started: ${result.stdout || result.stderr}`)
    const reply = JSON.parse(result.stdout) as { ok?: boolean }
    if (reply.ok !== true) throw new Error('Managed daemon update was not confirmed')
    const port = this.readPortFile()
    if (!port) throw new Error('Managed daemon update returned without a runtime port')
    return port
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
   * Scope matters: the installer hardcodes the production runtime dir
   * (/tmp/open-walnut), so an isolated dir (tests, sandbox, ephemeral demo) is
   * never governed by a persistent config — only by a `daemon.service` marker
   * inside its own dir, which exists exactly when a `--service` daemon claimed
   * it. Without that scoping, one installed LaunchAgent would make every test
   * server on the machine refuse to spawn its own throwaway daemon.
   */
  private detectServiceTakeover(): ServiceTakeover {
    const files = [path.join(this.daemonDir, 'daemon.service')]
    if (path.resolve(this.daemonDir) === PROD_DAEMON_DIR) files.push(...daemonServiceConfigPaths())
    return classifyServiceTakeover(files.map((file) => ({ path: file, state: this.probeServiceConfig(file) })))
  }

  private probeServiceConfig(file: string): ServiceProbeState {
    try {
      fs.lstatSync(file)
      return 'present'
    } catch (err) {
      return classifyServiceConfigError(err)
    }
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

  private async ping(port: number): Promise<{ alive: boolean; version?: string; capabilities?: string[]; instanceId?: string }> {
    return new Promise((resolve) => {
      // 2s is generous for localhost WebSocket (typically <10ms) but handles
      // daemon startup jitter. This blocks Walnut server startup, so keep short.
      const timeout = setTimeout(() => { resolve({ alive: false }) }, 2000)
      try {
        const ws = new WebSocket(`ws://localhost:${port}`)
        ws.on('open', () => {
          ws.send(JSON.stringify({ id: 1, cmd: 'hello' }))
        })
        ws.on('message', (data) => {
          clearTimeout(timeout)
          ws.close()
          try {
            const msg = JSON.parse(data.toString()) as {
              ok?: boolean; version?: string; capabilities?: string[]; instanceId?: string
            }
            resolve({
              alive: msg.ok === true,
              version: msg.version,
              capabilities: msg.capabilities,
              instanceId: msg.instanceId,
            })
          } catch {
            resolve({ alive: false })
          }
        })
        ws.on('error', () => { clearTimeout(timeout); resolve({ alive: false }) })
      } catch {
        clearTimeout(timeout)
        resolve({ alive: false })
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
    if (path.resolve(this.daemonDir) === PROD_DAEMON_DIR) return
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

    // Scrub test-runner identity before spawning. The daemon is long-lived shared
    // infrastructure: if a vitest-spawned process warms it, the inherited VITEST /
    // NODE_ENV=test / OPEN_WALNUT_HOME would flow daemon → every Claude CLI it
    // spawns → any `npm run dev:prod` executed inside such a CLI, and constants.ts'
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
    Object.assign(env, parentWatchdogEnv(this.daemonDir))
    delete env.VITEST
    delete env.VITEST_MODE
    delete env.VITEST_WORKER_ID
    delete env.VITEST_POOL_ID
    delete env.OPEN_WALNUT_HOME
    // Legacy ephemeral marker: nothing reads it anymore (IS_EPHEMERAL is argv-based
    // now), but stale builds running inside daemon-spawned CLIs might — scrub it so
    // the daemon can never become a carrier again (incident 2026-07-14).
    delete env.OPEN_WALNUT_EPHEMERAL
    if (env.NODE_ENV === 'test') delete env.NODE_ENV

    // Preflight the ONE thing a daemon cannot recover from: the CLI it exists to
    // spawn. The daemon inherits this env verbatim, and its spawn preamble looks
    // in the same places this resolver does (PATH, then $HOME/.toolbox/bin,
    // $HOME/.local/bin, …). A miss here means every session will exit 127, so
    // say it once, loudly, at the moment of spawn — the 2026-08-28 outage
    // reported itself only as a per-session "claude: not found" 20 times over.
    // Not fatal: the preamble also sources the user's shell rc, which can still
    // put claude on PATH, so a miss is a strong warning rather than a verdict.
    this._spawnClaudeCli = resolveClaudeCliExecutable(env)
    if (!this._spawnClaudeCli) {
      log.session.error(
        'spawning the local daemon with an environment where the claude CLI cannot be resolved — '
        + 'sessions will fail with exit 127 unless your shell rc adds it to PATH',
        {
          daemonDir: this.daemonDir,
          envHome: env.HOME,
          realHome: currentProdClaimPosture().realHome,
          pathEntries: (env.PATH ?? '').split(path.delimiter).length,
        },
      )
    }

    // Source-fallback daemons are plain .cjs scripts (no compiled binary in
    // published npm installs) — run them under the current Node runtime.
    const isSourceScript = binaryPath.endsWith('.cjs') || binaryPath.endsWith('.js')
    const [cmd, args] = isSourceScript
      ? [process.execPath, [binaryPath, '--start']]
      : [binaryPath, ['--start']]

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
      prodDaemonDir: PROD_DAEMON_DIR,
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
    const [spawnCmd, spawnArgs] = host.available ? [host.argv[0]!, host.argv.slice(1)] : [cmd, args]
    // stderr → daemon-stderr.log (append, rotated). The daemon died silently
    // ≥7 times over 2026-08-11..13 with stdio:'ignore' discarding the only
    // evidence a runtime-level crash (Bun OOM/native abort) ever leaves — the
    // JS-level guards write daemon-exit-*.log, but a runtime death bypasses JS
    // entirely; this file is the last-resort black box. An inherited FILE fd
    // (not a pipe) keeps the detached daemon independent of our lifetime.
    const stderrFd = this.openStderrLog()
    const proc = spawn(spawnCmd, spawnArgs, {
      detached: true,
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
    let port = await this.waitForPortFile(10000)
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
    const startVerdict = classifySessionHostStart({
      portFileSeen: port !== null,
      hostUsed: host.available,
      hostAlive: hostPid !== null && this.isPidAlive(hostPid),
    })
    if (startVerdict.verdict !== 'started' && host.available) {
      log.session.error('the daemon did not start under the Walnut Sessions host', {
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
      const retry = spawn(cmd, args, {
        detached: true,
        stdio: ['ignore', 'ignore', retryFd ?? 'ignore'],
        env,
      })
      if (retryFd !== null) { try { fs.closeSync(retryFd) } catch { /* already closed */ } }
      this._spawnedPid = retry.pid ?? null
      retry.unref()
      retry.on('error', (err) => { spawnError = err })
      port = await this.waitForPortFile(10000)
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
          'Local daemon failed to start — port file not created within 10s, and the Walnut Sessions '
          + `host (pid ${hostPid}) is still running, so a second spawn could race a daemon that is `
          + `about to come up. Check ${path.join(this.daemonDir, 'daemon-stderr.log')}, or set `
          + 'WALNUT_SESSION_HOST=0 to start the daemon without the identity host.',
        )
      }
      throw new Error('Local daemon failed to start — port file not created within 10s')
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

  private findDaemonBinary(): string {
    if (this.overrideBinaryPath) return this.overrideBinaryPath
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
  private materializeSourceDaemon(): string {
    const scriptPath = path.join(this.daemonDir, 'daemon-fallback.cjs')
    const source = getDaemonSource()
    const sourceHash = createHash('sha256').update(source).digest('hex').slice(0, 12)
    const hashFile = `${scriptPath}.sha256`

    fs.mkdirSync(this.daemonDir, { recursive: true })
    let existingHash: string | null = null
    try { existingHash = fs.readFileSync(hashFile, 'utf-8').trim() } catch { /* first run */ }
    if (existingHash !== sourceHash) {
      fs.writeFileSync(scriptPath, source, 'utf-8')
      fs.writeFileSync(`${scriptPath}.version`, resolveDaemonSourceVersion(), 'utf-8')
      fs.writeFileSync(hashFile, sourceHash, 'utf-8')
      log.session.info('materialized source-fallback local daemon', { scriptPath, sourceHash })
    }
    // Sidecar bundles — the template require()s each next to itself and
    // advertises the matching capability only when the load succeeds.
    // Best-effort per file: an absent bundle (published npm package) just means
    // the server keeps its own fallback for that feature.
    for (const sidecarFile of ['changes-core.cjs', 'path-resolve-core.cjs', 'transcript-rewind-core.cjs', 'trigger-check-core.cjs', 'daemon-cron-runtime.cjs', 'daemon-instance-lock.cjs', 'daemon-service-cli.cjs']) {
      try {
        const sidecarSrc = path.join(DAEMON_BINARIES_DIR, sidecarFile)
        const sidecarDst = path.join(this.daemonDir, sidecarFile)
        if (fs.existsSync(sidecarSrc)) fs.copyFileSync(sidecarSrc, sidecarDst)
      } catch { /* server-side fallback stays */ }
    }
    return scriptPath
  }

  private readBinaryVersion(binaryPath: string): string | null {
    try {
      return fs.readFileSync(`${binaryPath}.version`, 'utf-8').trim()
    } catch {
      return null
    }
  }

  // 10s allows for: binary exec, Bun runtime init, directory creation,
  // socket bind, and port file write. Empirically sufficient for all tested hardware.
  private async waitForPortFile(timeoutMs: number): Promise<number | null> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const port = this.readPortFile()
      if (port) {
        // Verify it's a fresh port (not stale from old daemon)
        const pid = this.readPidFile()
        if (pid && this.isPidAlive(pid)) {
          return port
        }
      }
      await new Promise(r => setTimeout(r, 200))
    }
    return null
  }
}

export const localDaemon = new LocalDaemon()
