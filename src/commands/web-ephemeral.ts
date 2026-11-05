/**
 * `open-walnut web --ephemeral`: the two-phase isolated server for agent testing
 * (moved out of web.ts as is).
 *   1. Launcher (parent): copies ~/.open-walnut/ to /tmp/open-walnut-{PPID}-{random}/,
 *      spawns a detached child, polls for port, prints JSON, exits.
 *   2. Child (--_ephemeral-child): runs the real server on a random port,
 *      writes ephemeral.json, self-destructs after 10 min of idle (WALNUT_EPHEMERAL_IDLE_MINUTES)
 *      or once the process it works for is gone (ephemeral-owner.ts).
 */

/** Written by the launcher into the snapshot: the process the server works for. */
export const EPHEMERAL_OWNER_FILE = 'ephemeral-owner.json'

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
  ephemeralRuntimeDir,
  removeEphemeralRuntimeDirs,
  removeEphemeralRuntimeDirsNow,
  EPHEMERAL_SERVER_PID_FILE,
} from './ephemeral-registry.js'
import { ephemeralIdleTtlMs } from './ephemeral-idle.js'
import { resolveEphemeralOwner, startOwnerWatch, type EphemeralOwner } from './ephemeral-owner.js'
import { copyDataSnapshot, dropSnapshotQueuedMessages, ephemeralChildEnv, pauseSnapshotCronJobs, stopSnapshotTriage, stopSnapshotTunnels, stripSnapshotPushTokens } from './ephemeral-snapshot.js'

/** Auto-shutdown after this long with no HTTP request (WALNUT_EPHEMERAL_IDLE_MINUTES, default 10). */
const EPHEMERAL_IDLE_TTL_MS = ephemeralIdleTtlMs()
/** How often to check for idle timeout (milliseconds). */
const IDLE_CHECK_INTERVAL_MS = 60 * 1000

/**
 * Max time to wait for the child server to write ephemeral.json. A child that dies is caught at
 * once (earlyDeathPromise), so this only bounds a slow but healthy start: on a loaded machine a
 * cold boot takes well over 15s, and killing it then wasted the whole snapshot copy.
 */
const POLL_TIMEOUT_MS = 90_000

/** Poll interval when waiting for ephemeral.json. */
const POLL_INTERVAL_MS = 200

/** Maximum concurrent ephemeral servers (each is a full Express + WS server). */
const DEFAULT_EPHEMERAL_LIMIT = 3

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
export async function runEphemeralLauncher(): Promise<void> {
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
  // Its own local daemon (see ephemeralRuntimeDir): never the production one.
  const runtimeDir = ephemeralRuntimeDir(tmpDir)
  if (!runtimeDir) {
    process.stderr.write(`ephemeral: unexpected snapshot dir name ${tmpDir}\n`)
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    process.exit(1)
    return
  }
  // Created fresh (never recursive): an entry that already exists, a planted
  // symlink included, is not ours, and the daemon would put its socket there.
  const createdRuntimeDirs: string[] = []
  try {
    for (const dir of [runtimeDir, `${runtimeDir}-streams`]) {
      fs.mkdirSync(dir, { mode: 0o700 })
      createdRuntimeDirs.push(dir)
    }
  } catch (err) {
    process.stderr.write(`ephemeral: cannot create runtime dir ${runtimeDir}: ${(err as Error).message}\n`)
    for (const dir of [tmpDir, ...createdRuntimeDirs]) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
    process.exit(1)
    return
  }

  // Who the server works for: it ends when that process does (ephemeral-owner.ts). Read
  // before the copy, while this launcher's parent is surely still the one that asked.
  const owner = await resolveEphemeralOwner()

  // 4. Ensure WALNUT_HOME exists (first run on a fresh machine)
  fs.mkdirSync(WALNUT_HOME, { recursive: true })

  // Record the snapshot BEFORE copying into it. A launcher killed mid-copy (agent
  // Bash timeouts do exactly this) never reaches any cleanup, so the registry row
  // written here is the only thing that makes the half-copied dir findable later.
  const registryFile = registryPath(WALNUT_HOME)
  registerEphemeralDir(registryFile, tmpDir)

  // 5. Copy data snapshot (skip large/lockable files, and the private health store):
  // copy-on-write where the volume can, else a real copy under a size cap.
  let snapshot: ReturnType<typeof copyDataSnapshot>
  try {
    snapshot = copyDataSnapshot(WALNUT_HOME, tmpDir)
  } catch (err) {
    process.stderr.write(`ephemeral: could not write the snapshot: ${err instanceof Error ? err.message : String(err)}\n`)
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    removeEphemeralRuntimeDirsNow(runtimeDir) // no server ran: no terminal to end
    unregisterEphemeralDir(registryFile, tmpDir)
    process.exit(1)
    return
  }
  if (owner) {
    try { fs.writeFileSync(path.join(tmpDir, EPHEMERAL_OWNER_FILE), JSON.stringify(owner)) } catch { /* the idle timer still ends it */ }
  }

  // The copied automations and phone registrations belong to the real Walnut.
  const pausedCronJobs = pauseSnapshotCronJobs(tmpDir)
  const removedPushTokens = stripSnapshotPushTokens(tmpDir)
  const stoppedTunnels = stopSnapshotTunnels(tmpDir)
  // The triage bootstrap would re-enable its paused routine from the config.
  const stoppedTriage = stopSnapshotTriage(tmpDir)
  // The copied queue would be delivered to the user's real sessions at boot.
  let droppedQueuedMessages: number
  try {
    droppedQueuedMessages = dropSnapshotQueuedMessages(tmpDir)
  } catch (err) {
    process.stderr.write(`ephemeral: ${err instanceof Error ? err.message : String(err)}\n`)
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    removeEphemeralRuntimeDirsNow(runtimeDir) // no server ran: no terminal to end
    unregisterEphemeralDir(registryFile, tmpDir)
    process.exit(1)
    return
  }

  // 5. Spawn detached child
  const binPath = process.argv[1]
  // Ephemeral identity travels via the --_ephemeral-child argv flag ONLY (see
  // IS_EPHEMERAL in constants.ts). No env marker: env inherits down the whole
  // process tree and has twice poisoned shared daemons + prod servers.
  const child = spawn(process.execPath, [binPath, 'web', '--_ephemeral-child'], {
    env: ephemeralChildEnv(process.env, tmpDir, runtimeDir),
    stdio: 'ignore',  // No pipes — no SIGPIPE risk
    detached: true,
  })

  child.on('error', (err) => {
    process.stderr.write(`ephemeral: spawn failed — ${err.message}\n`)
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    removeEphemeralRuntimeDirsNow(runtimeDir) // no server ran: no terminal to end
    unregisterEphemeralDir(registryFile, tmpDir)
    process.exit(1)
  })

  child.unref()

  const childPid = child.pid
  if (childPid == null) {
    process.stderr.write('ephemeral: child.pid is undefined — spawn may have failed\n')
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    removeEphemeralRuntimeDirsNow(runtimeDir) // no server ran: no terminal to end
    unregisterEphemeralDir(registryFile, tmpDir)
    process.exit(1)
    return
  }
  // The server's pid beside its daemon: a reaper that does not know this snapshot (another
  // Walnut home, another TMPDIR) must still see that the daemon dir has a live owner.
  try { fs.writeFileSync(path.join(runtimeDir, EPHEMERAL_SERVER_PID_FILE), `${childPid}\n`) } catch { /* best-effort */ }

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
    // 7. Print JSON to stdout (exec tool captures this). daemonDir holds this
    // server's own daemon and logs (open-walnut-<date>.log).
    console.log(JSON.stringify({ ...data, daemonDir: runtimeDir, owner, snapshot, pausedCronJobs, removedPushTokens, stoppedTunnels, stoppedTriage, droppedQueuedMessages }))
    process.exit(0)
  } catch (err) {
    process.stderr.write(`ephemeral: ${err instanceof Error ? err.message : String(err)}\n`)
    // Kill child and clean up
    try { process.kill(childPid, 'SIGTERM') } catch { /* may already be dead */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    removeEphemeralRuntimeDirsNow(runtimeDir) // no server ran: no terminal to end
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
 * 3. Tracks HTTP activity and self-destructs after 10 min idle (WALNUT_EPHEMERAL_IDLE_MINUTES)
 * 4. Cleans up tmpdir on exit
 */
export async function runEphemeralChild(): Promise<void> {
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

  let owner: EphemeralOwner | null = null
  try { owner = JSON.parse(fs.readFileSync(path.join(tmpDir, EPHEMERAL_OWNER_FILE), 'utf-8')) as EphemeralOwner } catch { /* none named */ }

  // Write control file so the launcher (and agents) can discover us. `heartbeat`
  // says its mtime is touched every OWNER_CHECK_MS, which the reaper reads.
  const controlFile = path.join(tmpDir, 'ephemeral.json')
  const controlData = {
    pid: process.pid,
    port,
    tmpDir,
    startedAt: new Date().toISOString(),
    heartbeat: true,
    ...(owner ? { owner } : {}),
  }
  fs.writeFileSync(controlFile, JSON.stringify(controlData, null, 2))

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

  // Heartbeat and owner: touch the control file, and end once the owner is surely gone.
  const stopOwnerWatch = startOwnerWatch(controlFile, owner, (reason) => { void cleanup(reason) })

  let cleaningUp = false
  async function cleanup(reason: string): Promise<void> {
    if (cleaningUp) return
    cleaningUp = true

    process.stderr.write(`ephemeral child: shutting down (${reason})\n`)
    clearInterval(idleChecker)
    stopOwnerWatch()

    // This server's own daemon dir (set by the launcher; see ephemeralRuntimeDir).
    const runtimeDir = process.env.WALNUT_DAEMON_DIR
    // Its terminals' dtach masters are ended first (they need their sockets and
    // pid records, which live in the runtime dir), each step bounded; `waitMs`
    // caps the wait, after which the dirs are removed regardless.
    const removeAll = async (waitMs: number) => {
      try { fs.rmSync(tmpDir!, { recursive: true, force: true }) } catch { /* best-effort */ }
      if (!runtimeDir) return
      await Promise.race([removeEphemeralRuntimeDirs(runtimeDir), new Promise((r) => setTimeout(r, waitMs))])
      removeEphemeralRuntimeDirsNow(runtimeDir)
    }

    // Force exit if stopServer() hangs for more than 10 seconds
    const forceExit = setTimeout(() => {
      process.stderr.write('ephemeral child: forced exit after 10s timeout\n')
      void removeAll(3_000).finally(() => process.exit(1))
    }, 10_000)
    forceExit.unref()

    try { await stopServer() } catch { /* best-effort */ }
    // Stop our own daemon before deleting its dir, or it keeps writing there.
    // Bounded: stopIfIsolated polls the pid; the parent-pid watchdog covers the rest.
    try {
      const { localDaemon } = await import('../providers/local-daemon.js')
      await Promise.race([localDaemon.stopIfIsolated(), new Promise((r) => setTimeout(r, 5_000))])
    } catch { /* best-effort */ }
    // From here removeAll bounds itself: the forced exit would cut its wait short.
    clearTimeout(forceExit)
    await removeAll(20_000)

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
