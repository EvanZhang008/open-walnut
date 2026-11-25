/**
 * Task workspaces' one bus subscriber: a completed or deleted task's workspace
 * is cleaned up by the rule in decisions.ts (cleanup.ts), and a completed task's
 * workspace that waited for its session goes once that session stops. Started at
 * server boot (primary only), with the boot pass that resumes interrupted jobs and
 * the clock that re-checks workspaces kept for unmerged commits (merge-recheck.ts).
 */

import { bus, EventNames, type BusEvent } from '../event-bus.js'
import type { Task } from '../types.js'
import { IS_EPHEMERAL } from '../../constants.js'
import { onTaskCompleted, onTaskDeleted, onTaskSessionStopped, resumeWorkspaces } from './cleanup.js'
import { log } from '../../logging/index.js'
import { bootPolicy } from '../boot-policy.js'
import { runPeriodic, type PeriodicHandle } from '../periodic-task.js'
import { MERGE_RECHECK_TICK_MS, sweepMergeRechecks } from './merge-recheck.js'
import { homeWritesStopped } from '../../lib/leader-clocks.js'

const SUBSCRIBER = 'task-workspaces'
/** The first re-check pass after a boot: a restart picks up checks that fell due meanwhile. */
const RECHECK_BOOT_DELAY_MS = 3 * 60_000
/** A pass stops starting new checks after this long (each fetches, so one can take minutes). */
const RECHECK_BUDGET_MS = 30 * 60_000

let recheck: PeriodicHandle | null = null
let recheckKick: ReturnType<typeof setTimeout> | null = null

type WorkspaceAction = { action: 'complete' | 'delete'; task: Task } | { action: 'session-stopped'; taskId: string }

/**
 * What a bus event asks of a task's workspace. Completion is read from
 * task:phase-changed, never task:completed: every path into COMPLETE emits the
 * phase change, while the board's "Mark complete" (PATCH phase) and the sync and
 * bulk paths announce plain task:updated and never task:completed.
 */
export function workspaceEventAction(event: Pick<BusEvent, 'name' | 'data'>): WorkspaceAction | null {
  if (event.name === EventNames.SESSION_STATUS_CHANGED) {
    const s = event.data as { taskId?: string | null; process_status?: string } | undefined
    return s?.taskId && (s.process_status === 'stopped' || s.process_status === 'error') ? { action: 'session-stopped', taskId: s.taskId } : null
  }
  const data = event.data as { task?: Task; newPhase?: string; oldPhase?: string } | undefined
  const task = data?.task
  if (!task?.workspace) return null
  if (event.name === EventNames.TASK_PHASE_CHANGED) {
    return data?.newPhase === 'COMPLETE' && data.oldPhase !== 'COMPLETE' ? { action: 'complete', task } : null
  }
  if (event.name === EventNames.TASK_DELETED) return { action: 'delete', task }
  return null
}

function onEvent(event: BusEvent): void {
  const hit = workspaceEventAction(event)
  if (!hit) return
  if (hit.action === 'session-stopped') {
    void onTaskSessionStopped(hit.taskId).catch((err) => log.web.warn('workspace cleanup after a session stop failed', { taskId: hit.taskId, error: String(err) }))
  } else if (hit.action === 'complete') {
    void onTaskCompleted(hit.task.id).catch((err) => log.web.warn('workspace cleanup after completion failed', { taskId: hit.task.id, error: String(err) }))
  } else {
    void onTaskDeleted(hit.task).catch((err) => log.web.warn('workspace cleanup after deletion failed', { taskId: hit.task.id, error: String(err) }))
  }
}

export function startWorkspaceWatch(): void {
  if (!bootPolicy('workspace-watch')) return
  bus.subscribe(SUBSCRIBER, onEvent, {
    global: true,
    interest: [EventNames.TASK_PHASE_CHANGED, EventNames.TASK_DELETED, EventNames.SESSION_STATUS_CHANGED],
  })
  // A test server runs over copied tasks while HOME stays real: it resumes nothing at boot.
  if (IS_EPHEMERAL) return
  void resumeWorkspaces().catch((err) => log.web.warn('workspace boot resume failed', { error: String(err) }))
  if (recheck) return
  recheck = runPeriodic('workspace-merge-recheck', MERGE_RECHECK_TICK_MS, RECHECK_BUDGET_MS, async (ctx) => {
    if (homeWritesStopped()) return
    const checked = await sweepMergeRechecks(ctx)
    if (checked > 0) log.web.info('workspace merge re-check pass', { checked })
  })
  recheckKick = setTimeout(() => recheck?.kick(), RECHECK_BOOT_DELAY_MS)
  recheckKick.unref?.()
}

export function stopWorkspaceWatch(): void {
  bus.unsubscribe(SUBSCRIBER)
  recheck?.stop()
  recheck = null
  if (recheckKick) clearTimeout(recheckKick)
  recheckKick = null
}
