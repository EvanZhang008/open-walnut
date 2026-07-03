/**
 * Session Health Monitor — periodic liveness checks for non-terminal sessions.
 *
 * Runs every 30 seconds inside the server process. For each non-terminal session:
 *   1. Check isProcessAlive (routes through session manager or daemon connection)
 *   2. If process dead: set process_status='error' (with errorMessage) or 'stopped'
 *   3. Clear task session slot on error (agent_complete keeps slot for resume)
 *   4. Emit session:status-changed
 *   5. Check idle timeout: kill sessions whose outputFile mtime exceeds the threshold.
 *      Uses file mtime — persistent on disk, survives server restarts, no state machine dependency.
 */

import fsp from 'node:fs/promises'
import { log } from '../logging/index.js'
import { isProcessAliveAsync } from '../utils/process.js'
import { isSessionProcessAlive, isLocalJsonlFresh } from '../utils/session-liveness.js'
import { bus, EventNames } from './event-bus.js'
import type { SessionRecord, Task, TaskPhase } from './types.js'
const HEALTH_CHECK_INTERVAL_MS = 30_000
/**
 * Default idle timeouts — local vs remote.
 *
 * Remote sessions run on a dev host and cost the user nothing local; premature
 * reaping forces a slow `--resume` spawn (~10s) and leaves a misleading
 * `[Request interrupted by user]` marker in the transcript (CLI SIGINT handler
 * writes it — there's no "silent shutdown" path in print mode). Users leaving
 * AWAIT_HUMAN_ACTION sessions overnight for review hit this constantly.
 *
 * Local sessions share the laptop's RAM/CPU, so we're stricter — but 30 min
 * was too aggressive for turns with long think time.
 */
const DEFAULT_LOCAL_IDLE_TIMEOUT_MS = 60 * 60 * 1000
const DEFAULT_REMOTE_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000

export class SessionHealthMonitor {
  private timer: ReturnType<typeof setInterval> | null = null

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.check().catch(() => {}), HEALTH_CHECK_INTERVAL_MS)
    log.session.info('session health monitor started', { intervalMs: HEALTH_CHECK_INTERVAL_MS })
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
      log.session.info('session health monitor stopped')
    }
  }

  async check(): Promise<void> {
    const { markCriticalSection } = await import('./event-loop-monitor.js')
    const endSection = markCriticalSection('health-monitor.check')
    try {
      await this.checkInner()
    } finally {
      endSection()
    }
  }

  private async checkInner(): Promise<void> {
    const checkT0 = Date.now()
    const { listSessions, isTerminalSession, updateSessionRecord } = await import('./session-tracker.js')

    // ── Single snapshot per cycle ────────────────────────────────────────────
    // Previously each helper re-called listSessions() / listNonTerminalSessions(),
    // causing 3× full parse + migration of ~1000 records per 30s tick. Now we read
    // once, derive the filtered views, and pass them down.
    let allSessions: SessionRecord[]
    try {
      allSessions = await listSessions()
    } catch (err) {
      log.session.warn('health monitor: failed to list sessions', {
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }

    // Per-cycle liveness memo — isSessionProcessAlive is called up to 3× per session
    // (checkIdleTimeout, main loop, reconcileTaskPhases). Cache for the cycle.
    //
    // Promise-valued, not bool-valued: this coalesces racing callers within the same
    // tick who all call isSessionProcessAlive on the same session before the first
    // resolves — they share one in-flight probe instead of starting N of them.
    //
    // Key includes discriminators beyond claudeSessionId because killOrphanedProcesses
    // iterates ALL sessions (including archived). Per commit 1a93276, an archived
    // record can share its claudeSessionId with a new live record — but they have
    // different pid/host/process_status and must not share a cached liveness result.
    const livenessCache = new Map<string, Promise<boolean>>()
    const cachedIsAlive = (s: SessionRecord): Promise<boolean> => {
      const key = `${s.claudeSessionId}|${s.archived ? 'a' : 'l'}|${s.pid ?? 'n'}|${s.host ?? 'local'}`
      let p = livenessCache.get(key)
      if (!p) {
        p = isSessionProcessAlive(s)
        livenessCache.set(key, p)
      }
      return p
    }

    // Kill orphaned processes from terminal/stopped sessions (leaked processes)
    await this.killOrphanedProcesses(allSessions, cachedIsAlive)
    const tOrphan = Date.now()

    // Auto-recover remote sessions stuck in 'error' due to connection loss
    await this.recoverConnectionLostSessions(allSessions, updateSessionRecord)
    const tRecover = Date.now()

    let sessions = allSessions.filter(s => !isTerminalSession(s) && !s.archived)

    // ── Drain the orphan dead-pool in ONE batch write (event-loop fix) ───────
    // A local session (host==null) with pid==null can never be alive:
    // isSessionProcessAlive() returns false for it (no PID to probe, no daemon).
    // Yet such records accumulate (server restarts, daemon resets) and each tick
    // the per-session loop below would do a SEPARATE synchronous updateSessionRecord
    // for every one of them — ~293 serial transactions/tick, the confirmed source
    // of the 15s HTTP stalls. Collapse them into a single batch transition, then
    // exclude them from the serial loop. Once 'stopped' they drop out of the
    // non-terminal filter above on the next tick, so the pool drains for good.
    //
    // 2-min grace on last_status_change protects a record mid-spawn whose PID
    // hasn't been persisted yet (mirrors killOrphanedProcesses' grace).
    const ORPHAN_GRACE_MS = 2 * 60 * 1000
    const nowMs = Date.now()
    const orphanIds: string[] = []
    sessions = sessions.filter((s) => {
      const isOrphan =
        s.host == null && s.pid == null &&
        s.process_status !== 'stopped' && s.process_status !== 'error' &&
        (nowMs - new Date(s.last_status_change ?? s.startedAt ?? 0).getTime()) > ORPHAN_GRACE_MS
      if (isOrphan) { orphanIds.push(s.claudeSessionId); return false }
      return true
    })
    if (orphanIds.length > 0) {
      const { batchUpdateSessionRecords } = await import('./session-tracker.js')
      const written = await batchUpdateSessionRecords(orphanIds, {
        process_status: 'stopped',
        activity: undefined,
        last_status_change: new Date().toISOString(),
        status_reason: 'orphan_no_pid',
        status_changed_by: 'health-monitor',
      })
      log.session.info('health monitor: drained orphan dead-pool', { orphanCount: orphanIds.length, written: written.length })
    }

    if (sessions.length === 0) {
      const total = Date.now() - checkT0
      if (total > 500) log.session.warn('health monitor: check() slow (no active sessions)', { totalMs: total, orphanMs: tOrphan - checkT0, recoverMs: tRecover - tOrphan })
      return
    }

    // Batch-load all tasks upfront to avoid N+1 queries when checking task.phase
    let taskMap = new Map<string, Task>()
    try {
      const { listTasks } = await import('./task-manager.js')
      const allTasks = await listTasks()
      for (const t of allTasks) taskMap.set(t.id, t)
    } catch (err) {
      log.session.warn('health monitor: failed to load tasks for phase lookup', {
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // Detect stale AWAIT_HUMAN_ACTION sessions (stuck sub-agents)
    await this.checkStaleAwaitingSessions(sessions, updateSessionRecord, taskMap)

    // Detect hung Claude Code processes: message delivered but no Claude output for 5 minutes.
    // Root cause: Claude Code can hang internally (e.g. between autocompact and API call)
    // while the process stays alive. Idle timeout misses this because Walnut's own user
    // message writes refresh the file mtime.
    const hungKilledIds = await this.checkHungSessions(sessions, updateSessionRecord)

    // Idle timeout — kill sessions with stale outputFile mtime past the configured threshold.
    // Returns IDs of sessions it killed — the main loop must skip those to avoid
    // a race where the stale in-memory process_status ('idle') causes the main loop
    // to overwrite the correct 'stopped' with 'error' + "Process exited without result".
    const idleTimedOutIds = await this.checkIdleTimeout(sessions, updateSessionRecord, taskMap, cachedIsAlive)

    for (const session of sessions) {
      // Skip sessions already handled by idle timeout or hung detection (prevents stale-state race)
      if (idleTimedOutIds.has(session.claudeSessionId)) continue
      if (hungKilledIds.has(session.claudeSessionId)) continue

      const alive = await cachedIsAlive(session)

      // alive=true: could be 'running' or 'idle' (don't override idle→running)
      // alive=false: process is dead or unreachable past grace period
      if (!alive && session.process_status !== 'stopped' && session.process_status !== 'error') {
        const now = new Date().toISOString()
        const taskPhase = session.taskId ? taskMap.get(session.taskId)?.phase : undefined
        const isWorkInProgress = taskPhase === 'IN_PROGRESS'

        // Remote session: daemon disconnection ≠ process death.
        // The remote process may still be alive — we just can't verify it right now.
        // Always use recoverable 'error' + "Connection lost" path regardless of
        // process_status or task phase, so recoverConnectionLostSessions() can
        // probe and restore the session after the daemon reconnects.
        if (session.host) {
          await updateSessionRecord(session.claudeSessionId, {
            process_status: 'error',
            errorMessage: 'Connection lost — unable to reach remote host',
            activity: undefined,
            last_status_change: now,
            status_reason: 'remote_unreachable',
            status_changed_by: 'health-monitor',
          } as any)
          log.session.warn('health monitor: remote session unreachable', {
            sessionId: session.claudeSessionId,
            taskId: session.taskId,
            previousProcessStatus: session.process_status,
            taskPhase,
          })
          bus.emit(EventNames.SESSION_STATUS_CHANGED, {
            sessionId: session.claudeSessionId,
            taskId: session.taskId,
            process_status: 'error',
            errorMessage: 'Connection lost — unable to reach remote host',
          }, ['*'], { source: 'health-monitor', urgency: 'urgent' })
          continue
        }

        // --- Local sessions only from here ---

        if (session.process_status === 'running' && isWorkInProgress) {
          // Process died while work was in progress — determine outcome.

          // Local sessions: read the last 8KB of the JSONL file to check for a result event.
          const hasResult = session.outputFile ? await this.outputFileHasResult(session.outputFile) : false

          if (hasResult) {
            // Normal completion — process_status 'stopped'
            await updateSessionRecord(session.claudeSessionId, {
              process_status: 'stopped',
              activity: undefined,
              last_status_change: now,
              status_reason: 'normal_completion',
              status_changed_by: 'health-monitor',
            } as any)
          } else {
            // Error — process_status 'error' with detail
            await updateSessionRecord(session.claudeSessionId, {
              process_status: 'error',
              errorMessage: 'Process exited without result',
              activity: undefined,
              last_status_change: now,
              status_reason: 'process_exited_no_result',
              status_changed_by: 'health-monitor',
            } as any)
          }

          // Clear session slot for both normal completion and error —
          // frees the task's 1-session slot so a new session can start.
          if (session.taskId) {
            try {
              const { clearSessionSlot } = await import('./task-manager.js')
              const { task } = await clearSessionSlot(session.taskId, session.claudeSessionId)
              bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: hasResult ? 'session-complete' : 'session-error' })
            } catch (err) {
              log.session.warn('health monitor: failed to clear session slot', {
                sessionId: session.claudeSessionId,
                taskId: session.taskId,
                error: err instanceof Error ? err.message : String(err),
              })
            }
            // Phase sync: process death → AGENT_COMPLETE (has result) or AWAIT_HUMAN_ACTION (no result)
            try {
              const { applySessionPhase } = await import('./phase.js')
              await applySessionPhase(
                session.taskId,
                hasResult ? 'session:result' : 'session:error',
                'health-monitor:process-death',
                { sessionId: session.claudeSessionId, processAlive: false },
              )
            } catch (err) {
              log.session.warn('health monitor: phase sync failed on process death', {
                sessionId: session.claudeSessionId, taskId: session.taskId,
                error: err instanceof Error ? err.message : String(err),
              })
            }
          }

          const newProcessStatus = hasResult ? 'stopped' : 'error'
          log.session.info('health monitor: session process died', {
            sessionId: session.claudeSessionId,
            taskId: session.taskId,
            newProcessStatus,
          })

          bus.emit(EventNames.SESSION_STATUS_CHANGED, {
            sessionId: session.claudeSessionId,
            taskId: session.taskId,
            process_status: newProcessStatus,
          }, ['*'], { source: 'health-monitor', urgency: 'urgent' })
        } else {
          // Process died while idle or in non-in_progress state (local only).
          const updates: Record<string, unknown> = {
            last_status_change: now,
          }

          if (isWorkInProgress) {
            const hasResult = session.outputFile
              ? await this.outputFileHasResult(session.outputFile) : false
            if (hasResult) {
              updates.process_status = 'stopped'
              updates.status_reason = 'normal_completion'
            } else {
              updates.process_status = 'error'
              updates.errorMessage = 'Process exited without result'
              updates.status_reason = 'process_exited_no_result'
            }
            updates.activity = undefined
            updates.status_changed_by = 'health-monitor'
          } else {
            updates.process_status = 'stopped'
            updates.status_reason = 'liveness_check_failed'
            updates.status_changed_by = 'health-monitor'
          }

          await updateSessionRecord(session.claudeSessionId, updates)

          log.session.info('health monitor: process status updated', {
            sessionId: session.claudeSessionId,
            taskId: session.taskId,
            pid: session.pid,
            previousProcessStatus: session.process_status,
            taskPhase,
            ...(isWorkInProgress ? { newProcessStatus: updates.process_status } : {}),
          })

          if (isWorkInProgress) {
            bus.emit(EventNames.SESSION_STATUS_CHANGED, {
              sessionId: session.claudeSessionId,
              taskId: session.taskId,
              process_status: updates.process_status as string,
            }, ['*'], { source: 'health-monitor', urgency: 'urgent' })
            // Phase sync for idle process death with work in progress
            if (session.taskId) {
              const hasResult = updates.status_reason === 'normal_completion'
              try {
                const { applySessionPhase } = await import('./phase.js')
                await applySessionPhase(
                  session.taskId,
                  hasResult ? 'session:result' : 'session:error',
                  'health-monitor:process-death-idle',
                  { sessionId: session.claudeSessionId, processAlive: false },
                )
              } catch (err) {
                log.session.warn('health monitor: phase sync failed on idle process death', {
                  sessionId: session.claudeSessionId, taskId: session.taskId,
                  error: err instanceof Error ? err.message : String(err),
                })
              }
            }
          }
        }
      }
    }

    // Layer 2: Reconcile task phases from session facts (30s cycle)
    await this.reconcileTaskPhases(sessions, taskMap, cachedIsAlive)

    // Log total check duration (> 500ms = worth investigating)
    const checkTotal = Date.now() - checkT0
    if (checkTotal > 500) {
      log.session.warn('health monitor: check() slow', {
        totalMs: checkTotal, orphanMs: tOrphan - checkT0, recoverMs: tRecover - tOrphan,
        sessionCount: sessions.length, taskCount: taskMap.size,
      })
    }
  }

  /**
   * Detect sessions where a message was delivered but Claude produced no output.
   * Does NOT kill — just logs a warning and updates the activity field so the UI
   * shows a yellow banner. The user or idle timeout handles the actual recovery.
   *
   * Logs at 5 min (warn, once) so next time we have server-side evidence without
   * needing to dig through Claude Code's internal debug log.
   */
  private async checkHungSessions(
    sessions: SessionRecord[],
    updateSessionRecord: (id: string, update: Record<string, unknown>) => Promise<unknown>,
  ): Promise<Set<string>> {
    const WARN_THRESHOLD_MS = 5 * 60 * 1000  // log warning after 5 min with no Claude output
    const flaggedIds = new Set<string>()

    let runner: { getSessionTimestamps(id: string): { lastClaudeOutputAt: number; lastMessageDeliveryAt: number } | undefined; isTeamActive(id: string): boolean; isBackgroundWorkActive(id: string): boolean | Promise<boolean> } | undefined
    try {
      const { sessionRunner } = await import('../providers/claude-code-session.js')
      runner = sessionRunner
    } catch { return flaggedIds }

    for (const session of sessions) {
      if (session.process_status !== 'running') continue

      // Skip team-active sessions — poll loop produces no Claude output, but is not hung
      if (runner.isTeamActive(session.claudeSessionId)) continue
      // Skip sessions running a dynamic workflow / background subagents — the main turn
      // produces no output for minutes, but the session is busy, not hung. L2: this PULLs the
      // daemon-authoritative task state and reconciles any lost-terminal event before deciding,
      // so a wedged session self-heals on this tick (see claude-code-session reconcileFromDaemon).
      if (await runner.isBackgroundWorkActive(session.claudeSessionId)) continue

      const ts = runner.getSessionTimestamps(session.claudeSessionId)
      if (!ts) continue
      if (ts.lastMessageDeliveryAt === 0) continue  // no message delivered yet

      // Only flag if a message was delivered AFTER the last Claude output
      if (ts.lastClaudeOutputAt >= ts.lastMessageDeliveryAt) continue

      const waitingMs = Date.now() - ts.lastMessageDeliveryAt
      if (waitingMs < WARN_THRESHOLD_MS) continue

      const waitingMin = Math.round(waitingMs / 60_000)

      // Log warning (every 30s health check will re-log, but that's fine for diagnostics)
      log.session.warn('health monitor: possible hung session — no Claude output after message delivery', {
        sessionId: session.claudeSessionId,
        taskId: session.taskId,
        pid: session.pid,
        waitingMinutes: waitingMin,
        lastMessageDeliveryAt: new Date(ts.lastMessageDeliveryAt).toISOString(),
        lastClaudeOutputAt: ts.lastClaudeOutputAt ? new Date(ts.lastClaudeOutputAt).toISOString() : 'never',
      })

      // Update activity so UI shows a yellow warning banner
      await updateSessionRecord(session.claudeSessionId, {
        activity: `Waiting for response (${waitingMin} min)...`,
      })

      bus.emit(EventNames.SESSION_STATUS_CHANGED, {
        sessionId: session.claudeSessionId,
        taskId: session.taskId,
        process_status: 'running',
        activity: `Waiting for response (${waitingMin} min)...`,
      }, ['*'], { source: 'health-monitor' })

      flaggedIds.add(session.claudeSessionId)
    }

    return flaggedIds
  }

  /**
   * Idle timeout based on SessionManager.lastEventAt (preferred) or file mtime (fallback).
   *
   * Checks ALL non-terminal sessions with a live process. Defaults: 1h for
   * local, 2h for remote (remote sessions are cheap for the laptop and
   * premature reap produces a bogus "[Request interrupted by user]" marker in
   * the transcript — see CLI print.ts SIGINT handler). Override via
   * config.session.idle_timeout_minutes (applies to both unless 0 = disabled).
   *
   * Skips sessions whose task phase is AWAIT_HUMAN_ACTION — they're waiting for user input, not truly idle.
   */
  private async checkIdleTimeout(
    sessions: SessionRecord[],
    updateSessionRecord: (id: string, update: Record<string, unknown>) => Promise<unknown>,
    taskMap: Map<string, Task>,
    cachedIsAlive: (s: SessionRecord) => Promise<boolean>,
  ): Promise<Set<string>> {
    const killedIds = new Set<string>()
    // Config override applies uniformly to local + remote when set. 0 = disabled.
    let configOverrideMs: number | null = null
    try {
      const { getConfig } = await import('./config-manager.js')
      const config = await getConfig()
      const mins = config.session?.idle_timeout_minutes
      if (mins != null) {
        configOverrideMs = mins === 0 ? 0 : mins * 60 * 1000
      }
    } catch (err) {
      log.session.debug('health monitor: config not available, using default idle timeout', {
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // Explicit 0 override = disabled
    if (configOverrideMs === 0) return killedIds

    const now = Date.now()

    const { getRegisteredSessionManager } = await import('../providers/session-manager.js')

    // Import sessionRunner for team-active + background-work + permission checks (lazy, cached by Node module system)
    let runner: { isTeamActive(id: string): boolean; isBackgroundWorkActive?(id: string): boolean | Promise<boolean>; hasPendingPermission?(id: string): boolean } | undefined
    try {
      const { sessionRunner } = await import('../providers/claude-code-session.js')
      runner = sessionRunner
    } catch { /* fallback: no team check */ }

    for (const session of sessions) {
      // Per-session threshold: config override wins; otherwise remote gets 2h, local gets 1h.
      const isRemote = !!session.host
      const idleTimeoutMs = configOverrideMs
        ?? (isRemote ? DEFAULT_REMOTE_IDLE_TIMEOUT_MS : DEFAULT_LOCAL_IDLE_TIMEOUT_MS)

      // Skip sessions whose task is awaiting human action — they're waiting for user input, not truly idle
      const taskPhase = session.taskId ? taskMap.get(session.taskId)?.phase : undefined
      if (taskPhase === 'AWAIT_HUMAN_ACTION') continue

      // Skip team-active sessions — lead session is polling for in-process teammate
      // results (Claude Code team mode). No JSONL output during poll loop sleep, but
      // the session is NOT idle — teammates are working on the remote/local host.
      if (runner?.isTeamActive(session.claudeSessionId)) {
        log.session.debug('health monitor: skipping idle check — team active', {
          sessionId: session.claudeSessionId, taskId: session.taskId,
        })
        continue
      }

      // Skip sessions running a dynamic workflow / background subagents — they can run
      // for many minutes (up to the CLI's 10-min bg-wait ceiling) with no main-turn
      // output, but the session is busy, not idle. Killing it would abort the workflow.
      // L2: PULLs the daemon-authoritative task state and reconciles any lost-terminal event
      // first, so a wedged session self-heals on this tick (see reconcileFromDaemon).
      if (await runner?.isBackgroundWorkActive?.(session.claudeSessionId)) {
        log.session.debug('health monitor: skipping idle check — background work active', {
          sessionId: session.claudeSessionId, taskId: session.taskId,
        })
        continue
      }

      // Skip sessions waiting for permission — they re-emit every 60s for visibility.
      // No auto-resolve: session waits indefinitely for human decision.
      // Don't kill the process: Claude Code is alive but blocked on control_response.
      if (runner?.hasPendingPermission?.(session.claudeSessionId)) {
        log.session.debug('health monitor: skipping idle check — pending permission', {
          sessionId: session.claudeSessionId, taskId: session.taskId,
        })
        continue
      }

      // Check if process is actually alive before spending time on idle check
      if (!await cachedIsAlive(session)) continue

      // Determine last activity time:
      // 1. Prefer SessionManager.lastEventAt (works for both local and remote)
      // 2. Fallback to file mtime for local sessions without an active manager
      const mgr = getRegisteredSessionManager(session.claudeSessionId)
      let lastActiveMs: number
      if (mgr) {
        lastActiveMs = mgr.lastEventAt
        if (lastActiveMs === 0) continue  // No events received yet — skip
      } else if (session.outputFile && !session.outputFile.startsWith('remote://')) {
        try {
          const stat = await fsp.stat(session.outputFile)
          lastActiveMs = stat.mtimeMs
        } catch {
          continue  // Can't stat file — skip
        }
      } else {
        continue  // No manager and no output file (or remote sentinel) — skip
      }

      const idleDurationMs = now - lastActiveMs
      if (idleDurationMs < idleTimeoutMs) continue

      // Second-line defense: if the session record shows a recent status
      // transition (e.g. AWAIT_HUMAN_ACTION → IN_PROGRESS triggered by a
      // fresh user message), treat that as activity even if lastEventAt is
      // stale. Otherwise a remote session that just received a new message
      // — but whose first JSONL response hasn't arrived yet — would be
      // killed mid-turn. The primary fix bumps lastEventAt on writeMessage
      // (remote-session-manager.ts); this guard catches any other code path
      // that moves the session record forward without touching the manager.
      if (session.last_status_change) {
        const statusChangeMs = Date.parse(session.last_status_change)
        if (!Number.isNaN(statusChangeMs) && now - statusChangeMs < idleTimeoutMs) {
          log.session.debug('health monitor: skipping idle check — recent status change', {
            sessionId: session.claudeSessionId,
            lastStatusChange: session.last_status_change,
            ageMs: now - statusChangeMs,
          })
          continue
        }
      }

      const idleMinutes = Math.round(idleDurationMs / 60_000)
      log.session.info('health monitor: idle timeout — killing session', {
        sessionId: session.claudeSessionId,
        taskId: session.taskId,
        pid: session.pid,
        host: session.host,
        idleMinutes,
        thresholdMinutes: Math.round(idleTimeoutMs / 60_000),
        source: mgr ? 'lastEventAt' : 'file-mtime',
      })

      // Graceful kill via session manager if available (handles both local + remote),
      // otherwise fall back to local PID signals.
      if (mgr) {
        mgr.kill()
      } else {
        const pid = session.pid
        if (pid == null) continue  // No PID — can't signal; skip to next session
        // Kill entire process group (-pid) to also clean up MCP child processes
        try { process.kill(-pid, 'SIGINT') } catch { /* already dead */ }
        // Deferred SIGTERM/SIGKILL fallback — fire-and-forget, doesn't block health check loop
        setTimeout(() => {
          isProcessAliveAsync(pid, 'claude').then((alive) => {
            if (alive) {
              try { process.kill(-pid, 'SIGTERM') } catch { /* already dead */ }
              setTimeout(() => {
                try { process.kill(-pid, 'SIGKILL') } catch {}
              }, 2_000)
            }
          }).catch(() => {})
        }, 5_000)
      }

      killedIds.add(session.claudeSessionId)

      const updateNow = new Date().toISOString()
      await updateSessionRecord(session.claudeSessionId, {
        process_status: 'stopped',
        errorMessage: `No output for ${idleMinutes} min`,
        activity: undefined,
        last_status_change: updateNow,
        status_reason: 'idle_timeout',
        status_changed_by: 'health-monitor',
      } as any)

      bus.emit(EventNames.SESSION_STATUS_CHANGED, {
        sessionId: session.claudeSessionId,
        taskId: session.taskId,
        process_status: 'stopped',
      }, ['*'], { source: 'health-monitor' })

      // Phase sync: idle timeout → AWAIT_HUMAN_ACTION (we killed the session, not a normal completion)
      if (session.taskId) {
        try {
          const { applySessionPhase } = await import('./phase.js')
          await applySessionPhase(
            session.taskId, 'session:error', 'health-monitor:idle-timeout',
            { sessionId: session.claudeSessionId, processAlive: false },
          )
        } catch (err) {
          log.session.warn('health monitor: phase sync failed on idle timeout', {
            sessionId: session.claudeSessionId, taskId: session.taskId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    return killedIds
  }

  /**
   * Detect sessions that are "idle" with await_human_action but haven't produced
   * any JSONL output for a long time. These sessions likely have stuck sub-agents.
   * Emits a status change event so the UI shows a warning.
   */
  private async checkStaleAwaitingSessions(
    sessions: SessionRecord[],
    updateSessionRecord: (id: string, update: Record<string, unknown>) => Promise<unknown>,
    taskMap: Map<string, Task>,
  ): Promise<void> {
    const STALE_THRESHOLD_MS = 60 * 60 * 1000  // 1 hour with no output = stale

    const { getRegisteredSessionManager } = await import('../providers/session-manager.js')

    for (const session of sessions) {
      // Check both running and idle — AWAIT_HUMAN_ACTION can be in either state
      if (session.process_status === 'stopped' || session.process_status === 'error') continue
      const taskPhase = session.taskId ? taskMap.get(session.taskId)?.phase : undefined
      if (taskPhase !== 'AWAIT_HUMAN_ACTION') continue

      // Determine last activity time via session manager or file mtime
      const mgr = getRegisteredSessionManager(session.claudeSessionId)
      let lastActiveMs: number
      if (mgr) {
        lastActiveMs = mgr.lastEventAt
        if (lastActiveMs === 0) continue  // No events yet — not stale
      } else if (session.outputFile && !session.outputFile.startsWith('remote://')) {
        try {
          lastActiveMs = (await fsp.stat(session.outputFile)).mtimeMs
        } catch {
          continue
        }
      } else {
        continue  // No manager and no output file (or remote sentinel) — skip
      }

      const ageMs = Date.now() - lastActiveMs
      if (ageMs < STALE_THRESHOLD_MS) continue  // Still active

      // Output is stale — update activity to warn user
      const staleMinutes = Math.round(ageMs / 60_000)
      log.session.warn('health monitor: await_human_action session has stale output', {
        sessionId: session.claudeSessionId,
        taskId: session.taskId,
        staleMinutes,
      })

      await updateSessionRecord(session.claudeSessionId, {
        activity: `Possibly stuck — no output for ${staleMinutes} min`,
        last_status_change: new Date().toISOString(),
      })

      bus.emit(EventNames.SESSION_STATUS_CHANGED, {
        sessionId: session.claudeSessionId,
        taskId: session.taskId,
        process_status: session.process_status,
        phase: 'AWAIT_HUMAN_ACTION' as TaskPhase,
        activity: `Possibly stuck — no output for ${staleMinutes} min`,
      }, ['*'], { source: 'health-monitor' })
    }
  }

  /**
   * Kill orphaned OS processes from sessions that are in terminal state
   * (completed/error) or marked stopped but whose process is still alive.
   * These are invisible to the normal health checks (which only scan non-terminal sessions)
   * and accumulate over time, eventually exhausting OS resources.
   *
   * NOTE: This function is the PID-reuse defense for Walnut. isSessionProcessAlive()
   * no longer does `ps`-based binary verification (too expensive on the hot path) —
   * see the header comment in src/utils/session-liveness.ts for the full rationale.
   * The 2-minute grace period + activePids collision check below are what prevent us
   * from killing a recycled PID that now belongs to a different, still-active session.
   */
  private async killOrphanedProcesses(
    sessions: SessionRecord[],
    cachedIsAlive: (s: SessionRecord) => Promise<boolean>,
  ): Promise<void> {
    // Grace period: don't kill processes whose session record changed very recently.
    // The reconciler or other subsystems may have just updated the record, and the
    // current state may be transient. Real orphans are always older than 2 minutes.
    // 2 min = worst-case reconciler duration + a few HEALTH_CHECK_INTERVAL_MS (30s each)
    // cycles to handle transient states created during server startup.
    const ORPHAN_GRACE_MS = 2 * 60 * 1000

    try {
      const { isTerminalSession } = await import('./session-tracker.js')

      // Build set of PIDs actively used by non-terminal, non-stopped sessions.
      // This prevents PID-reuse collisions: OS can recycle a PID from a completed
      // session and assign it to a new active session.
      const activePids = new Set<number>()
      for (const s of sessions) {
        if (s.pid == null) continue
        const isStopped = s.process_status === 'stopped' || s.process_status === 'error'
        if (!isTerminalSession(s) && !isStopped) {
          activePids.add(s.pid)
        }
      }

      const now = Date.now()
      let killed = 0
      for (const s of sessions) {
        if (s.pid == null) continue
        if (s.provider === 'embedded' || s.provider === 'sdk') continue

        // Only target sessions that SHOULD have no running process
        const isStopped = s.process_status === 'stopped' || s.process_status === 'error'
        if (!isTerminalSession(s) && !isStopped) continue

        // Grace period: skip sessions whose record was recently changed.
        // Prevents killing processes during transient reconciler/startup race windows.
        const lastChange = s.last_status_change ?? s.lastActiveAt
        if (lastChange && (now - new Date(lastChange).getTime()) < ORPHAN_GRACE_MS) continue

        // PID reuse protection: skip if this PID is used by an active session
        if (activePids.has(s.pid)) {
          log.session.warn('health monitor: skipping orphan kill — PID reuse collision detected', {
            staleSessionId: s.claudeSessionId, pid: s.pid,
            staleProcessStatus: s.process_status,
          })
          continue
        }

        if (!await cachedIsAlive(s)) continue

        // GROUND-TRUTH RECHECK before a destructive kill — veto on POSITIVE proof of life.
        // We only reach here because the session is terminal/stopped AND the pid is still
        // alive — exactly the state a WRONG 'stopped' flag produces (e.g. the server-restart
        // reconciler mis-marking a live local session). Trusting that stale flag is what
        // SIGTERM'd a healthy CLI in the false-zombie incident. The DB status flag is not
        // authoritative; the JSONL mtime is (same signal the daemon's reapSession uses).
        // Veto ONLY on `=== true` (a fresh JSONL = positive proof the CLI is still working).
        // 'unknown' (remote session, or local file already cleaned/archived) is NOT evidence
        // of life and must fall through — vetoing on it would leak orphans. PID-reuse here is
        // already guarded by the activePids check above; remote cleanup is the daemon's job.
        if (isLocalJsonlFresh(s, ORPHAN_GRACE_MS) === true) {
          log.session.warn('health monitor: skipping orphan kill — JSONL recently written (process alive despite stopped flag)', {
            sessionId: s.claudeSessionId, pid: s.pid, process_status: s.process_status,
          })
          continue
        }

        log.session.warn('health monitor: killing orphaned process', {
          sessionId: s.claudeSessionId,
          taskId: s.taskId,
          pid: s.pid,
          process_status: s.process_status,
        })

        // Kill entire process group (-pid) to also clean up MCP child processes
        try { process.kill(-s.pid, 'SIGTERM') } catch { /* already dead */ }

        // Remote process cleanup is handled by daemon transport when the local tunnel dies.

        killed++
      }

      if (killed > 0) {
        log.session.info('health monitor: killed orphaned processes', { count: killed })
      }
    } catch (err) {
      log.session.debug('health monitor: orphan process cleanup failed, will retry', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Auto-recover remote sessions stuck in 'error' with "Connection lost" message.
   *
   * This is the persistent recovery loop that runs every 30s. It complements
   * DaemonConnection.recoverDisconnectedSessions() (which is one-shot on reconnect)
   * by continuously retrying recovery for sessions that were missed due to
   * timing races (e.g. daemon reconnected before health monitor marked error).
   *
   * For each matching session:
   *   - Daemon connected + process alive → restore to 'running'
   *   - Daemon connected + process dead → set 'stopped' (resumable)
   *   - Daemon not connected → update activity to "Reconnecting..." (UI shows yellow banner)
   */
  private async recoverConnectionLostSessions(
    sessions: SessionRecord[],
    updateSessionRecord: (id: string, update: Record<string, unknown>) => Promise<unknown>,
  ): Promise<void> {
    try {
      const { isDaemonConnected, probeDaemonSession } = await import('../providers/daemon-connection.js')

      for (const s of sessions) {
        // Only target remote sessions in error state with "Connection lost" message
        if (!s.host) continue
        if (s.process_status !== 'error') continue
        if (!s.errorMessage?.includes('Connection lost')) continue
        if (s.archived) continue

        try {
          if (isDaemonConnected(s.host)) {
            // Daemon is connected — probe the remote process
            const probe = await probeDaemonSession(s.host, s.claudeSessionId)

            if (probe === null) {
              // Probe failed (daemon disconnected mid-probe) — retry next cycle
              continue
            }

            const now = new Date().toISOString()
            if (probe.alive) {
              // Process still running — restore session
              await updateSessionRecord(s.claudeSessionId, {
                process_status: 'running',
                errorMessage: undefined,
                activity: undefined,
                last_status_change: now,
                status_reason: 'auto_recovered',
                status_changed_by: 'health-monitor',
              } as any)
              bus.emit(EventNames.SESSION_STATUS_CHANGED, {
                sessionId: s.claudeSessionId,
                taskId: s.taskId,
                process_status: 'running',
              }, ['*'], { source: 'health-monitor', urgency: 'urgent' })
              log.session.info('health monitor: auto-recovered connection-lost session', {
                sessionId: s.claudeSessionId, host: s.host, alive: true,
              })
            } else {
              // Process dead — mark stopped (user's next message will --resume)
              await updateSessionRecord(s.claudeSessionId, {
                process_status: 'stopped',
                errorMessage: undefined,
                activity: undefined,
                last_status_change: now,
                status_reason: 'auto_recovered_dead',
                status_changed_by: 'health-monitor',
              } as any)
              bus.emit(EventNames.SESSION_STATUS_CHANGED, {
                sessionId: s.claudeSessionId,
                taskId: s.taskId,
                process_status: 'stopped',
              }, ['*'], { source: 'health-monitor', urgency: 'urgent' })
              log.session.info('health monitor: auto-recovered connection-lost session (process dead)', {
                sessionId: s.claudeSessionId, host: s.host, alive: false,
              })

              // Phase sync: remote process died during connection loss — result may
              // have been lost. Advance task phase so it doesn't stay stuck at IN_PROGRESS.
              if (s.taskId) {
                try {
                  const { applySessionPhase } = await import('./phase.js')
                  await applySessionPhase(
                    s.taskId, 'session:result', 'health-monitor:remote-dead-recovery',
                    { sessionId: s.claudeSessionId, processAlive: false },
                  )
                } catch (err) {
                  log.session.warn('health monitor: phase sync failed on remote dead recovery', {
                    sessionId: s.claudeSessionId, taskId: s.taskId,
                    error: err instanceof Error ? err.message : String(err),
                  })
                }
              }
            }
          } else {
            // Daemon not connected — update activity so UI shows "Reconnecting..." banner
            // Only update if not already showing reconnecting message (avoid churn)
            if (s.activity !== 'Reconnecting to remote host...') {
              await updateSessionRecord(s.claudeSessionId, {
                activity: 'Reconnecting to remote host...',
              })
              bus.emit(EventNames.SESSION_STATUS_CHANGED, {
                sessionId: s.claudeSessionId,
                taskId: s.taskId,
                process_status: 'error',
                activity: 'Reconnecting to remote host...',
              }, ['*'], { source: 'health-monitor' })
            }
          }
        } catch (err) {
          log.session.debug('health monitor: connection-lost recovery failed for session', {
            sessionId: s.claudeSessionId, host: s.host,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    } catch (err) {
      log.session.warn('health monitor: recoverConnectionLostSessions failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Layer 2 Reconciler: derive expected task phase from session facts.
   * Called every 30s. Only fixes drift — if phase is already correct, does nothing.
   *
   * IMPORTANT: Only considers the task's PRIMARY sessions (listed in task.session_ids
   * or task.session_id). Subagents (triage, etc.) also carry taskId but are NOT
   * primary sessions — their liveness must not affect task phase.
   */
  private async reconcileTaskPhases(
    sessions: SessionRecord[],
    taskMap: Map<string, Task>,
    cachedIsAlive: (s: SessionRecord) => Promise<boolean>,
  ): Promise<void> {
    const { TERMINAL_PHASES } = await import('./phase.js')

    // Build set of primary session IDs per task (from task records, not session records)
    const primarySessionIds = new Set<string>()
    for (const task of taskMap.values()) {
      if (task.session_id) primarySessionIds.add(task.session_id)
      if (task.session_ids) for (const sid of task.session_ids) primarySessionIds.add(sid)
    }

    // Deduplicate: process each task at most once.
    // Collect primary sessions per task, then decide phase per task.
    const taskSessions = new Map<string, { alive: SessionRecord[]; dead: SessionRecord[] }>()

    for (const session of sessions) {
      if (session.archived || !session.taskId) continue
      // Only consider primary sessions — skip subagents/triage
      if (!primarySessionIds.has(session.claudeSessionId)) continue
      const task = taskMap.get(session.taskId)
      if (!task || TERMINAL_PHASES.has(task.phase)) continue

      if (!taskSessions.has(session.taskId)) {
        taskSessions.set(session.taskId, { alive: [], dead: [] })
      }
      const bucket = taskSessions.get(session.taskId)!
      const processAlive = await cachedIsAlive(session)
      ;(processAlive ? bucket.alive : bucket.dead).push(session)
    }

    for (const [taskId, { alive, dead }] of taskSessions) {
      const task = taskMap.get(taskId)!

      // Only Rule A: all primary sessions dead + task stuck at IN_PROGRESS → needs attention.
      // isProcessAlive() is a hard OS fact — safe to act on.
      //
      // NO Rule B (alive → force IN_PROGRESS): if process_status is accurate, Layer 1
      // already set IN_PROGRESS on session:input. If process_status is wrong (e.g. stuck
      // at 'running' when should be 'idle'), propagating it to task phase makes two things
      // wrong. Fix session status accuracy instead.
      let expectedPhase: TaskPhase | null = null
      if (alive.length === 0 && task.phase === 'IN_PROGRESS') {
        expectedPhase = 'AWAIT_HUMAN_ACTION'  // all primary sessions dead + stuck at IN_PROGRESS
      }

      if (expectedPhase) {
        const representativeSession = alive[0] ?? dead[0]
        log.session.warn('reconciler: fixing phase drift', {
          taskId, actual: task.phase, expected: expectedPhase,
          sessionId: representativeSession?.claudeSessionId,
          aliveSessions: alive.length, deadSessions: dead.length,
        })
        try {
          const { applySessionPhase } = await import('./phase.js')
          await applySessionPhase(
            taskId, 'reconciler', 'health-monitor:reconciler',
            { sessionId: representativeSession?.claudeSessionId, newPhase: expectedPhase },
          )
        } catch (err) {
          log.session.warn('reconciler: phase fix failed', {
            taskId, expected: expectedPhase,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }
  }

  private async outputFileHasResult(filePath: string): Promise<boolean> {
    // Only read last ~8KB — result event is always the final JSONL line.
    // Avoids reading 100MB+ files for long sessions.
    let fh: fsp.FileHandle | undefined
    try {
      fh = await fsp.open(filePath, 'r')
      const stat = await fh.stat()
      const TAIL_BYTES = 8192
      const start = Math.max(0, stat.size - TAIL_BYTES)
      const buf = Buffer.alloc(Math.min(TAIL_BYTES, stat.size))
      await fh.read(buf, 0, buf.length, start)
      const tail = buf.toString('utf-8')
      for (const line of tail.split('\n')) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          // A result with is_error:true (e.g. --resume "No conversation found")
          // is NOT a successful completion — treat it as no result.
          if (event.type === 'result') return !event.is_error
        } catch { continue }  // expected: partial JSON lines in tail buffer
      }
    } catch (err) {
      log.session.debug('health monitor: cannot read output file for result check', {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      try { await fh?.close() } catch { /* ignore close errors */ }
    }
    return false
  }
}
