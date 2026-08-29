/**
 * CLI command: open-walnut web [--port 3456] [--dev] [--ephemeral] [--_ephemeral-child]
 * Starts the Express + WebSocket server.
 *
 * --ephemeral: Two-phase daemon pattern for agent testing:
 *   1. Launcher (parent): copies ~/.open-walnut/ to /tmp/open-walnut-{PPID}-{random}/,
 *      spawns a detached child, polls for port, prints JSON, exits.
 *   2. Child (--_ephemeral-child): runs the real server on a random port,
 *      writes ephemeral.json, self-destructs after 10 min of idle.
 *
 * Supports up to 3 concurrent agents — each gets its own tmpdir and port.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  registryPath,
  registerEphemeralDir,
  unregisterEphemeralDir,
  reapStaleEphemeralDirs,
  countLiveEphemeralServers,
} from './ephemeral-registry.js'

/** Auto-shutdown after 10 minutes of no HTTP requests. */
const EPHEMERAL_IDLE_TTL_MS = 10 * 60 * 1000

/** How often to check for idle timeout (milliseconds). */
const IDLE_CHECK_INTERVAL_MS = 60 * 1000

/** Max time to wait for the child server to write ephemeral.json. */
const POLL_TIMEOUT_MS = 15_000

/** Poll interval when waiting for ephemeral.json. */
const POLL_INTERVAL_MS = 200

/** Maximum concurrent ephemeral servers (each is a full Express + WS server). */
const DEFAULT_EPHEMERAL_LIMIT = 3

/**
 * Top-level WALNUT_HOME entries the ephemeral snapshot does not copy because
 * their owners already treat them as regenerable. See the filter in
 * runEphemeralLauncher() for the measured sizes and the anchoring rationale.
 */
const SNAPSHOT_SKIP_TOP_LEVEL = new Set(['.git', '.smart-env', 'cache'])

export async function runWeb(options: {
  port?: string
  dev?: boolean
  ephemeral?: boolean
  _ephemeralChild?: boolean
}): Promise<void> {
  if (options._ephemeralChild) {
    return runEphemeralChild()
  }

  if (options.ephemeral) {
    return runEphemeralLauncher()
  }

  // Normal server
  // Note: ephemeral WALNUT_HOME guard is in constants.ts (must run at import time,
  // before any derived paths are computed). See resolveWalnutHome() there.

  // Native addons (better-sqlite3) are compiled against one Node ABI. If the
  // running Node differs, the task store can't open and startup dies with an
  // opaque "prewarm failed". Repair it in place instead of requiring a Node
  // version pin to stay in sync forever. Advisory: never exits.
  const { ensureNativeModulesLoadable } = await import('../core/native-abi-preflight.js')
  try {
    ensureNativeModulesLoadable()
  } catch (err) {
    process.stderr.write(
      `native module preflight errored (continuing): ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }

  // Sanity check: dist/daemon-binaries/*.version must match current daemon source.
  // If not, auto-rebuild. This is the belt to the suspenders of `npm run build`
  // auto-building daemon — catches someone running `node dist/cli.js web`
  // directly after editing daemon source.
  //
  // ⚠️ ADVISORY ONLY — NEVER exit on the result. This used to `process.exit(1)`
  // on a failed/non-converging rebuild, which crash-looped a production server
  // 41 times over a cosmetic hash-list disagreement. The guard reports; startup
  // continues regardless. Never reintroduce an exit here.
  const { verifyDaemonBinaryVersion } = await import('../providers/daemon-version-check.js')
  try {
    verifyDaemonBinaryVersion()
  } catch (err) {
    // A throw from the guard (fs/spawn surprise) must not be fatal either.
    process.stderr.write(
      `daemon version check errored (continuing): ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }

  const { startServer, stopServer, armGracefulSignalExit } = await import('../web/server.js')

  const port = options.port ? parseInt(options.port, 10) : undefined

  // Keep the process alive — the server runs until SIGINT/SIGTERM.
  //
  // ⚠️ Registered BEFORE `await startServer()`, and armed only once registered.
  // startServer() installs its own always-fatal SIGTERM handler early in boot
  // (see fatalSignal() in web/server.ts): a `kill -15` arriving mid-boot — which
  // every dev-prod.sh deploy sends to the outgoing listener — must kill the
  // process, not be logged and ignored. Registering our graceful handler after
  // startServer() resolved left a multi-second window where the ONLY listener was
  // a log-only one, which in Node overrides the OS default and made the booting
  // server immune to SIGTERM: 62 unkillable servers accumulated on 2026-08-09
  // (peak 43 concurrent) until the Mac starved and macOS killed the user's GUI
  // apps. Handler first, then arm, then boot.
  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return // a second signal must not race a teardown in flight
    shuttingDown = true
    // Safety timeout: force-exit if stopServer hangs (e.g. audio save stuck)
    const bail = setTimeout(() => process.exit(1), 4000)
    try {
      await stopServer()
    } catch {
      // A failed teardown must still terminate — never leave an immune process.
    } finally {
      clearTimeout(bail)
    }
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGHUP', shutdown)
  armGracefulSignalExit()

  await startServer({ port, dev: !!options.dev })
}

// ── Ephemeral Launcher (parent — exits quickly) ──────────────────────────

/**
 * Parent process that:
 * 1. Reaps stale /tmp/open-walnut-* dirs (dead PIDs)
 * 2. Checks ephemeral concurrency limit (max 3 live servers)
 * 3. Copies WALNUT_HOME to a unique tmpdir
 * 4. Spawns a detached child: open-walnut web --_ephemeral-child
 * 5. Polls for ephemeral.json until port appears
 * 6. Prints JSON to stdout and exits
 */
async function runEphemeralLauncher(): Promise<void> {
  const { WALNUT_HOME } = await import('../constants.js')

  // 1. Reap stale dirs from previous runs
  reapStaleEphemeralDirs(WALNUT_HOME)

  // 2. Enforce ephemeral server concurrency limit
  const liveCount = countLiveEphemeralServers(WALNUT_HOME)
  if (liveCount >= DEFAULT_EPHEMERAL_LIMIT) {
    // Output JSON error to stdout so the calling session can parse it
    console.log(JSON.stringify({
      error: true,
      reason: `Ephemeral server limit reached: ${liveCount}/${DEFAULT_EPHEMERAL_LIMIT} running. Wait for an existing server to idle-timeout or kill one manually.`,
      running: liveCount,
      limit: DEFAULT_EPHEMERAL_LIMIT,
    }))
    process.exit(1)
    return
  }

  // 3. Create unique tmpdir: /tmp/open-walnut-{PPID}-{random}
  const prefix = `open-walnut-${process.ppid}-`
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))

  // 4. Ensure WALNUT_HOME exists (first run on a fresh machine)
  fs.mkdirSync(WALNUT_HOME, { recursive: true })

  // Record the snapshot BEFORE copying into it. A launcher killed mid-copy (agent
  // Bash timeouts do exactly this) never reaches any cleanup, so the registry row
  // written here is the only thing that makes the half-copied dir findable later.
  const registryFile = registryPath(WALNUT_HOME)
  registerEphemeralDir(registryFile, tmpDir)

  // 5. Copy data snapshot (skip large/lockable files)
  fs.cpSync(WALNUT_HOME, tmpDir, {
    recursive: true,
    // NOTE: do not bother passing mode: COPYFILE_FICLONE here hoping for a
    // copy-on-write snapshot. Measured on macOS 15 / APFS with Node 25: cloning
    // works on this volume (/bin/cp -c duplicates a 2G file for 0 bytes) but Node
    // never uses clonefile(2) — both fs.cpSync and fs.copyFileSync with
    // COPYFILE_FICLONE consumed the full 2G. Getting CoW here would mean shelling
    // out to `cp -Rc` (macOS) / `cp -R --reflink=auto` (Linux), which cannot honour
    // the filter below, so the snapshot stays a real copy and we keep it small by
    // excluding regenerable data instead.
    // Keep relative symlinks RELATIVE. The default rewrites them to absolute
    // paths into the LIVE data dir (measured: notes/CLAUDE.md -> AGENTS.md became
    // an absolute link back into ~/.open-walnut), so the "isolated" snapshot
    // silently read and wrote production notes through them.
    verbatimSymlinks: true,
    filter: (src: string) => {
      // Skip SQLite files (WAL-locked, ephemeral creates fresh ones)
      if (/\.sqlite(-wal|-shm)?$/.test(src)) return false
      // Skip session stream files (large, not needed)
      if (src.includes(path.join('sessions', 'streams'))) return false
      // Skip the runtime tmp dir — since streams moved to ~/.open-walnut/tmp/
      // it holds live FIFO .pipe files, and cpSync on a FIFO dies with
      // ERR_INTERNAL_ASSERTION "Unreachable code" (cp-sync getStats).
      if (src.includes(path.join(path.sep, 'tmp', path.sep)) ||
          src.endsWith(path.join(path.sep, 'tmp'))) return false
      // Skip images dir (can be large)
      if (src.includes(path.join(path.sep, 'images', path.sep)) ||
          src.endsWith(path.join(path.sep, 'images'))) return false
      // Skip regenerable TOP-LEVEL dirs: .git (2.7G of data-dir history — git-sync
      // checks isRepo() and re-inits when absent, so the snapshot self-heals into
      // a fresh repo), .smart-env (1.2G embeddings store), cache (1.5G derived,
      // 1.4G of it cache/history). All three are already classified as
      // regenerable by their owners: backup/scan.ts excludes them and git-sync
      // gitignores them. Sizes measured against a 17G home on 2026-08-27.
      //
      // Anchored to the FIRST path segment under WALNUT_HOME on purpose. A
      // substring test like includes('/cache/') would also drop a note folder the
      // user happens to have named "cache", or a nested repo inside notes/ —
      // silently thinning the snapshot the tests then trust.
      const rel = path.relative(WALNUT_HOME, src)
      if (rel && SNAPSHOT_SKIP_TOP_LEVEL.has(rel.split(path.sep)[0])) return false
      // Skip lock files
      if (src.endsWith('.lock')) return false
      // Skip the single-instance lock — a snapshot carrying the LIVE server's
      // server.lock.json makes the child refuse its own fresh dir (the lock
      // names a pid that really is alive: the production server).
      if (src.endsWith('server.lock.json')) return false
      // Skip anything that isn't a plain file/dir/symlink — cpSync dies on
      // sockets and FIFOs (ERR_INTERNAL_ASSERTION "Unreachable code" during a
      // directory walk; typed ERR_FS_CP_SOCKET/ERR_FS_CP_FIFO_PIPE when hit
      // directly). The tmp/ rule above catches the known FIFOs by path; this
      // catches the rest by TYPE (e.g. code-server/data/code-server-ipc.sock,
      // which killed every `web --ephemeral` launch while an embedded VS Code
      // was running). Symlinks are safe to pass ONLY because cpSync runs with
      // the default dereference:false (it recreates the link, never stats the
      // target) — don't add dereference:true without revisiting this.
      try {
        const st = fs.lstatSync(src)
        if (!st.isFile() && !st.isDirectory() && !st.isSymbolicLink()) return false
      } catch (err) {
        // Excluding on lstat failure trades a loud cpSync abort for a quietly
        // incomplete snapshot (a directory here drops its whole subtree) — say so.
        process.stderr.write(`ephemeral: skipping unstatable ${src}: ${err instanceof Error ? err.message : String(err)}\n`)
        return false
      }
      return true
    },
  })

  // 5. Spawn detached child
  const binPath = process.argv[1]
  // Ephemeral identity travels via the --_ephemeral-child argv flag ONLY (see
  // IS_EPHEMERAL in constants.ts). No env marker: env inherits down the whole
  // process tree and has twice poisoned shared daemons + prod servers.
  const child = spawn(process.execPath, [binPath, 'web', '--_ephemeral-child'], {
    env: { ...process.env, OPEN_WALNUT_HOME: tmpDir },
    stdio: 'ignore',  // No pipes — no SIGPIPE risk
    detached: true,
  })

  child.on('error', (err) => {
    process.stderr.write(`ephemeral: spawn failed — ${err.message}\n`)
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    unregisterEphemeralDir(registryFile, tmpDir)
    process.exit(1)
  })

  child.unref()

  const childPid = child.pid
  if (childPid == null) {
    process.stderr.write('ephemeral: child.pid is undefined — spawn may have failed\n')
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    unregisterEphemeralDir(registryFile, tmpDir)
    process.exit(1)
    return
  }

  // 6. Poll for ephemeral.json, racing against early child death
  const controlFile = path.join(tmpDir, 'ephemeral.json')

  // Detect early child death so we fail fast instead of waiting the full poll timeout
  const earlyDeathPromise = new Promise<never>((_, reject) => {
    child.on('exit', (code, signal) => {
      reject(new Error(
        `child exited immediately (code=${code}, signal=${signal}) — check server logs`,
      ))
    })
  })

  try {
    const data = await Promise.race([
      pollForControlFile(controlFile),
      earlyDeathPromise,
    ])
    // 7. Print JSON to stdout (exec tool captures this)
    console.log(JSON.stringify(data))
    process.exit(0)
  } catch (err) {
    process.stderr.write(`ephemeral: ${err instanceof Error ? err.message : String(err)}\n`)
    // Kill child and clean up
    try { process.kill(childPid, 'SIGTERM') } catch { /* may already be dead */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    unregisterEphemeralDir(registryFile, tmpDir)
    process.exit(1)
  }
}

/**
 * Poll for the control file written by the child.
 * Returns the parsed JSON data or throws after timeout.
 */
function pollForControlFile(controlFile: string): Promise<{
  pid: number
  port: number
  tmpDir: string
  startedAt: string
}> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + POLL_TIMEOUT_MS

    const check = () => {
      if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for child to start (${POLL_TIMEOUT_MS / 1000}s)`))
        return
      }

      try {
        const raw = fs.readFileSync(controlFile, 'utf-8')
        const data = JSON.parse(raw)
        if (data.port && data.pid) {
          resolve(data)
          return
        }
      } catch {
        // File doesn't exist yet or incomplete write — retry
      }

      setTimeout(check, POLL_INTERVAL_MS)
    }

    check()
  })
}

// ── Ephemeral Child (detached server daemon) ─────────────────────────────

/**
 * Child process that:
 * 1. Starts the real server on port 0 (random)
 * 2. Writes ephemeral.json with { pid, port, tmpDir, startedAt }
 * 3. Tracks HTTP activity and self-destructs after 10 min idle
 * 4. Cleans up tmpdir on exit
 */
async function runEphemeralChild(): Promise<void> {
  const tmpDir = process.env.OPEN_WALNUT_HOME
  if (!tmpDir) {
    process.stderr.write('ephemeral child: OPEN_WALNUT_HOME not set\n')
    process.exit(1)
    return
  }

  const { startServer, stopServer, armGracefulSignalExit } = await import('../web/server.js')

  // Start server on random port — identical to production
  const httpServer = await startServer({ port: 0 })

  const addr = httpServer.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  if (!port) {
    process.stderr.write('ephemeral child: could not determine port\n')
    process.exit(1)
    return
  }

  // Write control file so the launcher (and agents) can discover us
  const controlData = {
    pid: process.pid,
    port,
    tmpDir,
    startedAt: new Date().toISOString(),
  }
  fs.writeFileSync(
    path.join(tmpDir, 'ephemeral.json'),
    JSON.stringify(controlData, null, 2),
  )

  // Idle timeout: reset on every HTTP request
  let lastActivity = Date.now()
  httpServer.on('request', () => {
    lastActivity = Date.now()
  })

  const idleChecker = setInterval(() => {
    if (Date.now() - lastActivity > EPHEMERAL_IDLE_TTL_MS) {
      cleanup('idle timeout')
    }
  }, IDLE_CHECK_INTERVAL_MS)
  idleChecker.unref()

  let cleaningUp = false
  async function cleanup(reason: string): Promise<void> {
    if (cleaningUp) return
    cleaningUp = true

    process.stderr.write(`ephemeral child: shutting down (${reason})\n`)
    clearInterval(idleChecker)

    // Force exit if stopServer() hangs for more than 10 seconds
    const forceExit = setTimeout(() => {
      process.stderr.write('ephemeral child: forced exit after 10s timeout\n')
      try { fs.rmSync(tmpDir!, { recursive: true, force: true }) } catch { /* best-effort */ }
      process.exit(1)
    }, 10_000)
    forceExit.unref()

    try { await stopServer() } catch { /* best-effort */ }
    try { fs.rmSync(tmpDir!, { recursive: true, force: true }) } catch { /* best-effort */ }

    process.exit(0)
  }

  process.on('SIGINT', () => cleanup('SIGINT'))
  process.on('SIGTERM', () => cleanup('SIGTERM'))
  // Claim ownership of the signal, or startServer()'s own always-fatal handler
  // wins the race: it sees no armed owner, removeAllListeners('SIGTERM') and
  // re-raises with the default disposition, so the process dies instantly and
  // cleanup() above never reaches its rmSync. Measured: a SIGTERMed child left
  // its whole 3.2G snapshot behind. Must come AFTER the handlers are registered
  // (server.ts documents that ordering).
  armGracefulSignalExit()
}
