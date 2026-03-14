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
  const { startServer } = await import('../web/server.js')

  const port = options.port ? parseInt(options.port, 10) : undefined
  await startServer({ port, dev: !!options.dev })

  // Keep the process alive — the server runs until SIGINT/SIGTERM
  const shutdown = async () => {
    const { stopServer } = await import('../web/server.js')
    await stopServer()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
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
  reapStaleEphemeralDirs()

  // 2. Enforce ephemeral server concurrency limit
  const liveCount = countLiveEphemeralServers()
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

  // 4. Copy data snapshot (skip large/lockable files)
  fs.cpSync(WALNUT_HOME, tmpDir, {
    recursive: true,
    filter: (src: string) => {
      // Skip SQLite files (WAL-locked, ephemeral creates fresh ones)
      if (/\.sqlite(-wal|-shm)?$/.test(src)) return false
      // Skip session stream files (large, not needed)
      if (src.includes(path.join('sessions', 'streams'))) return false
      // Skip images dir (can be large)
      if (src.includes(path.join(path.sep, 'images', path.sep)) ||
          src.endsWith(path.join(path.sep, 'images'))) return false
      // Skip lock files
      if (src.endsWith('.lock')) return false
      return true
    },
  })

  // 5. Spawn detached child
  const binPath = process.argv[1]
  const child = spawn(process.execPath, [binPath, 'web', '--_ephemeral-child'], {
    env: { ...process.env, WALNUT_HOME: tmpDir, WALNUT_EPHEMERAL: '1' },
    stdio: 'ignore',  // No pipes — no SIGPIPE risk
    detached: true,
  })

  child.on('error', (err) => {
    process.stderr.write(`ephemeral: spawn failed — ${err.message}\n`)
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    process.exit(1)
  })

  child.unref()

  const childPid = child.pid
  if (childPid == null) {
    process.stderr.write('ephemeral: child.pid is undefined — spawn may have failed\n')
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
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

/**
 * Scan /tmp/open-walnut-* directories for dead ephemeral servers.
 * If ephemeral.json exists with a PID that's dead, remove the dir.
 */
function reapStaleEphemeralDirs(): void {
  const tmpBase = os.tmpdir()
  let entries: string[]
  try {
    entries = fs.readdirSync(tmpBase).filter((e) => e.startsWith('open-walnut-'))
  } catch {
    return
  }

  for (const entry of entries) {
    const dir = path.join(tmpBase, entry)
    const controlFile = path.join(dir, 'ephemeral.json')

    try {
      const stat = fs.statSync(dir)
      if (!stat.isDirectory()) continue
    } catch {
      continue
    }

    try {
      const raw = fs.readFileSync(controlFile, 'utf-8')
      const data = JSON.parse(raw)
      if (data.pid && !isProcessAlive(data.pid)) {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    } catch {
      // No control file or can't parse — check if dir is very old (>1h)
      try {
        const stat = fs.statSync(dir)
        const ageMs = Date.now() - stat.mtimeMs
        if (ageMs > 60 * 60 * 1000) {
          fs.rmSync(dir, { recursive: true, force: true })
        }
      } catch {
        // Can't stat — another reaper got it first, fine
      }
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Count currently live ephemeral servers by scanning /tmp/open-walnut-* dirs.
 * Only counts directories with an ephemeral.json whose PID is still alive.
 * Called AFTER reapStaleEphemeralDirs() so stale dirs are already cleaned.
 */
function countLiveEphemeralServers(): number {
  const tmpBase = os.tmpdir()
  let entries: string[]
  try {
    entries = fs.readdirSync(tmpBase).filter((e) => e.startsWith('open-walnut-'))
  } catch {
    return 0
  }

  let count = 0
  for (const entry of entries) {
    const controlFile = path.join(tmpBase, entry, 'ephemeral.json')
    try {
      const raw = fs.readFileSync(controlFile, 'utf-8')
      const data = JSON.parse(raw)
      if (data.pid && isProcessAlive(data.pid)) {
        count++
      }
    } catch {
      // No control file or can't parse — not a live server
    }
  }
  return count
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
    process.stderr.write('ephemeral child: WALNUT_HOME not set\n')
    process.exit(1)
    return
  }

  const { startServer, stopServer } = await import('../web/server.js')

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
}
