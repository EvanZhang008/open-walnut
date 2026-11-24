/**
 * Keeping the sessions on this host alive, or ending them: the idle scanner (every minute, the
 * decision tree below), the ONE keep-alive verdict it and getState share (deriveSessionProtection,
 * with its source), the scheduler's own debug log as the last-resort cron evidence, and the boot's
 * adoption of the CLIs a previous daemon left (recordAdoptedOwners, cleanupOrphanedProcessGroups).
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts), at the place this code
 * had in its body; Main starts the scan and runs the boot adoption, the orphan stop and getState
 * read the verdict. The code is the runtime's as it was; deps carry the runtime's own names.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hasDiskCronInterest, lockLiveFifo, type DaemonCore } from './daemon-core.js'
import { Subscribers, type SessionData, type TaskState, type DaemonCronRuntime } from './daemon-session-types.js'
import type { CliOwner } from './cli-owner-core.js'
import type { FoldState } from './daemon-fold.js'
import type { DaemonEnv, DaemonLog } from './daemon-module-deps.js'

/** The one keep-alive verdict (deriveSessionProtection): what keeps a session alive, and its kill ceiling. */
export interface SessionProtection {
  source: 'cron' | 'team' | 'bg-task' | 'turn-retry' | null
  killMs: number
  detail?: string
}

export interface DaemonIdleScanDeps<W extends object> {
  daemonEnv: DaemonEnv
  SERVICE_MODE: boolean
  STREAMS_DIR: string
  sessions: Map<string, SessionData<W>>
  core: DaemonCore<SessionData<W>>
  cliOwner: CliOwner
  /** The embedded editor: an idle one is reaped by the same scan. */
  codeServer: { reapIdleCodeServer: (now: number) => boolean }
  /** The runtime's cron runtime, once Main made it. */
  cronRuntime: () => DaemonCronRuntime | null
  /** The command drain: a stopping daemon kills nothing. */
  daemonCommands: { readonly closed: boolean }
  isProcessGroupAlive: (pgid: number) => boolean
  killProcessGroup: (pid: number, signal: NodeJS.Signals) => unknown
  killSessionProcessGroup: (pid: number, sid: string) => unknown
  namedSessionId: (args: string[]) => string | undefined
  readStartTime: (pid: number) => string | null
  reapSession: (sid: string, code: number, reason: string, groupExited?: boolean) => void
  rebuildFoldStateFromJsonl: (jsonlPath: string) => { boundary: number; state: FoldState }
  rebuildTaskStateFromJsonl: (jsonlPath: string, now: number) => TaskState
  startOrphanPoll: (sid: string) => void
  logMsg: DaemonLog
}

export function createDaemonIdleScan<W extends object>(deps: DaemonIdleScanDeps<W>) {
  const { daemonEnv, SERVICE_MODE, STREAMS_DIR, sessions, core, cliOwner, codeServer, cronRuntime, daemonCommands, isProcessGroupAlive, killProcessGroup, killSessionProcessGroup, namedSessionId, readStartTime, reapSession, rebuildFoldStateFromJsonl, rebuildTaskStateFromJsonl, startOrphanPoll, logMsg } = deps

  // ── Session idle scanner ──
  // Runs every 60s, kills orphaned sessions per the decision tree:
  //   - Process already dead → cleanup process group (kill MCP residuals)
  //   - Has client watching → skip (Mac health monitor manages it)
  //   - JSONL < 5min old → skip (active)
  //   - JSONL 5min-2hr old → log warning
  //   - JSONL > 2hr old + no watcher → kill sequence

  // 5min: long enough for model response delays (up to 120s) and MCP tool execution,
  // short enough to detect stuck sessions promptly.
  // The two windows below can be shortened by their WALNUT_SESSION_* variables (tests of the scan only).
  const SESSION_IDLE_WARNING_MS = parseInt(daemonEnv.WALNUT_SESSION_IDLE_WARNING_MS || '', 10) || 5 * 60 * 1000     // 5 minutes
  // 2hr: conservative — gives plenty of time for legitimate background work (builds,
  // long MCP ops, await_human_action), but eventually reclaims resources.
  const SESSION_IDLE_KILL_MS = parseInt(daemonEnv.WALNUT_SESSION_IDLE_KILL_MS || '', 10) || 2 * 60 * 60 * 1000   // 2 hours
  // Cron-armed sessions (/loop): the CLI's in-process scheduler lives in THIS
  // process's memory — killing it silently kills the loop. Extended, not
  // disabled: the CLI auto-expires recurring crons after 7 days, so a session
  // idle beyond that has a dead scheduler and is safe to reclaim.
  const SESSION_CRON_IDLE_KILL_MS = 7 * 24 * 60 * 60 * 1000   // 7 days
  // Sessions with a running background task (local_bash / local_agent /
  // local_workflow): a wait-style bash task polls silently — its output goes to
  // the task's output_file, NOT the JSONL — so the session looks "idle" for the
  // task's whole lifetime (incident inc-1786222771315: a "wait for QA phase"
  // bash task was killed at the 2h mark while derivedRunning was 1).
  // PRINCIPLE: a session with running background work should never be reaped.
  // The Mac-side health monitor implements exactly that (isBackgroundWorkActive
  // → skip, unbounded). This daemon-side cap exists ONLY for the one edge case
  // with no client to bail us out: a live CLI whose task framework wedged and
  // will never emit a terminal event — indistinguishable from real work, and
  // without a ceiling it's an immortal process on the remote host. 3 days of
  // TOTAL JSONL silence (not task runtime) is far beyond any legitimate silent
  // stretch; the Mac monitor protects real work long before this fires.
  const SESSION_BG_IDLE_KILL_MS = 3 * 24 * 60 * 60 * 1000   // 3 days
  const SESSION_SCAN_INTERVAL_MS = 60_000             // every 60s
  // The idle scan's own cadence (WALNUT_SESSION_IDLE_SCAN_MS shortens it for a test of the scan).
  const SESSION_IDLE_SCAN_MS = parseInt(daemonEnv.WALNUT_SESSION_IDLE_SCAN_MS || '', 10) || SESSION_SCAN_INTERVAL_MS

  // ── Last-resort cron evidence: the CLI scheduler's own debug log ──
  // The fold's cronIds is a replay of the /tmp stream file — /tmp can be
  // age-cleaned (systemd-tmpfiles `v /tmp 10d`) or hand-wiped, and a rebuild
  // from a missing file yields an EMPTY fold that would strip a live loop's
  // protection. The CLI writes `[ScheduledTasks] firing <id>` to
  // ~/.claude/debug/<sid>.txt (HOME, not /tmp) in real time on every fire —
  // first-hand, process-independent evidence. Before killing, check the tail
  // of that file for a recent firing line; recent = within the kill threshold
  // (a firing inside the window means the scheduler is alive regardless of
  // what the fold thinks). Read is bounded (last 64KB) and only runs on the
  // rare kill path, never on the per-minute scan of healthy sessions.
  const CRON_DEBUG_TAIL_BYTES = 64 * 1024
  function hasRecentSchedulerFiring(sid: string, withinMs: number): boolean {
    const debugPath = path.join(os.homedir(), '.claude', 'debug', sid + '.txt')
    let fd: number
    try { fd = fs.openSync(debugPath, 'r') } catch { return false }
    try {
      const size = fs.fstatSync(fd).size
      const readLen = Math.min(size, CRON_DEBUG_TAIL_BYTES)
      const buf = Buffer.alloc(readLen)
      fs.readSync(fd, buf, 0, readLen, size - readLen)
      const text = buf.toString('utf-8')
      const cutoff = Date.now() - withinMs
      // Lines look like: 2026-08-08T01:43:58.502Z [DEBUG] [ScheduledTasks] firing 018e22e9 (recurring)
      const re = /^(\S+) \[DEBUG\] \[ScheduledTasks\] (?:firing|scheduled) /gm
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        const t = Date.parse(m[1])
        if (!Number.isNaN(t) && t >= cutoff) return true
      }
      return false
    } catch { return false } finally {
      try { fs.closeSync(fd) } catch {}
    }
  }

  // ── Session keep-alive protection: ONE authoritative verdict, with a source ──
  // Every "why is this idle session still alive?" decision flows through here,
  // and the same verdict is exposed on getState so what a human sees while
  // debugging IS what the kill path used. History: each cross-turn state the
  // CLI keeps in-process became an incident when the reaper didn't know about
  // it — /loop crons (2026-08-07), running bg tasks (inc-1786222771315), and
  // teamActive was never wired daemon-side at all. New cross-turn state = add
  // ONE branch here, nowhere else.
  // PRINCIPLE: protected sessions are extended, never exempt — the ceilings
  // below exist only as immortal-process backstops (wedged task framework /
  // expired scheduler), not as work budgets.
  function deriveSessionProtection(session: SessionData<W>, sid: string, now: number): SessionProtection {
    // Cron (7d = the CLI's own recurring-cron auto-expiry). TWO signals, either
    // arms: fold (CronCreate seen in THIS stream — covers session-only crons,
    // which never touch disk) or disk ({cwd}/.claude/scheduled_tasks.json —
    // durable crons; the fold goes blind on stream wipe/rebuild, on --resume
    // respawn (history replay re-arms the CLI scheduler with NO new CronCreate
    // line — lab 2026-08-10 P4b), and on adopted foreign tasks).
    const supervised = cronRuntime()?.get(sid)
    if (supervised?.enabled && supervised.state !== 'inactive') {
      return { source: 'cron', killMs: Number.MAX_SAFE_INTEGER, detail: 'supervision:' + supervised.state }
    }
    if (supervised?.state !== 'inactive' && Object.keys(session.foldState.cronIds).length > 0) {
      return { source: 'cron', killMs: SESSION_CRON_IDLE_KILL_MS, detail: 'fold' }
    }
    if (session.cwd) {
      // 10-min TTL cache: scans run every 60s per session; staleness only
      // delays the *lift* of protection, never a kill.
      if (session.diskCronCache && now - session.diskCronCache.at < 10 * 60_000) {
        if (session.diskCronCache.armed) {
          return { source: 'cron', killMs: SESSION_CRON_IDLE_KILL_MS, detail: 'disk-cache' }
        }
      } else {
        let tasksJson: string | null = null
        let lockJson: string | null = null
        try { tasksJson = fs.readFileSync(path.join(session.cwd, '.claude', 'scheduled_tasks.json'), 'utf-8') } catch {}
        try { lockJson = fs.readFileSync(path.join(session.cwd, '.claude', 'scheduled_tasks.lock'), 'utf-8') } catch {}
        const disk = hasDiskCronInterest({ sid, tasksJson, lockJson, nowMs: now })
        session.diskCronCache = { at: now, armed: disk.armed, reason: disk.reason }
        if (disk.armed) {
          return { source: 'cron', killMs: SESSION_CRON_IDLE_KILL_MS, detail: 'disk:' + (disk.reason ?? '') }
        }
      }
    }
    // In-process team (Claude Code team mode): the lead session polls teammates
    // between turns with no JSONL output of its own. The Mac health monitor has
    // skipped team-active sessions since day one; the daemon reaper never knew.
    if (session.foldState.teamActive) {
      return { source: 'team', killMs: SESSION_BG_IDLE_KILL_MS }
    }
    // Running background task (daemon's OWN taskState — the same fold the
    // watcher feeds): wait-style bash tasks write to output_file, not the
    // stream, so the session looks idle for the task's whole lifetime
    // (inc-1786222771315). isBackgrounded tasks are already excluded by
    // runningTaskCount.
    if (session.taskState.derivedRunning > 0) {
      return { source: 'bg-task', killMs: SESSION_BG_IDLE_KILL_MS }
    }
    // Pending turn-retry: the session is deliberately SILENT during the backoff
    // (up to 10 min), which is exactly what "idle" looks like to the reaper. This
    // is cross-turn state the reaper must know about, or the 30-min idle kill
    // silently eats a session that was waiting out an upstream outage — the retry
    // would then fire against a corpse and the whole feature would look flaky.
    if (session.turnRetryTimer) {
      return { source: 'turn-retry', killMs: SESSION_BG_IDLE_KILL_MS, detail: 'backoff-pending' }
    }
    return { source: null, killMs: SESSION_IDLE_KILL_MS }
  }

  function scanIdleSessions() {
    if (daemonCommands.closed) return
    const now = Date.now()

    // Embedded code-server rides the same 60s scan: 2h untouched → reap.
    if (codeServer.reapIdleCodeServer(now)) logMsg('info', 'idle scan: reaped idle code-server', {})

    for (const [sid, session] of sessions) {
      const pid = session.pid
      if (!pid) continue

      // 1. Process already dead? Clean up process group (MCP residuals) and skip
      if (session.exitCode !== null) {
        // Ensure any MCP children are also dead
        if (!SERVICE_MODE && isProcessGroupAlive(pid)) {
          logMsg('info', 'idle scan: cleaning dead session process group', { sid, pid })
          killProcessGroup(pid, 'SIGKILL')
        }
        continue
      }

      // Check if process is actually alive (might have died without triggering exit event)
      let alive = false
      try { process.kill(pid, 0); alive = true } catch {}
      if (!alive) {
        // Process died but we missed the exit event — clean up via the central
        // reaper (handles FIFO unlink, broadcast, registry flush).
        reapSession(sid, -1, 'idle-scan-missed-exit')
        continue
      }

      // Feed the age-cleaner watchdog: .pgid is written once at spawn and never
      // touched again, so systemd-tmpfiles' 10-day /tmp age rule (`v /tmp 10d`
      // on typical Linux dev hosts) deletes it out from under a long-lived
      // session — the jsonl self-refreshes on every output, the pgid does not,
      // and without it a daemon restart cannot re-adopt the live CLI. Touch it
      // on every scan (60s) for every live session.
      try { const t = new Date(); fs.utimesSync(session.pgidPath, t, t) } catch {}

      // 2. Has at least one subscribed ws? Skip idle check — someone cares.
      if (session.subscribers.size > 0) continue

      // 3. Check JSONL file mtime
      let mtimeMs = 0
      try {
        const stat = fs.statSync(session.jsonlPath)
        mtimeMs = stat.mtimeMs
      } catch {
        continue  // Can't stat file — skip
      }

      // Idle since the later of its last output and the last time someone watched it (Subscribers).
      const idleMs = now - Math.max(mtimeMs, session.subscribers.watchedAt || 0)

      // ONE authoritative verdict with a source — see deriveSessionProtection.
      const prot = deriveSessionProtection(session, sid, now)

      if (idleMs < SESSION_IDLE_WARNING_MS) {
        // Active — skip
        continue
      } else if (idleMs < prot.killMs) {
        // Warning zone — log but don't kill
        const idleMinutes = Math.round(idleMs / 60_000)
        logMsg('warn', 'idle scan: session idle with no subscribers', {
          sid, pid, idleMinutes,
          protectedBy: prot.source, thresholdMs: prot.killMs, detail: prot.detail,
        })
      } else {
        // Kill zone — no subscribers + no output past threshold. FINAL CHECK
        // before the irreversible kill: the CLI scheduler's own debug log
        // (HOME, survives /tmp wipes). A recent firing/scheduled line means a
        // live loop the fold failed to see (stream file wiped + rebuild, or a
        // tool_result shape change) — refuse to kill, re-check next scan.
        if (prot.source !== 'cron' && hasRecentSchedulerFiring(sid, SESSION_IDLE_KILL_MS)) {
          logMsg('warn', 'idle scan: kill vetoed — CLI scheduler debug log shows recent cron firing', {
            sid, pid, idleMinutes: Math.round(idleMs / 60_000),
          })
          continue
        }
        const idleMinutes = Math.round(idleMs / 60_000)
        // idleMinutes counts from the later of the last output and the last subscriber; outputIdleMinutes from the output alone.
        logMsg('warn', 'idle scan: killing idle session (no subscribers, no output)', {
          sid, pid, idleMinutes, outputIdleMinutes: Math.round((now - mtimeMs) / 60_000), protectedBy: prot.source, thresholdMs: prot.killMs, detail: prot.detail,
        })
        // Record the intent BEFORE signalling: the reap arrives asynchronously
        // (the orphan poll sees ESRCH and reports 'orphan-poll-dead', code -1),
        // so by then nothing remembers that WE asked for this. Without the stamp
        // reapSession can only consult the JSONL tail, which says "not a clean
        // turn end" for any session whose last line isn't a type:result — and the
        // projection then shows a red Error for our own routine reclamation.
        session.intentionalStopAt = now
        killSessionProcessGroup(pid, sid)
      }
    }
  }

  /**
   * After the startup adoption: every CLI this daemon now runs gets its owner
   * record (a CLI an older daemon spawned has none), then records of CLIs that are
   * gone are removed (cli-owner-core.ts).
   */
  async function recordAdoptedOwners(): Promise<void> {
    try {
      for (const [sid, session] of [...sessions]) {
        if (session.state !== 'running' || !session.pid) continue
        const owned = namedSessionId(session.args) ?? sid
        await cliOwner.adopt(owned, session.pid, session.startTime ?? null, session.spawnInfo?.home)
      }
      const removed = await cliOwner.prune()
      if (removed > 0) logMsg('info', 'cli owner: removed records of ended CLIs', { removed })
    } catch (err) {
      logMsg('warn', 'cli owner: startup records failed', { error: (err as Error).message })
    }
  }

  /**
   * Startup cleanup: scan .pgid files for process groups not registered in the
   * sessions map. Two outcomes per .pgid file:
   *   - Process alive, sid NOT in sessions map → legacy/half-spawned orphan
   *     (daemon was killed between writing .pgid and persisting sessions.json).
   *     Adopt it so the session survives across daemon restarts instead of
   *     being silently killed.'s post-fix behavior.
   *   - Process dead → stale pgid file, remove it.
   *
   * IMPORTANT: sids already present in `sessions` were adopted by
   * reconcileRegistry() — DO NOT touch them here. This check is the fix for the
   * bug where cleanup killed sessions that reconcile had just adopted.
   */
  function cleanupOrphanedProcessGroups() {
    let scanned = 0
    let skippedAdopted = 0
    let adoptedLegacy = 0
    let removedStale = 0
    try {
      const files = fs.readdirSync(STREAMS_DIR)
      for (const f of files) {
        if (!f.endsWith('.pgid')) continue
        scanned++
        const sid = f.replace('.pgid', '')

        // reconcileRegistry() already adopted this one with authoritative state.
        // Skipping here is load-bearing: without it, cleanup kills every session
        // reconcile just adopted (the bug that dropped 7 live clouddev sessions).
        if (sessions.has(sid)) {
          skippedAdopted++
          continue
        }

        if (SERVICE_MODE) continue
        try {
          const pgidPath = path.join(STREAMS_DIR, f)
          const pid = parseInt(fs.readFileSync(pgidPath, 'utf-8').trim(), 10)
          if (isNaN(pid) || pid <= 0) {
            try { fs.unlinkSync(pgidPath) } catch {}
            removedStale++
            continue
          }

          if (isProcessGroupAlive(pid)) {
            // Live process with no sessions.json entry — legacy pgid-only
            // (daemon died mid-spawn before persistRegistry). Adopt instead of
            // kill: the Claude CLI and its JSONL are intact, only the registry
            // entry was lost. Orphan poll will reap it if the process later dies.
            const jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl')
            const pipePath = path.join(STREAMS_DIR, sid + '.pipe')
            logMsg('info', 'startup: adopting live session from previous daemon (legacy pgid-only)', { sid, pid })
            const legacyFold = rebuildFoldStateFromJsonl(jsonlPath)
            lockLiveFifo(fs, pipePath) // see LIVE_FIFO_MODE in daemon-core.ts
            sessions.set(sid, {
              proc: null,
              pipePath,
              jsonlPath,
              pgidPath,
              pid,
              // Watcher starts at the fold rebuild's COMPLETE-line boundary — same
              // rule as registry adopt and attach-discover. 0 here would live-fan
              // the entire multi-MB history to the first subscriber AND poison the
              // client cursor (attach reply currentOffset=0 adopted as valid); a
              // raw stat().size would start mid-line (contract §4 boundary rule).
              offset: legacyFold.boundary,
              taskState: rebuildTaskStateFromJsonl(jsonlPath, Date.now()),
              foldState: legacyFold.state,
              watcher: null,
              subscribers: new Subscribers(),
              exitCode: null,
              state: 'running',
              exitReason: null,
              exitedAt: null,
              parented: false,
              startTime: readStartTime(pid),
              cwd: '',
              args: [],
              orphanPollTimer: null,
              mode: 'default',
              pendingCtrl: null,
            })
            startOrphanPoll(sid)
            adoptedLegacy++
          } else {
            // Process gone — clean up the stale pgid file
            logMsg('info', 'startup cleanup: removing stale pgid for dead session', { sid, pid })
            try { fs.unlinkSync(pgidPath) } catch {}
            removedStale++
          }
        } catch (err) {
          logMsg('warn', 'startup cleanup: error processing pgid file', { sid, error: (err as Error).message })
        }
      }
    } catch (err) {
      logMsg('warn', 'startup cleanup: readdir failed', { streamsDir: STREAMS_DIR, error: (err as Error).message })
    }
    logMsg('info', 'startup cleanup: done', {
      scanned, skippedAdopted, adoptedLegacy, removedStale,
      sessionsAfter: sessions.size,
    })
  }

  return { SESSION_IDLE_WARNING_MS, SESSION_IDLE_KILL_MS, SESSION_SCAN_INTERVAL_MS, SESSION_IDLE_SCAN_MS, hasRecentSchedulerFiring, deriveSessionProtection, scanIdleSessions, recordAdoptedOwners, cleanupOrphanedProcessGroups }
}
