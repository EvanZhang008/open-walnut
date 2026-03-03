/**
 * Task routes — thin pass-through to core task-manager functions.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { log } from '../../logging/index.js'
import { VALID_PHASES } from '../../core/phase.js'
import {
  addTask,
  listTasks,
  getTask,
  completeTask,
  toggleComplete,
  updateTask,
  deleteTask,
  ActiveSessionError,
  ActiveChildrenError,
  CategorySourceConflictError,
  addNote,
  updateNote,
  updateDescription,
  updateSummary,
  toggleStar,
  reorderTasks,
  getAllTags,
  CircularDependencyError,
  isTaskBlocked,
} from '../../core/task-manager.js'
import { listSessions } from '../../core/session-tracker.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { VALID_PRIORITIES, type Task, type WorkStatus, type ProcessStatus, type SessionMode } from '../../core/types.js'

/** Session info used during enrichment (includes mode for slot inference). */
interface SessionInfo {
  work_status: WorkStatus
  process_status: ProcessStatus
  activity?: string
  mode: SessionMode
  provider?: import('../../core/types.js').SessionProvider
  planCompleted?: boolean
  archived?: boolean
}

/** Map SessionInfo to the enriched status shape attached to tasks. */
function toSlotStatus(info: SessionInfo, slot?: 'plan' | 'exec'): { work_status: WorkStatus; process_status: ProcessStatus; activity?: string; mode?: SessionMode; provider?: import('../../core/types.js').SessionProvider; planCompleted?: boolean } {
  return {
    work_status: info.work_status,
    process_status: info.process_status,
    activity: info.activity,
    mode: info.mode,
    provider: info.provider,
    ...(slot === 'plan' && info.planCompleted ? { planCompleted: true } : {}),
  }
}

/** Whether a session is still active (not in a terminal state). */
function isActiveSession(info: SessionInfo): boolean {
  return info.work_status !== 'completed' && info.work_status !== 'error'
}

/** Enrich tasks that have slot sessions with session status info. */
async function enrichTasksWithSessionStatus(tasks: Task[]): Promise<Task[]> {
  // Collect ALL session IDs needed across all tasks
  const sessionIds = new Set<string>()
  for (const t of tasks) {
    if (t.session_id) sessionIds.add(t.session_id)
    if (t.plan_session_id) sessionIds.add(t.plan_session_id)
    if (t.exec_session_id) sessionIds.add(t.exec_session_id)
    if (t.session_ids) for (const sid of t.session_ids) sessionIds.add(sid)
  }
  if (sessionIds.size === 0) return tasks

  // Single read of the session store — avoids N file reads via getSessionByClaudeId
  const allSessions = await listSessions()
  const sessionMap = new Map<string, SessionInfo>()
  for (const rec of allSessions) {
    if (sessionIds.has(rec.claudeSessionId)) {
      sessionMap.set(rec.claudeSessionId, {
        work_status: rec.work_status,
        process_status: rec.process_status,
        activity: rec.activity,
        mode: rec.mode,
        provider: rec.provider,
        planCompleted: rec.planCompleted,
        archived: rec.archived,
      })
    }
  }

  return tasks.map((t) => {
    const enriched: Task = { ...t }

    // Enrich the new single-slot session_status from task.session_id
    const singleInfo = t.session_id ? sessionMap.get(t.session_id) : undefined
    if (singleInfo) {
      enriched.session_status = {
        work_status: singleInfo.work_status,
        process_status: singleInfo.process_status,
        activity: singleInfo.activity,
        mode: singleInfo.mode,
        provider: singleInfo.provider,
        ...(singleInfo.planCompleted ? { planCompleted: true } : {}),
      }
    }

    // Enrich from explicit slot fields (strip mode before attaching) — backward compat
    const planInfo = t.plan_session_id ? sessionMap.get(t.plan_session_id) : undefined
    if (planInfo) enriched.plan_session_status = toSlotStatus(planInfo, 'plan')
    const execInfo = t.exec_session_id ? sessionMap.get(t.exec_session_id) : undefined
    if (execInfo) enriched.exec_session_status = toSlotStatus(execInfo, 'exec')

    // Infer missing slot statuses from session_ids + session mode.
    // Covers: from_plan fallback (SESSION_SEND doesn't call linkSessionSlot),
    // sessionReady rejection, async gap before sessionReady resolves, and
    // older tasks created before exec_session_id tracking was added.
    // Only infer from non-terminal sessions (completed/error sessions fall
    // through to the "N sessions" history pill instead).
    if ((!enriched.plan_session_status || !enriched.exec_session_status) && t.session_ids?.length) {
      // Iterate in reverse so the most recent session wins (session_ids is chronological)
      for (let i = t.session_ids.length - 1; i >= 0; i--) {
        const sid = t.session_ids[i]
        // Skip sessions already covered by slot fields
        if (sid === t.plan_session_id || sid === t.exec_session_id) continue
        const info = sessionMap.get(sid)
        if (!info || !isActiveSession(info)) continue
        if (!enriched.plan_session_status && info.mode === 'plan') {
          enriched.plan_session_status = toSlotStatus(info, 'plan')
        } else if (!enriched.exec_session_status && info.mode !== 'plan') {
          enriched.exec_session_status = toSlotStatus(info, 'exec')
        }
      }
    }

    // Collect all unique work_statuses across all sessions for this task
    const allSids = new Set<string>()
    if (t.plan_session_id) allSids.add(t.plan_session_id)
    if (t.exec_session_id) allSids.add(t.exec_session_id)
    if (t.session_ids) for (const sid of t.session_ids) allSids.add(sid)
    if (allSids.size > 0) {
      const statuses = new Set<WorkStatus>()
      for (const sid of allSids) {
        const info = sessionMap.get(sid)
        if (info) statuses.add(info.work_status)
      }
      if (statuses.size > 0) enriched.session_work_statuses = [...statuses]
    }

    // Filter archived sessions from session_ids so frontend counts/pills are correct
    if (enriched.session_ids) {
      enriched.session_ids = enriched.session_ids.filter(sid => !sessionMap.get(sid)?.archived)
    }
    return enriched
  })
}

export const tasksRouter = Router()

/** Extract a single string param (Express may return string | string[]). */
function param(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value
}

const VALID_STATUSES = ['todo', 'in_progress', 'done']
const VALID_PHASES_ARRAY = [...VALID_PHASES]

// GET /api/tasks — list with optional filters
tasksRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, category, project, source, tags } = req.query as Record<string, string | undefined>
    const tasks = (await listTasks({ status, category })).filter((t) => !t.title.startsWith('.metadata'))
    // Client-side project filtering (listTasks only supports status+category)
    let filtered = project
      ? tasks.filter((t) => t.project.toLowerCase() === project.toLowerCase())
      : tasks
    // Source/provider filtering
    if (source) {
      filtered = filtered.filter((t) => t.source === source)
    }
    // Tag filtering (comma-separated, any-match)
    if (tags) {
      const tagSet = new Set(tags.split(',').map(t => t.trim()).filter(Boolean))
      if (tagSet.size > 0) {
        filtered = filtered.filter((t) => t.tags?.some(tag => tagSet.has(tag)))
      }
    }
    const enriched = await enrichTasksWithSessionStatus(filtered)
    // Add is_blocked flag based on dependency resolution
    const allTasksForDeps = filtered // Use the already-loaded filtered list
    const tasksWithBlocked = enriched.map((t) => ({
      ...t,
      ...(t.depends_on?.length ? { is_blocked: isTaskBlocked(t, enriched) } : {}),
    }))
    res.json({ tasks: tasksWithBlocked })
  } catch (err) {
    next(err)
  }
})

// GET /api/tasks/meta/tags — all unique tags with frequency counts (for autocomplete)
tasksRouter.get('/meta/tags', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const tags = await getAllTags()
    res.json({ tags })
  } catch (err) {
    next(err)
  }
})

// GET /api/tasks/enriched — tasks with computed fields
tasksRouter.get('/enriched', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const tasks = (await listTasks({})).filter((t) => !t.title.startsWith('.metadata'))
    const now = Date.now()

    const enriched = tasks.map((t) => {
      const overdue = t.due_date ? new Date(t.due_date).getTime() < now && t.status !== 'done' : false

      return {
        ...t,
        overdue,
      }
    })

    res.json({ tasks: enriched })
  } catch (err) {
    next(err)
  }
})

// GET /api/tasks/:id
tasksRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = param(req.params.id)
    const task = await getTask(id)
    const [enriched] = await enrichTasksWithSessionStatus([task])
    const allTasks = await listTasks({})
    const taskWithDeps: Record<string, unknown> = { ...enriched }
    if (enriched.depends_on?.length) {
      taskWithDeps.is_blocked = isTaskBlocked(enriched, allTasks)
      taskWithDeps.resolved_dependencies = enriched.depends_on.map((depId: string) => {
        const dep = allTasks.find((t) => t.id === depId)
        return dep ? { id: dep.id, title: dep.title, phase: dep.phase } : { id: depId, title: '(not found)', phase: 'UNKNOWN' }
      })
    }
    const dependents = allTasks.filter((t) => t.depends_on?.includes(enriched.id))
    if (dependents.length > 0) {
      taskWithDeps.dependents = dependents.map((t) => ({ id: t.id, title: t.title, phase: t.phase }))
    }
    // Child tasks — handle both full-ID and prefix parent_task_id (legacy data)
    const children = allTasks.filter((t) => t.parent_task_id && enriched.id.startsWith(t.parent_task_id))
    if (children.length > 0) {
      taskWithDeps.children = children.map((t) => ({
        id: t.id, title: t.title, phase: t.phase, status: t.status, priority: t.priority,
      }))
    }
    res.json({ task: taskWithDeps })
  } catch (err) {
    next(err)
  }
})

// POST /api/tasks — create
tasksRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { title, priority, status } = req.body

    if (typeof title !== 'string' || title.trim() === '') {
      res.status(400).json({ error: 'title must be a non-empty string' })
      return
    }
    if (priority !== undefined && !VALID_PRIORITIES.includes(priority)) {
      res.status(400).json({ error: `priority must be one of: ${VALID_PRIORITIES.join(', ')}` })
      return
    }
    if (status !== undefined && !VALID_STATUSES.includes(status)) {
      res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` })
      return
    }
    if (req.body.depends_on !== undefined) {
      if (!Array.isArray(req.body.depends_on) || !req.body.depends_on.every((d: unknown) => typeof d === 'string')) {
        res.status(400).json({ error: 'depends_on must be an array of strings' })
        return
      }
    }
    // source is passed through to addTask; validation happens in task-manager via store.categories
    const result = await addTask(req.body)
    log.web.info('task created via REST', { taskId: result.task.id, category: result.task.category, project: result.task.project })
    bus.emit(EventNames.TASK_CREATED, { task: result.task }, ['web-ui', 'main-agent'], { source: 'api' })
    res.status(201).json(result)
  } catch (err) {
    if (err instanceof CategorySourceConflictError) {
      res.status(409).json({
        error: err.message,
        category: err.category,
        intended_source: err.intendedSource,
        existing_source: err.existingSource,
      })
      return
    }
    next(err)
  }
})

// PATCH /api/tasks/reorder — reorder tasks within a category/project group
// (Must be before /:id to avoid matching "reorder" as an ID)
tasksRouter.patch('/reorder', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { category, project, taskIds } = req.body as { category: string; project: string; taskIds: string[] }

    if (typeof category !== 'string' || !category || typeof project !== 'string' || !project) {
      res.status(400).json({ error: 'category and project must be non-empty strings' })
      return
    }
    if (!Array.isArray(taskIds) || taskIds.length === 0 || !taskIds.every((id: unknown) => typeof id === 'string')) {
      res.status(400).json({ error: 'taskIds must be a non-empty array of strings' })
      return
    }

    await reorderTasks(category, project, taskIds)
    bus.emit(EventNames.TASK_REORDERED, { category, project, taskIds }, ['web-ui'], { source: 'api' })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// PATCH /api/tasks/:id — update fields
tasksRouter.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = param(req.params.id)
    if (req.body.priority !== undefined && !VALID_PRIORITIES.includes(req.body.priority)) {
      res.status(400).json({ error: `priority must be one of: ${VALID_PRIORITIES.join(', ')}` })
      return
    }
    if (req.body.phase !== undefined && !VALID_PHASES.has(req.body.phase)) {
      res.status(400).json({ error: `phase must be one of: ${VALID_PHASES_ARRAY.join(', ')}` })
      return
    }
    if (req.body.starred !== undefined && typeof req.body.starred !== 'boolean') {
      res.status(400).json({ error: 'starred must be a boolean' })
      return
    }
    if (req.body.needs_attention !== undefined && typeof req.body.needs_attention !== 'boolean') {
      res.status(400).json({ error: 'needs_attention must be a boolean' })
      return
    }
    if (req.body.parent_task_id !== undefined && typeof req.body.parent_task_id !== 'string') {
      res.status(400).json({ error: 'parent_task_id must be a string (task ID or empty string to remove)' })
      return
    }
    // Tag validation
    for (const field of ['add_tags', 'remove_tags', 'set_tags'] as const) {
      if (req.body[field] !== undefined) {
        if (!Array.isArray(req.body[field]) || !req.body[field].every((t: unknown) => typeof t === 'string')) {
          res.status(400).json({ error: `${field} must be an array of strings` })
          return
        }
      }
    }
    // Dependency validation
    for (const field of ['add_depends_on', 'remove_depends_on', 'set_depends_on'] as const) {
      if (req.body[field] !== undefined) {
        if (!Array.isArray(req.body[field]) || !req.body[field].every((d: unknown) => typeof d === 'string')) {
          res.status(400).json({ error: `${field} must be an array of strings` })
          return
        }
      }
    }
    const result = await updateTask(id, req.body)
    log.web.info('task updated via REST', { taskId: id, fields: Object.keys(req.body) })
    bus.emit(EventNames.TASK_UPDATED, { task: result.task }, ['web-ui', 'main-agent'], { source: 'api' })
    res.json(result)
  } catch (err) {
    if (err instanceof CategorySourceConflictError) {
      res.status(409).json({
        error: err.message,
        category: err.category,
        intended_source: err.intendedSource,
        existing_source: err.existingSource,
      })
      return
    }
    if (err instanceof ActiveChildrenError) {
      res.status(409).json({ error: err.message, active_children: err.activeCount })
      return
    }
    if (err instanceof CircularDependencyError) {
      res.status(409).json({ error: err.message, task_id: err.taskId, dep_id: err.depId })
      return
    }
    next(err)
  }
})

// POST /api/tasks/:id/complete
tasksRouter.post('/:id/complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = param(req.params.id)
    const result = await completeTask(id)
    log.web.info('task completed via REST', { taskId: id })
    bus.emit(EventNames.TASK_COMPLETED, { task: result.task }, ['web-ui', 'main-agent'], { source: 'api' })
    res.json(result)
  } catch (err) {
    if (err instanceof ActiveChildrenError) {
      res.status(409).json({ error: err.message, active_children: err.activeCount })
      return
    }
    next(err)
  }
})

// POST /api/tasks/:id/toggle-complete
tasksRouter.post('/:id/toggle-complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = param(req.params.id)
    const result = await toggleComplete(id)
    const eventName = result.task.status === 'done' ? EventNames.TASK_COMPLETED : EventNames.TASK_UPDATED
    bus.emit(eventName, { task: result.task }, ['web-ui', 'main-agent'], { source: 'api' })
    res.json(result)
  } catch (err) {
    if (err instanceof ActiveChildrenError) {
      res.status(409).json({ error: err.message, active_children: err.activeCount })
      return
    }
    next(err)
  }
})

// POST /api/tasks/:id/star
tasksRouter.post('/:id/star', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = param(req.params.id)
    const result = await toggleStar(id)
    bus.emit(EventNames.TASK_STARRED, { task: result.task, starred: result.starred }, ['web-ui'], { source: 'api' })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// DELETE /api/tasks/:id — delete a task (blocked if active sessions exist)
tasksRouter.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = param(req.params.id)
    const result = await deleteTask(id)
    log.web.info('task deleted via REST', { taskId: id })
    bus.emit(EventNames.TASK_DELETED, { id: result.task.id, task: result.task }, ['web-ui', 'main-agent'], { source: 'api' })
    res.status(204).end()
  } catch (err) {
    if (err instanceof ActiveSessionError) {
      res.status(409).json({
        error: `Cannot delete task: has active sessions: ${err.activeSessionIds.join(', ')}`,
        active_session_ids: err.activeSessionIds,  // kept for API compat
      })
      return
    }
    next(err)
  }
})

// POST /api/tasks/:id/notes
tasksRouter.post('/:id/notes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = param(req.params.id)
    const { content } = req.body as { content: string }
    const result = await addNote(id, content)
    bus.emit(EventNames.TASK_UPDATED, { task: result.task }, ['web-ui'], { source: 'api' })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// PUT /api/tasks/:id/note — replace entire note
tasksRouter.put('/:id/note', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = param(req.params.id)
    const { content } = req.body as { content: string }
    const result = await updateNote(id, content)
    bus.emit(EventNames.TASK_UPDATED, { task: result.task }, ['web-ui'], { source: 'api' })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// PUT /api/tasks/:id/description — update description
tasksRouter.put('/:id/description', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = param(req.params.id)
    const { content } = req.body as { content: string }
    const result = await updateDescription(id, content)
    bus.emit(EventNames.TASK_UPDATED, { task: result.task }, ['web-ui'], { source: 'api' })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// PUT /api/tasks/:id/summary — update summary
tasksRouter.put('/:id/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = param(req.params.id)
    const { content } = req.body as { content: string }
    const result = await updateSummary(id, content)
    bus.emit(EventNames.TASK_UPDATED, { task: result.task }, ['web-ui'], { source: 'api' })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// PUT /api/tasks/:id/depends-on — set dependencies directly
tasksRouter.put('/:id/depends-on', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = param(req.params.id)
    const { depends_on } = req.body as { depends_on: string[] }
    if (!Array.isArray(depends_on) || !depends_on.every((d: unknown) => typeof d === 'string')) {
      res.status(400).json({ error: 'depends_on must be an array of strings' })
      return
    }
    const result = await updateTask(id, { set_depends_on: depends_on })
    bus.emit(EventNames.TASK_UPDATED, { task: result.task }, ['web-ui', 'main-agent'], { source: 'api' })
    res.json(result)
  } catch (err) {
    if (err instanceof CircularDependencyError) {
      res.status(409).json({ error: err.message, task_id: err.taskId, dep_id: err.depId })
      return
    }
    next(err)
  }
})

