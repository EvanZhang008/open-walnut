/**
 * A health alarm's fix task: filed under the Walnut project (where the user's
 * Walnut work and its lead live), the way the notification center's "Ask AI to
 * fix" files one (src/web/routes/notifications.ts).
 *
 *  - `record`: a plain task with the brief as its description; nothing runs.
 *  - `start`: the same brief starts a session in Walnut's source checkout
 *    (self-repair/walnut-source.ts), told where it stands the same way.
 */

import { randomUUID } from 'node:crypto'
import { LOG_DIR, WALNUT_HOME, WALNUT_PACKAGE_ROOT, WALNUT_REPO_URL } from '../../constants.js'
import type { FixTaskInput } from './engine.js'

export const FIX_PROJECT = 'Walnut'
export const FIX_SEND_SOURCE = 'health-alarm'

export async function openFixTask(input: FixTaskInput): Promise<{ taskId: string; started: boolean }> {
  if (input.mode === 'record') {
    const { addTask } = await import('../task-manager.js')
    const { task } = await addTask({ title: input.title, project: FIX_PROJECT, description: input.brief })
    return { taskId: task.id, started: false }
  }
  const { ensureWalnutSource } = await import('../self-repair/walnut-source.js')
  const { whereSection } = await import('../self-repair/fix-briefing.js')
  const { quickStartSession } = await import('../sessions/quick-start.js')
  const { getVersion } = await import('../version.js')
  const { source, cloned } = await ensureWalnutSource()
  const message = [
    input.brief,
    '',
    ...whereSection({
      source, cloned, version: getVersion(), packageRoot: WALNUT_PACKAGE_ROOT,
      dataDir: WALNUT_HOME, logDir: LOG_DIR, repoUrl: WALNUT_REPO_URL,
    }),
  ].join('\n')
  const task = await quickStartSession({
    message,
    cwd: source.dir,
    taskTitle: input.title,
    project: FIX_PROJECT,
    projectFromFolder: false,
    source: FIX_SEND_SOURCE,
    requestTs: Date.now(),
    preassignedSessionId: randomUUID(),
  })
  return { taskId: task.id, started: true }
}

export async function isTaskOpen(taskId: string): Promise<boolean> {
  const { listTasksByIds } = await import('../task-manager.js')
  const [t] = await listTasksByIds([taskId])
  return !!t && t.phase !== 'COMPLETE'
}
