/**
 * A health alarm's fix task: filed under the Walnut project (where the user's
 * Walnut work and its lead live), the way the notification center's "Ask AI to
 * fix" files one (src/web/routes/notifications.ts).
 *
 *  - `record`: a plain task with the brief as its description; nothing runs.
 *  - `start`: the same brief starts a session in Walnut's source checkout
 *    (self-repair/walnut-source.ts), told where it stands the same way.
 *
 * `tellTask` hands an alarm to a task that already has the problem (its owner,
 * or its open fix task ringing again): into its session as a Walnut note, or,
 * when it has none and fix tasks start, a session started with the note.
 */

import { randomUUID } from 'node:crypto'
import { LOG_DIR, WALNUT_HOME, WALNUT_PACKAGE_ROOT, WALNUT_REPO_URL } from '../../constants.js'
import type { FixTaskInput, TellTaskInput, TellTaskResult } from './engine.js'

export const FIX_PROJECT = 'Walnut'
export const FIX_SEND_SOURCE = 'health-alarm'

export async function openFixTask(input: FixTaskInput): Promise<{ taskId: string; started: boolean }> {
  if (input.mode === 'record') {
    const { addTask } = await import('../task-manager.js')
    const { task } = await addTask({ title: input.title, project: FIX_PROJECT, description: input.brief })
    return { taskId: task.id, started: false }
  }
  const { quickStartSession } = await import('../sessions/quick-start.js')
  const { message, cwd } = await withWhere(input.brief)
  const task = await quickStartSession({
    message,
    cwd,
    taskTitle: input.title,
    project: FIX_PROJECT,
    projectFromFolder: false,
    source: FIX_SEND_SOURCE,
    requestTs: Date.now(),
    preassignedSessionId: randomUUID(),
  })
  return { taskId: task.id, started: true }
}

/** The brief plus where Walnut's source and data are, for a session that starts on it. */
async function withWhere(brief: string): Promise<{ message: string; cwd: string }> {
  const { ensureWalnutSource } = await import('../self-repair/walnut-source.js')
  const { whereSection } = await import('../self-repair/fix-briefing.js')
  const { getVersion } = await import('../version.js')
  const { source, cloned } = await ensureWalnutSource()
  const message = [
    brief,
    '',
    ...whereSection({
      source, cloned, version: getVersion(), packageRoot: WALNUT_PACKAGE_ROOT,
      dataDir: WALNUT_HOME, logDir: LOG_DIR, repoUrl: WALNUT_REPO_URL,
    }),
  ].join('\n')
  return { message, cwd: source.dir }
}

export async function tellTask(input: TellTaskInput): Promise<TellTaskResult> {
  const { listTasksByIds } = await import('../task-manager.js')
  const [task] = await listTasksByIds([input.taskId])
  if (!task || task.phase === 'COMPLETE') return { delivered: false, started: false, detail: 'the task is closed' }
  const { getSessionsForTask } = await import('../session-tracker.js')
  const { pickDeliverySession, isLiveSessionStatus } = await import('../routines/session-target.js')
  const target = pickDeliverySession(await getSessionsForTask(task.id).catch(() => []))
  const name = `"${task.title}"`
  // A live session takes it now; a stopped one is resumed only when fix tasks start sessions.
  if (target && (isLiveSessionStatus(target.process_status) || input.start)) {
    const { buildWalnutMessage } = await import('../peers/walnut-message-tag.js')
    const { sendMessageToSession } = await import('../session-message-queue.js')
    await sendMessageToSession(target.claudeSessionId, buildWalnutMessage({
      kind: 'notification',
      attrs: { from: 'Walnut: health monitor', note: 'a health alarm about the problem this task works on' },
      body: input.text,
    }), { source: FIX_SEND_SOURCE, taskId: task.id })
    return { delivered: true, started: false, detail: `told its task ${name}` }
  }
  if (!target && input.start) {
    const { startSessionForTask } = await import('../sessions/task-start.js')
    const { message, cwd } = await withWhere(input.text)
    // A task filed with no place runs where Walnut's source checkout is: this machine.
    await startSessionForTask({ taskIdPrefix: task.id, message, ...(task.cwd ? {} : { cwd, host: '__local__' }), source: FIX_SEND_SOURCE })
    return { delivered: false, started: true, detail: `started a session on its task ${name}` }
  }
  return { delivered: false, started: false, detail: `its task ${name} has no running session to tell` }
}

export async function isTaskOpen(taskId: string): Promise<boolean> {
  const { listTasksByIds } = await import('../task-manager.js')
  const [t] = await listTasksByIds([taskId])
  return !!t && t.phase !== 'COMPLETE'
}
