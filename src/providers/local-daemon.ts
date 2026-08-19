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
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { WebSocket } from 'ws'
import { log } from '../logging/index.js'
import { DAEMON_BINARIES_DIR } from '../constants.js'
import { getDaemonSource, resolveDaemonSourceVersion } from './daemon-source.js'

// Env-aware default so the singleton (exported below) isolates a demo server's
// daemon when WALNUT_DAEMON_DIR is set. Tests pass `daemonDir` explicitly and are
// unaffected. Production sets nothing → /tmp/open-walnut.
const PROD_DAEMON_DIR = '/tmp/open-walnut'
const DEFAULT_DAEMON_DIR = process.env.WALNUT_DAEMON_DIR || PROD_DAEMON_DIR

export function getLocalDaemonBinaryName(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  return `daemon-${platform}-${arch}`
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

// True when running under vitest (or any test runner that sets NODE_ENV=test).
// Used by ensureRunning() to refuse touching the production daemon dir.
const IS_TEST_ENV = !!(process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.NODE_ENV === 'test')

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
  private _instanceId: string | null = null
  private _ensureInFlight: Promise<number> | null = null
  private readonly daemonDir: string
  private readonly portFile: string
  private readonly pidFile: string
  private readonly instanceIdFile: string
  private readonly overrideBinaryPath: string | undefined

  constructor(opts: LocalDaemonOptions = {}) {
    this.daemonDir = opts.daemonDir ?? DEFAULT_DAEMON_DIR
    this.portFile = path.join(this.daemonDir, 'daemon.port')
    this.pidFile = path.join(this.daemonDir, 'daemon.pid')
    this.instanceIdFile = path.join(this.daemonDir, 'daemon.instance')
    this.overrideBinaryPath = opts.binaryPath
  }

  get port(): number | null { return this._port }
  get wsUrl(): string | null { return this._wsUrl }
  /** PID of the daemon process we spawned, or pid from daemon.pid file as fallback. Null if unknown. */
  get pid(): number | null { return this._spawnedPid ?? this.readPidFile() }
  /** Daemon instance ID (from hello or on-disk). Null if daemon hasn't been contacted. */
  get instanceId(): string | null { return this._instanceId ?? this.readInstanceIdFile() }

  async ensureRunning(): Promise<number> {
    // Test guard: a vitest-spawned server (e.g. an e2e's startServer()) must NEVER
    // touch the production daemon at /tmp/open-walnut — it would (a) restart it on
    // any version mismatch, killing live session plumbing, and (b) warm a daemon
    // that inherits the test env (VITEST / OPEN_WALNUT_HOME), poisoning every
    // Claude CLI it later spawns (incident inc-1783280584117: a dev:prod run inside
    // such a CLI booted a "production" 3456 against the empty test-global home —
    // every session 404'd). Tests that intentionally exercise a real daemon must
    // opt in via WALNUT_DAEMON_DIR or an explicit `daemonDir`. startServer() catches
    // this throw and logs "local sessions will fail" — the right outcome for tests
    // that mock the daemon transport anyway.
    if (IS_TEST_ENV && path.resolve(this.daemonDir) === '/tmp/open-walnut') {
      throw new Error(
        'Refusing to touch the production daemon dir /tmp/open-walnut from a test process. ' +
        'Set WALNUT_DAEMON_DIR to an isolated temp dir (or pass daemonDir explicitly).',
      )
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
    const existingPort = this.readPortFile()
    if (existingPort) {
      const helloResult = await this.ping(existingPort)
      if (helloResult.alive) {
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

    // 3. Spawn fresh daemon
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
    return port
  }

  getDirectWsUrl(): string {
    if (!this._wsUrl) throw new Error('Local daemon not running. Call ensureRunning() first.')
    return this._wsUrl
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
      const pid = parseInt(content, 10)
      return pid > 0 ? pid : null
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

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
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
    const pid = this.readPidFile()
    if (!pid) return
    try { process.kill(pid, 'SIGTERM') } catch { return }

    // Wait for shutdown (up to 5s)
    for (let i = 0; i < 50; i++) {
      if (!this.isPidAlive(pid)) break
      await new Promise((r) => setTimeout(r, 100))
    }
    // Force kill if still alive
    if (this.isPidAlive(pid)) {
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
    try { fs.unlinkSync(this.portFile) } catch {}
    try { fs.unlinkSync(this.pidFile) } catch {}
    try { fs.unlinkSync(this.instanceIdFile) } catch {}
    this._spawnedPid = null
    this._instanceId = null
  }

  private async spawnDaemon(binaryPath: string): Promise<number> {
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

    // Source-fallback daemons are plain .cjs scripts (no compiled binary in
    // published npm installs) — run them under the current Node runtime.
    const isSourceScript = binaryPath.endsWith('.cjs') || binaryPath.endsWith('.js')
    const [cmd, args] = isSourceScript
      ? [process.execPath, [binaryPath, '--start']]
      : [binaryPath, ['--start']]
    // stderr → daemon-stderr.log (append, rotated). The daemon died silently
    // ≥7 times over 2026-08-11..13 with stdio:'ignore' discarding the only
    // evidence a runtime-level crash (Bun OOM/native abort) ever leaves — the
    // JS-level guards write daemon-exit-*.log, but a runtime death bypasses JS
    // entirely; this file is the last-resort black box. An inherited FILE fd
    // (not a pipe) keeps the detached daemon independent of our lifetime.
    const stderrFd = this.openStderrLog()
    const proc = spawn(cmd, args, {
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
    this._spawnedPid = proc.pid ?? null
    proc.unref()

    // Capture async spawn errors (ENOENT, EACCES) so they surface as rejection
    // instead of "unhandled error" crashes. The listener is single-use — once
    // spawn completes (error or success), nothing more arrives.
    let spawnError: Error | null = null
    proc.on('error', (err) => { spawnError = err })

    // Wait for port file (daemon writes it on startup)
    const port = await this.waitForPortFile(10000)
    if (spawnError) {
      throw new Error(`Local daemon spawn failed: ${(spawnError as Error).message}`)
    }
    if (!port) {
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
    const binaryName = getLocalDaemonBinaryName()
    const candidates = [
      path.join(DAEMON_BINARIES_DIR, binaryName),
      path.join(__dirname, '..', '..', 'dist', 'daemon-binaries', binaryName),
    ]
    for (const p of candidates) {
      if (fs.existsSync(p)) return p
    }
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
    for (const sidecarFile of ['changes-core.cjs', 'path-resolve-core.cjs']) {
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
