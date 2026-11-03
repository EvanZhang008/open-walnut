/**
 * CLI command: open-walnut web [--port 3456] [--dev] [--ephemeral] [--_ephemeral-child]
 * Starts the Express + WebSocket server.
 *
 * --ephemeral: the two-phase isolated server for agent testing (web-ephemeral.ts).
 * Supports up to 3 concurrent agents — each gets its own tmpdir and port.
 * A restart into an update it installed: web-restart.ts.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { takeExitOnOrphanRequest, watchForOrphan } from '../lib/exit-on-orphan.js'

/** How long a SIGTERMed server may spend in stopServer() before it exits anyway. */
export const SHUTDOWN_BAIL_MS = 7_000

/**
 * A server is never a session. One started from inside a Walnut session (a
 * deploy run by an agent, `open-walnut web` typed in a session's terminal)
 * inherits that session's identity, and the op executor falls back to
 * WALNUT_SESSION_ID for in-process calls that name no caller (an action-card
 * click, a routine watcher's read). Every such call would then act AS that
 * session: its task_create filed beside the deployer's task (moving that task
 * into a new folder), its task_list narrowed to the deployer's folder.
 */
export function forgetInheritedSessionIdentity(env: NodeJS.ProcessEnv = process.env): void {
  delete env.WALNUT_SESSION_ID
  delete env.WALNUT_AGENT_SOCKET
  // That session's task directory too: the local daemon, the in-app terminal and
  // every script a child runs would otherwise write into another task's.
  delete env.WALNUT_TASK_DIR
}

/**
 * The env this command started with, for the server a restart into an update starts
 * (web-restart.ts): the server takes some requests out of its own env at boot. Never
 * the session identity, nor the Mac app's orphan request (it names that app's child).
 */
export function bootEnvOf(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  forgetInheritedSessionIdentity(out)
  delete out.OPEN_WALNUT_EXIT_ON_ORPHAN
  return out
}

export async function runWeb(options: {
  port?: string
  dev?: boolean
  ephemeral?: boolean
  _ephemeralChild?: boolean
  replica?: boolean
}): Promise<void> {
  // A server started in a directory deleted since (a deploy's build clone) moves
  // out of it first: every child it starts would inherit it (login-session.ts).
  ;(await import('../core/login-session.js')).healCwd()
  // Taken before the boot below edits process.env.
  const bootEnv = bootEnvOf(process.env)
  // Before anything that may take a while: the app may die during an update check.
  const orphanParent = takeExitOnOrphanRequest()
  forgetInheritedSessionIdentity()
  // A looping parent started this server: a restart into an update is exit 75 to it
  // (restart-supervisor.ts). Read and removed before anything can inherit it.
  const { takeRestartSupervised, preloadRestartLoop } = await import('../core/self-update/restart-supervisor.js')
  const supervised = takeRestartSupervised()
  if (options._ephemeralChild) {
    return (await import('./web-ephemeral.js')).runEphemeralChild()
  }

  if (options.replica) {
    return runHostReplica(options)
  }

  if (options.ephemeral) {
    return (await import('./web-ephemeral.js')).runEphemeralLauncher()
  }

  // Normal server
  // Note: ephemeral WALNUT_HOME guard is in constants.ts (must run at import time,
  // before any derived paths are computed). See resolveWalnutHome() there.

  // Update on restart (src/core/self-update/startup-update.ts): an npm install, or
  // the compiled file in install.sh's layout, with a newer release published
  // installs it now, before anything is listening, and this process becomes a
  // thin parent of the new one. Every other case (a source
  // checkout, updates.auto: false, no newer release, the registry down, a
  // read-only prefix) falls through and starts as it is.
  // The parent that restarted this process after an update learns from this file
  // that it listened, so its exit is no failure to start (startup-update.ts).
  const { READY_FILE_ENV, RESTART_EXIT_CODE } = await import('../core/self-update/startup-update.js')
  const { runStartupUpdate } = await import('../core/self-update/startup-update-run.js')
  const { bootRole, readConfigAuto, runSupervisor } = await import('./web-restart.js')
  const readyFile = process.env[READY_FILE_ENV]
  delete process.env[READY_FILE_ENV]
  let role: Awaited<ReturnType<typeof bootRole>>
  {
    // A thin parent may loop later, after a live install replaced this version's files.
    await preloadRestartLoop()
    const outcome = await runStartupUpdate(readConfigAuto, { readyAlso: readyFile })
    if (outcome.kind === 'stopped') {
      // Stopped while it installed (it cleaned up): the shell's code for that signal.
      process.exit(128 + (os.constants.signals[outcome.signal] ?? 0))
    }
    role = await bootRole({
      outcome, supervised, restartCode: RESTART_EXIT_CODE,
      qualifies: async () => (await import('../core/self-update/live-eligible.js')).supervisesFromStart(process.env),
    })
    // The new version asked for a restart into a later update: this parent loops.
    if (role.kind === 'loop') { process.exitCode = await runSupervisor(bootEnv, { firstCode: role.firstCode }); return }
    if (role.kind === 'exit') { process.exitCode = role.code; return }
  }

  // The compiled file in install.sh's layout marks the version it runs from, so no
  // update removes that file while this server still starts it (binary-install.ts).
  try {
    const { detectInstall } = await import('../core/self-update/install-kind.js')
    const install = detectInstall()
    if (install.kind === 'binary' && install.binary) {
      const { markRunning } = await import('../core/self-update/binary-install.js')
      markRunning(install.binary.root, install.binary.version)
    }
  } catch { /* advisory: the server starts either way */ }

  // An install that can update itself while it serves (live-eligible.ts) runs its
  // server as a child from the start, so a restart into an update is that child's
  // exit 75: this process never boots a server (no background work, no heap of its
  // own), forwards signals and ends with the child's code. A parent above it that
  // waits for its ready file (an older thin parent) hears when the child listens.
  if (role.kind === 'supervise') {
    process.exitCode = await runSupervisor(bootEnv, { readyAlso: readyFile })
    return
  }

  // Sanity check: dist/daemon-binaries/*.version must match current daemon source.
  // If not, auto-rebuild. This is the belt to the suspenders of `bun run build`
  // auto-building daemon: it catches someone running `bun dist/cli.js web`
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

  const { startServer, stopServer, armGracefulSignalExit, exitTraceFile } = await import('../web/server.js')

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
    // Safety timeout: force-exit if stopServer hangs (e.g. audio save stuck).
    // Longer than the 5s a plugin may take to deactivate (plugin-manager.ts
    // deactivationTimeoutMs), or one slow plugin ends the teardown here before
    // the import and the stores get their turn (2026-10-01: exit 1 at exactly
    // 4s, nothing after the plugins logged); shorter than the deploy's 8s
    // SIGKILL grace (scripts/dev-prod.sh STOP_GRACE_SECS). The trace names the
    // bail, so a code=1 exit is not mistaken for a crash.
    const bail = setTimeout(() => {
      const msg = `[${new Date().toISOString()}] SERVER EXIT: shutdown bail after ${SHUTDOWN_BAIL_MS}ms pid=${process.pid}`
      try { fs.appendFileSync(exitTraceFile(), msg + '\n') } catch { /* best-effort */ }
      process.exit(1)
    }, SHUTDOWN_BAIL_MS)
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
  // The Mac app that started this died without stopping it: stop as it would have.
  watchForOrphan(orphanParent, () => {
    try { fs.appendFileSync(exitTraceFile(), `[${new Date().toISOString()}] SERVER EXIT: the app that started it is gone pid=${process.pid}\n`) } catch { /* best-effort */ }
    void shutdown()
  })

  await startServer({ port, dev: !!options.dev })
  // Its own login session and cwd, checked now and every minute; GET /api/config
  // reports it, and the Mac app replaces a server whose session ended.
  ;(await import('../core/login-session.js')).startLoginSessionMonitor()
  if (readyFile) {
    try { fs.writeFileSync(readyFile, `${process.pid}\n`) } catch { /* the parent then reads an exit as a failed start */ }
  }
  // How this server restarts into an update it installed (live-update.ts).
  const { registerLiveRestart } = await import('./web-restart.js')
  await registerLiveRestart({
    supervised, stopServer, exitTraceFile, bailMs: SHUTDOWN_BAIL_MS,
    beginTeardown: () => { if (shuttingDown) return false; shuttingDown = true; return true },
  })

  // Someone watching `walnut web` in a terminal gets the npm-style one-liner when
  // the first check (20 s after listen) finds a newer release. A server started by
  // a service or a deploy script has no TTY and already logs the fact.
  if (process.stderr.isTTY) {
    try {
      const { getUpdateChecker, formatUpdateNotice } = await import('../core/self-update/update-check.js')
      let off: (() => void) | null = null
      off = getUpdateChecker().onChecked((status) => {
        off?.()
        const notice = formatUpdateNotice(status)
        if (notice) process.stderr.write(`\n${notice}\n`)
      })
    } catch { /* advisory only */ }
  }
}

// ── Host replica (`walnut web --replica`) ────────────────────────────────

/**
 * The port a host replica listens on: the one its daemon's spec names
 * (WALNUT_HOST_SERVER_PORT), else an explicit --port. Never 3456: on the Mac
 * that is the production Walnut, and the default must never be taken by accident.
 */
export function hostReplicaPort(env: NodeJS.ProcessEnv, flag: string | undefined): number {
  const raw = (env.WALNUT_HOST_SERVER_PORT ?? '').trim() || (flag ?? '').trim()
  const port = Number(raw)
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
    throw new Error('walnut web --replica needs WALNUT_HOST_SERVER_PORT (its daemon sets it) or --port <port>')
  }
  if (port === 3456) throw new Error('a host replica never listens on 3456 (the production Walnut\'s port)')
  return port
}

/**
 * A host replica: the full server program as a follower of the Mac, started by
 * its host's daemon (docs/plan/walnut-replica-servers-impl.md, WP1). It never
 * updates itself, rebuilds a native module or the daemon binaries (the Mac
 * installs it), and startServer refuses a run dir or data dir that is not its own.
 */
async function runHostReplica(options: { port?: string; dev?: boolean }): Promise<void> {
  if (!process.env.WALNUT_ROLE) process.env.WALNUT_ROLE = 'replica'
  // Refused before anything logs (an unset run dir would log into /tmp/open-walnut)
  // and without the logger: the reason goes to stderr, the exit is at once.
  let port: number
  const { LOG_DIR, WALNUT_HOME } = await import('../constants.js')
  try {
    const { role, placement } = await import('../core/server-role.js')
    if (role() !== 'replica' || placement() !== 'host') {
      throw new Error(`walnut web --replica runs a host replica, but this env says role ${role()}, placement ${placement()}`)
    }
    const { assertReplicaBootSafe } = await import('../replica/boot-guard.js')
    assertReplicaBootSafe({ env: process.env, walnutHome: WALNUT_HOME })
    // The commander default is 3456 whether or not --port was given: only an explicit other one counts.
    port = hostReplicaPort(process.env, options.port === '3456' ? undefined : options.port)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  }
  // Every file a host replica makes is 0600, every dir 0700 (startServer sets it too).
  process.umask(0o077)
  // Its two dirs are claimed before the logger makes the run dir: a dir it
  // finds empty (or makes) gets the replica's marker, and only a marked dir
  // ever has its modes repaired (startServer does that).
  const { claimReplicaDir } = await import('../replica/boot-guard.js')
  for (const dir of [WALNUT_HOME, LOG_DIR]) claimReplicaDir(dir)
  // The run dir is proven its own: now the logger may make it and prune old
  // logs (cli.ts skipped this for `web --replica`), so a long-lived replica
  // keeps three days of logs like every other Walnut.
  const { initLogging } = await import('../logging/index.js')
  initLogging()
  const { startServer, stopServer, armGracefulSignalExit } = await import('../web/server.js')
  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    const bail = setTimeout(() => {
      try { fs.appendFileSync(path.join(LOG_DIR, 'exit.log'), `[${new Date().toISOString()}] SERVER EXIT: shutdown bail after ${SHUTDOWN_BAIL_MS}ms pid=${process.pid}\n`) } catch { /* best-effort */ }
      process.exit(1)
    }, SHUTDOWN_BAIL_MS)
    try { await stopServer() } catch { /* a failed teardown must still terminate */ } finally { clearTimeout(bail) }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGHUP', shutdown)
  armGracefulSignalExit()
  await startServer({ port, dev: !!options.dev })
}
