/**
 * /api/v1 task + focus endpoints (additive) — the Wave-1 mobile parity set.
 * Semantics are identical to the web routes (src/web/routes/tasks.ts,
 * src/web/routes/focus.ts) because both call the SAME task-manager functions.
 *
 *   GET    /tasks/:id                → { task } (full detail incl. note/description/summary/deps)
 *   DELETE /tasks/:id?force=true     → 204 (409 conflict when sessions are active)
 *   POST   /tasks/:id/star           → { task, starred }
 *   POST   /tasks/:id/notes          → { task } (append timestamped note)
 *   PUT    /tasks/:id/note           → { task } (replace whole note)
 *   PUT    /tasks/:id/description    → { task }
 *   PUT    /tasks/:id/summary        → { task }
 *   PUT    /tasks/:id/depends-on     → { task }
 *   PATCH  /tasks/reorder            → { ok: true }
 *   POST   /tasks/batch/phase        → { changed, failed, syncFailed } (partial success)
 *   POST   /tasks/batch/delete       → { deleted, failed } (partial success)
 *   GET    /focus/tasks              → TierResult
 *   POST   /focus/tasks/:id          → { pinned_tasks }
 *   DELETE /focus/tasks/:id          → { pinned_tasks }
 *   PUT    /focus/reorder            → TierResult
 *   PUT    /focus/tasks/:id/tier     → TierResult
 *   GET    /focus/tiers              → { tiers }
 *
 * Cloud companion (REPLICA): all Class A. The replica has a REAL local task
 * store (seeded by the projection import), and every mutation here goes
 * through task-manager which emits TASK_* bus events — the cloud outbox
 * subscriber (server.ts) turns those into op files that ride git-sync back to
 * the primary (task-outbox.ts). Nothing here needs a bridge. Detail responses
 * serve the FULL local task row (not the slim projection) so note/description
 * read back — the frozen GET /v1/tasks list stays slim and untouched.
 *
 * Frozen-contract note: everything here is additive (docs/reference/api-v1.md).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { log } from '../../logging/index.js'
import { bus, EventNames } from '../../core/event-bus.js'
import type { Task, TaskPhase } from '../../core/types.js'

export const taskV1Router = Router()

// Same frozen error shape as api-v1.ts.
function sendError(res: Response, status: number, code: string, message: string, extra?: Record<string, unknown>): void {
  res.status(status).json({ error: { code, message }, ...(extra ?? {}) })
}

/** Express 5 params can be string[] on routers with wildcard routes. */
function paramStr(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v.join('/')
  return v ?? ''
}

/**
 * Map the task-manager's message-based errors to the frozen v1 vocabulary.
 * Returns true when the error was handled (response sent).
 */
function sendTaskManagerError(res: Response, err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  if (/No task found matching/i.test(msg) || /^Task not found/i.test(msg)) {
    sendError(res, 404, 'not_found', msg)
    return true
  }
  if (/Ambiguous ID prefix/i.test(msg)) {
    sendError(res, 400, 'bad_request', msg)
    return true
  }
  return false
}

// ─── Task detail / delete / field setters ───────────────────────────────────

// GET /api/v1/tasks/:id — FULL task detail (description/note/summary readback
// — the slim list projection is write-only for those fields). Adds the same
// dependency/children/parent decorations the web detail endpoint serves.
taskV1Router.get('/tasks/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = paramStr(req.params.id)
    const tm = await import('../../core/task-manager.js')
    let task: Task
    try {
      task = await tm.getTask(id)
    } catch (err) {
      if (sendTaskManagerError(res, err)) return
      throw err
    }
    const allTasks = await tm.listTasks({})
    const detail: Record<string, unknown> = { ...task }
    if (task.depends_on?.length) {
      detail.is_blocked = tm.isTaskBlocked(task, allTasks)
      detail.resolved_dependencies = task.depends_on.map((depId) => {
        const dep = allTasks.find((t) => t.id === depId)
        return dep ? { id: dep.id, title: dep.title, phase: dep.phase } : { id: depId, title: '(not found)', phase: 'UNKNOWN' }
      })
    }
    const dependents = allTasks.filter((t) => t.depends_on?.includes(task.id))
    if (dependents.length > 0) {
      detail.dependents = dependents.map((t) => ({ id: t.id, title: t.title, phase: t.phase }))
    }
    // Children — tolerate prefix parent_task_id (legacy data), like the web route.
    const children = allTasks.filter((t) => t.parent_task_id && task.id.startsWith(t.parent_task_id))
    if (children.length > 0) {
      detail.children = children.map((t) => ({ id: t.id, title: t.title, phase: t.phase, status: t.status, priority: t.priority }))
    }
    if (task.parent_task_id) {
      const parent = allTasks.find((t) => t.id.startsWith(task.parent_task_id!))
      if (parent) detail.parent = { id: parent.id, title: parent.title, phase: parent.phase, status: parent.status }
    }
    res.json({ task: detail })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/v1/tasks/:id?force=true — 204; 409 conflict when the task has
// active sessions and force is not set (force stops the sessions first).
taskV1Router.delete('/tasks/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = paramStr(req.params.id)
    const force = req.query.force === 'true' || (req.body ?? {}).force === true
    const tm = await import('../../core/task-manager.js')
    try {
      const result = await tm.deleteTask(id)
      log.web.info('task deleted via api-v1', { taskId: id })
      bus.emit(EventNames.TASK_DELETED, { id: result.task.id, task: result.task }, ['web-ui', 'main-agent'], { source: 'api-v1' })
      res.status(204).end()
    } catch (err) {
      if (err instanceof tm.ActiveSessionError && force) {
        // Force mode: stop sessions and retry — same flow as the web route.
        const { completeTaskSessions } = await import('../../core/session-tracker.js')
        await completeTaskSessions(err.activeSessionIds)
        for (const sid of err.activeSessionIds) {
          try { await tm.clearSessionSlot(id, sid) } catch { /* best-effort */ }
        }
        const result = await tm.deleteTask(id)
        log.web.info('task force-deleted via api-v1 (stopped sessions)', { taskId: id, stoppedSessions: err.activeSessionIds.length })
        bus.emit(EventNames.TASK_DELETED, { id: result.task.id, task: result.task }, ['web-ui', 'main-agent'], { source: 'api-v1' })
        res.status(204).end()
        return
      }
      if (err instanceof tm.ActiveSessionError) {
        sendError(res, 409, 'conflict',
          `Cannot delete task: has active sessions: ${err.activeSessionIds.join(', ')}`,
          { active_session_ids: err.activeSessionIds })
        return
      }
      if (sendTaskManagerError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/tasks/:id/star — toggle star. → { task, starred }
taskV1Router.post('/tasks/:id/star', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = paramStr(req.params.id)
    const { toggleStar } = await import('../../core/task-manager.js')
    try {
      const result = await toggleStar(id)
      bus.emit(EventNames.TASK_STARRED, { task: result.task, starred: result.starred }, ['web-ui'], { source: 'api-v1' })
      res.json(result)
    } catch (err) {
      if (sendTaskManagerError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

/** Shared body gate for the content-setter endpoints below. */
function requireContent(req: Request, res: Response): string | null {
  const content = (req.body ?? {}).content
  if (typeof content !== 'string') {
    sendError(res, 400, 'bad_request', 'content (string) is required')
    return null
  }
  return content
}

// POST /api/v1/tasks/:id/notes — append a timestamped note entry.
taskV1Router.post('/tasks/:id/notes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = paramStr(req.params.id)
    const content = requireContent(req, res)
    if (content === null) return
    const { addNote } = await import('../../core/task-manager.js')
    try {
      res.json(await addNote(id, content))
    } catch (err) {
      if (sendTaskManagerError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// PUT /api/v1/tasks/:id/note — replace the entire note.
taskV1Router.put('/tasks/:id/note', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = paramStr(req.params.id)
    const content = requireContent(req, res)
    if (content === null) return
    const { updateNote } = await import('../../core/task-manager.js')
    try {
      res.json(await updateNote(id, content))
    } catch (err) {
      if (sendTaskManagerError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// PUT /api/v1/tasks/:id/description
taskV1Router.put('/tasks/:id/description', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = paramStr(req.params.id)
    const content = requireContent(req, res)
    if (content === null) return
    const { updateDescription } = await import('../../core/task-manager.js')
    try {
      res.json(await updateDescription(id, content))
    } catch (err) {
      if (sendTaskManagerError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// PUT /api/v1/tasks/:id/summary
taskV1Router.put('/tasks/:id/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = paramStr(req.params.id)
    const content = requireContent(req, res)
    if (content === null) return
    const { updateSummary } = await import('../../core/task-manager.js')
    try {
      res.json(await updateSummary(id, content))
    } catch (err) {
      if (sendTaskManagerError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// PUT /api/v1/tasks/:id/depends-on { depends_on: string[] } — set dependencies.
taskV1Router.put('/tasks/:id/depends-on', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = paramStr(req.params.id)
    const dependsOn = (req.body ?? {}).depends_on
    if (!Array.isArray(dependsOn) || !dependsOn.every((d: unknown) => typeof d === 'string')) {
      sendError(res, 400, 'bad_request', 'depends_on must be an array of strings')
      return
    }
    const tm = await import('../../core/task-manager.js')
    try {
      res.json(await tm.updateTask(id, { set_depends_on: dependsOn }, { source: 'api', extraTargets: ['main-agent'] }))
    } catch (err) {
      if (err instanceof tm.CircularDependencyError) {
        sendError(res, 409, 'conflict', err.message, { task_id: err.taskId, dep_id: err.depId })
        return
      }
      if (sendTaskManagerError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// ─── Reorder + batch ─────────────────────────────────────────────────────────

// PATCH /api/v1/tasks/reorder { project, taskIds } — reorder within ONE project
// group. project '' = Inbox (valid), so the guard is a type check.
// NOTE: Express matches routes in registration order per-router; this router
// only has explicit paths (no bare /tasks/:id PATCH), so no reorder-vs-id clash.
taskV1Router.patch('/tasks/reorder', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { project, taskIds } = (req.body ?? {}) as { project?: unknown; taskIds?: unknown }
    if (typeof project !== 'string') {
      sendError(res, 400, 'bad_request', "project must be a string ('' = Inbox)")
      return
    }
    if (!Array.isArray(taskIds) || taskIds.length === 0 || !taskIds.every((id) => typeof id === 'string')) {
      sendError(res, 400, 'bad_request', 'taskIds must be a non-empty array of strings')
      return
    }
    const { reorderTasks } = await import('../../core/task-manager.js')
    await reorderTasks(project, taskIds as string[])
    bus.emit(EventNames.TASK_REORDERED, { project, taskIds }, ['web-ui'], { source: 'api-v1' })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

/** Validate a batch body's task_ids. Returns ids or null after replying 400. */
function batchIds(req: Request, res: Response): string[] | null {
  const taskIds = (req.body ?? {}).task_ids
  if (!Array.isArray(taskIds) || taskIds.length === 0 || !taskIds.every((id: unknown) => typeof id === 'string')) {
    sendError(res, 400, 'bad_request', 'task_ids must be a non-empty array of strings')
    return null
  }
  return taskIds as string[]
}

// POST /api/v1/tasks/batch/phase { task_ids, phase } — partial success by
// design: always 200 with { changed, failed, syncFailed }.
taskV1Router.post('/tasks/batch/phase', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const taskIds = batchIds(req, res)
    if (!taskIds) return
    const phase = (req.body ?? {}).phase
    const { VALID_PHASES } = await import('../../core/phase.js')
    if (typeof phase !== 'string' || !VALID_PHASES.has(phase as TaskPhase)) {
      sendError(res, 400, 'bad_request', `phase must be one of: ${[...VALID_PHASES].join(', ')}`)
      return
    }
    const { setPhaseBulk } = await import('../../core/task-manager.js')
    const { changed, failed, syncFailed } = await setPhaseBulk(taskIds, phase as TaskPhase)
    log.web.info('tasks batch phase via api-v1', { count: taskIds.length, changed: changed.length, failed: failed.length, phase })
    // Per-task events so every surface (and the cloud outbox) reconciles the
    // same way it does for a single-task change.
    const eventName = phase === 'COMPLETE' ? EventNames.TASK_COMPLETED : EventNames.TASK_UPDATED
    for (const task of changed) {
      bus.emit(eventName, { task }, ['web-ui', 'main-agent'], { source: 'api-v1' })
    }
    res.json({ changed, failed, syncFailed })
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/tasks/batch/delete { task_ids, force? } — partial success:
// always 200 with { deleted, failed }. POST (not DELETE) because the id list
// travels in the body.
taskV1Router.post('/tasks/batch/delete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const taskIds = batchIds(req, res)
    if (!taskIds) return
    const force = (req.body ?? {}).force === true || req.query.force === 'true'
    const { deleteTasksByIds } = await import('../../core/task-manager.js')
    const { deleted, failed } = await deleteTasksByIds(taskIds, { force })
    log.web.info('tasks batch delete via api-v1', { count: taskIds.length, deleted: deleted.length, failed: failed.length, force })
    for (const task of deleted) {
      bus.emit(EventNames.TASK_DELETED, { id: task.id, task }, ['web-ui', 'main-agent'], { source: 'api-v1' })
    }
    res.json({ deleted, failed })
  } catch (err) {
    next(err)
  }
})

// ─── Focus bar (pins + tiers) ────────────────────────────────────────────────

// GET /api/v1/focus/tasks — full tier split (pinned + built-in + custom buckets).
taskV1Router.get('/focus/tasks', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { getTierSplit } = await import('../../core/task-manager.js')
    res.json(await getTierSplit())
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/focus/tasks/:id — pin (idempotent). → { pinned_tasks }
taskV1Router.post('/focus/tasks/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const taskId = paramStr(req.params.id)
    const { getPinnedTasks, togglePin } = await import('../../core/task-manager.js')
    const current = await getPinnedTasks()
    if (current.some((t) => t.id === taskId)) {
      res.json({ pinned_tasks: current.map((t) => t.id) })
      return
    }
    try {
      const result = await togglePin(taskId)
      bus.emit(EventNames.CONFIG_CHANGED, { key: 'focus_bar' }, ['web-ui'])
      res.json({ pinned_tasks: result.pinned_tasks })
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Cannot pin a completed task')) {
        sendError(res, 409, 'conflict', err.message)
        return
      }
      if (sendTaskManagerError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// DELETE /api/v1/focus/tasks/:id — unpin (idempotent). → { pinned_tasks }
taskV1Router.delete('/focus/tasks/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const taskId = paramStr(req.params.id)
    const { getPinnedTasks, togglePin } = await import('../../core/task-manager.js')
    const current = await getPinnedTasks()
    if (!current.some((t) => t.id === taskId)) {
      res.json({ pinned_tasks: current.map((t) => t.id) })
      return
    }
    const result = await togglePin(taskId)
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'focus_bar' }, ['web-ui'])
    res.json({ pinned_tasks: result.pinned_tasks })
  } catch (err) {
    next(err)
  }
})

// PUT /api/v1/focus/reorder { task_ids } — reorder pins. Returns the FULL
// TierResult (a pinned-only payload historically made clients wipe tiers).
taskV1Router.put('/focus/reorder', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const taskIds = (req.body ?? {}).task_ids
    if (!Array.isArray(taskIds) || !taskIds.every((id: unknown) => typeof id === 'string')) {
      sendError(res, 400, 'bad_request', 'task_ids must be an array of strings')
      return
    }
    const { reorderPins } = await import('../../core/task-manager.js')
    const result = await reorderPins(taskIds as string[])
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'focus_bar' }, ['web-ui'])
    res.json(result)
  } catch (err) {
    next(err)
  }
})

const BUILTIN_TIERS = ['focus', 'satellite', 'backlog', 'wait']

// PUT /api/v1/focus/tasks/:id/tier { tier } — move a pinned task between tiers.
taskV1Router.put('/focus/tasks/:id/tier', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const taskId = paramStr(req.params.id)
    const tier = (req.body ?? {}).tier
    const { getCustomTiers, setFocusTier } = await import('../../core/task-manager.js')
    const customIds = (await getCustomTiers()).map((t) => t.id)
    if (typeof tier !== 'string' || (!BUILTIN_TIERS.includes(tier) && !customIds.includes(tier))) {
      sendError(res, 400, 'bad_request', `tier must be one of: ${[...BUILTIN_TIERS, ...customIds].join(', ')}`)
      return
    }
    try {
      res.json(await setFocusTier(taskId, tier))
    } catch (err) {
      if (err instanceof Error && (err.message.startsWith('Task not found') || err.message.startsWith('Task is not pinned'))) {
        sendError(res, 400, 'bad_request', err.message)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/focus/tiers — the registered custom tiers (ordered).
taskV1Router.get('/focus/tiers', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { getCustomTiers } = await import('../../core/task-manager.js')
    res.json({ tiers: await getCustomTiers() })
  } catch (err) {
    next(err)
  }
})

// Router-level error funnel — keeps unexpected failures in the frozen shape.
taskV1Router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log.web.error('api-v1 task route error', {
    error: err instanceof Error ? err.message : String(err),
  })
  if (res.headersSent) {
    res.end()
    return
  }
  sendError(res, 500, 'internal', 'Internal server error')
})
