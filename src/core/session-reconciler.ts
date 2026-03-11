/**
 * Session Reconciler — detect zombie sessions and identify reconnectable ones.
 *
 * When the Walnut server restarts, non-terminal sessions in sessions.json may be:
 *   1. Still alive (detached process survived) → reconnectable
 *   2. Dead (process died with old server) → mark agent_complete/error
 *
 * Sessions with pid + outputFile are checked via PID liveness.
 * Legacy sessions without these fields are assumed dead.
 */

import { log } from '../logging/index.js'
import { isProcessAliveAsync } from '../utils/process.js'
import { bus, EventNames } from './event-bus.js'
import type { SessionRecord } from './types.js'

export interface ReconcileResult {
  reconciled: number
  reconnectable: SessionRecord[]
}

/**
 * Reconcile sessions.json against actual process state.
 *
 * For each session not in a terminal state (completed/error):
 *   - If it has pid + outputFile AND the process is alive → reconnectable
 *     (set process_status='running', keep current work_status)
 *   - Otherwise → mark process_status='stopped', work_status='agent_complete'
 *     (only the agent/human can set 'completed') and clean up task references
 */
export async function reconcileSessions(): Promise<ReconcileResult> {
  const { listSessions, updateSessionRecord } = await import('./session-tracker.js')

  let sessions: SessionRecord[]
  try {
    sessions = await listSessions()
  } catch (err) {
    log.session.warn('session reconciler: failed to read sessions', {
      error: err instanceof Error ? err.message : String(err),
    })
    return { reconciled: 0, reconnectable: [] }
  }

  const { TERMINAL_WORK_STATUSES } = await import('./session-tracker.js')
  const zombieCandidates = sessions.filter(
    (s) => !TERMINAL_WORK_STATUSES.has(s.work_status),
  )

  if (zombieCandidates.length === 0) {
    log.session.info('session reconciler: no non-terminal sessions found')
    return { reconciled: 0, reconnectable: [] }
  }

  log.session.info('session reconciler: checking sessions', { count: zombieCandidates.length })

  let reconciled = 0
  const reconnectable: SessionRecord[] = []

  for (const session of zombieCandidates) {
    // SDK and embedded sessions have no detached process to reconnect.
    // SDK: session server clears state on restart.
    // Embedded: in-process loop is lost when the server restarts.
    // Mark both as agent_complete so the UI shows them as resumable.
    if (session.provider === 'sdk' || session.provider === 'embedded') {
      try {
        const now = new Date().toISOString()
        await updateSessionRecord(session.claudeSessionId, {
          process_status: 'stopped',
          work_status: 'agent_complete',
          activity: undefined,
          last_status_change: now,
        })
        reconciled++

        bus.emit(EventNames.SESSION_STATUS_CHANGED, {
          sessionId: session.claudeSessionId,
          taskId: session.taskId,
          process_status: 'stopped',
          work_status: 'agent_complete',
          previousWorkStatus: session.work_status,
        }, ['*'], { source: 'reconciler', urgency: 'urgent' })

        log.session.info(`session reconciler: marked ${session.provider} session agent_complete`, {
          sessionId: session.claudeSessionId,
          taskId: session.taskId || '(none)',
        })
      } catch (err) {
        log.session.warn(`session reconciler: failed to reconcile ${session.provider} session`, {
          sessionId: session.claudeSessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      continue
    }

    // Check if this session has detached-mode fields and its process is still alive
    const processName = session.host ? 'ssh' : 'claude'
    if (session.pid != null && session.outputFile && await isProcessAliveAsync(session.pid, processName)) {
      // Process is alive — determine correct process_status:
      //   running = actively processing (work_status is in_progress)
      //   idle = turn complete, waiting for input
      const correctProcessStatus = session.work_status === 'in_progress' ? 'running' : 'idle'
      await updateSessionRecord(session.claudeSessionId, {
        process_status: correctProcessStatus,
      }).catch(() => {})

      log.session.info('session reconciler: session still alive', {
        sessionId: session.claudeSessionId,
        taskId: session.taskId || '(none)',
        pid: session.pid,
        processStatus: correctProcessStatus,
      })
      reconnectable.push(session)
      continue
    }

    // Session is dead — mark as agent_complete (not completed).
    // Only the agent or human can determine if the work is truly done.
    try {
      const now = new Date().toISOString()
      await updateSessionRecord(session.claudeSessionId, {
        process_status: 'stopped',
        work_status: 'agent_complete',
        activity: undefined,
        last_status_change: now,
      })

      // Do NOT clear session slot — agent_complete sessions are still linked
      // to their tasks and can be resumed. Slots are only cleared when
      // work_status transitions to 'completed' (agent/human decision).

      reconciled++

      // Notify UI subscribers so dashboards update immediately
      bus.emit(EventNames.SESSION_STATUS_CHANGED, {
        sessionId: session.claudeSessionId,
        taskId: session.taskId,
        process_status: 'stopped',
        work_status: 'agent_complete',
        previousWorkStatus: session.work_status,
      }, ['*'], { source: 'reconciler', urgency: 'urgent' })

      log.session.info('session reconciler: marked zombie session agent_complete', {
        sessionId: session.claudeSessionId,
        taskId: session.taskId || '(none)',
        previousWorkStatus: session.work_status,
        hadPid: session.pid != null,
      })
    } catch (err) {
      log.session.warn('session reconciler: failed to reconcile session', {
        sessionId: session.claudeSessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  log.session.info('session reconciler: done', {
    reconciled,
    reconnectable: reconnectable.length,
    total: zombieCandidates.length,
  })

  return { reconciled, reconnectable }
}
