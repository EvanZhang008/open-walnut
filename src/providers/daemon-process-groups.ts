/**
 * The session daemon's process-group helpers: a CLI is spawned detached, so its pid is its
 * group's id, and kill(-pid) reaches the CLI and every MCP server it started. The signal, the
 * liveness probe, the session's three-step kill ladder, and the running-group scan the exit
 * ladder polls without the event loop.
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts); its callers (stop,
 * the idle scan, the CLI owner, the usage budget, the exit reap) hold these names as they did.
 * Every pid it signals comes from those callers, which prove the process is theirs first. The
 * code is the runtime's as it was; deps carry the runtime's own names (its timers and its
 * execFileSync, whose children get the runtime's env and umask).
 */
import fs from 'node:fs'
import type { ChildProcessFns } from './daemon-child-spawn.js'
import type { DaemonLog } from './daemon-module-deps.js'

export interface DaemonProcessGroupsDeps {
  logMsg: DaemonLog
  /** The runtime's own timers (daemon-runtime-timers.ts): its stop() clears them. */
  setTimeout: (fn: () => void, ms: number) => unknown
  execFileSync: ChildProcessFns['execFileSync']
}

export function createDaemonProcessGroups(deps: DaemonProcessGroupsDeps) {
  const { logMsg, setTimeout, execFileSync } = deps

  // ── Process group helpers ──
  // Claude is spawned with detached:true, so pid === PGID.
  // kill(-pid) sends signal to the entire process group (Claude + MCP servers).

  /** Send a signal to an entire process group. Returns true if signal was delivered. */
  function killProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
    // pid ≤ 1 can only be corrupted bookkeeping (a stale registry/pgid file).
    // kill(-1, sig) does NOT throw — POSIX broadcasts it to every process the
    // user can signal; on 2026-08-09 that tore down an entire GUI session.
    if (!Number.isInteger(pid) || pid <= 1) return false
    try {
      process.kill(-pid, signal)
      return true
    } catch {
      return false
    }
  }

  /** Check if any process in the group is still alive. */
  function isProcessGroupAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 1) return false
    try {
      process.kill(-pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }

  /**
   * 3-phase kill sequence for a process group:
   *   1. SIGINT  → wait 5s (graceful shutdown, on-stop hooks)
   *   2. SIGTERM → wait 2s (forceful but clean)
   *   3. SIGKILL → nuclear (guaranteed death)
   */
  function killSessionProcessGroup(pid: number, sid: string) {
    if (!isProcessGroupAlive(pid)) return

    logMsg('info', 'kill sequence: SIGINT', { sid, pid })
    killProcessGroup(pid, 'SIGINT')

    setTimeout(() => {
      if (!isProcessGroupAlive(pid)) return
      logMsg('info', 'kill sequence: SIGTERM', { sid, pid })
      killProcessGroup(pid, 'SIGTERM')

      setTimeout(() => {
        if (!isProcessGroupAlive(pid)) return
        logMsg('warn', 'kill sequence: SIGKILL', { sid, pid })
        killProcessGroup(pid, 'SIGKILL')
      }, 2000)
    }, 5000)
  }

  /** Block the thread without spinning the event loop (cleanup() has no timers). */
  function sleepSync(ms: number) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  }

  /**
   * The groups in `pids` that still have a running member. A zombie does not
   * count: the exit ladder blocks the event loop, so the daemon never reaps its own
   * dead CLIs while it waits, and kill(-pgid, 0) keeps answering for their zombies
   * (every isolated-dir exit used to wait out the whole 7s ladder). One ps per poll;
   * when ps cannot answer, kill(-pgid, 0) decides alone.
   */
  function runningGroupsSync(pids: number[]): number[] {
    const alive = pids.filter(isProcessGroupAlive)
    if (alive.length === 0) return alive
    const running = runningGroupIdsSync()
    return running ? alive.filter((pid) => running.has(pid)) : alive
  }

  /**
   * The process groups with a member that is not a zombie: from /proc on Linux
   * (a slim image has no ps), from one ps elsewhere; null when neither answers.
   */
  function runningGroupIdsSync(): Set<number> | null {
    const running = new Set<number>()
    if (fs.existsSync('/proc/self/stat')) {
      let names: string[]
      try { names = fs.readdirSync('/proc') } catch { return null }
      for (const name of names) {
        if (!/^\d+$/.test(name)) continue
        try {
          const raw = fs.readFileSync(`/proc/${name}/stat`, 'utf-8')
          // After "<pid> (<comm>) ": state, ppid, pgrp, ...
          const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
          if (fields[0] && fields[0] !== 'Z' && fields[2]) running.add(Number(fields[2]))
        } catch { /* gone meanwhile */ }
      }
      return running
    }
    let out: string
    try {
      out = execFileSync('ps', ['-A', '-o', 'pgid=', '-o', 'stat='], { encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return null
    }
    for (const line of out.split('\n')) {
      const [pgid, stat] = line.trim().split(/\s+/)
      if (pgid && stat && !stat.startsWith('Z')) running.add(Number(pgid))
    }
    return running
  }

  return { killProcessGroup, isProcessGroupAlive, killSessionProcessGroup, sleepSync, runningGroupsSync, runningGroupIdsSync }
}
