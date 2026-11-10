/**
 * `open-walnut web --ephemeral`: the two-phase isolated server for agent testing
 * (moved out of web.ts as is).
 *   1. Launcher (parent): copies ~/.open-walnut/ to /tmp/open-walnut-{PPID}-{random}/,
 *      spawns a detached child, polls for port, prints JSON, exits.
 *   2. Child (--_ephemeral-child): runs the real server on a random port,
 *      writes ephemeral.json, self-destructs after 10 min of idle (WALNUT_EPHEMERAL_IDLE_MINUTES)
 *      or once the process it works for is gone (ephemeral-owner.ts).
 * At most WALNUT_EPHEMERAL_MAX run at once (2 on a Mac): the launcher takes a slot before
 * anything else and waits for one when all are held (ephemeral-slots.ts).
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
  liveEphemeralServers,
  ephemeralRuntimeDir,
  removeEphemeralRuntimeDirs,
  removeEphemeralRuntimeDirsNow,
  EPHEMERAL_SERVER_PID_FILE,
} from './ephemeral-registry.js'
import { ephemeralContendedIdleTtlMs, ephemeralIdleTtlMs, idleExitRule } from './ephemeral-idle.js'
import { ephemeralExitLogFile, recordEphemeralExit, type EphemeralExitRule } from './ephemeral-exit-record.js'
import { machineHold } from '../lib/machine-hold.js'
import { ownerGone, processStartOf, resolveEphemeralOwner, startOwnerWatch, type EphemeralOwner } from './ephemeral-owner.js'
import { EPHEMERAL_SLOT_FILE, acquireEphemeralSlot, ephemeralMaxServers, ephemeralSlotDir, ephemeralWaitMs, giveUpLines, releaseSlot, slotWanted, updateSlot, type HeldSlot } from './ephemeral-slots.js'
import { copyDataSnapshot, dropSnapshotQueuedMessages, ephemeralChildEnv, pauseSnapshotCronJobs, stopSnapshotTriage, stopSnapshotTunnels, stripSnapshotPushTokens } from './ephemeral-snapshot.js'

/** Auto-shutdown after this long with no HTTP request (WALNUT_EPHEMERAL_IDLE_MINUTES, default 10). */
const EPHEMERAL_IDLE_TTL_MS = ephemeralIdleTtlMs()
/** The idle limit while a launcher waits for a slot (WALNUT_EPHEMERAL_CONTENDED_IDLE_MINUTES, default 15). */
const CONTENDED_IDLE_TTL_MS = ephemeralContendedIdleTtlMs()
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

// ── Ephemeral Launcher (parent — exits quickly) ──────────────────────────

/**
 * Parent process that:
 * 1. Reaps stale /tmp/open-walnut-* dirs (dead PIDs)
 * 2. Takes a slot (at most WALNUT_EPHEMERAL_MAX at once), waiting for one when all are held
 * 3. Copies WALNUT_HOME to a unique tmpdir
 * 4. Spawns a detached child: open-walnut web --_ephemeral-child
 * 5. Polls for ephemeral.json until port appears
 * 6. Prints JSON to stdout and exits
 */
export async function runEphemeralLauncher(): Promise<void> {
  const { WALNUT_HOME } = await import('../constants.js')

  // 0. A machine on hold, or in its quiet night, starts no test server (src/lib/machine-hold.ts;
  //    2026-11-09: review fixture servers started on a held Mac at night).
  const held = machineHold()
  if (held) {
    console.log(JSON.stringify({ error: true, reason: `The test server did not start: ${held}` }))
    process.exit(1)
    return
  }

  // 1. Reap stale dirs from previous runs
  reapStaleEphemeralDirs(WALNUT_HOME)

  // Who the server works for: it ends when that process does (ephemeral-owner.ts). Read
  // before the copy and any wait, while this launcher's parent is surely still the one that asked.
  const owner = await resolveEphemeralOwner()

  // 2. A slot before the copy, so a launcher still copying counts too. Every exit of this
  // launcher gives it back unless the server took it over; a killed one leaves a dead pid.
  const slot = await takeLauncherSlot(WALNUT_HOME, owner)
  if (slot) process.on('exit', () => releaseSlot(slot.file, process.pid))

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
  if (slot) {
    try { fs.writeFileSync(path.join(tmpDir, EPHEMERAL_SLOT_FILE), JSON.stringify({ file: slot.file })) } catch { /* it still holds the slot by pid */ }
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
  // The slot is the server's from here: it ends when the server does, not this launcher.
  // With its start time, so a pid reused after a crash during boot never holds the slot.
  if (slot && childPid != null && !updateSlot(slot.file, process.pid, { pid: childPid, start: await processStartOf(childPid), role: 'server' })) {
    process.stderr.write(`ephemeral: could not hand slot ${slot.file} to the server (pid ${childPid}); it is not counted until it rewrites the slot\n`)
  }
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
    // exitLog: where the server writes why it ended (its own logs go with its dirs).
    console.log(JSON.stringify({ ...data, daemonDir: runtimeDir, exitLog: ephemeralExitLogFile(), owner, snapshot, pausedCronJobs, removedPushTokens, stoppedTunnels, stoppedTriage, droppedQueuedMessages }))
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
 * The launcher's slot, null when there is no cap (WALNUT_EPHEMERAL_MAX=0). Waits when all are
 * held; one that waited too long, or whose owner went, exits 1 with what to do.
 */
async function takeLauncherSlot(walnutHome: string, owner: EphemeralOwner | null): Promise<HeldSlot | null> {
  const max = ephemeralMaxServers()
  if (max <= 0) return null
  const waitMs = ephemeralWaitMs()
  const got = await acquireEphemeralSlot({
    dir: ephemeralSlotDir(walnutHome), max, waitMs,
    holder: { pid: process.pid, start: await processStartOf(process.pid), role: 'launcher', takenAt: Date.now(), ownerPid: owner?.pid ?? null, ownerCommand: owner?.command.slice(0, 80) },
    contendedMinutes: CONTENDED_IDLE_TTL_MS / 60_000,
    liveServers: () => liveEphemeralServers(walnutHome),
    say: (line) => process.stderr.write(`${line}\n`),
    ...(owner ? { ownerGone: () => ownerGone(owner) } : {}),
  })
  if (got.slot) return got.slot
  const lines = got.reason === 'timeout'
    ? giveUpLines(got.running, max, waitMs)
    : [`ephemeral: stopped waiting for a slot: the process that asked for this server (pid ${owner?.pid}) is gone.`]
  for (const line of lines) process.stderr.write(`${line}\n`)
  // JSON to stdout too, so the calling session can parse it.
  console.log(JSON.stringify({ error: true, reason: lines[0], running: got.running.length, limit: max }))
  process.exit(1)
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
  // Why this server ends, written to the machine's exit log at exit (ephemeral-exit-record.ts):
  // its own logs go with its dirs. Every exit below names its rule through exitChild or cleanup.
  let exitWhy: { rule: EphemeralExitRule; detail: string } | null = null
  const facts: { port?: number; ownerPid?: number | null; idleMinutes?: () => number } = {}
  const idleLimitMinutes = EPHEMERAL_IDLE_TTL_MS / 60_000
  process.on('exit', (code) => {
    recordEphemeralExit({
      ...(exitWhy ?? { rule: 'crash' as const, detail: `exited with code ${code} and no reason of its own (an uncaught error, see the line before)` }),
      pid: process.pid, port: facts.port, snapshotDir: process.env.OPEN_WALNUT_HOME, ownerPid: facts.ownerPid,
      ...(facts.idleMinutes ? { idleMinutes: facts.idleMinutes(), idleLimitMinutes } : {}),
      uptimeSec: process.uptime(), code,
    })
  })
  // The slot its launcher handed it (ephemeral-slots.ts), given back on every exit.
  let slotFile: string | null = null
  try { slotFile = (JSON.parse(fs.readFileSync(path.join(process.env.OPEN_WALNUT_HOME ?? '', EPHEMERAL_SLOT_FILE), 'utf-8')) as { file?: string }).file ?? null } catch { /* no cap */ }
  if (slotFile) process.on('exit', () => releaseSlot(slotFile!, process.pid))
  const exitChild = (rule: EphemeralExitRule, detail: string, code: number): never => {
    exitWhy = { rule, detail }
    process.stderr.write(`ephemeral child: ${detail}\n`)
    process.exit(code)
  }

  const tmpDir = process.env.OPEN_WALNUT_HOME
  if (!tmpDir) {
    exitChild('start-failed', 'OPEN_WALNUT_HOME not set', 1)
    return
  }

  const { startServer, stopServer, armGracefulSignalExit } = await import('../web/server.js')

  // Start server on random port — identical to production
  const httpServer = await startServer({ port: 0 })

  const addr = httpServer.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  if (!port) {
    exitChild('start-failed', 'could not determine its port', 1)
    return
  }
  facts.port = port

  let owner: EphemeralOwner | null = null
  try { owner = JSON.parse(fs.readFileSync(path.join(tmpDir, EPHEMERAL_OWNER_FILE), 'utf-8')) as EphemeralOwner } catch { /* none named */ }
  facts.ownerPid = owner?.pid ?? null

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
  facts.idleMinutes = () => (Date.now() - lastActivity) / 60_000
  // What a waiting launcher prints about this server; its start time keeps a reused pid from holding the slot.
  const noteSlot = (extra: { start?: string } = {}) => {
    if (slotFile) updateSlot(slotFile, process.pid, { role: 'server', port, lastRequestAt: lastActivity, idleLimitMinutes, ...extra })
  }
  noteSlot()
  if (slotFile) void processStartOf(process.pid).then((start) => { if (start) noteSlot({ start }) })

  const idleChecker = setInterval(() => {
    noteSlot()
    // A raised limit holds only while no launcher waits for a slot.
    const contended = slotFile ? slotWanted(path.dirname(slotFile)) : false
    const rule = idleExitRule(Date.now() - lastActivity, EPHEMERAL_IDLE_TTL_MS, contended, CONTENDED_IDLE_TTL_MS)
    if (rule === 'idle') {
      void cleanup('idle', `no HTTP request for ${facts.idleMinutes!().toFixed(1)} min (its limit is ${idleLimitMinutes} min, WALNUT_EPHEMERAL_IDLE_MINUTES)`)
    } else if (rule === 'idle-contended') {
      void cleanup('idle-contended', `no HTTP request for ${facts.idleMinutes!().toFixed(1)} min while another test server waits for a slot (limit ${CONTENDED_IDLE_TTL_MS / 60_000} min then, WALNUT_EPHEMERAL_CONTENDED_IDLE_MINUTES; its own is ${idleLimitMinutes} min)`)
    }
  }, IDLE_CHECK_INTERVAL_MS)
  idleChecker.unref()

  // Heartbeat and owner: touch the control file, and end once the owner is surely gone.
  const stopOwnerWatch = startOwnerWatch(controlFile, owner, (reason) => { void cleanup('owner-gone', reason) })

  let cleaningUp = false
  async function cleanup(rule: EphemeralExitRule, reason: string): Promise<void> {
    if (cleaningUp) return
    cleaningUp = true
    exitWhy = { rule, detail: reason }

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
      exitWhy = { rule: 'forced', detail: `${reason}, and its shutdown did not finish in 10 s` }
      void removeAll(3_000).finally(() => process.exit(1))
    }, 10_000)
    forceExit.unref()

    // The daemons it ran on remote hosts, each in its own root there (remote-isolation.ts):
    // stopped and removed while their ssh masters are still up. Bounded; a daemon left
    // behind ends itself once no server has come for a while.
    try {
      const [{ retireIsolatedRemoteDaemons, isolatedRemoteHosts }, { endTestServerRemoteTerminals, retireTestServerTerminalRoots }, { testServerTerminalHosts }] = await Promise.all([
        import('../providers/daemon-connection.js'), import('../web/terminal/dtach-lifecycle.js'), import('../web/terminal/spawn.js'),
      ])
      // Hosts reached through a daemon and hosts reached only by a terminal (its own ssh, no daemon).
      const hosts = [...new Set([...isolatedRemoteHosts(), ...testServerTerminalHosts()])]
      const retire = endTestServerRemoteTerminals(hosts).catch(() => {})
        .then(() => retireIsolatedRemoteDaemons(4_000))
        .then(() => retireTestServerTerminalRoots(testServerTerminalHosts()).catch(() => {}))
      await Promise.race([retire, new Promise((r) => setTimeout(r, 6_000))])
    } catch { /* best-effort */ }
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

  process.on('SIGINT', () => cleanup('signal', 'SIGINT from another process'))
  process.on('SIGTERM', () => cleanup('signal', 'SIGTERM from another process'))
  // Claim ownership of the signal, or startServer()'s own always-fatal handler
  // wins the race: it sees no armed owner, removeAllListeners('SIGTERM') and
  // re-raises with the default disposition, so the process dies instantly and
  // cleanup() above never reaches its rmSync. Measured: a SIGTERMed child left
  // its whole 3.2G snapshot behind. Must come AFTER the handlers are registered
  // (server.ts documents that ordering).
  armGracefulSignalExit()
}
