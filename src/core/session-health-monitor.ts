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
 */

import fs from 'node:fs'
import { log } from '../logging/index.js'
import { isProcessAlive } from '../utils/process.js'
import { bus, EventNames } from './event-bus.js'

const HEALTH_CHECK_INTERVAL_MS = 30_000

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

    let sessions
    try {
      sessions = await listNonTerminalSessions()
    } catch {
      return
    }

    if (sessions.length === 0) return

    // Detect stale await_human_action sessions (stuck sub-agents)
    await this.checkStaleAwaitingSessions(sessions, updateSessionRecord)

    for (const session of sessions) {
      // SDK and embedded sessions have no PID — skip PID-based health checks.
      // SDK: managed by session server. Embedded: in-process, status managed by SubagentRunner.
      if (session.provider === 'sdk' || session.provider === 'embedded') continue

      const processName = session.host ? 'ssh' : 'claude'
      const alive = session.pid != null && isProcessAlive(session.pid, processName)
      const newProcessStatus = alive ? 'running' : 'stopped'

      if (newProcessStatus === session.process_status) continue

      // Process status changed
      const now = new Date().toISOString()

      if (newProcessStatus === 'stopped' && session.work_status === 'in_progress') {
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
        // Process status changed but work_status is already terminal-ish
        // (agent_complete, await_human_action) — just update process_status
        await updateSessionRecord(session.claudeSessionId, {
          process_status: newProcessStatus,
          last_status_change: now,
        })

        log.session.debug('health monitor: process status updated', {
          sessionId: session.claudeSessionId,
          taskId: session.taskId,
          pid: session.pid,
          newProcessStatus,
          workStatus: session.work_status,
        })
      }
    }
  }

  /**
   * Detect sessions that are "running" with await_human_action but haven't produced
   * any JSONL output for a long time. These sessions likely have stuck sub-agents.
   * Emits a status change event so the UI shows a warning.
   */
  private async checkStaleAwaitingSessions(
    sessions: Array<{ claudeSessionId: string; taskId?: string; pid?: number; process_status?: string; work_status?: string; outputFile?: string; lastActiveAt?: string }>,
    updateSessionRecord: (id: string, update: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    const STALE_THRESHOLD_MS = 60 * 60 * 1000  // 1 hour with no output = stale

    for (const session of sessions) {
      if (session.process_status !== 'running') continue
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
          process_status: 'running',
          work_status: 'await_human_action',
          activity: `Possibly stuck — no output for ${staleMinutes} min`,
        }, ['*'], { source: 'health-monitor' })
      } catch {
        // Can't stat file — skip
      }
    }
  }

  private outputFileHasResult(filePath: string): boolean {
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      // Check for a result event line in the JSONL
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          if (event.type === 'result') return true
        } catch {
          continue
        }
      }
    } catch {
      // File doesn't exist or can't be read
    }
    return false
  }
}
