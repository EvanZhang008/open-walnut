/**
 * The project a session's `x-walnut-project` header names (sessions/request-tag.ts): the
 * task's project now, since a task may have moved after its session was made, else the
 * project the session was made in. A session of no task names none, as Walnut's own calls.
 * Kept apart from request-tag.ts, which the host daemon's worker bundles and which must not
 * reach the task store.
 */
export async function requestTagProject(taskId: string | undefined, madeIn: string | undefined): Promise<string | undefined> {
  if (!taskId) return undefined
  try {
    const { getTask } = await import('../task-manager.js')
    const task = await getTask(taskId)
    return task ? (task.project ?? '') : madeIn
  } catch {
    return madeIn
  }
}
