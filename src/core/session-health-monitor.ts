/**
 * Session Health Monitor — periodic liveness checks for non-terminal sessions.
 *
 * Runs every 30 seconds inside the server process. For each session whose
 * work_status is not terminal (completed, error):
 *   1. Check isProcessAlive(pid, 'claude')
 *   2. Update process_status accordingly
 *   3. If process died while work_status was 'in_progress':
 *      → Check output file for result line → agent_complete or error
 *      → Clear task session slot only on error (agent_complete keeps slot for resume)
 *      → Emit session:status-changed
 *   4. Check idle timeout: kill sessions whose outputFile mtime exceeds the threshold.
 *      Uses file mtime — persistent on disk, survives server restarts, no state machine dependency.
 */

import fs from 'node:fs'
import { log } from '../logging/index.js'
import { isProcessAlive } from '../utils/process.js'
import { bus, EventNames } from './event-bus.js'

const HEALTH_CHECK_INTERVAL_MS = 30_000
/** Default idle timeout: 30 minutes */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000

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
    const { listNonTerminalSessions, updateSessionRecord } = await import('./session-tracker.js')

    // Kill orphaned processes from terminal/stopped sessions (leaked processes)
    await this.killOrphanedProcesses()

    let sessions
    try {
      sessions = await listNonTerminalSessions()
    } catch {
      return
    }

    if (sessions.length === 0) return

    // Detect stale await_human_action sessions (stuck sub-agents)
    await this.checkStaleAwaitingSessions(sessions, updateSessionRecord)

    // Idle timeout — kill sessions with stale outputFile mtime past the configured threshold
    await this.checkIdleTimeout(sessions, updateSessionRecord)

    for (const session of sessions) {
      // SDK and embedded sessions have no PID — skip PID-based health checks.
      // SDK: managed by session server. Embedded: in-process, status managed by SubagentRunner.
      if (session.provider === 'sdk' || session.provider === 'embedded') continue

      const processName = session.host ? 'ssh' : 'claude'
      const alive = session.pid != null && isProcessAlive(session.pid, processName)

      // Determine expected process status from PID liveness
      // alive=true: could be 'running' or 'idle' (don't override idle→running)
      // alive=false: must be 'stopped'
      if (!alive && session.process_status !== 'stopped') {
        const now = new Date().toISOString()

        if (session.process_status === 'running' && session.work_status === 'in_progress') {
          // Process died while work was in progress — determine outcome
          const hasResult = session.outputFile ? this.outputFileHasResult(session.outputFile) : false
          const newWorkStatus = hasResult ? 'agent_complete' as const : 'error' as const

          await updateSessionRecord(session.claudeSessionId, {
            process_status: 'stopped',
            work_status: newWorkStatus,
            activity: undefined,
            last_status_change: now,
          })

          // Only clear session slot on error — agent_complete sessions keep
          // their slot so the UI shows them and they can be resumed.
          if (newWorkStatus === 'error' && session.taskId) {
            try {
              const { clearSessionSlot } = await import('./task-manager.js')
              const { task } = await clearSessionSlot(session.taskId, session.claudeSessionId)
              bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'session-error' })
            } catch (err) {
              log.session.warn('health monitor: failed to clear session slot', {
                sessionId: session.claudeSessionId,
                taskId: session.taskId,
                error: err instanceof Error ? err.message : String(err),
              })
            }
          }

          log.session.info('health monitor: session process died', {
            sessionId: session.claudeSessionId,
            taskId: session.taskId,
            newWorkStatus,
          })

          bus.emit(EventNames.SESSION_STATUS_CHANGED, {
            sessionId: session.claudeSessionId,
            taskId: session.taskId,
            process_status: 'stopped',
            work_status: newWorkStatus,
            previousWorkStatus: 'in_progress',
          }, ['*'], { source: 'health-monitor', urgency: 'urgent' })
        } else {
          // Process died while idle or in non-in_progress state — just update process_status
          await updateSessionRecord(session.claudeSessionId, {
            process_status: 'stopped',
            last_status_change: now,
          })

          log.session.debug('health monitor: process status updated', {
            sessionId: session.claudeSessionId,
            taskId: session.taskId,
            pid: session.pid,
            previousProcessStatus: session.process_status,
            workStatus: session.work_status,
          })
        }
      }
    }
  }

  /**
   * Idle timeout based on JSONL output file mtime.
   *
   * Checks ALL non-terminal sessions with a live PID. If the outputFile hasn't
   * been written to in more than idle_timeout_minutes (default 30), kill the process.
   *
   * Why file mtime instead of process_status + last_status_change:
   *   - mtime is persistent — survives server restarts (it's on the filesystem)
   *   - mtime doesn't depend on the process_status state machine being correct
   *   - Works for both local and SSH sessions (local outputFile is always present)
   *   - No edge cases: if the file isn't being written, the session is idle
   *
   * Skips await_human_action sessions — they're waiting for user input, not truly idle.
   */
  private async checkIdleTimeout(
    sessions: Array<{ claudeSessionId: string; taskId?: string; pid?: number; process_status?: string; work_status?: string; host?: string; outputFile?: string; provider?: string }>,
    updateSessionRecord: (id: string, update: Record<string, unknown>) => Promise<unknown>,
  ): Promise<void> {
    // Read config to get idle_timeout_minutes
    let idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS
    try {
      const { getConfig } = await import('./config-manager.js')
      const config = await getConfig()
      const mins = config.session?.idle_timeout_minutes
      if (mins != null) {
        idleTimeoutMs = mins === 0 ? 0 : mins * 60 * 1000
      }
    } catch {
      // Config not available — use default
    }

    // 0 = disabled
    if (idleTimeoutMs <= 0) return

    const now = Date.now()

    for (const session of sessions) {
      if (session.work_status === 'await_human_action') continue  // waiting for user, not idle
      if (session.provider === 'sdk' || session.provider === 'embedded') continue
      if (session.pid == null) continue
      if (!session.outputFile) continue

      // Check if PID is actually alive before spending time on mtime check
      const processName = session.host ? 'ssh' : 'claude'
      if (!isProcessAlive(session.pid, processName)) continue

      // Check file mtime — the ground truth for "when was this session last active"
      let mtimeMs: number
      try {
        const stat = fs.statSync(session.outputFile)
        mtimeMs = stat.mtimeMs
      } catch {
        continue  // Can't stat file — skip (file may be on remote host only)
      }

      const idleDurationMs = now - mtimeMs
      if (idleDurationMs < idleTimeoutMs) continue

      const idleMinutes = Math.round(idleDurationMs / 60_000)
      log.session.info('health monitor: idle timeout (file mtime) — killing session', {
        sessionId: session.claudeSessionId,
        taskId: session.taskId,
        pid: session.pid,
        host: session.host,
        idleMinutes,
        thresholdMinutes: Math.round(idleTimeoutMs / 60_000),
      })

      // Graceful kill: SIGINT first, deferred SIGTERM fallback after 5s.
      // Does NOT busy-wait — fires SIGTERM via setTimeout so the health check continues.
      const pid = session.pid

      try { process.kill(pid, 'SIGINT') } catch { /* already dead */ }

      // Deferred SIGTERM fallback — fire-and-forget, doesn't block health check loop
      setTimeout(() => {
        if (isProcessAlive(pid, processName)) {
          try { process.kill(pid, 'SIGTERM') } catch { /* already dead */ }
        }
      }, 5_000)

      const updateNow = new Date().toISOString()
      await updateSessionRecord(session.claudeSessionId, {
        process_status: 'stopped',
        activity: undefined,
        last_status_change: updateNow,
      })

      bus.emit(EventNames.SESSION_STATUS_CHANGED, {
        sessionId: session.claudeSessionId,
        taskId: session.taskId,
        process_status: 'stopped',
        work_status: session.work_status,
      }, ['*'], { source: 'health-monitor' })
    }
  }

  /**
   * Detect sessions that are "idle" with await_human_action but haven't produced
   * any JSONL output for a long time. These sessions likely have stuck sub-agents.
   * Emits a status change event so the UI shows a warning.
   */
  private async checkStaleAwaitingSessions(
    sessions: Array<{ claudeSessionId: string; taskId?: string; pid?: number; process_status?: string; work_status?: string; outputFile?: string; lastActiveAt?: string }>,
    updateSessionRecord: (id: string, update: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    const STALE_THRESHOLD_MS = 60 * 60 * 1000  // 1 hour with no output = stale

    for (const session of sessions) {
      // Check both running and idle — await_human_action can be in either state
      if (session.process_status === 'stopped') continue
      if (session.work_status !== 'await_human_action') continue
      if (!session.outputFile) continue

      // Check if the JSONL output file has been written to recently
      try {
        const stat = fs.statSync(session.outputFile)
        const ageMs = Date.now() - stat.mtimeMs
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
          work_status: 'await_human_action',
          activity: `Possibly stuck — no output for ${staleMinutes} min`,
        }, ['*'], { source: 'health-monitor' })
      } catch {
        // Can't stat file — skip
      }
    }
  }

  /**
   * Kill orphaned OS processes from sessions that are in terminal state
   * (completed/error) or marked stopped but whose process is still alive.
   * These are invisible to the normal health checks (which only scan non-terminal sessions)
   * and accumulate over time, eventually exhausting OS resources.
   */
  private async killOrphanedProcesses(): Promise<void> {
    try {
      const { listSessions, TERMINAL_WORK_STATUSES } = await import('./session-tracker.js')
      const sessions = await listSessions()

      let killed = 0
      for (const s of sessions) {
        if (s.pid == null) continue
        if (s.provider === 'embedded' || s.provider === 'sdk') continue

        // Only target sessions that SHOULD have no running process
        const isTerminal = TERMINAL_WORK_STATUSES.has(s.work_status)
        const isStopped = s.process_status === 'stopped'
        if (!isTerminal && !isStopped) continue

        const processName = s.host ? 'ssh' : 'claude'
        if (!isProcessAlive(s.pid, processName)) continue

        log.session.warn('health monitor: killing orphaned process', {
          sessionId: s.claudeSessionId,
          taskId: s.taskId,
          pid: s.pid,
          process_status: s.process_status,
          work_status: s.work_status,
        })

        try { process.kill(s.pid, 'SIGTERM') } catch { /* already dead */ }
        killed++
      }

      if (killed > 0) {
        log.session.info('health monitor: killed orphaned processes', { count: killed })
      }
    } catch {
      // Non-critical — will retry on next health check
    }
  }

  private outputFileHasResult(filePath: string): boolean {
    // Only read last ~8KB — result event is always the final JSONL line.
    // Avoids reading 100MB+ files for long sessions.
    try {
      const fd = fs.openSync(filePath, 'r')
      try {
        const stat = fs.fstatSync(fd)
        const TAIL_BYTES = 8192
        const start = Math.max(0, stat.size - TAIL_BYTES)
        const buf = Buffer.alloc(Math.min(TAIL_BYTES, stat.size))
        fs.readSync(fd, buf, 0, buf.length, start)
        const tail = buf.toString('utf-8')
        for (const line of tail.split('\n')) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line)
            if (event.type === 'result') return true
          } catch { continue }
        }
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      // File doesn't exist or can't be read
    }
    return false
  }
}
